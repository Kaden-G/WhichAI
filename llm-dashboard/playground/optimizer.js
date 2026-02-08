(function () {
  'use strict';

  const META_PROMPT = `You are a prompt engineering expert. The user will describe a task in plain English. Your job is to create an optimized prompt consisting of a system prompt and a user prompt template.

Apply these prompt engineering principles:
1. CLARITY: Use precise, unambiguous language
2. CONTEXT: Provide relevant background and constraints
3. STRUCTURE: Use clear formatting (headers, lists, sections)
4. SPECIFICITY: Define exact output format, length, and style
5. EXAMPLES: Include 1-2 examples when it helps clarify expectations
6. GUARDRAILS: Add boundaries to prevent off-topic or harmful outputs

Output your response using these exact markers:

===SYSTEM_PROMPT===
[The system prompt goes here]
===USER_PROMPT===
[The user prompt template goes here, with [PLACEHOLDER] for user-provided values]
===EXPLANATION===
[Brief explanation of what you improved and why]`;

  async function optimizePrompt(description, provider, apiKey, modelName) {
    if (!description.trim()) throw new Error('Please describe what you want the prompt to do.');
    if (!apiKey) throw new Error('Set an API key first in Settings.');

    const messages = [
      { role: 'system', content: META_PROMPT },
      { role: 'user', content: `Create an optimized prompt for this task:\n\n${description}` },
    ];

    const result = await window.Providers.callModel(provider, apiKey, modelName, messages, {
      temperature: 0.7,
      maxTokens: 2048,
    });

    return parseOptimizerOutput(result.content);
  }

  function parseOptimizerOutput(text) {
    const systemMatch = text.match(/===SYSTEM_PROMPT===\s*([\s\S]*?)===USER_PROMPT===/);
    const userMatch = text.match(/===USER_PROMPT===\s*([\s\S]*?)===EXPLANATION===/);
    const explanationMatch = text.match(/===EXPLANATION===\s*([\s\S]*?)$/);

    if (!systemMatch || !userMatch) {
      // Fallback: treat the entire output as a user prompt
      return {
        systemPrompt: '',
        userPrompt: text.trim(),
        explanation: 'Could not parse structured output. The full response is shown as the user prompt.',
      };
    }

    return {
      systemPrompt: systemMatch[1].trim(),
      userPrompt: userMatch[1].trim(),
      explanation: explanationMatch ? explanationMatch[1].trim() : '',
    };
  }

  window.PromptOptimizer = {
    optimizePrompt,
    parseOptimizerOutput,
  };
})();
