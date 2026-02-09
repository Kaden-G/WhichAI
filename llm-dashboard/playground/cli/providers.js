'use strict';

// ===== Node.js LLM Provider Adapters =====
// Calls OpenAI, Anthropic, Google APIs using global fetch (Node 20+)

const MODEL_MAP = {
  'gpt-4o': { provider: 'openai', id: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', id: 'gpt-4o-mini' },
  'gpt-4.1': { provider: 'openai', id: 'gpt-4.1' },
  'gpt-4.1-mini': { provider: 'openai', id: 'gpt-4.1-mini' },
  'gpt-4.1-nano': { provider: 'openai', id: 'gpt-4.1-nano' },
  'o3': { provider: 'openai', id: 'o3' },
  'o3-mini': { provider: 'openai', id: 'o3-mini' },
  'claude-opus-4-6': { provider: 'anthropic', id: 'claude-opus-4-6' },
  'claude-sonnet-4-5': { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
  'claude-sonnet-4': { provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
  'claude-haiku-4-5': { provider: 'anthropic', id: 'claude-haiku-4-5-20251001' },
  'claude-haiku-3-5': { provider: 'anthropic', id: 'claude-3-5-haiku-20241022' },
  'gemini-2.5-pro': { provider: 'google', id: 'gemini-2.5-pro-preview-06-05' },
  'gemini-2.5-flash': { provider: 'google', id: 'gemini-2.5-flash-preview-05-20' },
  'gemini-2.0-flash': { provider: 'google', id: 'gemini-2.0-flash' },
};

// Preferred models by role
const ROLE_PREFERENCES = {
  planner: ['gpt-4.1-mini', 'gemini-2.5-flash', 'claude-haiku-4-5'],
  generator: ['claude-sonnet-4-5', 'gpt-4.1', 'gemini-2.5-pro'],
  judge: ['claude-sonnet-4-5', 'gpt-4o', 'gemini-2.5-pro'],
};

function resolveModel(role, apiKeys, override = null) {
  if (override && MODEL_MAP[override]) {
    const m = MODEL_MAP[override];
    if (apiKeys[m.provider]) return { name: override, ...m };
  }
  const prefs = ROLE_PREFERENCES[role] || ROLE_PREFERENCES.generator;
  for (const name of prefs) {
    const m = MODEL_MAP[name];
    if (m && apiKeys[m.provider]) return { name, ...m };
  }
  return null;
}

async function callLLM(provider, apiKey, modelId, messages, options = {}) {
  const maxTokens = options.maxTokens || 8192;
  const temperature = options.temperature ?? 0.3;

  if (provider === 'openai') {
    return callOpenAI(apiKey, modelId, messages, maxTokens, temperature);
  }
  if (provider === 'anthropic') {
    return callAnthropic(apiKey, modelId, messages, maxTokens, temperature);
  }
  if (provider === 'google') {
    return callGoogle(apiKey, modelId, messages, maxTokens, temperature);
  }
  throw new Error(`Unknown provider: ${provider}`);
}

async function callOpenAI(apiKey, modelId, messages, maxTokens, temperature) {
  const REASONING = ['o1', 'o3', 'o3-mini'];
  const isReasoning = REASONING.includes(modelId);
  const body = {
    model: modelId,
    messages,
    max_completion_tokens: maxTokens,
  };
  if (!isReasoning) body.temperature = temperature;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`OpenAI error: ${json.error?.message || JSON.stringify(json)}`);
  return {
    content: json.choices?.[0]?.message?.content || '',
    inputTokens: json.usage?.prompt_tokens || 0,
    outputTokens: json.usage?.completion_tokens || 0,
  };
}

async function callAnthropic(apiKey, modelId, messages, maxTokens, temperature) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');
  const body = {
    model: modelId,
    max_tokens: maxTokens,
    messages: nonSystemMsgs,
  };
  if (systemMsgs.length > 0) {
    body.system = systemMsgs.map(m => m.content).join('\n\n');
  }
  if (temperature != null) body.temperature = temperature;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Anthropic error: ${json.error?.message || JSON.stringify(json)}`);
  const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    content: text,
    inputTokens: json.usage?.input_tokens || 0,
    outputTokens: json.usage?.output_tokens || 0,
  };
}

async function callGoogle(apiKey, modelId, messages, maxTokens, temperature) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');
  const contents = nonSystemMsgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemMsgs.length > 0) {
    body.systemInstruction = { parts: [{ text: systemMsgs.map(m => m.content).join('\n\n') }] };
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Google error: ${json.error?.message || JSON.stringify(json)}`);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return {
    content: text,
    inputTokens: json.usageMetadata?.promptTokenCount || 0,
    outputTokens: json.usageMetadata?.candidatesTokenCount || 0,
  };
}

module.exports = { MODEL_MAP, ROLE_PREFERENCES, resolveModel, callLLM };
