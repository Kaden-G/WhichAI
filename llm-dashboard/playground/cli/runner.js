'use strict';

const { createContract, contractToPrompt, validateAgainstContract } = require('./contracts');
const { planManifest } = require('./planner');
const { generateFiles } = require('./generator');
const { assemble } = require('./assembler');
const { verify, formatResults } = require('./verifier');
const { evaluate, formatEvaluation } = require('./judge');

// ===== Pipeline Runner =====
// Orchestrates: Plan → Generate → Assemble → Verify → Judge

/**
 * Runs the full pipeline.
 * @param {Object} spec - Project specification
 * @param {Object} config - Pipeline config (from config.js)
 * @returns {{success: bool, outputPath: string, summary: Object}}
 */
async function runPipeline(spec, config) {
  const startTime = Date.now();
  const log = config.verbose ? console.log.bind(console) : () => {};

  const result = {
    success: false,
    outputPath: null,
    summary: {
      stages: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTime: 0,
    },
  };

  try {
    // === Stage 0: Create Contract ===
    log('\n=== Stage 0: Contract Creation ===');
    const contract = createContract(spec);
    log(`Contract: ${contract.projectName} (${contract.language})`);
    if (contract.entrypoint) log(`  Entrypoint: ${contract.entrypoint}`);
    if (contract.cliSignature) log(`  CLI: ${contract.cliSignature}`);
    result.summary.contract = contract;

    // === Stage 1: Plan File Manifest ===
    log('\n=== Stage 1: Planning File Manifest ===');
    const { manifest, usage: planUsage } = await planManifest(spec.description || JSON.stringify(spec), contract, config);
    result.summary.totalInputTokens += planUsage.inputTokens;
    result.summary.totalOutputTokens += planUsage.outputTokens;
    result.summary.stages.push({
      name: 'planner',
      filesPlanned: manifest.files.length,
      usage: planUsage,
    });
    log(`Manifest: ${manifest.files.length} files, entrypoint: ${manifest.entrypoint}`);

    // Merge manifest entrypoint into contract if not set
    if (!contract.entrypoint && manifest.entrypoint) {
      contract.entrypoint = manifest.entrypoint;
    }

    // === Stage 2: Generate Files (multi-call chunked) ===
    log('\n=== Stage 2: Generating Files ===');
    const { files: generatedFiles, usage: genUsage } = await generateFiles(
      spec.description || JSON.stringify(spec),
      contract,
      manifest,
      config,
      (msg) => log(`  ${msg}`)
    );
    result.summary.totalInputTokens += genUsage.inputTokens;
    result.summary.totalOutputTokens += genUsage.outputTokens;
    result.summary.stages.push({
      name: 'generator',
      filesGenerated: generatedFiles.length,
      usage: genUsage,
    });
    log(`Generated: ${generatedFiles.length} files`);

    // === Stage 2.5: Contract Validation ===
    log('\n=== Stage 2.5: Contract Validation ===');
    const contractValidation = validateAgainstContract(contract, generatedFiles);
    if (!contractValidation.valid) {
      log(`Contract issues (${contractValidation.issues.length}):`);
      contractValidation.issues.forEach(i => log(`  - ${i}`));
    } else {
      log('Contract validation: PASSED');
    }
    result.summary.stages.push({
      name: 'contract_validation',
      valid: contractValidation.valid,
      issues: contractValidation.issues,
    });

    // === Stage 3: Assemble to Disk ===
    log('\n=== Stage 3: Assembling Output ===');
    const assembly = assemble(generatedFiles, manifest, config);
    result.outputPath = assembly.outputPath;
    result.summary.stages.push({
      name: 'assembler',
      outputPath: assembly.outputPath,
      filesWritten: assembly.filesWritten,
      issues: assembly.issues,
    });
    log(`Output: ${assembly.outputPath} (${assembly.filesWritten} files written)`);
    if (assembly.issues.length > 0) {
      log(`Assembly issues (${assembly.issues.length}):`);
      assembly.issues.forEach(i => log(`  - ${i}`));
    }

    // === Stage 4: Verification Gate ===
    log('\n=== Stage 4: Verification ===');
    let verification = null;
    if (config.verify !== 'none' && config.outputFormat === 'repo_on_disk') {
      verification = verify(assembly.outputPath, manifest, config);
      result.summary.stages.push({
        name: 'verifier',
        level: verification.level,
        passed: verification.passed,
        results: verification.results,
      });
      log(formatResults(verification));

      if (!verification.passed) {
        result.success = false;
        result.summary.verificationPassed = false;
        console.error('\n=== PIPELINE FAILED: Verification gate did not pass ===');
        console.error(formatResults(verification));
      }
    } else {
      log(`Verification: skipped (level=${config.verify}, format=${config.outputFormat})`);
      result.summary.stages.push({ name: 'verifier', level: 'none', passed: true });
    }

    // === Stage 5: Judge (optional) ===
    let judgeResult = null;
    if (config.enableJudge) {
      log('\n=== Stage 5: Judge Evaluation ===');
      const { evaluation, usage: judgeUsage } = await evaluate(
        assembly.outputPath, contract, manifest, verification, config
      );
      result.summary.totalInputTokens += judgeUsage.inputTokens;
      result.summary.totalOutputTokens += judgeUsage.outputTokens;
      result.summary.stages.push({
        name: 'judge',
        evaluation,
        usage: judgeUsage,
      });
      judgeResult = evaluation;
      log(formatEvaluation(evaluation));

      if (!evaluation.passed) {
        result.success = false;
        console.error('\n=== PIPELINE FAILED: Judge evaluation did not pass ===');
      }
    }

    // === Determine overall success ===
    const verifyPassed = !verification || verification.passed;
    const judgePassed = !judgeResult || judgeResult.passed;
    const assemblyClean = assembly.issues.filter(i => i.startsWith('MISSING')).length === 0;

    result.success = verifyPassed && judgePassed && assemblyClean;
    result.summary.totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // === Final Summary ===
    log('\n' + '='.repeat(60));
    log(`Pipeline ${result.success ? 'SUCCEEDED' : 'FAILED'}`);
    log(`Output: ${result.outputPath}`);
    log(`Files: ${assembly.filesWritten} written`);
    log(`Tokens: ${result.summary.totalInputTokens.toLocaleString()} in / ${result.summary.totalOutputTokens.toLocaleString()} out`);
    log(`Time: ${result.summary.totalTime}s`);
    log('='.repeat(60));

  } catch (err) {
    result.success = false;
    result.error = err.message;
    console.error(`\nPipeline error: ${err.message}`);
    if (config.verbose) console.error(err.stack);
  }

  return result;
}

module.exports = { runPipeline };
