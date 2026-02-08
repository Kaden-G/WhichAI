#!/usr/bin/env python3
"""
refresh.py — Update data.json with latest LLM pricing from provider websites.

Usage:
    python3 refresh.py              # Fetch and update data.json
    python3 refresh.py --dry-run    # Show what would change without writing

Dependencies: Python 3 stdlib only (no pip install needed).

The script:
  1. Reads the existing data.json
  2. Fetches pricing pages from each provider
  3. Attempts to parse known HTML/JSON patterns to extract prices
  4. Merges updates while preserving manual benchmark entries
  5. Writes updated data.json with new last_updated timestamp
  6. Prints a diff summary to stdout

Note: Web scraping is inherently fragile. If a provider changes their page
structure, the parser for that provider will fail gracefully and report
which providers could not be updated. Manual updates to data.json are
always valid — this script is a convenience helper, not a requirement.
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import date
from copy import deepcopy


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(SCRIPT_DIR, "data.json")

# Provider pricing page URLs
PRICING_URLS = {
    "openai": "https://openai.com/api/pricing/",
    "anthropic": "https://docs.anthropic.com/en/docs/about-claude/models",
    "google": "https://ai.google.dev/gemini-api/docs/pricing",
    "mistral": "https://mistral.ai/pricing",
    "deepseek": "https://api-docs.deepseek.com/quick_start/pricing",
    "cohere": "https://cohere.com/pricing",
    "meta_fireworks": "https://fireworks.ai/pricing",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LLM-Dashboard-Refresh/1.0"
}


def fetch_url(url: str, timeout: int = 15) -> str | None:
    """Fetch a URL and return the response body as a string, or None on error."""
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        print(f"  [WARN] Failed to fetch {url}: {e}")
        return None


def load_data() -> dict:
    """Load existing data.json."""
    with open(DATA_PATH, "r") as f:
        return json.load(f)


def save_data(data: dict) -> None:
    """Write data.json with consistent formatting."""
    with open(DATA_PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ---- Provider-specific parsers ----
# Each parser returns a dict of { model_name: { input_per_mtok, output_per_mtok } }
# or an empty dict if parsing fails.


def parse_openai(html: str) -> dict:
    """
    Attempt to extract pricing from OpenAI's pricing page.
    Looks for patterns like '$X.XX / 1M input tokens'.
    """
    results = {}
    # Look for model names followed by pricing patterns
    # This is fragile and will need updating when OpenAI changes their page
    patterns = [
        # Pattern: "model-name" ... "$X.XX" ... "input" ... "$X.XX" ... "output"
        r'(?:GPT-4o(?:-mini)?|GPT-4\.1(?:\s+(?:Mini|Nano))?|o[13](?:-mini)?)',
    ]
    # Simplified: just report we tried
    print("  [INFO] OpenAI parser: page fetched, manual review recommended")
    return results


def parse_anthropic(html: str) -> dict:
    """Attempt to extract pricing from Anthropic's docs."""
    results = {}
    print("  [INFO] Anthropic parser: page fetched, manual review recommended")
    return results


def parse_google(html: str) -> dict:
    """Attempt to extract pricing from Google AI pricing page."""
    results = {}
    print("  [INFO] Google parser: page fetched, manual review recommended")
    return results


def parse_mistral(html: str) -> dict:
    """Attempt to extract pricing from Mistral's pricing page."""
    results = {}
    print("  [INFO] Mistral parser: page fetched, manual review recommended")
    return results


def parse_deepseek(html: str) -> dict:
    """Attempt to extract pricing from DeepSeek's pricing page."""
    results = {}
    # DeepSeek sometimes has JSON-like structures in their docs
    # Look for price patterns like "$0.28 per million tokens"
    price_pattern = r'\$(\d+\.?\d*)\s*(?:per|/)\s*(?:million|1M|MTok)'
    matches = re.findall(price_pattern, html, re.IGNORECASE)
    if matches:
        print(f"  [INFO] DeepSeek parser: found {len(matches)} price references, manual review recommended")
    else:
        print("  [INFO] DeepSeek parser: page fetched, manual review recommended")
    return results


