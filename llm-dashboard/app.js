(function () {
  'use strict';

  // ===== State =====
  let DATA = null;
  let filteredModels = [];
  let sortCol = 'blended';
  let sortAsc = true;
  let blendMode = 'simple'; // 'simple' or 'output-heavy'
  let activeProviders = new Set();
  let activeTags = new Set();
  let maxPrice = 40;

  // Cost estimator state
  let costReqPerDay = 50;
  let costAvgInput = 800;
  let costAvgOutput = 1200;

  const USAGE_PRESETS = {
    solo:     { label: 'Solo Dev',       reqPerDay: 50,    avgInput: 800,  avgOutput: 1200 },
    team:     { label: 'Small Team',     reqPerDay: 250,   avgInput: 800,  avgOutput: 1200 },
    tool:     { label: 'Internal Tool',  reqPerDay: 500,   avgInput: 500,  avgOutput: 500  },
    app:      { label: 'Customer App',   reqPerDay: 5000,  avgInput: 400,  avgOutput: 600  },
    pipeline: { label: 'High Volume',    reqPerDay: 50000, avgInput: 300,  avgOutput: 300  },
    custom:   { label: 'Custom',         reqPerDay: 50,    avgInput: 800,  avgOutput: 1200 }
  };

  // ===== Provider colors matching CSS =====
  const PROVIDER_COLORS = {
    'OpenAI': '#10a37f',
    'Anthropic': '#d97706',
    'Google': '#4285f4',
    'Mistral': '#7c3aed',
    'DeepSeek': '#0ea5e9',
    'Cohere': '#e11d48',
    'Meta (Fireworks)': '#1877f2'
  };

  const PROVIDER_CLASS = {
    'OpenAI': 'provider-openai',
    'Anthropic': 'provider-anthropic',
    'Google': 'provider-google',
    'Mistral': 'provider-mistral',
    'DeepSeek': 'provider-deepseek',
    'Cohere': 'provider-cohere',
    'Meta (Fireworks)': 'provider-meta'
  };

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
    feature_engineering: 'Feature Engineering'
  };

  // ===== Utility =====
  function blendedCost(m) {
    if (blendMode === 'output-heavy') {
      return (m.input_per_mtok + 3 * m.output_per_mtok) / 4;
    }
    return (m.input_per_mtok + m.output_per_mtok) / 2;
  }

  function qualityScore(m) {
    const benchmarks = m.benchmarks;
    if (!benchmarks) return null;
    // Normalize: mmlu 0-100, humaneval 0-100, math 0-100, gpqa 0-100, swe_bench 0-100, arena_elo special
    const weights = { mmlu: 1, humaneval: 1, math: 1, gpqa: 1.2, swe_bench: 1.3, arena_elo: 1 };
    let total = 0, wSum = 0;
    for (const [key, w] of Object.entries(weights)) {
      let val = benchmarks[key];
      if (val === null || val === undefined) continue;
      // Normalize arena_elo to 0-100 scale (roughly 900-1500 range)
      if (key === 'arena_elo') {
        val = Math.max(0, Math.min(100, ((val - 900) / 600) * 100));
      }
      total += val * w;
      wSum += w;
    }
    return wSum > 0 ? total / wSum : null;
  }

  function computePareto(models) {
    // Sort by blended cost ascending
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

  function formatContext(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 2) + 'M';
    return (n / 1000).toFixed(0) + 'K';
  }

  function formatPrice(n) {
    if (n === null || n === undefined) return '-';
    return '$' + n.toFixed(2);
  }

  function formatBenchmark(v) {
    if (v === null || v === undefined) return '-';
    return typeof v === 'number' ? v.toFixed(1) : v;
  }

  // ===== Init =====
  async function init() {
    const resp = await fetch('data.json');
    DATA = await resp.json();

    initTheme();
    renderHeader();
    renderFilters();
    applyFilters();
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
      renderChart(); // re-render chart with new theme colors
    });
  }

  // ===== Header =====
  function renderHeader() {
    document.getElementById('last-updated').textContent = 'Updated: ' + DATA.last_updated;
    const linksEl = document.getElementById('source-links');
    const footerLinksEl = document.getElementById('footer-source-links');
    for (const [name, url] of Object.entries(DATA.sources)) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = name.charAt(0).toUpperCase() + name.slice(1).replace('_', ' ');
      linksEl.appendChild(a);

      const a2 = a.cloneNode(true);
      footerLinksEl.appendChild(a2);
    }
  }

  // ===== Filters =====
  function renderFilters() {
    // Provider checkboxes
    const providers = [...new Set(DATA.models.map(m => m.provider))];
    providers.forEach(p => activeProviders.add(p));

    const provEl = document.getElementById('provider-filters');
    providers.forEach(p => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.value = p;
      cb.addEventListener('change', () => {
        if (cb.checked) activeProviders.add(p);
        else activeProviders.delete(p);
        applyFilters();
      });
      const dot = document.createElement('span');
      dot.className = 'provider-dot';
      dot.style.backgroundColor = PROVIDER_COLORS[p] || '#888';
      label.appendChild(cb);
      label.appendChild(dot);
      label.appendChild(document.createTextNode(' ' + p));
      provEl.appendChild(label);
    });

    // Tag buttons
    const allTags = new Set();
    DATA.models.forEach(m => (m.tags || []).forEach(t => allTags.add(t)));
    const tagEl = document.getElementById('tag-filters');
    [...allTags].sort().forEach(t => {
      const btn = document.createElement('button');
      btn.className = 'tag-btn';
      btn.textContent = t;
      btn.addEventListener('click', () => {
        if (activeTags.has(t)) {
          activeTags.delete(t);
          btn.classList.remove('active');
        } else {
          activeTags.add(t);
          btn.classList.add('active');
        }
        applyFilters();
      });
      tagEl.appendChild(btn);
    });

    // Price slider
    const slider = document.getElementById('price-slider');
    const sliderVal = document.getElementById('price-slider-value');
    // Set max based on data
    const maxBlended = Math.ceil(Math.max(...DATA.models.map(m => blendedCost(m))));
    slider.max = maxBlended + 2;
    slider.value = slider.max;
    maxPrice = parseFloat(slider.max);
    sliderVal.textContent = '$' + parseFloat(slider.value).toFixed(2);

    slider.addEventListener('input', () => {
      maxPrice = parseFloat(slider.value);
      sliderVal.textContent = '$' + maxPrice.toFixed(2);
      applyFilters();
    });

    // Blend mode radio
    document.querySelectorAll('input[name="blend-mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        blendMode = radio.value;
        // Update slider max
        const newMax = Math.ceil(Math.max(...DATA.models.map(m => blendedCost(m))));
        slider.max = newMax + 2;
        if (maxPrice > parseFloat(slider.max)) {
          maxPrice = parseFloat(slider.max);
          slider.value = slider.max;
          sliderVal.textContent = '$' + maxPrice.toFixed(2);
        }
        applyFilters();
      });
    });
  }

  function applyFilters() {
    filteredModels = DATA.models.filter(m => {
      if (!activeProviders.has(m.provider)) return false;
      if (activeTags.size > 0 && !(m.tags || []).some(t => activeTags.has(t))) return false;
      if (blendedCost(m) > maxPrice) return false;
      return true;
    });
    renderAll();
  }

  function renderAll() {
    renderUseCaseGrid();
    renderCostEstimator();
    renderChart();
    renderTable();
  }

  // ===== Cost Estimator =====
  function modelMonthlyCost(m) {
    const monthlyInputTokens = costReqPerDay * 30 * costAvgInput;
    const monthlyOutputTokens = costReqPerDay * 30 * costAvgOutput;
    return (monthlyInputTokens / 1e6) * m.input_per_mtok + (monthlyOutputTokens / 1e6) * m.output_per_mtok;
  }

  function impactTier(dailyCost) {
    if (dailyCost < 1) return { label: 'Negligible', cls: 'impact-negligible', desc: 'Not worth optimizing' };
    if (dailyCost < 10) return { label: 'Noticeable', cls: 'impact-noticeable', desc: 'Worth comparing' };
    if (dailyCost < 50) return { label: 'Budget Item', cls: 'impact-budget', desc: 'Actively optimize' };
    if (dailyCost < 200) return { label: 'Significant', cls: 'impact-significant', desc: 'Careful selection needed' };
    return { label: 'Major Expense', cls: 'impact-major', desc: 'Top priority to optimize' };
  }

  function formatDollars(n) {
    if (n < 0.01) return '< $0.01';
    if (n < 1) return '$' + n.toFixed(2);
    if (n < 100) return '$' + n.toFixed(2);
    if (n < 10000) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function renderCostEstimator() {
    const tbody = document.getElementById('cost-tbody');
    tbody.innerHTML = '';

    const costed = filteredModels
      .map(m => ({ m, monthly: modelMonthlyCost(m), daily: modelMonthlyCost(m) / 30 }))
      .sort((a, b) => a.monthly - b.monthly);

    if (costed.length === 0) return;

    const cheapest = costed[0].monthly;
    const paretoSet = computePareto(filteredModels);

    costed.forEach(({ m, monthly, daily }) => {
      const annual = monthly * 12;
      const impact = impactTier(daily);
      const extra = monthly - cheapest;
      const provClass = PROVIDER_CLASS[m.provider] || '';

      const tr = document.createElement('tr');
      tr.className = provClass;
      if (paretoSet.has(m.model)) tr.classList.add('pareto-optimal');

      tr.innerHTML = `
        <td>${m.provider}</td>
        <td style="font-weight:500">${m.model}</td>
        <td>${formatDollars(daily)}/day</td>
        <td style="font-weight:600">${formatDollars(monthly)}/mo</td>
        <td>${formatDollars(annual)}/yr</td>
        <td><span class="impact-badge ${impact.cls}" title="${impact.desc}">${impact.label}</span></td>
        <td>${extra < 0.01 ? '-' : '+' + formatDollars(extra) + '/mo'}</td>
      `;
      tbody.appendChild(tr);
    });

    // Savings callout
    const callout = document.getElementById('cost-savings-callout');
    const mostExpensive = costed[costed.length - 1];
    // Find cheapest Pareto model (best value)
    const paretoCosted = costed.filter(c => paretoSet.has(c.m.model));
    const bestValue = paretoCosted.length > 0 ? paretoCosted[0] : costed[0];

    if (mostExpensive && bestValue && mostExpensive.monthly - bestValue.monthly > 1) {
      const savings = mostExpensive.monthly - bestValue.monthly;
      const savingsAnnual = savings * 12;
      callout.innerHTML = `
        At this usage level, choosing <strong>${bestValue.m.model}</strong> (${formatDollars(bestValue.monthly)}/mo)
        over <strong>${mostExpensive.m.model}</strong> (${formatDollars(mostExpensive.monthly)}/mo)
        saves <span class="savings-amount">${formatDollars(savings)}/mo</span>
        (<span class="savings-amount">${formatDollars(savingsAnnual)}/yr</span>).
        ${savings < 30 ? ' At this volume, the price difference is minimal — pick on quality.' : ''}
        ${savings >= 300 ? ' This is a meaningful budget item — optimizing model choice pays off.' : ''}
      `;
      callout.classList.add('visible');
    } else {
      callout.classList.remove('visible');
    }
  }

  function initCostEstimator() {
    const reqSlider = document.getElementById('req-per-day');
    const inputSlider = document.getElementById('avg-input');
    const outputSlider = document.getElementById('avg-output');
    const reqVal = document.getElementById('req-per-day-val');
    const inputVal = document.getElementById('avg-input-val');
    const outputVal = document.getElementById('avg-output-val');

    function formatSliderNum(n) {
      return n >= 1000 ? n.toLocaleString('en-US') : n.toString();
    }

    function syncSliders() {
      reqSlider.value = costReqPerDay;
      inputSlider.value = costAvgInput;
      outputSlider.value = costAvgOutput;
      reqVal.textContent = formatSliderNum(costReqPerDay);
      inputVal.textContent = formatSliderNum(costAvgInput);
      outputVal.textContent = formatSliderNum(costAvgOutput);
    }

    reqSlider.addEventListener('input', () => {
      costReqPerDay = parseInt(reqSlider.value);
      reqVal.textContent = formatSliderNum(costReqPerDay);
      setPresetActive('custom');
      renderCostEstimator();
    });
    inputSlider.addEventListener('input', () => {
      costAvgInput = parseInt(inputSlider.value);
      inputVal.textContent = formatSliderNum(costAvgInput);
      setPresetActive('custom');
      renderCostEstimator();
    });
    outputSlider.addEventListener('input', () => {
      costAvgOutput = parseInt(outputSlider.value);
      outputVal.textContent = formatSliderNum(costAvgOutput);
      setPresetActive('custom');
      renderCostEstimator();
    });

    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = USAGE_PRESETS[btn.dataset.preset];
        if (!preset) return;
        costReqPerDay = preset.reqPerDay;
        costAvgInput = preset.avgInput;
        costAvgOutput = preset.avgOutput;
        syncSliders();
        setPresetActive(btn.dataset.preset);
        renderCostEstimator();
      });
    });

    function setPresetActive(key) {
      document.querySelectorAll('.preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.preset === key);
      });
    }

    syncSliders();
  }

  // ===== Use Case Grid =====
  function renderUseCaseGrid() {
    const grid = document.getElementById('use-case-grid');
    grid.innerHTML = '';

    const paretoSet = computePareto(filteredModels);

    for (const [key, label] of Object.entries(USE_CASE_LABELS)) {
      // Get models with scores for this use case
      const scored = filteredModels
        .filter(m => m.use_case_scores && m.use_case_scores[key] != null)
        .map(m => ({ ...m, score: m.use_case_scores[key] }))
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) continue;

      // Best Performance: highest score
      const best = scored[0];

      // Best Value: highest score among Pareto-optimal models
      const paretoScored = scored.filter(m => paretoSet.has(m.model));
      const value = paretoScored.length > 0 ? paretoScored[0] : null;

      // Budget: cheapest with score >= 60
      const viable = scored.filter(m => m.score >= 60);
      const budget = viable.length > 0
        ? viable.reduce((a, b) => blendedCost(a) < blendedCost(b) ? a : b)
        : null;

      // Top 5 runners-up for the detail panel
      const top5 = scored.slice(0, Math.min(8, scored.length));

      const card = document.createElement('div');
      card.className = 'use-case-card';
      card.innerHTML = `
        <h3>${label} <span class="card-expand-hint">click for details</span></h3>
        ${tierHTML('&#127942;', 'Best', best)}
        ${value ? tierHTML('&#9889;', 'Value', value) : ''}
        ${budget ? tierHTML('&#128176;', 'Budget', budget) : ''}
        <div class="card-detail">
          ${buildDetailWhyHTML(key, best, value, budget, paretoSet)}
          ${buildDetailRankingHTML(key, top5, paretoSet)}
        </div>
      `;

      card.addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      grid.appendChild(card);
    }
  }

  function tierHTML(icon, tierLabel, m) {
    return `
      <div class="use-case-tier">
        <span class="tier-icon">${icon}</span>
        <span class="tier-label">${tierLabel}</span>
        <span class="tier-model" style="color:${PROVIDER_COLORS[m.provider] || '#888'}">${m.model}</span>
        <span class="tier-price">$${m.input_per_mtok} send · $${m.output_per_mtok} recv</span>
      </div>`;
  }

  function buildDetailWhyHTML(useCaseKey, best, value, budget, paretoSet) {
    const ucLabel = USE_CASE_LABELS[useCaseKey];
    let html = '<h4>How these were picked</h4>';

    html += `<p class="why-text"><strong>Best:</strong> ${best.model} has the highest ${ucLabel.toLowerCase()} score (${best.score}/100) among all visible models.</p>`;

    if (value) {
      const isAlsoBest = value.model === best.model;
      if (isAlsoBest) {
        html += `<p class="why-text"><strong>Value:</strong> Same model — ${value.model} is also on the Pareto frontier (no cheaper model scores higher overall), making it both the best and best value.</p>`;
      } else {
        html += `<p class="why-text"><strong>Value:</strong> ${value.model} scores ${value.score}/100 for ${ucLabel.toLowerCase()} and sits on the Pareto frontier — it's the highest scorer among models where no cheaper option has better overall quality. Blended cost: ${formatPrice(blendedCost(value))}/1M tok vs. ${formatPrice(blendedCost(best))}/1M tok for the top pick.</p>`;
      }
    }

    if (budget) {
      const isSame = budget.model === (value && value.model) || budget.model === best.model;
      if (!isSame) {
        html += `<p class="why-text"><strong>Budget:</strong> ${budget.model} is the cheapest model that still scores above 60/100 for ${ucLabel.toLowerCase()} (scores ${budget.score}). Blended cost: just ${formatPrice(blendedCost(budget))}/1M tok.</p>`;
      } else {
        html += `<p class="why-text"><strong>Budget:</strong> ${budget.model} (${budget.score}/100) is already the cheapest viable option at ${formatPrice(blendedCost(budget))}/1M tok.</p>`;
      }
    }

    return html;
  }

  function buildDetailRankingHTML(useCaseKey, top, paretoSet) {
    const ucLabel = USE_CASE_LABELS[useCaseKey];
    let html = `<h4>Top models for ${ucLabel.toLowerCase()}</h4>`;
    html += '<table class="card-detail-table"><thead><tr><th>Model</th><th>Score</th><th>Blended</th><th>Send/Recv per 1M</th></tr></thead><tbody>';

    for (const m of top) {
      const isPareto = paretoSet.has(m.model);
      const color = PROVIDER_COLORS[m.provider] || '#888';
      html += `<tr${isPareto ? ' style="font-weight:600"' : ''}>
        <td style="color:${color}">${m.model}${isPareto ? ' *' : ''}</td>
        <td><div class="score-bar-container"><div class="score-bar"><div class="score-bar-fill" style="width:${m.score}%;background:${color}"></div></div><span class="score-bar-val">${m.score}</span></div></td>
        <td>${formatPrice(blendedCost(m))}</td>
        <td>$${m.input_per_mtok} / $${m.output_per_mtok}</td>
      </tr>`;
    }

    html += '</tbody></table>';
    html += '<p style="font-size:0.7rem;color:var(--text-secondary);margin:0">* = Pareto-optimal (no cheaper model has higher overall quality)</p>';
    return html;
  }

  // ===== Scatter Chart (Canvas) =====
  function renderChart() {
    const canvas = document.getElementById('scatter-chart');
    const container = canvas.parentElement;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const pad = { top: 30, right: 30, bottom: 50, left: 65 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);

    const textColor = isDark ? '#e2e8f0' : '#1a1a2e';
    const gridColor = isDark ? '#334155' : '#e5e7eb';
    const bgColor = isDark ? '#1e293b' : '#ffffff';

    // Clear
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    // Compute data points
    const points = filteredModels.map(m => ({
      x: blendedCost(m),
      y: qualityScore(m),
      model: m.model,
      provider: m.provider,
      m: m
    })).filter(p => p.y !== null);

    if (points.length === 0) {
      ctx.fillStyle = textColor;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No models with benchmark data match current filters', W / 2, H / 2);
      return;
    }

    const xMin = 0;
    const xMax = Math.max(...points.map(p => p.x)) * 1.15;
    const yMin = Math.min(...points.map(p => p.y)) * 0.95;
    const yMax = Math.max(...points.map(p => p.y)) * 1.03;

    function toCanvasX(v) { return pad.left + ((v - xMin) / (xMax - xMin)) * plotW; }
    function toCanvasY(v) { return pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    const xTicks = niceScale(xMin, xMax, 8);
    const yTicks = niceScale(yMin, yMax, 6);

    ctx.font = '11px sans-serif';
    ctx.fillStyle = textColor;

    xTicks.forEach(v => {
      const x = toCanvasX(v);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText('$' + v.toFixed(1), x, H - pad.bottom + 18);
    });

    yTicks.forEach(v => {
      const y = toCanvasY(v);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(1), pad.left - 8, y + 4);
    });

    // Axis labels
    ctx.font = '12px sans-serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.fillText('Blended Cost ($ per 1M tokens)', pad.left + plotW / 2, H - 6);

    ctx.save();
    ctx.translate(14, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Quality Score', 0, 0);
    ctx.restore();

    // Pareto frontier line
    const paretoSet = computePareto(filteredModels);
    const paretoPoints = points
      .filter(p => paretoSet.has(p.model))
      .sort((a, b) => a.x - b.x);

    if (paretoPoints.length > 1) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(toCanvasX(paretoPoints[0].x), toCanvasY(paretoPoints[0].y));
      for (let i = 1; i < paretoPoints.length; i++) {
        ctx.lineTo(toCanvasX(paretoPoints[i].x), toCanvasY(paretoPoints[i].y));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw dots
    const dotPositions = [];
    points.forEach(p => {
      const cx = toCanvasX(p.x);
      const cy = toCanvasY(p.y);
      const isPareto = paretoSet.has(p.model);
      const r = isPareto ? 7 : 5;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = PROVIDER_COLORS[p.provider] || '#888';
      ctx.fill();
      if (isPareto) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      dotPositions.push({ cx, cy, r: r + 4, point: p });
    });

    // Label Pareto points
    ctx.font = '10px sans-serif';
    paretoPoints.forEach(p => {
      const cx = toCanvasX(p.x);
      const cy = toCanvasY(p.y);
      ctx.fillStyle = textColor;
      ctx.textAlign = 'left';
      ctx.fillText(p.model, cx + 10, cy - 4);
    });

    // Store for hover
    canvas._dotPositions = dotPositions;
    canvas._toCanvasX = toCanvasX;
    canvas._toCanvasY = toCanvasY;
  }

  function niceScale(min, max, ticks) {
    const range = max - min;
    const step = range / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(step)));
    const residual = step / mag;
    let niceStep;
    if (residual <= 1.5) niceStep = 1 * mag;
    else if (residual <= 3) niceStep = 2 * mag;
    else if (residual <= 7) niceStep = 5 * mag;
    else niceStep = 10 * mag;

    const result = [];
    let v = Math.ceil(min / niceStep) * niceStep;
    while (v <= max) {
      result.push(v);
      v += niceStep;
    }
    return result;
  }

  // ===== Chart Hover =====
  function initChartHover() {
    const canvas = document.getElementById('scatter-chart');
    const tooltip = document.getElementById('chart-tooltip');

    canvas.addEventListener('mousemove', (e) => {
      if (!canvas._dotPositions) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let found = null;
      for (const d of canvas._dotPositions) {
        const dist = Math.sqrt((mx - d.cx) ** 2 + (my - d.cy) ** 2);
        if (dist < d.r) { found = d; break; }
      }

      if (found) {
        const p = found.point;
        const m = p.m;
        tooltip.innerHTML = `
          <div class="tt-provider" style="color:${PROVIDER_COLORS[p.provider]}">${p.provider}</div>
          <div class="tt-model">${p.model}</div>
          <div class="tt-row"><span class="tt-label">Send (prompt)</span><span class="tt-value">${formatPrice(m.input_per_mtok)} / 1M tok</span></div>
          <div class="tt-row"><span class="tt-label">Receive (response)</span><span class="tt-value">${formatPrice(m.output_per_mtok)} / 1M tok</span></div>
          <div class="tt-row"><span class="tt-label">Blended avg</span><span class="tt-value">${formatPrice(blendedCost(m))} / 1M tok</span></div>
          <div class="tt-row"><span class="tt-label">Quality</span><span class="tt-value">${qualityScore(m) !== null ? qualityScore(m).toFixed(1) : '-'}</span></div>
          <div class="tt-row"><span class="tt-label">Context</span><span class="tt-value">${formatContext(m.context_window)}</span></div>
        `;
        tooltip.classList.add('visible');

        // Position tooltip
        let tx = e.clientX - rect.left + 15;
        let ty = e.clientY - rect.top - 10;
        if (tx + 260 > rect.width) tx = e.clientX - rect.left - 270;
        if (ty + 150 > rect.height) ty = e.clientY - rect.top - 150;
        tooltip.style.left = tx + 'px';
        tooltip.style.top = ty + 'px';
      } else {
        tooltip.classList.remove('visible');
      }
    });

    canvas.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });
  }

  // ===== Table =====
  function renderTable() {
    const tbody = document.getElementById('model-tbody');
    tbody.innerHTML = '';

    const paretoSet = computePareto(filteredModels);

    // Sort
    const sorted = [...filteredModels].sort((a, b) => {
      let va, vb;
      switch (sortCol) {
        case 'provider': va = a.provider; vb = b.provider; break;
        case 'model': va = a.model; vb = b.model; break;
        case 'input_per_mtok': va = a.input_per_mtok; vb = b.input_per_mtok; break;
        case 'output_per_mtok': va = a.output_per_mtok; vb = b.output_per_mtok; break;
        case 'blended': va = blendedCost(a); vb = blendedCost(b); break;
        case 'context_window': va = a.context_window; vb = b.context_window; break;
        case 'quality': va = qualityScore(a) || 0; vb = qualityScore(b) || 0; break;
        case 'mmlu': va = a.benchmarks?.mmlu || 0; vb = b.benchmarks?.mmlu || 0; break;
        case 'humaneval': va = a.benchmarks?.humaneval || 0; vb = b.benchmarks?.humaneval || 0; break;
        case 'math': va = a.benchmarks?.math || 0; vb = b.benchmarks?.math || 0; break;
        case 'gpqa': va = a.benchmarks?.gpqa || 0; vb = b.benchmarks?.gpqa || 0; break;
        case 'swe_bench': va = a.benchmarks?.swe_bench || 0; vb = b.benchmarks?.swe_bench || 0; break;
        case 'arena_elo': va = a.benchmarks?.arena_elo || 0; vb = b.benchmarks?.arena_elo || 0; break;
        default: va = blendedCost(a); vb = blendedCost(b);
      }
      if (typeof va === 'string') {
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortAsc ? va - vb : vb - va;
    });

    sorted.forEach(m => {
      const tr = document.createElement('tr');
      const provClass = PROVIDER_CLASS[m.provider] || '';
      tr.className = provClass;
      if (paretoSet.has(m.model)) tr.classList.add('pareto-optimal');

      const q = qualityScore(m);
      tr.innerHTML = `
        <td>${m.provider}</td>
        <td style="font-weight:500">${m.model}</td>
        <td>${formatPrice(m.input_per_mtok)}</td>
        <td>${formatPrice(m.output_per_mtok)}</td>
        <td style="font-weight:600">${formatPrice(blendedCost(m))}</td>
        <td>${formatContext(m.context_window)}</td>
        <td style="font-weight:600">${q !== null ? q.toFixed(1) : '-'}</td>
        <td>${formatBenchmark(m.benchmarks?.mmlu)}</td>
        <td>${formatBenchmark(m.benchmarks?.humaneval)}</td>
        <td>${formatBenchmark(m.benchmarks?.math)}</td>
        <td>${formatBenchmark(m.benchmarks?.gpqa)}</td>
        <td>${formatBenchmark(m.benchmarks?.swe_bench)}</td>
        <td>${formatBenchmark(m.benchmarks?.arena_elo)}</td>
        <td>${(m.tags || []).map(t => '<span class="tag-pill">' + t + '</span>').join('')}</td>
      `;
      tbody.appendChild(tr);
    });

    // Update sort arrows
    document.querySelectorAll('#model-table thead th').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      if (!arrow) return;
      if (th.dataset.sort === sortCol) {
        arrow.textContent = sortAsc ? ' \u25B2' : ' \u25BC';
      } else {
        arrow.textContent = '';
      }
    });
  }

  function initTableSort() {
    document.querySelectorAll('#model-table thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortCol === col) {
          sortAsc = !sortAsc;
        } else {
          sortCol = col;
          sortAsc = true;
        }
        renderTable();
      });
    });
  }

  // ===== Resize =====
  function initResize() {
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => renderChart(), 150);
    });
  }

  // ===== Boot =====
  document.addEventListener('DOMContentLoaded', () => {
    init().then(() => {
      initCostEstimator();
      initChartHover();
      initTableSort();
      initResize();
    });
  });
})();
