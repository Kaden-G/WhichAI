'use strict';

// ===== Interface Consistency Contracts =====
// Defines canonical schemas for generated projects.
// All pipeline stages reference the same contract.

/**
 * Creates a contract from a project spec.
 * The contract defines the canonical interface that all stages must respect.
 */
function createContract(spec) {
  return {
    projectName: spec.projectName || 'unnamed-project',
    language: spec.language || 'python',
    entrypoint: spec.entrypoint || null,
    cliSignature: spec.cliSignature || null,
    inputFormat: spec.inputFormat || null,
    outputFormat: spec.outputFormat || null,
    dependencies: spec.dependencies || [],
    constraints: spec.constraints || [],
    // Frozen at creation — stages cannot redefine these
    _frozen: true,
  };
}

/**
 * Serializes a contract for inclusion in LLM prompts.
 * This text is prepended to every stage to enforce consistency.
 */
function contractToPrompt(contract) {
  const lines = [
    '=== PROJECT CONTRACT (all stages MUST follow this exactly) ===',
    `Project: ${contract.projectName}`,
    `Language: ${contract.language}`,
  ];

  if (contract.entrypoint) {
    lines.push(`Entrypoint: ${contract.entrypoint}`);
  }
  if (contract.cliSignature) {
    lines.push(`CLI Signature: ${contract.cliSignature}`);
  }
  if (contract.inputFormat) {
    lines.push(`Input Format: ${contract.inputFormat}`);
  }
  if (contract.outputFormat) {
    lines.push(`Output Format: ${contract.outputFormat}`);
  }
  if (contract.dependencies.length > 0) {
    lines.push(`Dependencies: ${contract.dependencies.join(', ')}`);
  }
  if (contract.constraints.length > 0) {
    lines.push('Constraints:');
    contract.constraints.forEach(c => lines.push(`  - ${c}`));
  }

  lines.push('=== END CONTRACT ===');
  lines.push('');
  lines.push('IMPORTANT: The entrypoint, CLI signature, input/output formats above are CANONICAL.');
  lines.push('Do NOT change, rename, or redefine them. All files must reference these exactly.');

  return lines.join('\n');
}

/**
 * Validates generated output against the contract.
 * Returns {valid: bool, issues: string[]}
 */
function validateAgainstContract(contract, files) {
  const issues = [];

  // Check entrypoint exists
  if (contract.entrypoint) {
    const entryFile = files.find(f =>
      f.path === contract.entrypoint ||
      f.path.endsWith('/' + contract.entrypoint) ||
      f.path.endsWith(contract.entrypoint)
    );
    if (!entryFile) {
      issues.push(`Contract violation: entrypoint "${contract.entrypoint}" not found in generated files`);
    } else if (!entryFile.content || entryFile.content.trim().length === 0) {
      issues.push(`Contract violation: entrypoint "${contract.entrypoint}" is empty`);
    }
  }

  // Check CLI signature is referenced in entrypoint
  if (contract.cliSignature && contract.entrypoint) {
    const entryFile = files.find(f =>
      f.path === contract.entrypoint ||
      f.path.endsWith('/' + contract.entrypoint)
    );
    if (entryFile && entryFile.content) {
      // Check that argparse/click/fire references exist
      const cliKeywords = ['argparse', 'click', 'fire', 'sys.argv', 'ArgumentParser', 'yargs', 'commander', 'meow'];
      const hasCliSetup = cliKeywords.some(kw => entryFile.content.includes(kw));
      if (!hasCliSetup && contract.cliSignature.includes('--')) {
        issues.push(`Contract violation: entrypoint does not appear to set up CLI argument parsing for: ${contract.cliSignature}`);
      }
    }
  }

  // Check all files are non-empty
  for (const file of files) {
    if (!file.content || file.content.trim().length === 0) {
      issues.push(`Empty file: ${file.path}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

module.exports = { createContract, contractToPrompt, validateAgainstContract };
