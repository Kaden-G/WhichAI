(function () {
  'use strict';

  const STORAGE_KEY = 'whichai-prompt-library';

  // ===== 24 Starter Templates (2 per use case) =====
  const STARTERS = [
    // Coding
    {
      id: 'starter-code-review', name: 'Code Review', useCase: 'coding', tags: ['code'],
      systemPrompt: 'You are a senior software engineer performing a thorough code review. Focus on correctness, performance, security, readability, and best practices. Be specific and cite line numbers.',
      userPrompt: 'Please review the following code:\n\n```\n[PASTE CODE HERE]\n```\n\nProvide feedback organized by: Critical Issues, Improvements, and Nitpicks.',
      isStarter: true,
    },
    {
      id: 'starter-unit-tests', name: 'Write Unit Tests', useCase: 'coding', tags: ['code', 'testing'],
      systemPrompt: 'You are a test engineer who writes comprehensive unit tests. Use the appropriate testing framework for the language. Cover edge cases, error conditions, and happy paths.',
      userPrompt: 'Write unit tests for the following function:\n\n```\n[PASTE FUNCTION HERE]\n```\n\nInclude tests for: normal inputs, edge cases, error handling, and boundary conditions.',
      isStarter: true,
    },
    // Reasoning
    {
      id: 'starter-pros-cons', name: 'Pros/Cons Analysis', useCase: 'reasoning', tags: ['analysis'],
      systemPrompt: 'You are a strategic analyst. Provide balanced, well-reasoned analysis. Consider short-term and long-term implications. Be specific with evidence and examples.',
      userPrompt: 'Analyze the pros and cons of the following decision:\n\n[DESCRIBE DECISION]\n\nConsider: cost, time, risk, scalability, team impact, and alternatives.',
      isStarter: true,
    },
    {
      id: 'starter-root-cause', name: 'Root Cause Analysis', useCase: 'reasoning', tags: ['analysis', 'debugging'],
      systemPrompt: 'You are an expert in root cause analysis using the "5 Whys" and Ishikawa (fishbone) methods. Be systematic and thorough. Identify contributing factors, not just the immediate cause.',
      userPrompt: 'Perform a root cause analysis for the following problem:\n\n[DESCRIBE THE PROBLEM]\n\nUse the 5 Whys method, then summarize with a fishbone diagram (in text form) showing all contributing factors.',
      isStarter: true,
    },
    // Classification
    {
      id: 'starter-sentiment', name: 'Sentiment Classifier', useCase: 'classification', tags: ['nlp'],
      systemPrompt: 'You are a sentiment analysis system. Classify text into exactly one of: POSITIVE, NEGATIVE, NEUTRAL, or MIXED. Also provide a confidence score (0.0-1.0) and a brief justification. Output valid JSON.',
      userPrompt: 'Classify the sentiment of each text below. Return a JSON array.\n\nTexts:\n1. "[TEXT 1]"\n2. "[TEXT 2]"\n3. "[TEXT 3]"\n\nFormat: [{"text_id": 1, "sentiment": "...", "confidence": 0.0, "reason": "..."}]',
      isStarter: true,
    },
    {
      id: 'starter-intent-router', name: 'Intent Router', useCase: 'classification', tags: ['nlp', 'chatbot'],
      systemPrompt: 'You are an intent classification system for a customer support chatbot. Classify user messages into one of these intents: BILLING, TECHNICAL_SUPPORT, ACCOUNT, GENERAL_INQUIRY, COMPLAINT, CANCEL, UPGRADE. Return JSON with intent and confidence.',
      userPrompt: 'Classify the intent of this customer message:\n\n"[CUSTOMER MESSAGE]"\n\nReturn: {"intent": "...", "confidence": 0.0, "sub_intent": "...", "suggested_action": "..."}',
      isStarter: true,
    },
    // Extraction
    {
      id: 'starter-json-extractor', name: 'JSON Entity Extractor', useCase: 'extraction', tags: ['nlp', 'data'],
      systemPrompt: 'You are a precise entity extraction system. Extract structured data from unstructured text. Output valid JSON only. If a field cannot be determined, use null. Never fabricate information.',
      userPrompt: 'Extract entities from the following text into a JSON object:\n\n"[PASTE TEXT]"\n\nExtract: names, dates, locations, organizations, monetary amounts, and any other key entities.\n\nFormat: {"entities": [{"type": "...", "value": "...", "context": "..."}]}',
      isStarter: true,
    },
    {
      id: 'starter-resume-parser', name: 'Resume Parser', useCase: 'extraction', tags: ['hr', 'data'],
      systemPrompt: 'You are a resume parsing system. Extract structured information from resumes into a standardized JSON format. Be thorough but only extract what is explicitly stated.',
      userPrompt: 'Parse this resume into structured JSON:\n\n[PASTE RESUME TEXT]\n\nExtract: {name, email, phone, location, summary, experience: [{title, company, dates, bullets}], education: [{degree, school, year}], skills: []}',
      isStarter: true,
    },
    // Summarization
    {
      id: 'starter-exec-summary', name: 'Executive Summary', useCase: 'summarization', tags: ['business'],
      systemPrompt: 'You write concise executive summaries for busy decision-makers. Lead with the key takeaway. Use bullet points. Keep it under 200 words. Highlight action items and decisions needed.',
      userPrompt: 'Write an executive summary of the following:\n\n[PASTE DOCUMENT / REPORT]\n\nStructure: Key Takeaway (1 sentence), Background (2-3 bullets), Findings (3-5 bullets), Recommended Actions (numbered list).',
      isStarter: true,
    },
    {
      id: 'starter-meeting-notes', name: 'Meeting Notes', useCase: 'summarization', tags: ['business', 'productivity'],
      systemPrompt: 'You are a meeting summarizer. Extract key points, decisions, and action items from meeting transcripts. Be concise. Attribute action items to specific people when possible.',
      userPrompt: 'Summarize this meeting transcript:\n\n[PASTE TRANSCRIPT]\n\nFormat:\n- Attendees:\n- Key Discussion Points:\n- Decisions Made:\n- Action Items: (who, what, by when)\n- Follow-up Meeting: (if mentioned)',
      isStarter: true,
    },
    // Math
    {
      id: 'starter-math-solver', name: 'Step-by-Step Solver', useCase: 'math', tags: ['math', 'education'],
      systemPrompt: 'You are a patient math tutor. Solve problems step by step, explaining your reasoning at each stage. Use proper mathematical notation. Verify your answer at the end.',
      userPrompt: 'Solve this problem step by step:\n\n[MATH PROBLEM]\n\nShow every step clearly. Explain the reasoning behind each step. Verify your final answer.',
      isStarter: true,
    },
    {
      id: 'starter-stats-calc', name: 'Statistics Calculator', useCase: 'math', tags: ['math', 'data'],
      systemPrompt: 'You are a statistician. Perform statistical calculations and explain results in plain language. Show formulas used. Provide interpretations alongside numbers.',
      userPrompt: 'Perform statistical analysis on this data:\n\n[DATA SET]\n\nCalculate: mean, median, mode, standard deviation, quartiles, and any relevant tests. Visualize the distribution in ASCII if helpful. Interpret the results.',
      isStarter: true,
    },
    // Creative
    {
      id: 'starter-blog-writer', name: 'Blog Post Writer', useCase: 'creative', tags: ['writing', 'marketing'],
      systemPrompt: 'You are a skilled content writer. Write engaging, well-structured blog posts. Use a conversational but authoritative tone. Include headers, an introduction hook, and a clear conclusion with a call-to-action.',
      userPrompt: 'Write a blog post about:\n\nTopic: [TOPIC]\nTarget Audience: [AUDIENCE]\nTone: [professional / casual / technical]\nWord Count: ~[NUMBER] words\n\nInclude an attention-grabbing title, introduction, 3-5 key sections with subheadings, and a conclusion.',
      isStarter: true,
    },
    {
      id: 'starter-email-drafter', name: 'Email Drafter', useCase: 'creative', tags: ['writing', 'business'],
      systemPrompt: 'You write clear, professional emails. Match the tone to the context (formal for executives, friendly for colleagues, diplomatic for complaints). Be concise. Always include a clear call-to-action.',
      userPrompt: 'Draft an email:\n\nTo: [RECIPIENT / ROLE]\nContext: [SITUATION]\nGoal: [WHAT YOU WANT TO ACHIEVE]\nTone: [formal / friendly / urgent]\n\nWrite the email with subject line, body, and sign-off.',
      isStarter: true,
    },
    // Translation
    {
      id: 'starter-contextual-translation', name: 'Contextual Translation', useCase: 'translation', tags: ['language'],
      systemPrompt: 'You are an expert translator. Translate naturally, preserving meaning, tone, and cultural context. When idioms or culture-specific references exist, provide the adapted equivalent rather than a literal translation. Note any culturally significant choices.',
      userPrompt: 'Translate the following from [SOURCE LANGUAGE] to [TARGET LANGUAGE]:\n\n"[TEXT TO TRANSLATE]"\n\nContext: [e.g., formal document / casual conversation / marketing copy]\n\nProvide the translation and note any cultural adaptations made.',
      isStarter: true,
    },
    {
      id: 'starter-api-docs-translator', name: 'API Docs Translator', useCase: 'translation', tags: ['language', 'technical'],
      systemPrompt: 'You translate technical API documentation. Keep code examples unchanged. Translate surrounding text naturally. Preserve technical terms that are universally used in English (e.g., API, endpoint, JSON).',
      userPrompt: 'Translate this API documentation to [TARGET LANGUAGE]:\n\n[PASTE DOCUMENTATION]\n\nRules: Keep code snippets, variable names, and URLs unchanged. Translate descriptions and comments. Preserve markdown formatting.',
      isStarter: true,
    },
    // Data Labeling
    {
      id: 'starter-text-labeler', name: 'Text Classification Labeler', useCase: 'data_labeling', tags: ['data', 'ml'],
      systemPrompt: 'You are a data labeling assistant for text classification. Apply labels consistently according to the provided guidelines. When uncertain, indicate your confidence level. Output structured JSON for easy ingestion.',
      userPrompt: 'Label these texts according to the following categories: [LIST CATEGORIES]\n\nGuidelines: [LABELING RULES]\n\nTexts:\n1. "[TEXT 1]"\n2. "[TEXT 2]"\n3. "[TEXT 3]"\n\nOutput: [{"id": 1, "text": "...", "label": "...", "confidence": 0.0, "notes": "..."}]',
      isStarter: true,
    },
    {
      id: 'starter-ner-annotation', name: 'NER Annotation', useCase: 'data_labeling', tags: ['data', 'nlp'],
      systemPrompt: 'You are a Named Entity Recognition (NER) annotation system. Identify and classify entities in text. Use standard NER categories (PERSON, ORG, LOC, DATE, MONEY, etc.) or custom categories if provided.',
      userPrompt: 'Annotate named entities in this text:\n\n"[PASTE TEXT]"\n\nCategories: PERSON, ORGANIZATION, LOCATION, DATE, MONEY, PRODUCT\n\nOutput: [{"entity": "...", "type": "...", "start": 0, "end": 0, "context": "..."}]',
      isStarter: true,
    },
    // Synthetic Data
    {
      id: 'starter-test-data-gen', name: 'Test Data Generator', useCase: 'synthetic_data', tags: ['data', 'testing'],
      systemPrompt: 'You generate realistic synthetic test data. Data should be varied, realistic, and cover edge cases. Use consistent formats. Never use real personal information.',
      userPrompt: 'Generate [NUMBER] rows of synthetic test data with these columns:\n\n[DESCRIBE SCHEMA]\n\nRequirements:\n- Realistic values\n- Include edge cases (nulls, special characters, boundary values)\n- Output as [JSON / CSV]\n- No real personal information',
      isStarter: true,
    },
    {
      id: 'starter-training-augmentation', name: 'Training Augmentation', useCase: 'synthetic_data', tags: ['data', 'ml'],
      systemPrompt: 'You generate diverse training data variations to augment ML datasets. Preserve the core meaning/label while varying surface form. Create natural, realistic variations.',
      userPrompt: 'Generate [NUMBER] variations of each example below for training data augmentation:\n\nOriginal examples with labels:\n[PASTE EXAMPLES]\n\nVariation techniques: paraphrasing, synonym substitution, restructuring, formality changes. Preserve the original label for each variation.\n\nOutput as JSON: [{"original": "...", "label": "...", "variations": ["..."]}]',
      isStarter: true,
    },
    // RAG/Agents
    {
      id: 'starter-rag-system', name: 'RAG System Prompt', useCase: 'rag_agents', tags: ['rag', 'system'],
      systemPrompt: 'You are a helpful assistant that answers questions based ONLY on the provided context documents. If the answer is not in the context, say "I don\'t have enough information to answer that." Never fabricate information. Cite the source document for each claim.',
      userPrompt: 'Context Documents:\n---\n[DOCUMENT 1]\n---\n[DOCUMENT 2]\n---\n\nUser Question: [QUESTION]\n\nAnswer based only on the context above. Cite sources with [Doc N] notation.',
      isStarter: true,
    },
    {
      id: 'starter-tool-agent', name: 'Tool-Use Agent', useCase: 'rag_agents', tags: ['agents', 'system'],
      systemPrompt: 'You are an AI agent with access to tools. Available tools:\n\n1. search(query) - Search a knowledge base\n2. calculate(expression) - Evaluate math\n3. lookup(entity) - Get entity details\n\nTo use a tool, output: <tool>tool_name(args)</tool>\nWait for the result before continuing. Use tools when you need information you don\'t have. Think step by step.',
      userPrompt: 'Task: [DESCRIBE WHAT THE AGENT SHOULD DO]\n\nThink through what tools you need and in what order. Execute the task step by step.',
      isStarter: true,
    },
    // Feature Engineering
    {
      id: 'starter-feature-brainstorm', name: 'Feature Brainstormer', useCase: 'feature_engineering', tags: ['ml', 'data'],
      systemPrompt: 'You are an ML feature engineering expert. Given a dataset description and prediction target, brainstorm creative and useful features. Consider: interactions, aggregations, temporal patterns, domain-specific transformations, and encoding strategies.',
      userPrompt: 'Dataset: [DESCRIBE YOUR DATA - columns, types, domain]\nTarget variable: [WHAT YOU\'RE PREDICTING]\nCurrent features: [LIST EXISTING FEATURES]\n\nBrainstorm 15-20 new features. For each: name, formula/logic, intuition for why it would help, and expected importance (high/medium/low).',
      isStarter: true,
    },
    {
      id: 'starter-transform-pipeline', name: 'Transformation Pipeline', useCase: 'feature_engineering', tags: ['ml', 'code'],
      systemPrompt: 'You are a data engineering expert. Write clean, production-ready feature transformation code. Use pandas/sklearn conventions. Include comments explaining each transformation. Handle missing values and edge cases.',
      userPrompt: 'Write a feature engineering pipeline for this dataset:\n\nColumns: [LIST COLUMNS WITH TYPES]\nTarget: [TARGET VARIABLE]\n\nInclude: missing value imputation, encoding categoricals, scaling numerics, creating interaction features, and any domain-specific transforms. Output as a Python function using pandas and sklearn.',
      isStarter: true,
    },
  ];

  // ===== CRUD =====
  function getAllPrompts() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch { return []; }
  }

  function setAllPrompts(prompts) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  }

  function savePrompt(prompt) {
    const prompts = getAllPrompts();
    const existing = prompts.findIndex(p => p.id === prompt.id);
    if (existing >= 0) {
      prompts[existing] = { ...prompts[existing], ...prompt };
    } else {
      prompts.push({
        id: prompt.id || crypto.randomUUID(),
        name: prompt.name || 'Untitled',
        useCase: prompt.useCase || '',
        tags: prompt.tags || [],
        systemPrompt: prompt.systemPrompt || '',
        userPrompt: prompt.userPrompt || '',
        createdAt: prompt.createdAt || new Date().toISOString(),
        isStarter: false,
      });
    }
    setAllPrompts(prompts);
    return prompts;
  }

  function deletePrompt(id) {
    const prompts = getAllPrompts().filter(p => p.id !== id);
    setAllPrompts(prompts);
    return prompts;
  }

  function searchPrompts(query, useCase) {
    let prompts = getAllPrompts();
    if (useCase) {
      prompts = prompts.filter(p => p.useCase === useCase);
    }
    if (query) {
      const q = query.toLowerCase();
      prompts = prompts.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.systemPrompt.toLowerCase().includes(q) ||
        p.userPrompt.toLowerCase().includes(q) ||
        (p.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    return prompts;
  }

  function getStarterTemplates(useCase) {
    if (useCase) return STARTERS.filter(s => s.useCase === useCase);
    return STARTERS;
  }

  function exportLibrary() {
    const prompts = getAllPrompts();
    const blob = new Blob([JSON.stringify(prompts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whichai-prompt-library.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importLibrary(jsonString) {
    try {
      const imported = JSON.parse(jsonString);
      if (!Array.isArray(imported)) throw new Error('Expected an array');
      const existing = getAllPrompts();
      const existingIds = new Set(existing.map(p => p.id));
      const toAdd = imported.filter(p => !existingIds.has(p.id));
      setAllPrompts([...existing, ...toAdd]);
      return { added: toAdd.length, skipped: imported.length - toAdd.length };
    } catch (err) {
      return { error: err.message };
    }
  }

  // ===== Export =====
  window.PromptLibrary = {
    STARTERS,
    getAllPrompts,
    savePrompt,
    deletePrompt,
    searchPrompts,
    getStarterTemplates,
    exportLibrary,
    importLibrary,
  };
})();
