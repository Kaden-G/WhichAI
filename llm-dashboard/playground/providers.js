(function () {
  'use strict';

  // ===== Model Name → API ID Mapping =====
  const MODEL_MAP = {
    // OpenAI
    'GPT-4o':              'gpt-4o',
    'GPT-4o-mini':         'gpt-4o-mini',
    'GPT-4.1':             'gpt-4.1',
    'GPT-4.1 Mini':        'gpt-4.1-mini',
    'GPT-4.1 Nano':        'gpt-4.1-nano',
    'o3':                  'o3',
    'o3-mini':             'o3-mini',
    'o1':                  'o1',
    'GPT-5':               'gpt-5',
    'GPT-5 Mini':          'gpt-5-mini',
    'GPT-5 Nano':          'gpt-5-nano',
    // Anthropic
    'Claude Opus 4.6':     'claude-opus-4-6',
    'Claude Opus 4.5':     'claude-opus-4-5-20251022',
    'Claude Sonnet 4.5':   'claude-sonnet-4-5-20250929',
    'Claude Sonnet 4':     'claude-sonnet-4-20250514',
    'Claude Haiku 4.5':    'claude-haiku-4-5-20251001',
    'Claude Haiku 3.5':    'claude-3-5-haiku-20241022',
    // Google
    'Gemini 2.5 Pro':      'gemini-2.5-pro-preview-06-05',
    'Gemini 2.5 Flash':    'gemini-2.5-flash-preview-05-20',
    'Gemini 2.5 Flash-Lite': 'gemini-2.5-flash-lite-preview-06-17',
    'Gemini 2.0 Flash':    'gemini-2.0-flash',
    'Gemini 3 Pro Preview': 'gemini-3-pro-preview',
    'Gemini 3 Flash Preview': 'gemini-3-flash-preview',
  };

  // Provider detection from model display name
  const PROVIDER_FOR_MODEL = {};
  function initProviderMap(models) {
    models.forEach(m => { PROVIDER_FOR_MODEL[m.model] = m.provider; });
  }

  function getProvider(modelName) {
    const p = PROVIDER_FOR_MODEL[modelName];
    if (p === 'OpenAI') return 'openai';
    if (p === 'Anthropic') return 'anthropic';
    if (p === 'Google') return 'google';
    return null;
  }

  function getApiId(modelName) {
    return MODEL_MAP[modelName] || null;
  }

  // ===== Big-3 Providers =====
  const BIG3 = new Set(['OpenAI', 'Anthropic', 'Google']);

  function isBig3(providerName) {
    return BIG3.has(providerName);
  }

  // ===== Adapters =====
  const adapters = {
    openai: {
      buildRequest(apiKey, modelId, messages, options) {
        const body = {
          model: modelId,
          messages: messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 2048,
        };
        if (options.stream) body.stream = true;
        if (options.stream) body.stream_options = { include_usage: true };
        return {
          url: 'https://api.openai.com/v1/chat/completions',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        };
      },
      parseResponse(json) {
        return {
          content: json.choices?.[0]?.message?.content || '',
          inputTokens: json.usage?.prompt_tokens || 0,
          outputTokens: json.usage?.completion_tokens || 0,
        };
      },
      parseStreamChunk(line) {
        if (!line.startsWith('data: ')) return null;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return { content: '', done: true, usage: null };
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          const done = json.choices?.[0]?.finish_reason != null;
          const usage = json.usage ? {
            inputTokens: json.usage.prompt_tokens || 0,
            outputTokens: json.usage.completion_tokens || 0,
          } : null;
          return { content: delta, done, usage };
        } catch { return null; }
      },
    },

    anthropic: {
      buildRequest(apiKey, modelId, messages, options) {
        const systemMsgs = messages.filter(m => m.role === 'system');
        const nonSystemMsgs = messages.filter(m => m.role !== 'system');
        const body = {
          model: modelId,
          max_tokens: options.maxTokens ?? 2048,
          messages: nonSystemMsgs,
        };
        if (systemMsgs.length > 0) {
          body.system = systemMsgs.map(m => m.content).join('\n\n');
        }
        if (options.temperature != null) body.temperature = options.temperature;
        if (options.stream) body.stream = true;
        return {
          url: 'https://api.anthropic.com/v1/messages',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
        };
      },
      parseResponse(json) {
        const text = (json.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');
        return {
          content: text,
          inputTokens: json.usage?.input_tokens || 0,
          outputTokens: json.usage?.output_tokens || 0,
        };
      },
      parseStreamChunk(line) {
        if (!line.startsWith('data: ')) return null;
        const data = line.slice(6).trim();
        try {
          const json = JSON.parse(data);
          if (json.type === 'content_block_delta') {
            return { content: json.delta?.text || '', done: false, usage: null };
          }
          if (json.type === 'message_delta') {
            return {
              content: '',
              done: json.delta?.stop_reason != null,
              usage: json.usage ? {
                inputTokens: json.usage.input_tokens || 0,
                outputTokens: json.usage.output_tokens || 0,
              } : null,
            };
          }
          if (json.type === 'message_start' && json.message?.usage) {
            return {
              content: '',
              done: false,
              usage: { inputTokens: json.message.usage.input_tokens || 0, outputTokens: 0 },
            };
          }
          return null;
        } catch { return null; }
      },
    },

    google: {
      buildRequest(apiKey, modelId, messages, options) {
        const systemMsgs = messages.filter(m => m.role === 'system');
        const nonSystemMsgs = messages.filter(m => m.role !== 'system');
        const contents = nonSystemMsgs.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));
        const body = {
          contents,
          generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.maxTokens ?? 2048,
          },
        };
        if (systemMsgs.length > 0) {
          body.systemInstruction = { parts: [{ text: systemMsgs.map(m => m.content).join('\n\n') }] };
        }
        const method = options.stream ? 'streamGenerateContent' : 'generateContent';
        const streamSuffix = options.stream ? '&alt=sse' : '';
        return {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:${method}?key=${apiKey}${streamSuffix}`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
      },
      parseResponse(json) {
        const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        return {
          content: text,
          inputTokens: json.usageMetadata?.promptTokenCount || 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount || 0,
        };
      },
      parseStreamChunk(line) {
        if (!line.startsWith('data: ')) return null;
        const data = line.slice(6).trim();
        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
          const done = json.candidates?.[0]?.finishReason != null;
          const usage = json.usageMetadata ? {
            inputTokens: json.usageMetadata.promptTokenCount || 0,
            outputTokens: json.usageMetadata.candidatesTokenCount || 0,
          } : null;
          return { content: text, done, usage };
        } catch { return null; }
      },
    },
  };

  // ===== Core Dispatch =====
  const PROXY_URL = 'http://127.0.0.1:8765/proxy';

  async function callModel(provider, apiKey, modelName, messages, options = {}) {
    const adapter = adapters[provider];
    if (!adapter) throw new Error(`Unknown provider: ${provider}`);
    const modelId = getApiId(modelName);
    if (!modelId) throw new Error(`No API mapping for model: ${modelName}`);

    const req = adapter.buildRequest(apiKey, modelId, messages, { ...options, stream: false });

    // Try direct fetch first
    try {
      const resp = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error?.message || JSON.stringify(json));
      return adapter.parseResponse(json);
    } catch (err) {
      // If it looks like a CORS error, retry through proxy
      if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
        const proxyResp = await fetch(PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: req.url, headers: req.headers, body: req.body }),
        });
        const json = await proxyResp.json();
        if (!proxyResp.ok) throw new Error(json.error?.message || json.error || JSON.stringify(json));
        return adapter.parseResponse(json);
      }
      throw err;
    }
  }

  async function callModelStreaming(provider, apiKey, modelName, messages, options = {}, onChunk) {
    const adapter = adapters[provider];
    if (!adapter) throw new Error(`Unknown provider: ${provider}`);
    const modelId = getApiId(modelName);
    if (!modelId) throw new Error(`No API mapping for model: ${modelName}`);

    const req = adapter.buildRequest(apiKey, modelId, messages, { ...options, stream: true });

    let resp;
    try {
      resp = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
      });
    } catch (err) {
      // CORS fallback — proxy doesn't support streaming, fall back to non-streaming
      if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
        const result = await callModel(provider, apiKey, modelName, messages, options);
        onChunk({ content: result.content, done: true, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens } });
        return result;
      }
      throw err;
    }

    if (!resp.ok) {
      const json = await resp.json();
      throw new Error(json.error?.message || JSON.stringify(json));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalUsage = null;
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = adapter.parseStreamChunk(trimmed);
        if (parsed) {
          fullContent += parsed.content;
          if (parsed.usage) finalUsage = parsed.usage;
          onChunk(parsed);
        }
      }
    }

    return {
      content: fullContent,
      inputTokens: finalUsage?.inputTokens || 0,
      outputTokens: finalUsage?.outputTokens || 0,
    };
  }

  async function testApiKey(provider, apiKey) {
    const adapter = adapters[provider];
    if (!adapter) return { ok: false, error: 'Unknown provider' };

    let testModel, messages;
    if (provider === 'openai') {
      testModel = 'GPT-4o-mini';
      messages = [{ role: 'user', content: 'Say "ok"' }];
    } else if (provider === 'anthropic') {
      testModel = 'Claude Haiku 3.5';
      messages = [{ role: 'user', content: 'Say "ok"' }];
    } else if (provider === 'google') {
      testModel = 'Gemini 2.0 Flash';
      messages = [{ role: 'user', content: 'Say "ok"' }];
    }

    try {
      const result = await callModel(provider, apiKey, testModel, messages, { maxTokens: 8 });
      return { ok: true, response: result.content };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ===== Exports =====
  window.Providers = {
    MODEL_MAP,
    BIG3,
    isBig3,
    getProvider,
    getApiId,
    initProviderMap,
    callModel,
    callModelStreaming,
    testApiKey,
    adapters,
  };
})();
