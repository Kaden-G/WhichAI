'use strict';

const { callLLM, resolveModel } = require('./providers');
const { contractToPrompt } = require('./contracts');
const { chunkFiles, detectTruncation, estimateTokens } = require('./token-budget');

// ===== Multi-Call Chunked File Generator =====
// Generates files in chunks with hard size limits per call.
// Every chunk is machine-readable JSON: {files: [{path, content}]}
// Validates each file for completeness. Retries truncated files individually.

const MAX_RETRIES = 2;

const GENERATOR_SYSTEM = `You are an expert code generator. You produce COMPLETE, RUNNABLE source files.

You will receive:
1. A project contract (canonical interface — do not deviate).
2. The full project spec.
3. A file manifest showing the planned project structure.
4. A list of specific files to generate NOW.

CRITICAL RULES:
- Output ONLY raw JSON: {"files": [{"path": "...", "content": "..."}]}
- Each file's content must be the COMPLETE file — all imports, all functions, all code. No abbreviations.
- Do NOT output prose, explanations, or markdown fences. ONLY the JSON object.
- Do NOT use placeholder comments like "// rest of implementation" or "# TODO: implement".
- Every function/class body must be fully implemented.
- The entrypoint and CLI signature must EXACTLY match the contract.
- If a file is large, output it fully. Never truncate.
- Use consistent naming, imports, and interfaces across all files.`;

async function generateFiles(spec, contract, manifest, config, onProgress) {
  const model = resolveModel('generator', config.apiKeys, config.generatorModel);
  if (!model) throw new Error('No model available for generation. Set an API key.');

  const contractText = contractToPrompt(contract);
  const manifestSummary = manifest.files.map(f => `${f.path} — ${f.purpose} (~${f.estimatedLines} lines)`).join('\n');

  // Chunk files based on token budget
  const chunks = chunkFiles(manifest.files, config.maxOutputTokens, config.chunkingStrategy);

  if (config.verbose) {
    console.log(`[generator] Using model: ${model.name} (${model.provider})`);
    console.log(`[generator] Split into ${chunks.length} chunk(s)`);
  }

  const allFiles = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0 };

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const fileList = chunk.map(f => `- ${f.path} (${f.language}, ~${f.estimatedLines} lines): ${f.purpose}`).join('\n');

    if (onProgress) onProgress(`Generating chunk ${ci + 1}/${chunks.length} (${chunk.length} files)...`);

    const userPrompt = `${contractText}

PROJECT SPEC:
${spec}

FULL FILE MANIFEST (for reference — shows the complete project structure):
${manifestSummary}

FILES TO GENERATE NOW (generate these and ONLY these):
${fileList}

Output the complete JSON object with all ${chunk.length} file(s). Remember: raw JSON only, no markdown.`;

    let chunkFiles = await generateChunkWithRetry(
      model, config, userPrompt, chunk, totalUsage
    );
    allFiles.push(...chunkFiles);
  }

  return { files: allFiles, usage: totalUsage };
}

