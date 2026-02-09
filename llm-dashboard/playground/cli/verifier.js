'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ===== Verification Gate =====
// Runs local checks on the generated project.
// Modes: none, compile, tests, smoke

/**
 * Runs verification on the generated project directory.
 * @param {string} projectDir - Path to the generated project
 * @param {Object} manifest - The planned manifest
 * @param {Object} config - Pipeline config
 * @returns {{passed: bool, level: string, results: Array<{check, passed, output, error}>}}
 */
function verify(projectDir, manifest, config) {
  const level = config.verify || 'none';
  if (level === 'none') {
    return { passed: true, level, results: [{ check: 'none', passed: true, output: 'Verification skipped' }] };
  }

  const results = [];
  const language = manifest.files?.[0]?.language || detectLanguage(projectDir);

  // Always check: entrypoint exists
  if (manifest.entrypoint) {
    const entryPath = path.join(projectDir, manifest.entrypoint);
    const exists = fs.existsSync(entryPath);
    const size = exists ? fs.statSync(entryPath).size : 0;
    results.push({
      check: 'entrypoint_exists',
      passed: exists && size > 0,
      output: exists ? `${manifest.entrypoint} exists (${size} bytes)` : `${manifest.entrypoint} NOT FOUND`,
    });
  }

  // Always check: all manifest files exist
  const manifestCheck = checkManifestCompleteness(projectDir, manifest);
  results.push(manifestCheck);

  // Compile check
  if (['compile', 'tests', 'smoke'].includes(level)) {
    if (language === 'python') {
      results.push(compilePython(projectDir));
    } else if (['javascript', 'typescript'].includes(language)) {
      results.push(compileNode(projectDir));
    } else {
      results.push({ check: 'compile', passed: true, output: `No compiler check for language: ${language}` });
    }
  }

  // Test check
  if (['tests', 'smoke'].includes(level)) {
    if (language === 'python') {
      results.push(runPythonTests(projectDir));
    } else if (['javascript', 'typescript'].includes(language)) {
      results.push(runNodeTests(projectDir));
    }
  }

  // Smoke check
  if (level === 'smoke') {
    const smokeCmd = config.smokeCommand || manifest.smokeCommand;
    if (smokeCmd) {
      results.push(runSmokeTest(projectDir, smokeCmd));
    } else {
      results.push({ check: 'smoke', passed: false, output: 'No smoke command defined', error: 'Set --smoke-command or include smokeCommand in manifest' });
    }
  }

  const passed = results.every(r => r.passed);

  return { passed, level, results };
}

function checkManifestCompleteness(projectDir, manifest) {
  const missing = [];
  const empty = [];
  if (manifest.files) {
    for (const f of manifest.files) {
      const fp = path.join(projectDir, f.path);
      if (!fs.existsSync(fp)) {
        missing.push(f.path);
      } else if (fs.statSync(fp).size === 0) {
        empty.push(f.path);
      }
    }
  }

  const passed = missing.length === 0 && empty.length === 0;
  let output = `${manifest.files?.length || 0} files planned`;
  if (missing.length > 0) output += `\n  MISSING: ${missing.join(', ')}`;
  if (empty.length > 0) output += `\n  EMPTY: ${empty.join(', ')}`;
  if (passed) output += ' — all present and non-empty';

  return { check: 'manifest_completeness', passed, output };
}

function compilePython(projectDir) {
  try {
    // Find all .py files
    const pyFiles = findFiles(projectDir, '.py');
    if (pyFiles.length === 0) {
      return { check: 'compile_python', passed: true, output: 'No .py files found' };
    }

    const output = execSync(`python3 -m compileall -q "${projectDir}" 2>&1`, {
      timeout: 30000,
      encoding: 'utf-8',
      cwd: projectDir,
    });
    return { check: 'compile_python', passed: true, output: `compileall passed (${pyFiles.length} files)` };
  } catch (err) {
    const stderr = err.stderr || err.stdout || err.message;
    // Parse which file failed
    const fileMatch = stderr.match(/File "([^"]+)", line (\d+)/);
    let diagnosis = stderr.slice(0, 500);
    if (fileMatch) {
      diagnosis = `${fileMatch[1]}:${fileMatch[2]} — ${stderr.split('\n').pop()}`;
    }
    return { check: 'compile_python', passed: false, output: 'compileall FAILED', error: diagnosis };
  }
}

