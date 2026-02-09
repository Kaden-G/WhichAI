'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { callLLM, resolveModel } = require('./providers');
const { contractToPrompt } = require('./contracts');

// ===== Judge / Evaluator Module =====
// LLM-based evaluation of generated artifacts against a rubric.

const DEFAULT_RUBRIC = {
  completeness: {
    weight: 30,
    description: 'All planned files exist, are non-empty, and contain complete implementations',
  },
  runnable: {
    weight: 25,
    description: 'Project compiles without errors and runs successfully',
  },
  contractAdherence: {
    weight: 25,
    description: 'CLI signature, entrypoint, input/output formats match the contract exactly',
  },
  codeQuality: {
    weight: 10,
    description: 'Code follows best practices, has error handling, is well-structured',
  },
  security: {
    weight: 10,
    description: 'No hardcoded secrets, proper input validation, safe file handling',
  },
};

const JUDGE_SYSTEM = `You are a strict code project evaluator. You evaluate generated codebases against a rubric.

You will receive:
1. The project contract (canonical spec)
2. The complete generated source code (all files)
3. Verification results (if available)
4. A scoring rubric

Your job: evaluate the project and output ONLY a JSON evaluation. No prose.

Output format:
{
  "scores": {
    "completeness": {"score": 0-100, "issues": ["..."]},
    "runnable": {"score": 0-100, "issues": ["..."]},
    "contractAdherence": {"score": 0-100, "issues": ["..."]},
    "codeQuality": {"score": 0-100, "issues": ["..."]},
    "security": {"score": 0-100, "issues": ["..."]}
  },
  "overallScore": 0-100,
  "passed": true/false,
  "summary": "One-paragraph assessment",
  "criticalIssues": ["issues that MUST be fixed"]
}

Rules:
- Score 0-100 for each category.
- "passed" = true only if overallScore >= 70 AND no critical issues exist.
- Be strict: incomplete files, missing entrypoint, broken imports = automatic fail.
- If code has NotImplementedError, TODO placeholders, or truncation = completeness score below 30.`;

/**
 * Runs the judge evaluation on generated artifacts.
 * @param {string} projectDir - Path to the generated project
 * @param {Object} contract - The project contract
 * @param {Object} manifest - The file manifest
 * @param {Object} verification - Verification results (from verifier)
 * @param {Object} config - Pipeline config
 * @returns {{evaluation: Object, usage: Object}}
 */
async function evaluate(projectDir, contract, manifest, verification, config) {
  const model = resolveModel('judge', config.apiKeys, config.judgeModel);
  if (!model) throw new Error('No model available for judge. Set an API key.');

  // Load rubric
  let rubric = DEFAULT_RUBRIC;
  if (config.judgeRubric) {
    try {
      const rubricPath = path.resolve(config.judgeRubric);
      rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf-8'));
    } catch (err) {
      console.log(`[judge] Warning: could not load rubric from ${config.judgeRubric}: ${err.message}`);
    }
  }

  // Read all generated files
  const filesContent = readProjectFiles(projectDir);
  const contractText = contractToPrompt(contract);

  const rubricText = Object.entries(rubric)
    .map(([key, r]) => `${key} (weight: ${r.weight}): ${r.description}`)
    .join('\n');

  const userPrompt = `${contractText}

=== GENERATED FILES ===
${filesContent}

=== VERIFICATION RESULTS ===
${verification ? formatVerification(verification) : 'No verification was run.'}

=== RUBRIC ===
${rubricText}

Evaluate this project now. Output raw JSON only.`;

  if (config.verbose) {
    console.log(`[judge] Using model: ${model.name} (${model.provider})`);
  }

  const result = await callLLM(model.provider, config.apiKeys[model.provider], model.id, [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: userPrompt },
  ], { maxTokens: 4096, temperature: 0.1 });

  let content = result.content.trim();
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  let evaluation;
  try {
    evaluation = JSON.parse(content);
  } catch (err) {
    // If judge output isn't valid JSON, create a failure evaluation
    evaluation = {
      scores: {},
      overallScore: 0,
      passed: false,
      summary: `Judge produced invalid output: ${err.message}`,
      criticalIssues: ['Judge evaluation could not be parsed'],
      rawOutput: content.slice(0, 1000),
    };
  }

  return {
    evaluation,
    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
  };
}

function readProjectFiles(dir) {
  const lines = [];
  const files = walkDir(dir);
  for (const file of files) {
    const rel = path.relative(dir, file);
    const content = fs.readFileSync(file, 'utf-8');
    lines.push(`--- ${rel} ---`);
    lines.push(content);
    lines.push('');
  }
  return lines.join('\n');
}

function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '__pycache__', '.git', 'venv', '.venv'].includes(entry.name)) continue;
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function formatVerification(v) {
  return v.results
    .map(r => `${r.passed ? 'PASS' : 'FAIL'}: ${r.check} — ${r.output}${r.error ? ' | Error: ' + r.error : ''}`)
    .join('\n');
}

/**
 * Formats judge evaluation for display.
 */
function formatEvaluation(evaluation) {
  const lines = [];
  lines.push(`Overall Score: ${evaluation.overallScore}/100 — ${evaluation.passed ? 'PASSED' : 'FAILED'}`);
  lines.push('');

  if (evaluation.scores) {
    for (const [key, val] of Object.entries(evaluation.scores)) {
      lines.push(`  ${key}: ${val.score}/100`);
      if (val.issues && val.issues.length > 0) {
        val.issues.forEach(i => lines.push(`    - ${i}`));
      }
    }
  }

  lines.push('');
  if (evaluation.summary) lines.push(`Summary: ${evaluation.summary}`);
  if (evaluation.criticalIssues && evaluation.criticalIssues.length > 0) {
    lines.push('Critical Issues:');
    evaluation.criticalIssues.forEach(i => lines.push(`  ! ${i}`));
  }

  return lines.join('\n');
}

module.exports = { evaluate, formatEvaluation, DEFAULT_RUBRIC };
