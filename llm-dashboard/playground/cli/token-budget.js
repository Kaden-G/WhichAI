'use strict';

// ===== Token Estimation & Budgeting =====
// Rough heuristic: ~4 chars per token (works for English code)

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateFileTokens(estimatedLines, forJsonOutput = true) {
  // Average line ~40 chars = ~10 tokens
  const base = estimatedLines * 10;
  // JSON wrapping inflates size: \n→\\n, "→\", plus wrapper overhead
  return forJsonOutput ? Math.ceil(base * 1.6) : base;
}

function willExceedBudget(text, maxTokens) {
  return estimateTokens(text) > maxTokens;
}

/**
 * Groups file manifest entries into chunks that fit within token budget.
 * @param {Array} files - [{path, purpose, estimatedLines, language}]
 * @param {number} maxTokensPerChunk - Max output tokens per LLM call
 * @param {string} strategy - 'by_file' | 'by_module' | 'by_token_estimate'
 * @returns {Array<Array>} chunks of files
 */
function chunkFiles(files, maxTokensPerChunk, strategy = 'by_file') {
  if (strategy === 'by_module') {
    return chunkByModule(files, maxTokensPerChunk);
  }
  if (strategy === 'by_token_estimate') {
    return chunkByTokenEstimate(files, maxTokensPerChunk);
  }
  // Default: by_file — each large file gets its own chunk, small files grouped
  return chunkByFile(files, maxTokensPerChunk);
}

function chunkByFile(files, maxTokensPerChunk) {
  const chunks = [];
  let current = [];
  let currentEst = 0;

  // Sort by estimated size descending so large files get isolated
  const sorted = [...files].sort((a, b) => (b.estimatedLines || 50) - (a.estimatedLines || 50));

  for (const file of sorted) {
    const est = estimateFileTokens(file.estimatedLines || 50);

    // If single file exceeds budget, it gets its own chunk (will need multi-call for this file)
    if (est > maxTokensPerChunk) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentEst = 0;
      }
      chunks.push([file]);
      continue;
    }

    if (currentEst + est > maxTokensPerChunk && current.length > 0) {
      chunks.push(current);
      current = [];
      currentEst = 0;
    }

    current.push(file);
    currentEst += est;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function chunkByModule(files, maxTokensPerChunk) {
  // Group by top-level directory
  const groups = {};
  for (const file of files) {
    const parts = file.path.split('/');
    const module = parts.length > 1 ? parts[0] : '__root__';
    if (!groups[module]) groups[module] = [];
    groups[module].push(file);
  }

  const chunks = [];
  for (const [, moduleFiles] of Object.entries(groups)) {
    const subChunks = chunkByFile(moduleFiles, maxTokensPerChunk);
    chunks.push(...subChunks);
  }
  return chunks;
}

function chunkByTokenEstimate(files, maxTokensPerChunk) {
  // Strictly bin-pack by token estimate
  const chunks = [];
  let current = [];
  let currentEst = 0;

  for (const file of files) {
    const est = estimateFileTokens(file.estimatedLines || 50);
    if (currentEst + est > maxTokensPerChunk && current.length > 0) {
      chunks.push(current);
      current = [];
      currentEst = 0;
    }
    current.push(file);
    currentEst += est;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Checks if content shows signs of truncation.
 * Returns array of issues found.
 */
function detectTruncation(content) {
  const issues = [];
  const patterns = [
    { re: /\.{3}\s*$/m, msg: 'Trailing "..." suggests truncation' },
    { re: /\[rest of (code|file|implementation|function)\]/i, msg: 'Placeholder "[rest of ...]" found' },
    { re: /\[truncated\]/i, msg: '"[truncated]" marker' },
    { re: /\[continued\]/i, msg: '"[continued]" marker' },
    { re: /#\s*TODO:?\s*(implement|add|complete|finish)/i, msg: 'TODO placeholder' },
    { re: /pass\s+#\s*(TODO|placeholder|implement)/i, msg: '"pass # TODO" placeholder' },
    { re: /raise NotImplementedError/, msg: 'NotImplementedError stub' },
  ];

  for (const { re, msg } of patterns) {
    if (re.test(content)) issues.push(msg);
  }

  // Check for unterminated structures
  const openBraces = (content.match(/\{/g) || []).length;
  const closeBraces = (content.match(/\}/g) || []).length;
  if (openBraces > closeBraces + 2) {
    issues.push(`Unbalanced braces: ${openBraces} open vs ${closeBraces} close`);
  }

  const openParens = (content.match(/\(/g) || []).length;
  const closeParens = (content.match(/\)/g) || []).length;
  if (openParens > closeParens + 3) {
    issues.push(`Unbalanced parentheses: ${openParens} open vs ${closeParens} close`);
  }

  return issues;
}

module.exports = {
  estimateTokens,
  estimateFileTokens,
  willExceedBudget,
  chunkFiles,
  detectTruncation,
};
