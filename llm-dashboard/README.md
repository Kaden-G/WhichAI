# LLM Price-Performance Dashboard

A zero-dependency, single-page dashboard comparing LLM models on price and quality. Highlights the **Pareto frontier** — models offering the best performance at each price point.

## Quick Start

```bash
cd ~/llm-dashboard
python3 -m http.server 8080
# Open http://localhost:8080
```

## Features

- **Pareto Frontier** — scatter plot and table highlighting models where no cheaper model has higher quality
- **Use Case Recommendations** — per-domain cards showing Best Performance, Best Value, and Budget picks
- **Sortable Table** — click any column header to sort ascending/descending
- **Filters** — provider checkboxes, tag buttons, price range slider
- **Dark/Light Mode** — respects system preference, manual toggle available
- **Responsive** — works on mobile with horizontal scroll on the table
- **Zero Dependencies** — plain HTML, CSS, JS. No build step, no npm, no frameworks.

## Project Structure

```
index.html      # Single-page dashboard
style.css       # Responsive layout, theming, provider colors
app.js          # All client-side logic (chart, table, filters, Pareto)
data.json       # Curated model pricing + benchmark data
refresh.py      # Python script to update pricing data
README.md       # This file
```

## Data Model

All data lives in `data.json`. Every change is auditable via `git diff`. Each model entry includes:

- **Pricing**: `input_per_mtok`, `output_per_mtok` (USD per million tokens)
- **Benchmarks**: MMLU, HumanEval, MATH, GPQA, SWE-bench, Arena ELO
- **Use Case Scores**: Per-domain 1-100 ratings (coding, reasoning, classification, etc.)
- **Metadata**: Provider, context window, tags, release date, notes

## Refreshing Data

```bash
# Fetch latest pricing and update data.json
python3 refresh.py

# Preview changes without writing
python3 refresh.py --dry-run
```

The refresh script fetches provider pricing pages and attempts to extract updates. Since most providers use JavaScript-rendered pages, automated parsing is limited. The script preserves all manual entries (benchmarks, scores, notes) and only updates pricing fields.

**Recommended workflow:**
1. Watch for pricing announcements
2. Run `python3 refresh.py` to update the timestamp
3. Manually update prices in `data.json` as needed
4. `git diff data.json` to review
5. Commit

## Methodology

- **Blended Cost**: Simple = (input + output) / 2. Output-Heavy = (input + 3 × output) / 4
- **Quality Score**: Weighted average of normalized benchmarks (0-100). Null benchmarks are excluded
- **Pareto Frontier**: Models where no cheaper model has a higher quality score
- **Use Case Picks**: Best Performance (highest score), Best Value (highest among Pareto models), Budget (cheapest with score >= 60)

## Hosting

Works with any static file server:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .

# Nginx — just point root to this directory

# GitHub Pages — push to gh-pages branch

# Netlify/Vercel — drag and drop the folder
```

## Adding a Model

Edit `data.json` and add an entry to the `models` array:

```json
{
  "provider": "ProviderName",
  "model": "Model Name",
  "input_per_mtok": 1.00,
  "output_per_mtok": 5.00,
  "context_window": 128000,
  "benchmarks": {
    "mmlu": null,
    "humaneval": null,
    "math": null,
    "gpqa": null,
    "swe_bench": null,
    "arena_elo": null
  },
  "use_case_scores": {
    "coding": 75,
    "reasoning": 70,
    "classification": 80,
    "extraction": 80,
    "summarization": 78,
    "math": 70,
    "creative": 72,
    "translation": 75,
    "data_labeling": 76,
    "synthetic_data": 70,
    "rag_agents": 75,
    "feature_engineering": 72
  },
  "tags": ["general"],
  "released": "2026-01-01",
  "notes": ""
}
```

Refresh the page — the new model will appear in all views.
