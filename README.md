# writing-bench

A terminal-based tool for comparing LLM writing quality across literary
genres. Models write, critique each other's work, and revise. An LLM
judge does pairwise blind comparisons at each stage, and Bradley-Terry
maximum likelihood estimation produces order-independent ratings.

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

Models are specified as `provider:model[:label]`:

```
openai:gpt-4o                                        # displayed as "GPT-4o"
anthropic:claude-sonnet-4-20250514:sonnet             # displayed as "sonnet"
google-vertex-anthropic:claude-sonnet-4-20250514      # displayed as "Claude Sonnet 4"
ollama:llama3.1
```

Display names are resolved from [models.dev](https://models.dev)
automatically (e.g. `openai:gpt-4o` becomes "GPT-4o" in all output).
An explicit `:label` suffix overrides this. When different providers
serve the same model and produce the same display name, the provider
name is appended for disambiguation (e.g. "Claude Sonnet 4 (Google
Vertex AI)").

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
| `--outputs` | `-n` | `1` | Outputs per model per prompt (max 3) |
| `--concurrency` | | `5` | Max parallel API calls |
| `--resume` | | | Resume an interrupted run by ID |
| `--dry-run` | | | Preview without API calls |
| `--no-reasoning` | | | Skip reasoning in judgments |
| `--no-cache` | | | Skip reading cache (still writes) |

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

The benchmark runs a reactive pipeline where tasks fire as soon as their
dependencies are met:

1. **Write** -- Each model generates an output for each prompt.
2. **Judge (initial)** -- As pairs become available, an LLM judge does
   blind pairwise comparisons with randomized A/B positions.
3. **Feedback** -- Each model critiques every other model's initial output.
4. **Revise** -- The original writer revises using the feedback.
5. **Judge (revised)** -- Revised outputs are compared head-to-head. Revised
   samples are scoped by feedback source so comparisons are fair.
6. **Judge (improvement)** -- Each revision is compared against its original
   to measure whether the feedback actually helped.

All writing samples, feedback, revisions, and judgments are cached to disk.
Re-runs skip cached API calls at zero cost.

See the methodology page in the web viewer (`bun run start serve`, then
click "methodology") for full details on the rating system.

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

Ratings use **Bradley-Terry maximum likelihood estimation**, not sequential
ELO. BT computes strength parameters from all pairwise outcomes simultaneously,
so ratings are order-independent: the same set of judgments always produces
the same ratings regardless of processing order.

Strengths are converted to an ELO-like scale: `rating = 400 * log10(strength) + 1500`.
A 400-point gap corresponds to roughly 10:1 expected win odds. The baseline is 1500.

Three rating types:

- **Writing ELO** -- Head-to-head writing quality from initial and revised
  stage judgments.
- **Feedback ELO** -- How useful a model's editorial feedback is. Measured
  indirectly by comparing improvement rates: did a revision guided by this
  model's feedback beat the original?
- **Per-tag ELO** -- Writing ratings restricted to prompts with a given tag,
  showing category-specific strengths.

Ratings accumulate across runs. Pairwise records (win/loss/tie counts per
model pair) are stored on disk, merged with new data each run, and ratings
are recomputed from the full history.

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
    runner.ts          reactive benchmark orchestrator
    judge.ts           pairwise judging with position randomization
    elo.ts             Bradley-Terry rating computation
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
