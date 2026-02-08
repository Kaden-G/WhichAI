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
    loadSettings();
    initTheme();
    populateUseCases();
    populateModels();
    initEventListeners();
    updateCostDisplay();
    populateLibraryFilter();
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
    btn.disabled = isStreaming || !modelName || !hasKey;
    btn.textContent = isStreaming ? 'Sending...' : 'Send';
  }

  function clearChat() {
    messageHistory = [];
    const messagesDiv = document.getElementById('messages');
    messagesDiv.innerHTML = '<div class="pg-empty-state">Select a model and type a prompt to get started.</div>';
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
        // Open system prompt if it has content
        if (item.systemPrompt) {
          document.getElementById('system-prompt-section').classList.add('open');
        }
        // Set use case if item has one
        if (item.useCase) {
          document.getElementById('select-usecase').value = item.useCase;
          populateModels(item.useCase);
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
  async function runOptimizer() {
    const input = document.getElementById('optimizer-input').value.trim();
    if (!input) return;

    const modelName = document.getElementById('select-model').value;
    if (!modelName) { alert('Select a model first.'); return; }

    const provider = window.Providers.getProvider(modelName);
    if (!provider) { alert('Selected model is info-only.'); return; }
    if (!apiKeys[provider]) { alert(`No API key for ${provider}. Set one in Settings.`); return; }

    const btn = document.getElementById('btn-run-optimizer');
    btn.disabled = true;
    btn.innerHTML = '<span class="pg-spinner"></span> Optimizing...';

    try {
      const result = await window.PromptOptimizer.optimizePrompt(input, provider, apiKeys[provider], modelName);
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
    if (sys) document.getElementById('system-prompt-section').classList.add('open');
    updatePromptStats();
    closeModal('modal-optimizer');
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

    // System prompt toggle
    document.getElementById('toggle-system-prompt').addEventListener('click', () => {
      document.getElementById('system-prompt-section').classList.toggle('open');
    });

    // Prompt typing → live stats
    document.getElementById('user-prompt').addEventListener('input', updatePromptStats);
    document.getElementById('system-prompt').addEventListener('input', updatePromptStats);

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

    // Optimizer
    document.getElementById('btn-optimize').addEventListener('click', () => {
      document.getElementById('optimizer-result').classList.remove('visible');
      document.getElementById('btn-use-optimized').style.display = 'none';
      openModal('modal-optimizer');
    });
    document.getElementById('btn-run-optimizer').addEventListener('click', runOptimizer);
    document.getElementById('btn-use-optimized').addEventListener('click', useOptimizedPrompt);

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
