'use strict';

const { callLLM, resolveModel } = require('./providers');
const { contractToPrompt } = require('./contracts');

// ===== File Manifest Planner =====
// Stage 1: Plans the exact file manifest before any code is generated.
// Output is a structured JSON manifest — not prose.

const PLANNER_SYSTEM = `You are a software architect. You will receive a project specification and a contract.

Your ONLY job is to output a JSON file manifest. No prose, no explanation, no code.

Output EXACTLY this JSON structure (nothing else):
{
  "files": [
    {
      "path": "relative/path/to/file.ext",
      "purpose": "One-line description of this file",
      "estimatedLines": 50,
      "language": "python"
    }
  ],
  "entrypoint": "path/to/main/file",
  "testEntrypoint": "path/to/test/runner or null",
  "dependencies": ["package1", "package2"],
  "setupCommands": ["pip install -r requirements.txt"],
  "smokeCommand": "python main.py --help"
}

Rules:
- Include ALL files needed for a complete, runnable project (source, config, requirements, tests, README).
- Path separators must be forward slashes.
- estimatedLines must be realistic (not inflated).
- Do NOT include build artifacts, __pycache__, .git, node_modules, etc.
- The entrypoint MUST match the contract exactly.
- Output RAW JSON only. No markdown fences, no prose before/after.`;

async function planManifest(spec, contract, config) {
  const model = resolveModel('planner', config.apiKeys, config.plannerModel);
  if (!model) throw new Error('No model available for planning. Set an API key.');

  const contractText = contractToPrompt(contract);
  const userPrompt = `${contractText}\n\nProject Specification:\n${spec}\n\nOutput the file manifest JSON now.`;

  if (config.verbose) {
    console.log(`[planner] Using model: ${model.name} (${model.provider})`);
  }

  const result = await callLLM(model.provider, config.apiKeys[model.provider], model.id, [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: userPrompt },
  ], { maxTokens: 4096, temperature: 0.2 });

  // Parse JSON from response (strip markdown fences if present)
  let content = result.content.trim();
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch (err) {
    throw new Error(`Planner produced invalid JSON:\n${content}\n\nParse error: ${err.message}`);
  }

  // Validate manifest structure
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Planner produced empty file manifest');
  }
  for (const file of manifest.files) {
    if (!file.path) throw new Error(`Manifest file missing "path": ${JSON.stringify(file)}`);
    if (!file.language) file.language = guessLanguage(file.path);
    if (!file.estimatedLines) file.estimatedLines = 50;
  }

  if (config.verbose) {
    console.log(`[planner] Manifest: ${manifest.files.length} files planned`);
    manifest.files.forEach(f => console.log(`  ${f.path} (~${f.estimatedLines} lines, ${f.language})`));
  }

  return {
    manifest,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
  };
}

function guessLanguage(path) {
  const ext = path.split('.').pop().toLowerCase();
  const map = {
    py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript',
    tsx: 'typescript', html: 'html', css: 'css', json: 'json', yaml: 'yaml',
    yml: 'yaml', toml: 'toml', md: 'markdown', txt: 'text', sh: 'bash',
    sql: 'sql', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', cfg: 'ini',
    ini: 'ini', env: 'dotenv',
  };
  return map[ext] || 'text';
}

module.exports = { planManifest };
