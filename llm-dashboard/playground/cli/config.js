'use strict';

// ===== Central Configuration =====
// Priority: CLI flags > env vars > defaults

const DEFAULTS = {
  maxOutputTokens: 16384,
  maxContextTokens: 128000,
  chunkingStrategy: 'by_file',      // 'by_file' | 'by_module' | 'by_token_estimate'
  outputFormat: 'repo_on_disk',     // 'repo_on_disk' | 'filepack_json' | 'zip'
  outputDir: null,                  // Required when outputFormat=repo_on_disk
  verify: 'compile',               // 'none' | 'compile' | 'tests' | 'smoke'
  smokeCommand: null,              // Custom smoke test command
  enableJudge: false,
  judgeRubric: null,               // Path to rubric JSON
  plannerModel: null,              // Auto-select if null
  generatorModel: null,
  judgeModel: null,
  temperature: 0.3,
  verbose: false,
};

const ENV_MAP = {
  PIPELINE_MAX_OUTPUT_TOKENS: { key: 'maxOutputTokens', type: 'int' },
  PIPELINE_MAX_CONTEXT_TOKENS: { key: 'maxContextTokens', type: 'int' },
  PIPELINE_CHUNKING_STRATEGY: { key: 'chunkingStrategy', type: 'string' },
  PIPELINE_OUTPUT_FORMAT: { key: 'outputFormat', type: 'string' },
  PIPELINE_OUTPUT_DIR: { key: 'outputDir', type: 'string' },
  PIPELINE_VERIFY: { key: 'verify', type: 'string' },
  PIPELINE_ENABLE_JUDGE: { key: 'enableJudge', type: 'bool' },
  OPENAI_API_KEY: { key: '_openaiKey', type: 'string' },
  ANTHROPIC_API_KEY: { key: '_anthropicKey', type: 'string' },
  GOOGLE_API_KEY: { key: '_googleKey', type: 'string' },
};

function loadConfig(cliArgs = {}) {
  const config = { ...DEFAULTS };

  // Apply env var overrides
  for (const [envName, { key, type }] of Object.entries(ENV_MAP)) {
    const val = process.env[envName];
    if (val === undefined) continue;
    if (type === 'int') config[key] = parseInt(val, 10);
    else if (type === 'bool') config[key] = val === 'true' || val === '1';
    else config[key] = val;
  }

  // Apply CLI overrides (highest priority)
  for (const [k, v] of Object.entries(cliArgs)) {
    if (v !== undefined && v !== null) config[k] = v;
  }

  // Build API keys object
  config.apiKeys = {
    openai: config._openaiKey || process.env.OPENAI_API_KEY || '',
    anthropic: config._anthropicKey || process.env.ANTHROPIC_API_KEY || '',
    google: config._googleKey || process.env.GOOGLE_API_KEY || '',
  };
  delete config._openaiKey;
  delete config._anthropicKey;
  delete config._googleKey;

  return config;
}

function validateConfig(config) {
  const errors = [];

  if (config.outputFormat === 'repo_on_disk' && !config.outputDir) {
    errors.push('--output-dir is required when output-format is repo_on_disk');
  }
  if (config.verify === 'smoke' && !config.smokeCommand) {
    errors.push('--smoke-command is required when verify is smoke');
  }
  if (!config.apiKeys.openai && !config.apiKeys.anthropic && !config.apiKeys.google) {
    errors.push('At least one API key required. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY.');
  }

  const validFormats = ['repo_on_disk', 'filepack_json', 'zip'];
  if (!validFormats.includes(config.outputFormat)) {
    errors.push(`Invalid output-format: ${config.outputFormat}. Must be one of: ${validFormats.join(', ')}`);
  }

  const validVerify = ['none', 'compile', 'tests', 'smoke'];
  if (!validVerify.includes(config.verify)) {
    errors.push(`Invalid verify: ${config.verify}. Must be one of: ${validVerify.join(', ')}`);
  }

  const validChunking = ['by_file', 'by_module', 'by_token_estimate'];
  if (!validChunking.includes(config.chunkingStrategy)) {
    errors.push(`Invalid chunking-strategy: ${config.chunkingStrategy}. Must be one of: ${validChunking.join(', ')}`);
  }

  return errors;
}

module.exports = { DEFAULTS, loadConfig, validateConfig };
