(function () {
  'use strict';

  // ===== Default Stage Definitions =====
  const DEFAULT_STAGES = [
    {
      id: 'architect',
      label: 'Architect',
      systemPrompt: 'You are a software architect. Given a task, create a detailed step-by-step implementation plan. Break the work into clear, numbered steps. Specify technologies, file structure, data flow, and edge cases. Do NOT write code — only plan.',
      modelPreferences: ['Gemini 2.5 Flash', 'GPT-4.1 Mini', 'Claude Haiku 4.5'],
      temperature: 0.7,
    },
    {
      id: 'critic',
      label: 'Critic',
      systemPrompt: 'You are a senior code reviewer and technical critic. You will receive a task and a proposed plan. Review the plan for completeness, correctness, security issues, performance concerns, and edge cases. Output an improved version of the plan with your corrections and additions clearly marked.',
      modelPreferences: ['Claude Sonnet 4.5', 'Gemini 2.5 Pro', 'GPT-4o'],
      temperature: 0.5,
    },
    {
      id: 'builder',
      label: 'Builder',
      systemPrompt: 'You are an expert software engineer. You will receive a task and a reviewed implementation plan. Execute the plan by writing complete, production-ready code. Include all necessary files, imports, error handling, and comments. Output the full implementation.',
      modelPreferences: ['Claude Sonnet 4.5', 'GPT-4.1', 'Gemini 2.5 Pro'],
      temperature: 0.4,
    },
    {
      id: 'qa',
      label: 'QA / Debugger',
      systemPrompt: 'You are a QA engineer and debugger. You will receive a task, the implementation plan, and the code implementation. Review the code for bugs, logic errors, missing edge cases, and security vulnerabilities. Write tests where appropriate. Output a corrected version of the code with all fixes applied and a summary of what you changed and why.',
      modelPreferences: ['Gemini 2.5 Pro', 'Claude Sonnet 4', 'GPT-4o'],
      temperature: 0.3,
    },
  ];

  const MAX_STAGES = 6;
  const MIN_STAGES = 2;

  // ===== Stage Management =====
  let stages = [];
  let stageIdCounter = 0;

  function createStage(overrides = {}) {
    stageIdCounter++;
    return {
      id: overrides.id || `custom-${stageIdCounter}`,
      label: overrides.label || `Stage ${stageIdCounter}`,
      systemPrompt: overrides.systemPrompt || 'You are a helpful AI assistant. Complete the task given to you.',
      modelPreferences: overrides.modelPreferences || ['Claude Sonnet 4.5', 'GPT-4o', 'Gemini 2.5 Pro'],
      temperature: overrides.temperature ?? 0.7,
      modelOverride: overrides.modelOverride || null,
    };
  }

  function resetStages() {
    stageIdCounter = 0;
    stages = DEFAULT_STAGES.map(s => createStage(s));
  }

  function getStages() {
    return stages.map(s => ({ ...s }));
  }

  function setStages(newStages) {
    stages = newStages.map(s => ({ ...s }));
  }

  function addStage(afterIndex) {
    if (stages.length >= MAX_STAGES) return false;
    const newStage = createStage({ label: `Custom Stage ${stages.length + 1}` });
    const idx = afterIndex != null ? afterIndex + 1 : stages.length;
    stages.splice(idx, 0, newStage);
    return true;
  }

  function removeStage(index) {
    if (stages.length <= MIN_STAGES) return false;
    stages.splice(index, 1);
    return true;
  }

  function moveStage(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= stages.length) return false;
    if (toIndex < 0 || toIndex >= stages.length) return false;
    const [stage] = stages.splice(fromIndex, 1);
    stages.splice(toIndex, 0, stage);
    return true;
  }

  function updateStage(index, updates) {
    if (index < 0 || index >= stages.length) return false;
    Object.assign(stages[index], updates);
    return true;
  }

  // ===== Model Resolution =====
  function resolveModel(stage, apiKeys) {
    if (stage.modelOverride) {
      const provider = window.Providers.getProvider(stage.modelOverride);
      if (provider && apiKeys[provider]) return stage.modelOverride;
    }
    for (const modelName of stage.modelPreferences) {
      const provider = window.Providers.getProvider(modelName);
      if (provider && apiKeys[provider]) return modelName;
    }
    return null;
  }

  // ===== Stage Input Builder =====
  function buildStageInput(stageIndex, userPrompt, previousOutputs) {
    if (stageIndex === 0) {
      return userPrompt;
    }

    const parts = [`ORIGINAL TASK:\n${userPrompt}`];

    if (stageIndex === 1) {
      // Critic gets original task + plan
      parts.push(`\nPLAN TO REVIEW:\n${previousOutputs[0] || ''}`);
    } else if (stageIndex === 2) {
      // Builder gets original task + reviewed plan
      parts.push(`\nREVIEWED PLAN:\n${previousOutputs[1] || previousOutputs[0] || ''}`);
    } else if (stageIndex === 3) {
      // QA gets original task + plan + implementation
      parts.push(`\nPLAN:\n${previousOutputs[1] || previousOutputs[0] || ''}`);
      parts.push(`\nIMPLEMENTATION:\n${previousOutputs[2] || ''}`);
    } else {
      // Custom stages beyond 4: get original task + all previous outputs
      previousOutputs.forEach((output, i) => {
        if (output) {
          parts.push(`\nSTAGE ${i + 1} (${stages[i]?.label || 'Unknown'}) OUTPUT:\n${output}`);
        }
      });
    }

    return parts.join('\n');
  }

  // ===== Pipeline Runner =====
  let abortController = null;

  async function runPipeline(userPrompt, apiKeys, callbacks = {}) {
    const {
      onStageStart,    // (stageIndex, stage, resolvedModel) => void
      onStageChunk,    // (stageIndex, chunk) => void
      onStageComplete, // (stageIndex, result) => void
      onStageError,    // (stageIndex, error) => void
      onPipelineComplete, // (summary) => void
    } = callbacks;

    abortController = new AbortController();
    const previousOutputs = [];
    const summary = {
      stages: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalTime: 0,
    };

    for (let i = 0; i < stages.length; i++) {
      if (abortController.signal.aborted) break;

      const stage = stages[i];
      const resolvedModel = resolveModel(stage, apiKeys);

      if (!resolvedModel) {
        const err = new Error(`No available model for stage "${stage.label}". Add an API key in Settings.`);
        if (onStageError) onStageError(i, err);
        summary.stages.push({ index: i, label: stage.label, model: null, error: err.message });
        break;
      }

      const provider = window.Providers.getProvider(resolvedModel);
      const apiKey = apiKeys[provider];

      if (onStageStart) onStageStart(i, stage, resolvedModel);

      const stageInput = buildStageInput(i, userPrompt, previousOutputs);
      const messages = [
        { role: 'system', content: stage.systemPrompt },
        { role: 'user', content: stageInput },
      ];

      const startTime = Date.now();

      try {
        const result = await window.Providers.callModelStreaming(
          provider, apiKey, resolvedModel, messages,
          { temperature: stage.temperature, maxTokens: 4096 },
          (chunk) => {
            if (abortController.signal.aborted) return;
            if (onStageChunk) onStageChunk(i, chunk);
          }
        );

        if (abortController.signal.aborted) break;

        const elapsed = (Date.now() - startTime) / 1000;
        previousOutputs.push(result.content);

        const stageResult = {
          index: i,
          label: stage.label,
          model: resolvedModel,
          provider,
          content: result.content,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: 0,
          time: elapsed,
        };

        // Calculate cost from data.json model info if available
        const modelData = window.Providers._allModels?.find(m => m.model === resolvedModel);
        if (modelData) {
          stageResult.cost = (result.inputTokens / 1e6) * modelData.input_per_mtok
            + (result.outputTokens / 1e6) * modelData.output_per_mtok;
        }

        summary.stages.push(stageResult);
        summary.totalInputTokens += result.inputTokens;
        summary.totalOutputTokens += result.outputTokens;
        summary.totalCost += stageResult.cost;
        summary.totalTime += elapsed;

        if (onStageComplete) onStageComplete(i, stageResult);

      } catch (err) {
        if (abortController.signal.aborted) break;
        previousOutputs.push('');
        if (onStageError) onStageError(i, err);
        summary.stages.push({ index: i, label: stage.label, model: resolvedModel, error: err.message });
        break;
      }
    }

    abortController = null;
    if (onPipelineComplete) onPipelineComplete(summary);
    return summary;
  }

  function abortPipeline() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  function isRunning() {
    return abortController !== null;
  }

  // Initialize with defaults
  resetStages();

  // ===== Exports =====
  window.Pipeline = {
    DEFAULT_STAGES,
    MAX_STAGES,
    MIN_STAGES,
    getStages,
    setStages,
    resetStages,
    addStage,
    removeStage,
    moveStage,
    updateStage,
    resolveModel,
    buildStageInput,
    runPipeline,
    abortPipeline,
    isRunning,
  };
})();
