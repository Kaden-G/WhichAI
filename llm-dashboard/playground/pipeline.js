(function () {
  'use strict';

  // ===== Pipeline Modes (Scope Governor) =====
  const PIPELINE_MODES = {
    brainstorm: {
      label: 'Brainstorm Only',
      description: 'Ideate and refine — no code or architecture',
      activeStageIds: ['architect', 'critic'],
      promptOverrides: {
        architect: 'You are a creative product thinker and strategist. Brainstorm features, approaches, and ideas for the given task. Focus on WHAT to build and WHY — not HOW. Output a prioritized list of ideas with brief rationale for each. Do NOT write code, pseudo-code, or detailed architecture unless the user explicitly asks.',
        critic: 'You are a product critic and strategist. Review the brainstorm for feasibility, impact, and completeness. Add missing ideas, flag impractical ones, and rank by value vs effort. Deliver only a refined feature brainstorm. Do NOT produce code or detailed architecture.',
      },
    },
    full: {
      label: 'Full Implementation',
      description: 'Plan \u2192 Review \u2192 Build \u2192 QA \u2192 Present',
      activeStageIds: null, // null = all stages
      promptOverrides: {},
    },
  };

  let pipelineMode = 'full';
  let pipelineSpec = ''; // User-defined shared constants/constraints

  // ===== Performance Rules (injected into code-producing stages) =====
  const PERFORMANCE_RULES = `
PERFORMANCE RULES (enforce strictly):
- NEVER use .iterrows(), row-wise .apply(axis=1), or for-loops over DataFrame rows for windowed/aggregated features.
- ALWAYS use vectorized operations: pandas .rolling(), .expanding(), .cumsum(), .shift(), numpy vectorized ops, or SQL window functions.
- Row-wise iteration is ONLY acceptable if the dataset is explicitly stated to be small (<1000 rows) or the operation truly cannot be vectorized.
- Prefer built-in library methods over manual reimplementation.`;

  const CONSISTENCY_RULE = `
CONSISTENCY RULE: If a PROJECT SPEC is provided, treat ALL values in it as canonical. Never introduce contradicting constants, thresholds, sentinel values, or naming conventions. If you must deviate, explicitly state why.`;

  // ===== Default Stage Definitions =====
  const DEFAULT_STAGES = [
    {
      id: 'architect',
      label: 'Architect',
      systemPrompt: 'You are a software architect. Given a task, create a detailed step-by-step implementation plan. Break the work into clear, numbered steps. Specify technologies, file structure, data flow, and edge cases. Do NOT write code \u2014 only plan.' + CONSISTENCY_RULE,
      modelPreferences: ['Gemini 2.5 Flash', 'GPT-4.1 Mini', 'Claude Haiku 4.5'],
      temperature: 0.7,
      hasGate: false,
    },
    {
      id: 'critic',
      label: 'Critic',
      systemPrompt: 'You are a senior code reviewer and technical critic. You will receive a task and a proposed plan. Review the plan for completeness, correctness, security issues, performance concerns, and edge cases. Output an improved version of the plan with your corrections and additions clearly marked.' + CONSISTENCY_RULE,
      modelPreferences: ['Claude Sonnet 4.5', 'Gemini 2.5 Pro', 'GPT-4o'],
      temperature: 0.5,
      hasGate: false,
    },
    {
      id: 'builder',
      label: 'Builder',
      systemPrompt: 'You are an expert software engineer. You will receive a task and a reviewed implementation plan. Execute the plan by writing complete, production-ready code. Output EVERY file in full \u2014 include all imports, error handling, types, and comments. Use clear file-path headers (e.g. "// === filename.ext ===") so the user can copy each file. Do not summarize or abbreviate any part of the code.' + PERFORMANCE_RULES + CONSISTENCY_RULE,
      modelPreferences: ['GPT-4.1', 'Gemini 2.5 Flash', 'Claude Haiku 4.5'],
      temperature: 0.4,
      hasGate: true,
    },
    {
      id: 'qa',
      label: 'QA / Debugger',
      systemPrompt: 'You are a QA engineer and debugger. You will receive a task, the implementation plan, and the code implementation. Find every bug, logic error, missing edge case, and security vulnerability \u2014 then FIX THEM ALL. Output the COMPLETE, CORRECTED, READY-TO-RUN code with all fixes applied. Do not output diffs or partial snippets \u2014 output every file in full so the next stage can use it directly. After the code, add a brief "## Changes Made" section listing each fix.' + PERFORMANCE_RULES + CONSISTENCY_RULE,
      modelPreferences: ['Gemini 2.5 Pro', 'Claude Sonnet 4', 'GPT-4o'],
      temperature: 0.3,
      hasGate: true,
    },
    {
      id: 'presenter',
      label: 'Presenter',
      systemPrompt: `You are a technical presenter and documentation expert. You will receive a completed project (task + final code). Your job is to package it into a polished, COMPLETE deliverable.

CRITICAL RULES:
- You MUST include the COMPLETE, FINAL source code for EVERY file in your output. Do NOT summarize, abbreviate, or omit any code.
- Use clear file-path headers for each file: \`\`\`language:path/to/filename.ext (e.g. \`\`\`python:src/main.py)
- The user will download these files directly from your output. If you leave code out, they get an incomplete project.

Your output MUST include these sections IN ORDER:

## Project Overview
One-paragraph summary of what was built and why.

## Quick Start
Step-by-step instructions to get the project running (install dependencies, environment setup, run commands). Be specific \u2014 include exact terminal commands.

## Complete Source Code
Output EVERY file in full using fenced code blocks with the format:
\`\`\`language:path/to/file.ext
// complete file contents here
\`\`\`
Do NOT skip any file. Do NOT abbreviate. Each code block MUST have the language:filepath format so the user can download each file individually.

## File Structure
List every file with a one-line description.

## Usage Examples
2\u20133 concrete examples showing how to use the project.

## Next Steps (Optional Enhancements)
3\u20135 ideas for future improvements.

If the user requests a specific format (git repo structure, PowerPoint outline, Word doc, README, etc.), adapt your output to that format but ALWAYS include the complete source code.`,
      modelPreferences: ['Gemini 2.5 Flash', 'GPT-4.1 Mini', 'Claude Haiku 4.5'],
      temperature: 0.6,
      hasGate: false,
    },
  ];

  const MAX_STAGES = 8;
  const MIN_STAGES = 2;
  const MAX_GATE_RETRIES = 1;

  // ===== Gate Functions (Artifact Completeness + Performance + Execution) =====
  const TRUNCATION_PATTERNS = [
    { re: /\.{3}\s*$/m,                      msg: 'Trailing "..." suggests truncated output' },
    { re: /\[rest of (code|file|implementation|function)\]/i, msg: 'Placeholder "[rest of ...]" found' },
    { re: /#\s*TODO:?\s*(implement|add|complete|finish)/i,    msg: 'TODO placeholder in code' },
    { re: /\/\/\s*\.{3}\s*$/m,               msg: 'Trailing "// ..." suggests truncated code' },
    { re: /\[truncated\]/i,                   msg: '"[truncated]" marker found' },
    { re: /\[continued\]/i,                   msg: '"[continued]" marker found' },
    { re: /pass\s+#\s*(TODO|placeholder|implement)/i, msg: '"pass # TODO" placeholder in Python' },
    { re: /raise NotImplementedError/,        msg: 'NotImplementedError \u2014 unfinished implementation' },
    { re: /\/\/ TODO\b/i,                     msg: 'TODO comment in code' },
  ];

  const PERF_ANTI_PATTERNS = [
    { re: /\.iterrows\s*\(/g,                           msg: '.iterrows() \u2014 use vectorized operations instead' },
    { re: /\.apply\s*\([^)]*axis\s*=\s*1/g,             msg: 'Row-wise .apply(axis=1) \u2014 use vectorized alternative' },
    { re: /for\s+\w+\s+in\s+range\s*\(\s*len\s*\(/g,   msg: 'for i in range(len(df)) \u2014 use vectorized operations' },
    { re: /for\s+\w+\s*,\s*\w+\s+in\s+\w+\.itertuples/g, msg: 'itertuples() loop \u2014 consider vectorized operations' },
  ];

  function checkArtifactCompleteness(content) {
    const issues = [];
    for (const { re, msg } of TRUNCATION_PATTERNS) {
      if (re.test(content)) issues.push(msg);
    }
    // Check for empty function/class bodies (Python)
    const emptyPy = (content.match(/def\s+\w+[^:]*:\s*\n\s*pass\b/g) || []).length;
    if (emptyPy > 0) issues.push(`${emptyPy} empty Python function(s) with just "pass"`);
    // Check for empty JS/TS function bodies
    const emptyJs = (content.match(/(?:function\s+\w+|=>\s*)\s*\{\s*\}/g) || []).length;
    if (emptyJs > 0) issues.push(`${emptyJs} empty function body/bodies in JS/TS`);
    return issues;
  }

  function checkPerformanceRules(content) {
    const issues = [];
    for (const { re, msg } of PERF_ANTI_PATTERNS) {
      re.lastIndex = 0; // reset global regex
      if (re.test(content)) issues.push(msg);
    }
    return issues;
  }

  function checkConsistency(content, spec) {
    const issues = [];
    if (!spec) return issues;
    // Extract key=value pairs from spec and look for contradictions
    const specLines = spec.split('\n');
    for (const line of specLines) {
      const match = line.match(/^\s*(\w+)\s*[=:]\s*(.+)\s*$/);
      if (!match) continue;
      const [, name, value] = match;
      const trimVal = value.trim().replace(/^["']|["']$/g, '');
      // Look for assignments of this name with a different value
      const assignRe = new RegExp(`\\b${name}\\s*=\\s*([^\\s;,]+)`, 'g');
      let m;
      while ((m = assignRe.exec(content)) !== null) {
        const found = m[1].replace(/^["']|["']$/g, '');
        if (found !== trimVal && found !== value.trim()) {
          issues.push(`Spec conflict: "${name}" should be ${trimVal} but found ${found}`);
        }
      }
    }
    return issues;
  }

  function runGates(content, spec) {
    return [
      ...checkArtifactCompleteness(content),
      ...checkPerformanceRules(content),
      ...checkConsistency(content, spec),
    ];
  }

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
      hasGate: overrides.hasGate || false,
    };
  }

  function resetStages() {
    stageIdCounter = 0;
    stages = DEFAULT_STAGES.map(s => createStage(s));
  }

  function getStages() {
    return stages.map(s => ({ ...s }));
  }

  function getActiveStages() {
    const mode = PIPELINE_MODES[pipelineMode];
    if (!mode || !mode.activeStageIds) return stages;
    return stages.filter(s => mode.activeStageIds.includes(s.id));
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
  function buildStageInput(stageIndex, userPrompt, previousOutputs, opts = {}) {
    const { spec, gateIssues } = opts;

    // Spec prefix
    let prefix = '';
    if (spec) {
      prefix = `PROJECT SPEC (shared constraints \u2014 follow these exactly):\n${spec}\n\n`;
    }

    if (stageIndex === 0) {
      return prefix + userPrompt;
    }

    const parts = [prefix + `ORIGINAL TASK:\n${userPrompt}`];

    if (stageIndex === 1) {
      parts.push(`\nPLAN TO REVIEW:\n${previousOutputs[0] || ''}`);
    } else if (stageIndex === 2) {
      parts.push(`\nREVIEWED PLAN:\n${previousOutputs[1] || previousOutputs[0] || ''}`);
    } else if (stageIndex === 3) {
      parts.push(`\nPLAN:\n${previousOutputs[1] || previousOutputs[0] || ''}`);
      parts.push(`\nIMPLEMENTATION:\n${previousOutputs[2] || ''}`);
    } else if (stageIndex === 4) {
      parts.push(`\nFINAL CODE:\n${previousOutputs[3] || previousOutputs[2] || ''}`);
    } else {
      previousOutputs.forEach((output, i) => {
        if (output) {
          parts.push(`\nSTAGE ${i + 1} (${stages[i]?.label || 'Unknown'}) OUTPUT:\n${output}`);
        }
      });
    }

    // Append gate feedback if this is a retry
    if (gateIssues && gateIssues.length > 0) {
      parts.push(`\n\nGATE FEEDBACK \u2014 the previous output had these issues. Fix ALL of them:\n${gateIssues.map((g, j) => `${j + 1}. ${g}`).join('\n')}`);
    }

    return parts.join('\n');
  }

  // ===== Pipeline Runner =====
  let abortController = null;

  async function runPipeline(userPrompt, apiKeys, callbacks = {}) {
    const {
      onStageStart,       // (stageIndex, stage, resolvedModel) => void
      onStageChunk,       // (stageIndex, chunk) => void
      onStageComplete,    // (stageIndex, result) => void
      onStageError,       // (stageIndex, error) => void
      onGateCheck,        // (stageIndex, issues[]) => void
      onGateRetry,        // (stageIndex, attempt) => void
      onPipelineComplete, // (summary) => void
    } = callbacks;

    abortController = new AbortController();
    const activeStages = getActiveStages();
    const previousOutputs = [];
    let pendingGateIssues = null; // Issues from Builder gate → fed to QA input
    const summary = {
      stages: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalTime: 0,
      gateResults: [], // {stageIndex, issues[], retried}
    };

    // Get the effective system prompt (with mode overrides)
    const mode = PIPELINE_MODES[pipelineMode];
    function getEffectivePrompt(stage) {
      if (mode && mode.promptOverrides && mode.promptOverrides[stage.id]) {
        return mode.promptOverrides[stage.id];
      }
      return stage.systemPrompt;
    }

    for (let i = 0; i < activeStages.length; i++) {
      if (abortController.signal.aborted) break;

      const stage = activeStages[i];
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

      // Build input — include pending gate issues from previous stage if applicable
      const inputOpts = { spec: pipelineSpec || null };
      if (pendingGateIssues && stage.id === 'qa') {
        inputOpts.gateIssues = pendingGateIssues;
        pendingGateIssues = null;
      }

      const stageInput = buildStageInput(i, userPrompt, previousOutputs, inputOpts);
      const systemPrompt = getEffectivePrompt(stage);

      // Execute stage (with possible gate retry)
      let retryCount = 0;
      let finalResult = null;
      let currentInput = stageInput;

      while (retryCount <= (stage.hasGate ? MAX_GATE_RETRIES : 0)) {
        if (abortController.signal.aborted) break;

        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: currentInput },
        ];

        const startTime = Date.now();

        try {
          const result = await window.Providers.callModelStreaming(
            provider, apiKey, resolvedModel, messages,
            { temperature: stage.temperature, maxTokens: 8192 },
            (chunk) => {
              if (abortController.signal.aborted) return;
              if (onStageChunk) onStageChunk(i, chunk);
            }
          );

          if (abortController.signal.aborted) break;

          const elapsed = (Date.now() - startTime) / 1000;

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
            retryCount,
          };

          const modelData = window.Providers._allModels?.find(m => m.model === resolvedModel);
          if (modelData) {
            stageResult.cost = (result.inputTokens / 1e6) * modelData.input_per_mtok
              + (result.outputTokens / 1e6) * modelData.output_per_mtok;
          }

          finalResult = stageResult;

          // Run gates if applicable
          if (stage.hasGate && result.content) {
            const issues = runGates(result.content, pipelineSpec || null);
            summary.gateResults.push({ stageIndex: i, issues, retried: false });
            if (onGateCheck) onGateCheck(i, issues);

            if (issues.length > 0 && retryCount < MAX_GATE_RETRIES) {
              // For Builder: store issues to feed to QA instead of retrying Builder
              if (stage.id === 'builder') {
                pendingGateIssues = issues;
                break; // Exit retry loop, let QA handle it
              }
              // For QA: retry with gate feedback
              retryCount++;
              summary.gateResults[summary.gateResults.length - 1].retried = true;
              if (onGateRetry) onGateRetry(i, retryCount);
              currentInput = stageInput + `\n\nGATE FEEDBACK (attempt ${retryCount}) \u2014 fix ALL of these issues:\n${issues.map((g, j) => `${j + 1}. ${g}`).join('\n')}`;
              continue; // Retry the stage
            }
          }

          break; // Exit retry loop on success (or no gate / no issues)

        } catch (err) {
          if (abortController.signal.aborted) break;
          finalResult = { index: i, label: stage.label, model: resolvedModel, error: err.message };
          break;
        }
      }

      if (abortController.signal.aborted) break;

      if (finalResult) {
        if (finalResult.error) {
          previousOutputs.push('');
          if (onStageError) onStageError(i, new Error(finalResult.error));
          summary.stages.push(finalResult);
          break;
        }

        previousOutputs.push(finalResult.content);
        summary.stages.push(finalResult);
        summary.totalInputTokens += finalResult.inputTokens;
        summary.totalOutputTokens += finalResult.outputTokens;
        summary.totalCost += finalResult.cost;
        summary.totalTime += finalResult.time;
        if (onStageComplete) onStageComplete(i, finalResult);
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

  function setMode(mode) {
    if (PIPELINE_MODES[mode]) pipelineMode = mode;
  }

  function getMode() {
    return pipelineMode;
  }

  function setSpec(spec) {
    pipelineSpec = spec || '';
  }

  function getSpec() {
    return pipelineSpec;
  }

  // Initialize with defaults
  resetStages();

  // ===== Exports =====
  window.Pipeline = {
    PIPELINE_MODES,
    DEFAULT_STAGES,
    MAX_STAGES,
    MIN_STAGES,
    getStages,
    getActiveStages,
    setStages,
    resetStages,
    addStage,
    removeStage,
    moveStage,
    updateStage,
    resolveModel,
    buildStageInput,
    runGates,
    runPipeline,
    abortPipeline,
    isRunning,
    setMode,
    getMode,
    setSpec,
    getSpec,
  };
})();
