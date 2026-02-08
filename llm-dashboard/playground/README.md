# WhichAI Playground

A zero-dependency browser UI for calling LLM APIs directly, with smart model defaults from the dashboard's Pareto analysis.

## Quick Start

### 1. Start the CORS proxy

The proxy is required for OpenAI and Google APIs (which don't support browser CORS). Anthropic may work without it.

```bash
cd ~/llm-dashboard/playground
python3 proxy.py
```

This starts a local proxy on `http://127.0.0.1:8765`. It only forwards requests to `api.openai.com`, `api.anthropic.com`, and `generativelanguage.googleapis.com`.

### 2. Serve the dashboard

```bash
cd ~/llm-dashboard
python3 -m http.server 8080
```

### 3. Open the Playground

Navigate to `http://localhost:8080/playground/`

### 4. Add API keys

Click **Settings** and enter your API keys for one or more providers:

- **OpenAI**: Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic**: Get a key at [console.anthropic.com](https://console.anthropic.com)
- **Google**: Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

Click **Test** next to each key to verify it works.

## Features

- **Smart model selection**: Pick a use case and the playground auto-selects the best value model based on Pareto analysis
- **24 starter templates**: Pre-built prompts for coding, reasoning, classification, extraction, and more
- **Prompt optimizer**: Describe what you want in plain English and get an optimized prompt via LLM meta-prompt
- **Streaming responses**: Real-time token-by-token output display
- **Conversation mode**: Toggle multi-turn conversations with message history
- **Cost tracking**: Per-request, session, and all-time cost tracking
- **Prompt library**: Save, search, import/export your prompts
- **Dark mode**: Syncs with the dashboard theme

## Security Notes

- API keys are stored **in your browser only** (localStorage if "Remember" is checked, otherwise session-only)
- Keys are sent directly to provider APIs or through the local CORS proxy — never to any third-party server
- The CORS proxy runs on `localhost` only and validates target domains
- **Do not use "Remember keys" on shared or public computers**
- The proxy is not an open relay — it only forwards to the three allowed API domains

## File Structure

| File | Purpose |
|------|---------|
| `index.html` | App shell — 2-panel layout |
| `style.css` | All styling, reuses dashboard design tokens |
| `app.js` | Core orchestrator: state, UI, event wiring |
| `providers.js` | API adapters for OpenAI, Anthropic, Google |
| `library.js` | Prompt library CRUD + 24 starter templates |
| `optimizer.js` | Prompt optimization via LLM meta-prompt |
| `proxy.py` | CORS proxy (Python stdlib only) |
