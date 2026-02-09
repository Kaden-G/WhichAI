#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('./config');
const { runPipeline } = require('./runner');

// ===== CLI Entry Point =====

const options = {
  'spec': { type: 'string', short: 's' },
  'output-dir': { type: 'string', short: 'o' },
  'output-format': { type: 'string', default: 'repo_on_disk' },
  'max-output-tokens': { type: 'string' },
  'max-context-tokens': { type: 'string' },
  'chunking-strategy': { type: 'string' },
  'verify': { type: 'string', short: 'v' },
  'smoke-command': { type: 'string' },
  'enable-judge': { type: 'boolean', default: false },
  'judge-rubric': { type: 'string' },
  'planner-model': { type: 'string' },
  'generator-model': { type: 'string' },
  'judge-model': { type: 'string' },
  'temperature': { type: 'string' },
  'verbose': { type: 'boolean', default: false },
  'help': { type: 'boolean', short: 'h', default: false },
  'test': { type: 'string', short: 't' },
};

function printUsage() {
  console.log(`
WhichAI Pipeline CLI — Reliable code generation with verification

USAGE:
  node pipeline-cli.js --spec <spec.json> --output-dir <dir> [options]
  node pipeline-cli.js --test email-dashboard [options]

REQUIRED:
  -s, --spec <path>           Path to project spec JSON file
  -o, --output-dir <dir>      Output directory for generated project

TOKENS & CHUNKING:
  --max-output-tokens <n>     Max output tokens per LLM call (default: 8192)
  --max-context-tokens <n>    Max context tokens (default: 128000)
  --chunking-strategy <s>     by_file | by_module | by_token_estimate (default: by_file)

OUTPUT:
  --output-format <f>         repo_on_disk | filepack_json | zip (default: repo_on_disk)

VERIFICATION:
  -v, --verify <level>        none | compile | tests | smoke (default: compile)
  --smoke-command <cmd>       Command for smoke testing

JUDGE:
  --enable-judge              Enable LLM-based evaluation
  --judge-rubric <path>       Custom rubric JSON file

MODELS:
  --planner-model <id>        Override planner model (e.g., gpt-4.1-mini)
  --generator-model <id>      Override generator model (e.g., claude-sonnet-4-5)
  --judge-model <id>          Override judge model
  --temperature <n>           Generation temperature (default: 0.3)

OTHER:
  --verbose                   Verbose output
  -h, --help                  Show this help
  -t, --test <fixture>        Run a built-in test fixture (e.g., email-dashboard)

ENVIRONMENT VARIABLES:
  OPENAI_API_KEY              OpenAI API key
  ANTHROPIC_API_KEY           Anthropic API key
  GOOGLE_API_KEY              Google API key
  PIPELINE_MAX_OUTPUT_TOKENS  Override max output tokens
  PIPELINE_MAX_CONTEXT_TOKENS Override max context tokens

EXAMPLES:
  # Generate a project from a spec file
  node pipeline-cli.js -s myproject.json -o ./output --verbose

  # Generate with judge evaluation and custom token budget
  node pipeline-cli.js -s spec.json -o ./out --enable-judge --max-output-tokens 16384

  # Run built-in email dashboard test
  node pipeline-cli.js --test email-dashboard -o /tmp/email-test --verify compile --verbose

  # Generate as ZIP
  node pipeline-cli.js -s spec.json -o ./out --output-format zip
`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: true });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    printUsage();
    process.exit(1);
  }

  const args = parsed.values;

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // Load spec — either from file or test fixture
  let spec;
  if (args.test) {
    const fixturePath = path.join(__dirname, 'fixtures', `${args.test}.json`);
    if (!fs.existsSync(fixturePath)) {
      console.error(`Test fixture not found: ${fixturePath}`);
      console.error(`Available fixtures: ${listFixtures().join(', ') || 'none'}`);
      process.exit(1);
    }
    spec = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    console.log(`Loaded test fixture: ${args.test}`);

    // Default output dir for tests
    if (!args['output-dir']) {
      const os = require('node:os');
      args['output-dir'] = path.join(os.tmpdir(), `pipeline-test-${args.test}-${Date.now()}`);
      console.log(`Output dir (auto): ${args['output-dir']}`);
    }
  } else if (args.spec) {
    const specPath = path.resolve(args.spec);
    if (!fs.existsSync(specPath)) {
      console.error(`Spec file not found: ${specPath}`);
      process.exit(1);
    }
    spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
  } else {
    console.error('Error: --spec or --test is required');
    printUsage();
    process.exit(1);
  }

  // Build config
  const cliConfig = {};
  if (args['output-dir']) cliConfig.outputDir = args['output-dir'];
  if (args['output-format']) cliConfig.outputFormat = args['output-format'];
  if (args['max-output-tokens']) cliConfig.maxOutputTokens = parseInt(args['max-output-tokens']);
  if (args['max-context-tokens']) cliConfig.maxContextTokens = parseInt(args['max-context-tokens']);
  if (args['chunking-strategy']) cliConfig.chunkingStrategy = args['chunking-strategy'];
  if (args['verify']) cliConfig.verify = args['verify'];
  if (args['smoke-command']) cliConfig.smokeCommand = args['smoke-command'];
  if (args['enable-judge']) cliConfig.enableJudge = true;
  if (args['judge-rubric']) cliConfig.judgeRubric = args['judge-rubric'];
  if (args['planner-model']) cliConfig.plannerModel = args['planner-model'];
  if (args['generator-model']) cliConfig.generatorModel = args['generator-model'];
  if (args['judge-model']) cliConfig.judgeModel = args['judge-model'];
  if (args['temperature']) cliConfig.temperature = parseFloat(args['temperature']);
  if (args['verbose']) cliConfig.verbose = true;

  const config = loadConfig(cliConfig);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  // Run pipeline
  console.log('\n' + '='.repeat(60));
  console.log('WhichAI Pipeline CLI');
  console.log('='.repeat(60));
  console.log(`Project: ${spec.projectName || 'unnamed'}`);
  console.log(`Output: ${config.outputDir} (${config.outputFormat})`);
  console.log(`Tokens: max_output=${config.maxOutputTokens}, max_context=${config.maxContextTokens}`);
  console.log(`Chunking: ${config.chunkingStrategy}`);
  console.log(`Verify: ${config.verify}`);
  console.log(`Judge: ${config.enableJudge ? 'enabled' : 'disabled'}`);
  console.log('='.repeat(60));

  const result = await runPipeline(spec, config);

  // Final output
  console.log('\n' + '='.repeat(60));
  console.log(`RESULT: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  console.log(`Output: ${result.outputPath || 'N/A'}`);
  if (result.error) console.log(`Error: ${result.error}`);
  console.log('='.repeat(60));

  process.exit(result.success ? 0 : 1);
}

function listFixtures() {
  const fixturesDir = path.join(__dirname, 'fixtures');
  if (!fs.existsSync(fixturesDir)) return [];
  return fs.readdirSync(fixturesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  if (process.env.PIPELINE_VERBOSE) console.error(err.stack);
  process.exit(1);
});
