# writing-bench

A terminal-based tool for comparing LLM writing quality across literary
genres. Models write, critique each other's work, and revise. An LLM
judge does pairwise blind comparisons at each stage, and Whole History
Rating (WHR) produces order-independent ratings with confidence intervals.

## Quick Start

```bash
bun install

# Run a benchmark with two models
bun run start run -m anthropic:claude-sonnet-4-20250514 -m openai:gpt-4o

# View the most recent results
bun run start results --latest

# Open the web viewer
bun run start serve
```

## Model Specification

Models are specified as `provider:model[=label]`:

```
openai:gpt-4o                                        # displayed as "GPT-4o"
anthropic:claude-sonnet-4-20250514=sonnet             # displayed as "sonnet"
google-vertex-anthropic:claude-sonnet-4-20250514      # displayed as "Claude Sonnet 4"
ollama:llama3.1:8b                                    # colon is part of the model name
ollama:llama3.1:8b=my-llama                           # explicit label with variant
```

Display names are resolved from [models.dev](https://models.dev)
automatically (e.g. `openai:gpt-4o` becomes "GPT-4o" in all output).
An explicit `=label` suffix overrides this. The `=` separator avoids
ambiguity with Ollama's `model:variant` naming convention. When
different providers serve the same model and produce the same display
name, the provider name is appended for disambiguation (e.g.
"Claude Sonnet 4 (Google Vertex AI)").

Supported providers: `openai`, `anthropic`, `google`, `google-vertex`,
`google-vertex-anthropic`, `openrouter`, `opencode`, `ollama`.

Provider resolution uses models.dev for metadata (pricing, output
limits, provider npm packages). API keys are read from standard
environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.).

## CLI Commands

### `run` -- Run a benchmark