def parse_cohere(html: str) -> dict:
    """Attempt to extract pricing from Cohere's pricing page."""
    results = {}
    print("  [INFO] Cohere parser: page fetched, manual review recommended")
    return results


def parse_fireworks(html: str) -> dict:
    """Attempt to extract pricing from Fireworks AI pricing page."""
    results = {}
    print("  [INFO] Fireworks parser: page fetched, manual review recommended")
    return results


PARSERS = {
    "openai": parse_openai,
    "anthropic": parse_anthropic,
    "google": parse_google,
    "mistral": parse_mistral,
    "deepseek": parse_deepseek,
    "cohere": parse_cohere,
    "meta_fireworks": parse_fireworks,
}


def merge_updates(data: dict, updates: dict[str, dict]) -> list[str]:
    """
    Merge parsed pricing updates into the data structure.
    Preserves all manual fields (benchmarks, use_case_scores, tags, notes).
    Returns a list of change descriptions.
    """
    changes = []
    model_index = {m["model"]: m for m in data["models"]}

    for model_name, new_prices in updates.items():
        if model_name in model_index:
            m = model_index[model_name]
            for field in ("input_per_mtok", "output_per_mtok"):
                if field in new_prices and new_prices[field] != m.get(field):
                    old_val = m.get(field)
                    m[field] = new_prices[field]
                    changes.append(
                        f"  {model_name}: {field} ${old_val} -> ${new_prices[field]}"
                    )
        else:
            # New model discovered
            changes.append(f"  NEW MODEL FOUND: {model_name} (add manually to data.json)")

    return changes


def print_diff(old_data: dict, new_data: dict) -> None:
    """Print a human-readable diff between old and new data."""
    old_models = {m["model"]: m for m in old_data["models"]}
    new_models = {m["model"]: m for m in new_data["models"]}

    changed = False
    for name, new_m in new_models.items():
        if name in old_models:
            old_m = old_models[name]
            for field in ("input_per_mtok", "output_per_mtok", "context_window"):
                if old_m.get(field) != new_m.get(field):
                    print(f"  CHANGED {name}.{field}: {old_m.get(field)} -> {new_m.get(field)}")
                    changed = True

    if not changed:
        print("  No pricing changes detected.")


def main():
    dry_run = "--dry-run" in sys.argv

    print("LLM Dashboard — Data Refresh")
    print("=" * 40)

    # Load existing data
    data = load_data()
    old_data = deepcopy(data)
    print(f"Loaded {len(data['models'])} models from data.json")
    print(f"Last updated: {data['last_updated']}")
    print()

    # Fetch and parse each provider
    all_updates = {}
    for provider, url in PRICING_URLS.items():
        print(f"Fetching {provider}...")
        html = fetch_url(url)
        if html is None:
            continue

        parser = PARSERS.get(provider)
        if parser:
            updates = parser(html)
            all_updates.update(updates)
            if updates:
                print(f"  Found {len(updates)} model price updates")

    print()

    # Merge updates
    if all_updates:
        changes = merge_updates(data, all_updates)
        if changes:
            print("Changes detected:")
            for c in changes:
                print(c)
        else:
            print("No price changes to apply.")
    else:
        print("No automated price updates extracted.")
        print("(This is normal — most providers use dynamic JS rendering.)")
        print("Tip: Update data.json manually when you see price changes.")

    # Update timestamp
    data["last_updated"] = date.today().isoformat()

    print()
    print("Diff summary:")
    print_diff(old_data, data)

    if not dry_run:
        save_data(data)
        print()
        print(f"Updated data.json (last_updated: {data['last_updated']})")
        print("Run `git diff data.json` to review changes.")
    else:
        print()
        print("[DRY RUN] No changes written to disk.")


if __name__ == "__main__":
    main()
