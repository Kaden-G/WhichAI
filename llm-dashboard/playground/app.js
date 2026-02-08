(function () {
  'use strict';

  // ===== State =====
  let DATA = null;
  let allModels = [];
  let blendMode = 'simple';

  // Keys (session-only by default)
  let apiKeys = { openai: '', anthropic: '', google: '' };
  let rememberKeys = false;

  // Conversation
  let conversationMode = false;
  let messageHistory = []; // {role, content}
  let isStreaming = false;
  let isPipelineRunning = false;

  // Cost tracking
  let sessionCost = 0;
  let sessionBreakdown = []; // {model, inputTokens, outputTokens, cost, timestamp}

  // Current recommendation
  let recommendedModel = null;

  const USE_CASE_LABELS = {
    coding: 'Coding',
    reasoning: 'Reasoning',
    classification: 'Classification',
    extraction: 'Extraction',
    summarization: 'Summarization',
    math: 'Math & Science',
    creative: 'Creative Writing',
    translation: 'Translation',
    data_labeling: 'Data Labeling',
    synthetic_data: 'Synthetic Data',
    rag_agents: 'RAG / Agents',
    feature_engineering: 'Feature Engineering',
  };

  // ===== Prompt → Use Case Classifier =====
  const USE_CASE_KEYWORDS = {
    coding: ['code', 'function', 'bug', 'debug', 'refactor', 'implement', 'program', 'script', 'api', 'class', 'method', 'variable', 'compile', 'syntax', 'unit test', 'pull request', 'git', 'commit', 'deploy', 'backend', 'frontend', 'database', 'sql', 'html', 'css', 'javascript', 'python', 'java', 'rust', 'typescript', 'react', 'node', 'django', 'flask', 'algorithm', 'data structure', 'regex', 'lint', 'test'],
    reasoning: ['analyze', 'pros and cons', 'compare', 'evaluate', 'argue', 'justify', 'logic', 'reasoning', 'think through', 'trade-off', 'tradeoff', 'decision', 'strategy', 'root cause', 'why did', 'explain why', 'implications', 'consequences', 'critical thinking', 'debate'],
    classification: ['classify', 'categorize', 'label', 'sentiment', 'intent', 'detect', 'identify type', 'sort into', 'which category', 'positive or negative', 'spam', 'topic classification', 'is this'],
    extraction: ['extract', 'parse', 'pull out', 'find all', 'identify entities', 'ner', 'named entity', 'structured data', 'json from', 'scrape', 'get the', 'list all', 'key information'],
    summarization: ['summarize', 'summary', 'tldr', 'brief', 'condense', 'key points', 'main ideas', 'executive summary', 'meeting notes', 'digest', 'overview', 'recap', 'shorten'],
    math: ['calculate', 'solve', 'equation', 'formula', 'math', 'integral', 'derivative', 'statistics', 'probability', 'algebra', 'geometry', 'calculus', 'proof', 'theorem', 'compute', 'percentage', 'average', 'median', 'standard deviation'],
    creative: ['write a story', 'write a poem', 'blog post', 'essay', 'creative', 'draft an email', 'write an email', 'marketing copy', 'tagline', 'slogan', 'narrative', 'fiction', 'compose', 'rewrite', 'tone', 'engaging', 'catchy', 'persuasive', 'write a letter', 'article'],
    translation: ['translate', 'translation', 'in spanish', 'in french', 'in german', 'in japanese', 'in chinese', 'in korean', 'in portuguese', 'in italian', 'in arabic', 'to english', 'from english', 'multilingual', 'localize', 'localization'],
    data_labeling: ['label data', 'annotate', 'annotation', 'labeling', 'tag data', 'training data label', 'ground truth', 'inter-annotator'],
    synthetic_data: ['generate data', 'synthetic', 'fake data', 'test data', 'mock data', 'sample data', 'augment data', 'data augmentation', 'generate examples', 'create dataset'],
    rag_agents: ['rag', 'retrieval', 'agent', 'tool use', 'tool call', 'function calling', 'search and answer', 'knowledge base', 'grounded', 'context documents', 'cite sources', 'agentic'],
    feature_engineering: ['feature engineer', 'feature extraction', 'feature selection', 'transform features', 'create features', 'feature importance', 'ml pipeline', 'preprocessing', 'encode categorical', 'normalization'],
  };

  let autoClassifyTimeout = null;

  function classifyPrompt(text) {
    if (!text || text.length < 10) return null;
    const lower = text.toLowerCase();
    const scores = {};
    for (const [useCase, keywords] of Object.entries(USE_CASE_KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score++;
      }
      if (score > 0) scores[useCase] = score;
    }
    if (Object.keys(scores).length === 0) return null;
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }

  function autoClassifyAndUpdate() {
    const systemText = document.getElementById('system-prompt').value;
    const userText = document.getElementById('user-prompt').value;
    const combined = systemText + ' ' + userText;
    const detected = classifyPrompt(combined);
    const indicator = document.getElementById('detected-usecase');
    if (detected) {
      const sel = document.getElementById('select-usecase');
      if (sel.value !== detected) {
        sel.value = detected;
        populateModels(detected);
      }
      indicator.style.display = 'flex';
      document.getElementById('detected-usecase-name').textContent = USE_CASE_LABELS[detected];
    } else {
      indicator.style.display = 'none';
    }
  }

  function debouncedAutoClassify() {
    clearTimeout(autoClassifyTimeout);
    autoClassifyTimeout = setTimeout(autoClassifyAndUpdate, 400);
  }

  // ===== Pareto Logic (ported from dashboard) =====
  function blendedCost(m) {
    if (blendMode === 'output-heavy') {
      return (m.input_per_mtok + 3 * m.output_per_mtok) / 4;
    }
    return (m.input_per_mtok + m.output_per_mtok) / 2;
  }

  function qualityScore(m) {
    const benchmarks = m.benchmarks;
    if (!benchmarks) return null;
    const weights = { mmlu: 1, humaneval: 1, math: 1, gpqa: 1.2, swe_bench: 1.3, arena_elo: 1 };
    let total = 0, wSum = 0;
    for (const [key, w] of Object.entries(weights)) {
      let val = benchmarks[key];
      if (val === null || val === undefined) continue;
      if (key === 'arena_elo') {
        val = Math.max(0, Math.min(100, ((val - 900) / 600) * 100));
      }
      total += val * w;
      wSum += w;
    }
    return wSum > 0 ? total / wSum : null;
  }

  function computePareto(models) {
    const sorted = [...models].sort((a, b) => blendedCost(a) - blendedCost(b));
    const paretoSet = new Set();
    let bestQuality = -Infinity;
    for (const m of sorted) {
      const q = qualityScore(m);
      if (q !== null && q > bestQuality) {
        paretoSet.add(m.model);
        bestQuality = q;
      }
    }
    return paretoSet;
  }

  // ===== Init =====
  async function init() {
    const resp = await fetch('../data.json');
    DATA = await resp.json();
    allModels = DATA.models;

    window.Providers.initProviderMap(allModels);
    window.Providers._allModels = allModels;
    loadSettings();
    initTheme();
    populateUseCases();
    populateModels();
    initEventListeners();
    updateCostDisplay();
    populateLibraryFilter();
    updatePipelineButton();
  }

  // ===== Theme =====
  function initTheme() {
    const saved = localStorage.getItem('llm-dash-theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
      document.body.setAttribute('data-theme', saved);
    }
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.body.setAttribute('data-theme', next);
      localStorage.setItem('llm-dash-theme', next);
    });
  }

  // ===== Settings =====
  function loadSettings() {
    rememberKeys = localStorage.getItem('whichai-remember-keys') === 'true';
    if (rememberKeys) {
      try {
        const saved = JSON.parse(localStorage.getItem('whichai-api-keys') || '{}');
        apiKeys = { openai: saved.openai || '', anthropic: saved.anthropic || '', google: saved.google || '' };
      } catch { /* ignore */ }
    }
    // Load all-time cost
    const alltime = parseFloat(localStorage.getItem('whichai-alltime-cost') || '0');
    document.getElementById('cost-alltime').textContent = '$' + alltime.toFixed(3);
  }

  function saveSettings() {
    const remember = document.getElementById('remember-keys').checked;
    rememberKeys = remember;
    localStorage.setItem('whichai-remember-keys', remember ? 'true' : 'false');

    apiKeys.openai = document.getElementById('key-openai').value.trim();
    apiKeys.anthropic = document.getElementById('key-anthropic').value.trim();
    apiKeys.google = document.getElementById('key-google').value.trim();

    if (remember) {
      localStorage.setItem('whichai-api-keys', JSON.stringify(apiKeys));
    } else {
      localStorage.removeItem('whichai-api-keys');
    }

    updateSendButton();
    updatePipelineButton();
    closeModal('modal-settings');
  }

  // ===== Use Case Dropdown =====
  function populateUseCases() {
    const sel = document.getElementById('select-usecase');
    for (const [key, label] of Object.entries(USE_CASE_LABELS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  }

  // ===== Model Dropdown =====
  function populateModels(selectedUseCase) {
    const sel = document.getElementById('select-model');
    sel.innerHTML = '<option value="">-- Select a model --</option>';

    const paretoSet = computePareto(allModels);

    // Group by provider
    const providers = ['OpenAI', 'Anthropic', 'Google', 'Mistral', 'DeepSeek', 'Cohere', 'Meta (Fireworks)'];
    providers.forEach(provName => {
      const models = allModels.filter(m => m.provider === provName);
      if (models.length === 0) return;

      const group = document.createElement('optgroup');
      group.label = provName;

      // Sort by use-case score if selected, otherwise by blended cost
      const sorted = [...models].sort((a, b) => {
        if (selectedUseCase && a.use_case_scores && b.use_case_scores) {
          return (b.use_case_scores[selectedUseCase] || 0) - (a.use_case_scores[selectedUseCase] || 0);
        }
        return blendedCost(a) - blendedCost(b);
      });

      sorted.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.model;
        const isBig3 = window.Providers.isBig3(m.provider);
        const isPareto = paretoSet.has(m.model);
        const score = selectedUseCase && m.use_case_scores ? m.use_case_scores[selectedUseCase] : null;
        const q = qualityScore(m);

        let label = m.model;
        if (score) label += ` (${score}/100)`;
        label += ` — $${blendedCost(m).toFixed(2)}/1M`;
        if (isPareto) label += ' \u2605';
        if (!isBig3) label += ' (info only)';

        opt.textContent = label;
        opt.disabled = !isBig3;
        group.appendChild(opt);
      });

      sel.appendChild(group);
    });

    // Auto-select recommended model
    if (selectedUseCase) {
      const big3Models = allModels.filter(m => window.Providers.isBig3(m.provider));
      const paretoModels = big3Models.filter(m => paretoSet.has(m.model));
      const scored = (paretoModels.length > 0 ? paretoModels : big3Models)
        .filter(m => m.use_case_scores && m.use_case_scores[selectedUseCase])
        .sort((a, b) => (b.use_case_scores[selectedUseCase] || 0) - (a.use_case_scores[selectedUseCase] || 0));

      if (scored.length > 0) {
        const rec = scored[0];
        sel.value = rec.model;
        recommendedModel = rec.model;
        const recEl = document.getElementById('model-recommendation');
        recEl.style.display = 'flex';
        document.getElementById('rec-text').textContent =
          `${rec.model} — Best value for ${USE_CASE_LABELS[selectedUseCase]} (${rec.use_case_scores[selectedUseCase]}/100, $${blendedCost(rec).toFixed(2)}/1M)`;
      }
    } else {
      document.getElementById('model-recommendation').style.display = 'none';
      recommendedModel = null;
    }

    updateSendButton();
  }

  // ===== Token Counting & Cost Estimation =====
  function estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  function updatePromptStats() {
    const systemText = document.getElementById('system-prompt').value;
    const userText = document.getElementById('user-prompt').value;
    const totalText = systemText + userText;
    const tokens = estimateTokens(totalText);

    document.getElementById('token-estimate').textContent = `~${tokens.toLocaleString()} tokens`;

    // Cost estimate
    const modelName = document.getElementById('select-model').value;
    const model = allModels.find(m => m.model === modelName);
    if (model) {
      // Estimate: input tokens = system + user prompt, output ~1.5x input
      const estOutput = Math.ceil(tokens * 1.5);
      const cost = (tokens / 1e6) * model.input_per_mtok + (estOutput / 1e6) * model.output_per_mtok;
      document.getElementById('cost-estimate').textContent = `Est: $${cost.toFixed(4)}`;
    } else {
      document.getElementById('cost-estimate').textContent = 'Est: $0.000';
    }
  }

  // ===== Send Message =====
  async function sendMessage() {
    if (isStreaming) return;

    const modelName = document.getElementById('select-model').value;
    const systemPrompt = document.getElementById('system-prompt').value.trim();
    const userPrompt = document.getElementById('user-prompt').value.trim();

    if (!modelName || !userPrompt) return;

    const provider = window.Providers.getProvider(modelName);
    if (!provider) {
      alert('This model is info-only and cannot be called via API.');
      return;
    }

    const key = apiKeys[provider];
    if (!key) {
      alert(`No API key set for ${provider}. Open Settings to add one.`);
      return;
    }

    // Build messages
    if (!conversationMode) {
      messageHistory = [];
    }
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    // Add conversation history
    messageHistory.forEach(m => messages.push(m));
    messages.push({ role: 'user', content: userPrompt });

    // Add user message to UI
    addMessageToUI('user', userPrompt);
    messageHistory.push({ role: 'user', content: userPrompt });

    // Clear prompt if not in conversation mode
    if (!conversationMode) {
      // Keep the prompt for reference
    } else {
      document.getElementById('user-prompt').value = '';
      updatePromptStats();
    }

    // Start streaming
    isStreaming = true;
    updateSendButton();
    const startTime = Date.now();
    const assistantEl = addMessageToUI('assistant', '');
    assistantEl.classList.add('pg-streaming-cursor');

    try {
      const result = await window.Providers.callModelStreaming(
        provider, key, modelName, messages,
        { temperature: 0.7, maxTokens: 4096 },
        (chunk) => {
          if (chunk.content) {
            assistantEl.textContent += chunk.content;
            // Auto-scroll
            const messagesDiv = document.getElementById('messages');
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }
        }
      );

      assistantEl.classList.remove('pg-streaming-cursor');
      messageHistory.push({ role: 'assistant', content: result.content });

      // Calculate cost
      const model = allModels.find(m => m.model === modelName);
      const cost = model
        ? (result.inputTokens / 1e6) * model.input_per_mtok + (result.outputTokens / 1e6) * model.output_per_mtok
        : 0;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Update stats
      showResponseStats(result.inputTokens, result.outputTokens, cost, elapsed);

      // Update cost tracker
      sessionCost += cost;
      sessionBreakdown.push({
        model: modelName,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cost,
        timestamp: new Date().toISOString(),
      });
      updateCostDisplay();

    } catch (err) {
      assistantEl.classList.remove('pg-streaming-cursor');
      assistantEl.textContent = `Error: ${err.message}`;
      assistantEl.style.color = 'var(--danger)';
      assistantEl.style.borderColor = 'var(--danger)';
    }

    isStreaming = false;
    updateSendButton();
  }

  function addMessageToUI(role, content) {
    const messagesDiv = document.getElementById('messages');
    // Remove empty state
    const empty = messagesDiv.querySelector('.pg-empty-state');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = `pg-message pg-message-${role}`;
    div.textContent = content;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Show action buttons
    document.getElementById('btn-copy').style.display = '';
    document.getElementById('btn-export').style.display = '';
    document.getElementById('btn-new').style.display = '';

    return div;
  }

  function showResponseStats(inputTokens, outputTokens, cost, elapsed) {
    const statsEl = document.getElementById('response-stats');
    statsEl.style.display = '';
    document.getElementById('stat-tokens').textContent =
      `${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out`;
    document.getElementById('stat-cost').textContent = `$${cost.toFixed(4)}`;
    document.getElementById('stat-time').textContent = `${elapsed}s`;
  }

  function updateCostDisplay() {
    document.getElementById('cost-session').textContent = '$' + sessionCost.toFixed(3);
    const alltime = parseFloat(localStorage.getItem('whichai-alltime-cost') || '0') + sessionCost;
    document.getElementById('cost-alltime').textContent = '$' + alltime.toFixed(3);
  }

  function persistAlltimeCost() {
    const current = parseFloat(localStorage.getItem('whichai-alltime-cost') || '0');
    localStorage.setItem('whichai-alltime-cost', (current + sessionCost).toString());
    sessionCost = 0;
    sessionBreakdown = [];
  }

  // ===== UI Helpers =====
  function updateSendButton() {
    const btn = document.getElementById('btn-send');
    const modelName = document.getElementById('select-model').value;
    const provider = modelName ? window.Providers.getProvider(modelName) : null;
    const hasKey = provider ? !!apiKeys[provider] : false;
    const busy = isStreaming || isPipelineRunning;
    btn.disabled = busy || !modelName || !hasKey;
    btn.textContent = isStreaming ? 'Sending...' : 'Send';
    updatePipelineButton();
  }

  function updatePipelineButton() {
    const btn = document.getElementById('btn-pipeline');
    if (!btn) return;
    const hasAnyKey = !!(apiKeys.openai || apiKeys.anthropic || apiKeys.google);
    const busy = isStreaming || isPipelineRunning;
    btn.disabled = busy || !hasAnyKey;
    if (isPipelineRunning) {
      btn.textContent = 'Running...';
    } else {
      btn.textContent = 'Pipeline';
    }
  }

  function clearChat() {
    messageHistory = [];
    const messagesDiv = document.getElementById('messages');
    messagesDiv.innerHTML = '<div class="pg-empty-state">Type a prompt to get started. The best model will be selected automatically.</div>';
    document.getElementById('response-stats').style.display = 'none';
    document.getElementById('btn-copy').style.display = 'none';
    document.getElementById('btn-export').style.display = 'none';
    document.getElementById('btn-new').style.display = 'none';
  }

  // ===== Modal Helpers =====
  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }

  // ===== Library =====
  let libraryTab = 'starters';
  let libraryFilter = '';
  let librarySearch = '';

  function populateLibraryFilter() {
    const sel = document.getElementById('library-filter');
    // Already has "All Use Cases"
    for (const [key, label] of Object.entries(USE_CASE_LABELS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  }

  function renderLibrary() {
    const list = document.getElementById('library-list');
    list.innerHTML = '';

    let items;
    if (libraryTab === 'starters') {
      items = window.PromptLibrary.getStarterTemplates(libraryFilter || undefined);
      if (librarySearch) {
        const q = librarySearch.toLowerCase();
        items = items.filter(p =>
          p.name.toLowerCase().includes(q) ||
          p.systemPrompt.toLowerCase().includes(q) ||
          p.userPrompt.toLowerCase().includes(q)
        );
      }
    } else {
      items = window.PromptLibrary.searchPrompts(librarySearch, libraryFilter || undefined);
    }

    if (items.length === 0) {
      list.innerHTML = `<div class="pg-empty-state" style="padding:1rem">${
        libraryTab === 'saved' ? 'No saved prompts yet. Click "Save Current Prompt" to add one.' : 'No matching templates.'
      }</div>`;
      return;
    }

    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'pg-library-item' + (item.isStarter ? ' pg-library-item-starter' : '');
      div.innerHTML = `
        <div class="pg-library-item-info">
          <div class="pg-library-item-name">${escapeHtml(item.name)}</div>
          <div class="pg-library-item-meta">
            <span>${USE_CASE_LABELS[item.useCase] || item.useCase || 'General'}</span>
            ${(item.tags || []).map(t => `<span class="pg-library-tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
        <div class="pg-library-item-actions">
          <button class="pg-btn" style="font-size:0.72rem;padding:2px 8px" data-action="load">Load</button>
          ${!item.isStarter ? '<button class="pg-btn pg-btn-danger" style="font-size:0.72rem;padding:2px 8px" data-action="delete">Del</button>' : ''}
        </div>
      `;

      div.querySelector('[data-action="load"]').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('system-prompt').value = item.systemPrompt || '';
        document.getElementById('user-prompt').value = item.userPrompt || '';
        // Set use case if item has one, otherwise auto-detect
        if (item.useCase) {
          document.getElementById('select-usecase').value = item.useCase;
          populateModels(item.useCase);
          document.getElementById('detected-usecase').style.display = 'flex';
          document.getElementById('detected-usecase-name').textContent = USE_CASE_LABELS[item.useCase] || item.useCase;
        } else {
          autoClassifyAndUpdate();
        }
        updatePromptStats();
        closeModal('modal-library');
      });

      const delBtn = div.querySelector('[data-action="delete"]');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.PromptLibrary.deletePrompt(item.id);
          renderLibrary();
        });
      }

      list.appendChild(div);
    });
  }

  function saveCurrentPrompt() {
    const name = prompt('Name for this prompt:');
    if (!name) return;
    const useCase = document.getElementById('select-usecase').value || '';
    window.PromptLibrary.savePrompt({
      name,
      useCase,
      systemPrompt: document.getElementById('system-prompt').value,
      userPrompt: document.getElementById('user-prompt').value,
    });
    libraryTab = 'saved';
    updateLibraryTabs();
    renderLibrary();
  }

  function updateLibraryTabs() {
    document.querySelectorAll('.pg-library-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === libraryTab);
    });
  }

  // ===== Optimizer =====
  // Picks the best available provider for optimization: OpenAI preferred, then Anthropic, then Google
  function getOptimizerConfig() {
    const preferred = [
      { provider: 'openai', model: 'GPT-4o-mini' },
      { provider: 'anthropic', model: 'Claude Haiku 4.5' },
      { provider: 'google', model: 'Gemini 2.0 Flash' },
    ];
    for (const p of preferred) {
      if (apiKeys[p.provider]) return p;
    }
    return null;
  }

  async function runOptimizer() {
    const input = document.getElementById('optimizer-input').value.trim();
    if (!input) return;

    const config = getOptimizerConfig();
    if (!config) {
      alert('Add an API key in Settings first. OpenAI is preferred for optimization.');
      return;
    }

    const btn = document.getElementById('btn-run-optimizer');
    btn.disabled = true;
    btn.innerHTML = '<span class="pg-spinner"></span> Optimizing...';

    try {
      const result = await window.PromptOptimizer.optimizePrompt(input, config.provider, apiKeys[config.provider], config.model);
      document.getElementById('optimizer-system').textContent = result.systemPrompt;
      document.getElementById('optimizer-user').textContent = result.userPrompt;
      document.getElementById('optimizer-explanation').textContent = result.explanation;
      document.getElementById('optimizer-result').classList.add('visible');
      document.getElementById('btn-use-optimized').style.display = '';
    } catch (err) {
      alert('Optimization failed: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Optimize';
  }

  function useOptimizedPrompt() {
    const sys = document.getElementById('optimizer-system').textContent;
    const usr = document.getElementById('optimizer-user').textContent;
    document.getElementById('system-prompt').value = sys;
    document.getElementById('user-prompt').value = usr;
    updatePromptStats();
    debouncedAutoClassify();
    closeModal('modal-optimizer');
  }

  function saveSystemPromptToLibrary() {
    const systemPrompt = document.getElementById('system-prompt').value.trim();
    if (!systemPrompt) { alert('Write a system prompt first.'); return; }
    const name = prompt('Name for this system prompt:');
    if (!name) return;
    const detected = classifyPrompt(systemPrompt);
    window.PromptLibrary.savePrompt({
      name,
      useCase: detected || '',
      systemPrompt,
      userPrompt: '',
    });
    alert('Saved to library!');
  }

  // ===== Pipeline =====
  function openPipelineModal() {
    renderPipelineStages();
    document.getElementById('btn-pipeline-abort').style.display = 'none';
    document.getElementById('btn-pipeline-run').style.display = '';
    document.querySelector('.pg-pipeline-progress').style.display = 'none';
    openModal('modal-pipeline');
  }

  function getCallableModels() {
    return allModels.filter(m => window.Providers.isBig3(m.provider));
  }

  function getProviderColor(provider) {
    const colors = {
      openai: 'var(--color-openai)',
      anthropic: 'var(--color-anthropic)',
      google: 'var(--color-google)',
    };
    return colors[provider] || 'var(--accent)';
  }

  function renderPipelineStages() {
    const container = document.getElementById('pipeline-stages');
    const stages = window.Pipeline.getStages();
    const callableModels = getCallableModels();
    let html = '';

    stages.forEach((stage, i) => {
      const resolvedModel = window.Pipeline.resolveModel(stage, apiKeys);
      const provider = resolvedModel ? window.Providers.getProvider(resolvedModel) : null;

      if (i > 0) {
        html += '<div class="pg-pipeline-connector"></div>';
      }

      html += `<div class="pg-pipeline-stage-card${i === 0 ? ' open' : ''}" data-stage-index="${i}">
        <div class="pg-pipeline-stage-header">
          <span class="pg-pipeline-stage-badge">${i + 1}</span>
          <span class="pg-pipeline-stage-label">${escapeHtml(stage.label)}</span>
          <span class="pg-pipeline-stage-model-badge" style="${provider ? 'background:' + getProviderColor(provider) + ';color:#fff' : ''}">
            ${resolvedModel ? escapeHtml(resolvedModel) : 'No model available'}
          </span>
          <div class="pg-pipeline-stage-actions">
            ${i > 0 ? `<button data-action="move-up" title="Move up">&uarr;</button>` : ''}
            ${i < stages.length - 1 ? `<button data-action="move-down" title="Move down">&darr;</button>` : ''}
            ${stages.length > window.Pipeline.MIN_STAGES ? `<button data-action="remove" title="Remove">&times;</button>` : ''}
          </div>
          <span class="pg-pipeline-stage-toggle">\u25BC</span>
        </div>
        <div class="pg-pipeline-stage-body">
          <label>Label</label>
          <input type="text" class="pg-input" value="${escapeHtml(stage.label)}" data-field="label" style="margin-bottom:0.3rem">

          <label>System Prompt</label>
          <textarea data-field="systemPrompt">${escapeHtml(stage.systemPrompt)}</textarea>

          <label>Model Override</label>
          <select class="pg-select" data-field="modelOverride" style="margin-bottom:0.3rem">
            <option value="">Auto (use preference list)</option>
            ${callableModels.map(m => {
              const p = window.Providers.getProvider(m.model);
              const hasKey = p ? !!apiKeys[p] : false;
              return `<option value="${escapeHtml(m.model)}" ${stage.modelOverride === m.model ? 'selected' : ''} ${!hasKey ? 'disabled' : ''}>
                ${escapeHtml(m.model)}${!hasKey ? ' (no key)' : ''}
              </option>`;
            }).join('')}
          </select>

          <label>Temperature</label>
          <div class="pg-pipeline-temp-row">
            <input type="range" min="0" max="1" step="0.1" value="${stage.temperature}" data-field="temperature">
            <span class="pg-pipeline-temp-value">${stage.temperature}</span>
          </div>
        </div>
      </div>`;
    });

    container.innerHTML = html;

    // Update add stage button
    const addBtn = document.getElementById('btn-add-stage');
    addBtn.style.display = stages.length >= window.Pipeline.MAX_STAGES ? 'none' : '';

    // Wire stage card events
    container.querySelectorAll('.pg-pipeline-stage-card').forEach(card => {
      const idx = parseInt(card.dataset.stageIndex);

      // Toggle collapse
      card.querySelector('.pg-pipeline-stage-header').addEventListener('click', (e) => {
        if (e.target.closest('.pg-pipeline-stage-actions')) return;
        card.classList.toggle('open');
      });

      // Move up
      const moveUpBtn = card.querySelector('[data-action="move-up"]');
      if (moveUpBtn) {
        moveUpBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          syncStageEdits();
          window.Pipeline.moveStage(idx, idx - 1);
          renderPipelineStages();
        });
      }

      // Move down
      const moveDownBtn = card.querySelector('[data-action="move-down"]');
      if (moveDownBtn) {
        moveDownBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          syncStageEdits();
          window.Pipeline.moveStage(idx, idx + 1);
          renderPipelineStages();
        });
      }

      // Remove
      const removeBtn = card.querySelector('[data-action="remove"]');
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.Pipeline.removeStage(idx);
          renderPipelineStages();
        });
      }

      // Temperature slider live update
      const tempSlider = card.querySelector('[data-field="temperature"]');
      const tempValue = card.querySelector('.pg-pipeline-temp-value');
      if (tempSlider && tempValue) {
        tempSlider.addEventListener('input', () => {
          tempValue.textContent = tempSlider.value;
        });
      }
    });
  }

  function syncStageEdits() {
    const container = document.getElementById('pipeline-stages');
    const cards = container.querySelectorAll('.pg-pipeline-stage-card');
    cards.forEach(card => {
      const idx = parseInt(card.dataset.stageIndex);
      const label = card.querySelector('[data-field="label"]')?.value;
      const systemPrompt = card.querySelector('[data-field="systemPrompt"]')?.value;
      const modelOverride = card.querySelector('[data-field="modelOverride"]')?.value || null;
      const temperature = parseFloat(card.querySelector('[data-field="temperature"]')?.value) || 0.7;
      window.Pipeline.updateStage(idx, { label, systemPrompt, modelOverride, temperature });
    });
  }

  async function runPipelineFromModal() {
    const userPrompt = document.getElementById('user-prompt').value.trim();
    if (!userPrompt) {
      alert('Type a prompt in the "Your Prompt" field first.');
      return;
    }

    syncStageEdits();

    const stages = window.Pipeline.getStages();
    for (let i = 0; i < stages.length; i++) {
      const resolved = window.Pipeline.resolveModel(stages[i], apiKeys);
      if (!resolved) {
        alert(`Stage "${stages[i].label}" has no available model. Add an API key or change the model.`);
        return;
      }
    }

    // Close modal and set up UI
    closeModal('modal-pipeline');
    isPipelineRunning = true;
    updateSendButton();

    const messagesDiv = document.getElementById('messages');
    const empty = messagesDiv.querySelector('.pg-empty-state');
    if (empty) empty.remove();

    // Add user message bubble
    addMessageToUI('user', userPrompt);

    // Create result cards for each stage
    const resultCards = [];
    const pipelineContainer = document.createElement('div');
    pipelineContainer.className = 'pg-pipeline-results';

    stages.forEach((stage, i) => {
      const resolved = window.Pipeline.resolveModel(stage, apiKeys);
      const provider = resolved ? window.Providers.getProvider(resolved) : null;
      const card = document.createElement('div');
      card.className = 'pg-pipeline-result-card';
      card.innerHTML = `
        <div class="pg-pipeline-result-header">
          <span class="pg-pipeline-result-badge" style="background:var(--border)">${i + 1}</span>
          <span class="pg-pipeline-result-label">${escapeHtml(stage.label)}</span>
          <span class="pg-pipeline-result-model" style="background:${getProviderColor(provider)}">${escapeHtml(resolved || '?')}</span>
          <span class="pg-pipeline-result-stats"></span>
          <span class="pg-pipeline-result-toggle">\u25BC</span>
        </div>
        <div class="pg-pipeline-result-body"></div>
      `;

      card.querySelector('.pg-pipeline-result-header').addEventListener('click', () => {
        card.classList.toggle('open');
      });

      pipelineContainer.appendChild(card);
      resultCards.push(card);
    });

    messagesDiv.appendChild(pipelineContainer);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Show action buttons
    document.getElementById('btn-copy').style.display = '';
    document.getElementById('btn-export').style.display = '';
    document.getElementById('btn-new').style.display = '';

    const pipelineStartTime = Date.now();

    await window.Pipeline.runPipeline(userPrompt, apiKeys, {
      onStageStart(stageIndex, stage, resolvedModel) {
        const card = resultCards[stageIndex];
        card.classList.add('open', 'result-active');
        card.querySelector('.pg-pipeline-result-badge').style.background = 'var(--accent)';
        card.querySelector('.pg-pipeline-result-body').textContent = '';
        card.querySelector('.pg-pipeline-result-body').classList.add('pg-streaming-cursor');
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      },

      onStageChunk(stageIndex, chunk) {
        if (chunk.content) {
          const body = resultCards[stageIndex].querySelector('.pg-pipeline-result-body');
          body.textContent += chunk.content;
          messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
      },

      onStageComplete(stageIndex, result) {
        const card = resultCards[stageIndex];
        card.classList.remove('result-active');
        card.querySelector('.pg-pipeline-result-body').classList.remove('pg-streaming-cursor');
        card.querySelector('.pg-pipeline-result-badge').style.background = 'var(--success)';
        card.querySelector('.pg-pipeline-result-stats').textContent =
          `${result.inputTokens.toLocaleString()}+${result.outputTokens.toLocaleString()} tok | $${result.cost.toFixed(4)} | ${result.time.toFixed(1)}s`;

        // Auto-collapse completed stage
        card.classList.remove('open');

        // Track cost
        sessionCost += result.cost;
        sessionBreakdown.push({
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: result.cost,
          timestamp: new Date().toISOString(),
          pipelineStage: result.label,
        });
        updateCostDisplay();
      },

      onStageError(stageIndex, error) {
        const card = resultCards[stageIndex];
        card.classList.remove('result-active');
        card.classList.add('open');
        card.querySelector('.pg-pipeline-result-body').classList.remove('pg-streaming-cursor');
        card.querySelector('.pg-pipeline-result-badge').style.background = 'var(--danger)';
        card.querySelector('.pg-pipeline-result-body').textContent = `Error: ${error.message}`;
        card.querySelector('.pg-pipeline-result-body').style.color = 'var(--danger)';
      },

      onPipelineComplete(summary) {
        isPipelineRunning = false;
        updateSendButton();

        const totalTime = ((Date.now() - pipelineStartTime) / 1000).toFixed(1);

        // Show gold summary bar
        const summaryBar = document.createElement('div');
        summaryBar.className = 'pg-pipeline-summary';
        summaryBar.innerHTML = `
          <span class="pg-pipeline-summary-label">Pipeline Complete</span>
          <div class="pg-pipeline-summary-left">
            <span><strong>${summary.stages.length}</strong> stages</span>
            <span><strong>${(summary.totalInputTokens + summary.totalOutputTokens).toLocaleString()}</strong> tokens</span>
            <span><strong>$${summary.totalCost.toFixed(4)}</strong></span>
            <span><strong>${totalTime}s</strong></span>
          </div>
        `;
        pipelineContainer.appendChild(summaryBar);

        // Show response stats
        showResponseStats(summary.totalInputTokens, summary.totalOutputTokens, summary.totalCost, totalTime);

        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      },
    });
  }

  // ===== Event Listeners =====
  function initEventListeners() {
    // Use case change
    document.getElementById('select-usecase').addEventListener('change', (e) => {
      populateModels(e.target.value || undefined);
    });

    // Model change
    document.getElementById('select-model').addEventListener('change', () => {
      updateSendButton();
      updatePromptStats();
    });

    // Prompt typing → live stats + auto-classify use case
    document.getElementById('user-prompt').addEventListener('input', () => {
      updatePromptStats();
      debouncedAutoClassify();
    });
    document.getElementById('system-prompt').addEventListener('input', () => {
      updatePromptStats();
      debouncedAutoClassify();
    });

    // Send
    document.getElementById('btn-send').addEventListener('click', sendMessage);

    // Ctrl+Enter to send
    document.getElementById('user-prompt').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
      }
    });

    // Conversation toggle
    document.getElementById('toggle-conversation').addEventListener('click', () => {
      conversationMode = !conversationMode;
      document.getElementById('toggle-conversation').classList.toggle('active', conversationMode);
    });

    // Settings
    document.getElementById('btn-settings').addEventListener('click', () => {
      document.getElementById('key-openai').value = apiKeys.openai;
      document.getElementById('key-anthropic').value = apiKeys.anthropic;
      document.getElementById('key-google').value = apiKeys.google;
      document.getElementById('remember-keys').checked = rememberKeys;
      openModal('modal-settings');
    });
    document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

    // Test key buttons
    document.querySelectorAll('.test-key-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const provider = btn.dataset.provider;
        const keyInput = document.getElementById(`key-${provider}`);
        const statusEl = document.getElementById(`status-${provider}`);
        const key = keyInput.value.trim();
        if (!key) { statusEl.textContent = ''; return; }

        btn.disabled = true;
        statusEl.innerHTML = '<span class="pg-spinner"></span>';

        // Temporarily save key for testing
        apiKeys[provider] = key;
        const result = await window.Providers.testApiKey(provider, key);
        statusEl.textContent = result.ok ? '\u2705' : '\u274C';
        statusEl.title = result.ok ? 'Key works!' : result.error;
        btn.disabled = false;
      });
    });

    // Library
    document.getElementById('btn-library').addEventListener('click', () => {
      renderLibrary();
      openModal('modal-library');
    });

    document.querySelectorAll('.pg-library-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        libraryTab = tab.dataset.tab;
        updateLibraryTabs();
        renderLibrary();
      });
    });

    document.getElementById('library-search').addEventListener('input', (e) => {
      librarySearch = e.target.value;
      renderLibrary();
    });

    document.getElementById('library-filter').addEventListener('change', (e) => {
      libraryFilter = e.target.value;
      renderLibrary();
    });

    document.getElementById('btn-save-current').addEventListener('click', saveCurrentPrompt);

    document.getElementById('btn-export-library').addEventListener('click', () => {
      window.PromptLibrary.exportLibrary();
    });

    document.getElementById('btn-import-library').addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });

    document.getElementById('import-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = window.PromptLibrary.importLibrary(reader.result);
        if (result.error) {
          alert('Import failed: ' + result.error);
        } else {
          alert(`Imported ${result.added} prompts (${result.skipped} duplicates skipped).`);
          renderLibrary();
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // Optimizer — pre-fill with current system prompt
    document.getElementById('btn-optimize').addEventListener('click', () => {
      const currentSystem = document.getElementById('system-prompt').value.trim();
      document.getElementById('optimizer-input').value = currentSystem;
      document.getElementById('optimizer-result').classList.remove('visible');
      document.getElementById('btn-use-optimized').style.display = 'none';
      openModal('modal-optimizer');
    });
    document.getElementById('btn-run-optimizer').addEventListener('click', runOptimizer);
    document.getElementById('btn-use-optimized').addEventListener('click', useOptimizedPrompt);

    // Save system prompt to library
    document.getElementById('btn-save-system').addEventListener('click', saveSystemPromptToLibrary);

    // Pipeline
    document.getElementById('btn-pipeline').addEventListener('click', openPipelineModal);
    document.getElementById('btn-pipeline-run').addEventListener('click', runPipelineFromModal);
    document.getElementById('btn-pipeline-reset').addEventListener('click', () => {
      window.Pipeline.resetStages();
      renderPipelineStages();
    });
    document.getElementById('btn-pipeline-abort').addEventListener('click', () => {
      window.Pipeline.abortPipeline();
      isPipelineRunning = false;
      updateSendButton();
    });
    document.getElementById('btn-add-stage').addEventListener('click', () => {
      syncStageEdits();
      window.Pipeline.addStage();
      renderPipelineStages();
    });

    // Response actions
    document.getElementById('btn-copy').addEventListener('click', () => {
      const messages = document.querySelectorAll('.pg-message-assistant');
      const lastMsg = messages[messages.length - 1];
      if (lastMsg) {
        navigator.clipboard.writeText(lastMsg.textContent).then(() => {
          const btn = document.getElementById('btn-copy');
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      }
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      const data = {
        model: document.getElementById('select-model').value,
        messages: messageHistory,
        timestamp: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `playground-chat-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('btn-new').addEventListener('click', clearChat);

    // Cost tracker
    document.getElementById('btn-cost-breakdown').addEventListener('click', () => {
      renderBreakdown();
      openModal('modal-breakdown');
    });

    document.getElementById('btn-cost-reset').addEventListener('click', () => {
      if (confirm('Reset all-time cost tracking?')) {
        persistAlltimeCost();
        localStorage.setItem('whichai-alltime-cost', '0');
        sessionCost = 0;
        sessionBreakdown = [];
        updateCostDisplay();
      }
    });

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.pg-modal-overlay').classList.remove('open');
      });
    });

    // Close modal on overlay click
    document.querySelectorAll('.pg-modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
      });
    });

    // Persist cost on page unload
    window.addEventListener('beforeunload', persistAlltimeCost);
  }

  function renderBreakdown() {
    const el = document.getElementById('breakdown-content');
    if (sessionBreakdown.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted)">No API calls in this session yet.</p>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:0.8rem">';
    html += '<thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Model</th>';
    html += '<th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">In</th>';
    html += '<th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Out</th>';
    html += '<th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Cost</th></tr></thead><tbody>';

    sessionBreakdown.forEach(entry => {
      html += `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid var(--border-light)">${escapeHtml(entry.model)}</td>
        <td style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border-light);font-family:var(--mono)">${entry.inputTokens.toLocaleString()}</td>
        <td style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border-light);font-family:var(--mono)">${entry.outputTokens.toLocaleString()}</td>
        <td style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border-light);font-family:var(--mono)">$${entry.cost.toFixed(4)}</td>
      </tr>`;
    });

    html += `<tr style="font-weight:600">
      <td style="padding:4px 8px" colspan="3">Session Total</td>
      <td style="text-align:right;padding:4px 8px;font-family:var(--mono)">$${sessionCost.toFixed(4)}</td>
    </tr>`;
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===== Boot =====
  document.addEventListener('DOMContentLoaded', init);
})();