async function generateChunkWithRetry(model, config, userPrompt, expectedFiles, totalUsage) {
  let attempts = 0;
  let generatedFiles = [];

  while (attempts <= MAX_RETRIES) {
    attempts++;
    const result = await callLLM(
      model.provider, config.apiKeys[model.provider], model.id,
      [
        { role: 'system', content: GENERATOR_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: config.maxOutputTokens, temperature: config.temperature }
    );

    totalUsage.inputTokens += result.inputTokens;
    totalUsage.outputTokens += result.outputTokens;

    // Parse JSON
    let parsed;
    let content = result.content.trim();
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    try {
      parsed = JSON.parse(content);
    } catch (err) {
      if (config.verbose) console.log(`[generator] JSON parse failed (attempt ${attempts}): ${err.message}`);
      // Try to recover complete files from truncated JSON
      const recovered = recoverTruncatedJson(content);
      if (recovered && recovered.files.length > 0) {
        if (config.verbose) console.log(`[generator] Recovered ${recovered.files.length} file(s) from truncated output`);
        parsed = recovered;
      } else {
        if (attempts > MAX_RETRIES) {
          throw new Error(`Generator produced invalid JSON after ${attempts} attempts:\n${content.slice(0, 500)}`);
        }
        continue;
      }
    }

    if (!parsed.files || !Array.isArray(parsed.files)) {
      if (attempts > MAX_RETRIES) {
        throw new Error('Generator output missing "files" array');
      }
      continue;
    }

    generatedFiles = parsed.files;

    // Validate completeness
    const truncated = [];
    for (const file of generatedFiles) {
      const issues = detectTruncation(file.content || '');
      if (issues.length > 0) {
        truncated.push({ file, issues });
      }
    }

    // Check all expected files are present
    const generatedPaths = new Set(generatedFiles.map(f => f.path));
    const missing = expectedFiles.filter(f => !generatedPaths.has(f.path));

    if (truncated.length === 0 && missing.length === 0) {
      if (config.verbose) console.log(`[generator] Chunk complete: ${generatedFiles.length} files, all valid`);
      return generatedFiles;
    }

    // Retry truncated/missing files individually
    if (attempts <= MAX_RETRIES) {
      const toRetry = [
        ...truncated.map(t => expectedFiles.find(f => f.path === t.file.path)).filter(Boolean),
        ...missing,
      ];

      if (config.verbose) {
        console.log(`[generator] Retrying ${toRetry.length} file(s): ${toRetry.map(f => f.path).join(', ')}`);
      }

      for (const file of toRetry) {
        const singleResult = await retrySingleFile(model, config, file, userPrompt, totalUsage);
        if (singleResult) {
          // Replace or add
          const idx = generatedFiles.findIndex(f => f.path === file.path);
          if (idx >= 0) generatedFiles[idx] = singleResult;
          else generatedFiles.push(singleResult);
        }
      }
      return generatedFiles;
    }
  }

  return generatedFiles;
}

async function retrySingleFile(model, config, fileSpec, originalPrompt, totalUsage) {
  const retryPrompt = `${originalPrompt}

IMPORTANT: The previous generation truncated or missed the file "${fileSpec.path}".
Generate ONLY this single file now. Output raw JSON: {"files": [{"path": "${fileSpec.path}", "content": "...complete file..."}]}
The file must be COMPLETE — no truncation, no placeholders.`;

  const result = await callLLM(
    model.provider, config.apiKeys[model.provider], model.id,
    [
      { role: 'system', content: GENERATOR_SYSTEM },
      { role: 'user', content: retryPrompt },
    ],
    { maxTokens: config.maxOutputTokens, temperature: config.temperature }
  );

  totalUsage.inputTokens += result.inputTokens;
  totalUsage.outputTokens += result.outputTokens;

  let content = result.content.trim();
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  try {
    const parsed = JSON.parse(content);
    if (parsed.files && parsed.files.length > 0) {
      return parsed.files[0];
    }
  } catch {
    if (config.verbose) console.log(`[generator] Single-file retry parse failed for ${fileSpec.path}`);
  }
  return null;
}

/**
 * Attempts to recover complete files from truncated JSON output.
 * The LLM may produce: {"files": [{"path":"a.py","content":"...complete..."}, {"path":"b.py","content":"...trunc
 * We can still salvage a.py since it was fully serialized.
 */
function recoverTruncatedJson(raw) {
  // Find all complete file objects using regex
  const files = [];
  // Match complete {"path": "...", "content": "..."} objects
  const filePattern = /\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let match;
  while ((match = filePattern.exec(raw)) !== null) {
    try {
      // Unescape the content string properly
      const content = JSON.parse('"' + match[2] + '"');
      files.push({ path: match[1], content });
    } catch {
      // Skip malformed entries
    }
  }
  if (files.length === 0) return null;
  return { files };
}

module.exports = { generateFiles };