```
bun run start run -m provider:model [-m ...] [options]
```

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--models` | `-m` | required | Model specs (repeatable) |
| `--judges` | `-j` | same as models | Separate judge models |
| `--prompts` | `-p` | `prompts/*.toml` | Prompt file glob |
| `--filter` | `-f` | | Filter by prompt id or tag |
| `--outputs` | `-n` | unlimited | Max outputs per model per prompt (adaptive) |
| `--resume` | | | Resume an interrupted run by ID |
| `--dry-run` | | | Preview without API calls |
| `--no-reasoning` | | | Skip reasoning in judgments |
| `--no-cache` | | | Skip reading cache (still writes) |
| `--confidence` | | `0` | CI threshold (0 = stop when no CIs overlap, N > 0 = stop when CIs < ±N) |
| `--writing-weight` | | `1.0` | Priority weight for writing judgments |
| `--feedback-weight` | | `0.25` | Priority weight for feedback judgments |
| `--revised-weight` | | `0.4` | Priority weight for revised judgments |

### `results` -- Show previous results

```
bun run start results [run-id] [--latest] [--format table|json]
```

### `elo` -- Cumulative leaderboard

```
bun run start elo [--tag speech] [--format table|json]
```

### `export` -- Export for web viewer

```
bun run start export [--out web/data]
```

### `serve` -- Build and serve web viewer

```
bun run start serve [--port 3000] [--no-open]
```

### `clear-cache` -- Clear cached outputs

```
bun run start clear-cache provider:model [--judgments-only]
```

## How It Works

The benchmark uses a **pull-based adaptive architecture**. Instead of
generating all O(n²) pairwise judgments upfront, it uses confidence
intervals to decide what work to do next:

1. **Seed from cache** -- Exhaustively loads all previously computed
   artifacts (writes, feedback, revisions, judgments) at zero cost.
2. **Compute ratings** -- Runs Whole History Rating (WHR) with Bayesian
   confidence intervals on all available judgments.
3. **Pull the highest-value work** -- Identifies the model pair and
   judgment type whose data would most reduce rating uncertainty.
4. **Cascade dependencies** -- If a judgment needs a missing sample,
   feedback, or revision, those are generated automatically.
5. **Repeat** -- Returns to step 2 until no model's CI overlaps any
   other (default), or until CIs fall below `--confidence N` if set.

Three rating dimensions must all converge: writing quality (initial
judgments), revised writing quality (revised judgments), and feedback
quality (improvement judgments).

All artifacts are cached to disk. Re-runs skip cached API calls at
zero cost.

See [METHODOLOGY.md](METHODOLOGY.md) for full details on the rating
system, or view it in the web viewer (`bun run start serve`, then click
"methodology").

## Prompts

Prompts are defined as TOML files in `prompts/`. Each specifies the writing
task, genre tags, and the criteria judges should use:

```toml
name = "Sermon: The Prodigal Son"
tags = ["speech", "theological"]
description = "Tests theological depth, pastoral tone, and rhetorical structure"

prompt = """
Write a sermon on the parable of the Prodigal Son (Luke 15:11-32).
Target audience: general congregation.
Tone: pastoral, warm, theologically grounded.
Length: 1500-2000 words.
"""

judging_criteria = [
  "theological accuracy and depth of scriptural engagement",
  "rhetorical effectiveness and persuasive structure",
  "pastoral warmth and accessibility for a general audience",
  "overall structure, flow, and coherence",
  "effective use of illustration and application",
]

max_words = 2000
```

Available tags: `speech`, `theological`, `creative`, `fiction`, `essay`,
`analytical`, `technical`, `kids`, `youth`.

## Ratings

### Per-Run: Whole History Rating (WHR)

Within each run, ratings are computed using **Whole History Rating**, a
Bayesian extension of Bradley-Terry. WHR uses Newton's method on the
log-posterior with a Gaussian prior (σ²=0.25) for regularization, producing
both point estimates and 95% confidence intervals from the Hessian.

These CIs drive the adaptive loop's stopping criterion. Ratings are
shown on an ELO-like scale: `rating = r × 400/ln(10) + 1500`. A 400-point
gap corresponds to roughly 10:1 expected win odds.

Three rating dimensions:

- **Writing ELO** -- Head-to-head writing quality from initial judgments.
- **Revised Writing ELO** -- Head-to-head revised writing quality, scoped
  by feedback source.
- **Feedback ELO** -- How useful a model's editorial feedback is. Measured
  indirectly by comparing improvement rates: did a revision guided by this
  model's feedback beat the original?
- **Per-tag ELO** -- Writing ratings restricted to prompts with a given tag,
  showing category-specific strengths.

### Cumulative Ratings

Ratings accumulate across runs using the same WHR algorithm. Pairwise
records (win/loss/tie counts per model pair) are stored on disk, merged
with new data each run, and ratings are recomputed from the full history.

## Web Viewer

```bash
bun run start serve
```

Opens a static web viewer with:
- Cumulative leaderboard with ELO history sparklines
- Per-run detail pages with outputs, feedback, revisions, and judgments
- Per-tag rating breakdowns
- Cost and speed breakdowns
- Full methodology documentation

## Project Structure

```
src/
  index.tsx           entry point and CLI dispatcher
  cli.ts              yargs command definitions
  config.ts           TOML loading, model parsing, run config
  types.ts            shared TypeScript interfaces
  engine/
    runner.ts          pull-based adaptive benchmark orchestrator
    judge.ts           pairwise judging with position randomization
    whr.ts             Whole History Rating (WHR) with CIs
    need-identifier.ts information-gain scoring for adaptive loop
    scheduler.ts       concurrency-limited task scheduler
    retry.ts           exponential backoff retry logic
  providers/
    registry.ts        AI SDK provider resolution
    models.ts          models.dev API integration, cost calculation
  storage/
    run-store.ts       run result persistence
    elo-store.ts       cumulative ELO with pairwise records
    sample-cache.ts    disk cache for all API outputs
  export/
    web-export.ts      export run data for web viewer
  ui/                  Ink terminal UI components
prompts/               TOML prompt definitions
web/                   static web viewer (vanilla TypeScript SPA)
data/                  runtime data (gitignored)
```