function compileNode(projectDir) {
  try {
    const jsFiles = findFiles(projectDir, '.js');
    if (jsFiles.length === 0) {
      return { check: 'compile_node', passed: true, output: 'No .js files found' };
    }

    const errors = [];
    for (const file of jsFiles) {
      try {
        execSync(`node --check "${file}" 2>&1`, { timeout: 10000, encoding: 'utf-8' });
      } catch (e) {
        errors.push(`${path.relative(projectDir, file)}: ${(e.stderr || e.message).trim()}`);
      }
    }

    if (errors.length > 0) {
      return { check: 'compile_node', passed: false, output: `${errors.length} file(s) failed syntax check`, error: errors.join('\n') };
    }
    return { check: 'compile_node', passed: true, output: `node --check passed (${jsFiles.length} files)` };
  } catch (err) {
    return { check: 'compile_node', passed: false, output: 'Syntax check failed', error: err.message };
  }
}

function runPythonTests(projectDir) {
  // Check if pytest/unittest tests exist
  const testFiles = findFiles(projectDir, '.py').filter(f => {
    const base = path.basename(f);
    return base.startsWith('test_') || base.endsWith('_test.py');
  });

  if (testFiles.length === 0) {
    return { check: 'tests_python', passed: true, output: 'No test files found (skipped)' };
  }

  try {
    const output = execSync(`python3 -m pytest "${projectDir}" --tb=short -q 2>&1`, {
      timeout: 60000,
      encoding: 'utf-8',
      cwd: projectDir,
    });
    return { check: 'tests_python', passed: true, output: output.trim().split('\n').slice(-3).join('\n') };
  } catch (err) {
    const stderr = (err.stdout || '') + (err.stderr || '');
    return { check: 'tests_python', passed: false, output: 'pytest FAILED', error: stderr.slice(0, 1000) };
  }
}

function runNodeTests(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { check: 'tests_node', passed: true, output: 'No package.json found (skipped)' };
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (!pkg.scripts?.test || pkg.scripts.test.includes('no test specified')) {
      return { check: 'tests_node', passed: true, output: 'No test script defined (skipped)' };
    }

    const output = execSync('npm test 2>&1', {
      timeout: 60000,
      encoding: 'utf-8',
      cwd: projectDir,
    });
    return { check: 'tests_node', passed: true, output: output.trim().split('\n').slice(-5).join('\n') };
  } catch (err) {
    return { check: 'tests_node', passed: false, output: 'npm test FAILED', error: (err.stdout || err.message).slice(0, 1000) };
  }
}

function runSmokeTest(projectDir, command) {
  try {
    const output = execSync(command + ' 2>&1', {
      timeout: 30000,
      encoding: 'utf-8',
      cwd: projectDir,
    });
    return { check: 'smoke', passed: true, output: `Smoke command succeeded:\n${output.trim().slice(0, 500)}` };
  } catch (err) {
    return { check: 'smoke', passed: false, output: 'Smoke test FAILED', error: (err.stderr || err.stdout || err.message).slice(0, 500) };
  }
}

function detectLanguage(dir) {
  if (findFiles(dir, '.py').length > 0) return 'python';
  if (findFiles(dir, '.js').length > 0) return 'javascript';
  if (findFiles(dir, '.ts').length > 0) return 'typescript';
  if (findFiles(dir, '.go').length > 0) return 'go';
  if (findFiles(dir, '.rs').length > 0) return 'rust';
  return 'unknown';
}

function findFiles(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '__pycache__', '.git', 'venv', '.venv'].includes(entry.name)) continue;
      results.push(...findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Formats verification results for display.
 */
function formatResults(verification) {
  const lines = [];
  lines.push(`Verification Level: ${verification.level}`);
  lines.push(`Overall: ${verification.passed ? 'PASSED' : 'FAILED'}`);
  lines.push('');

  for (const r of verification.results) {
    const icon = r.passed ? '\u2705' : '\u274C';
    lines.push(`${icon} ${r.check}: ${r.output}`);
    if (r.error) {
      lines.push(`   Error: ${r.error}`);
    }
  }

  return lines.join('\n');
}

module.exports = { verify, formatResults };
