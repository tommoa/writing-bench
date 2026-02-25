# AGENTS.md

Guidelines for AI coding agents working in this repository. If you
discover that any section is outdated or encounter behavior that
contradicts what is documented here, update this file as part of your
change.

This is a greenfield project - we should not refer to previous state in
comments, nor should there be any concerns about backwards
compatibility.

**CRITICAL:** When considering any code change, ask the following
questions:
- Is it the right way to solve this issue?
- Will it be the most maintainable option?
- Is this actually a bug in a different system that we should be fixing?
- Is this the right interface to use?
- What is the simplest interface that will cover all my current needs?
- In how many situations will this method be used?
- Is this API easy to use for my current needs?
- Does any information get used in multiple places?
- Will users be able to determine a better value than can be determined
  here? (for configuration)
- Is there any code that needs to be written more than once?
- Can you hide any special cases?

Make sure you thoroughly answer all of these questions. Present the
responses to the user when providing your plan.

## Build & Run

Runtime is **Bun** (not Node). The CLI entry point is `src/index.tsx`.
Look in the `package.json` to see available scripts.

## Testing

Test framework: `bun:test`. Tests are co-located with source files
(`foo.ts` -> `foo.test.ts`).

```bash
bun test                          # run all tests
bun test src/engine/elo.test.ts   # run one test file
bun test --test-name-pattern "returns 0.5 for equal ratings"  # one case
```

TypeScript strict mode is enabled (`tsconfig.json`).

## Code Style

### Formatting
- 2-space indentation, semicolons always, double quotes
- Trailing commas in multi-line objects, arrays, and parameters
- No enforced line length limit
- ASCII only -- use `--` instead of em-dashes, plain quotes instead
  of smart quotes, etc.

### Naming
| What | Convention | Example |
|------|-----------|---------|
| Functions | camelCase | `computeEloFromJudgments` |
| Classes | PascalCase | `BenchmarkRunner` |
| Interfaces/Types | PascalCase | `PairwiseJudgment` |
| Module constants | SCREAMING_SNAKE | `DEFAULT_RATING`, `BT_MAX_ITER` |
| Source files | kebab-case | `elo-store.ts`, `sample-cache.ts` |
| Test files | `<name>.test.ts` | `elo.test.ts` |
| React components | PascalCase.tsx | `StatusBar.tsx` |

### Imports
- Separate `import type` from value imports
- Always use `.js` extensions for relative imports (even for `.ts` files)
- Order: third-party packages first, then internal relative imports
- No blank lines between import groups

```typescript
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import type { CumulativeElo, RunResult } from "../types.js";
import { createRating, mergeRecords } from "../engine/elo.js";
```

### Exports
- Named exports only -- no default exports anywhere
- React components are also named exports

### Functions
- Top-level functions use `function` declarations (both exported and private)
- Arrow functions for callbacks, lambdas, and inline handlers
- Class methods use method syntax

```typescript
// Top-level: function declaration
export function computeEloFromJudgments(...): EloRating[] { ... }
function buildMatrixFromJudgments(...): WinMatrix { ... }

// Callback: arrow
judgments.filter((j) => j.stage === "improvement");
```

### Types
- All shared types live in `src/types.ts`, organized with section headers
- `interface` for data shapes; `type` for unions, Zod inferences, function types
- Module-local types (not exported) for implementation details
- Zod schemas co-located with the code that validates the data
- Avoid `as` casts; use them only for untyped SDK error fields

### Comments
- Section headers use em-dash lines:
  ```typescript
  // ── Section Headers ────────────────────────────────
  ```
- JSDoc for exported functions (brief, imperative mood)
- Single-line comments for inline explanations

### Async
- `async/await` throughout, use `.then()` chains when obvious
- `Promise.all()` for parallel work, `Promise.allSettled()` when partial
  failure is acceptable

## Error Handling

- Custom error classes extend `Error` and set `.name`:
  ```typescript
  export class OutputTruncatedError extends Error {
    constructor() {
      super("Output truncated (finishReason: length)");
      this.name = "OutputTruncatedError";
    }
  }
  ```
- Runner tasks never crash the run -- errors are caught by `scheduleTask()`,
  recorded in `taskErrors`, and emitted as events
- `withRetry()` retries only when `isRetryable()` returns true (429, 5xx,
  empty output, truncated output)
- Zod `.parse()` for config validation (throws on invalid), `.safeParse()`
  for judgment response parsing (handles gracefully)
- Cache read failures are silently ignored (`try/catch` returning null)

## Testing Conventions

- Use `describe` / `it` (never `test`), descriptions are lowercase
  sentence fragments: `"returns 0.5 for equal ratings"`
- Helper factories at the bottom of test files using `make*` pattern:
  ```typescript
  function makeJudgment(id, sampleA, sampleB, winner, stage, promptId): PairwiseJudgment { ... }
  ```
- `beforeEach` / `afterEach` for filesystem cleanup -- save original
  content, restore in teardown

## Key Architectural Notes

- ESM module (`"type": "module"` in package.json)
- Bun is both runtime and bundler (no separate compile step for CLI)
- The web viewer (`web/`) is a separate vanilla TypeScript SPA, built
  with `bun run build:web`. It is independent from the OpenTUI terminal UI.
- The web viewer uses tiered data loading: a lean manifest loads
  immediately, and per-prompt content loads on-demand when the user
  expands prompt sections or views judgment reasoning.
- The methodology page (`web/methodology.html`) is a standalone static
  HTML file generated at build time -- it has no JavaScript dependency.
- **OpenTUI rendering rule**: `<text>` elements inside a `<box>` do NOT
  participate in flex layout -- multiple `<text>` children will render
  at position (0,0) and overlap. Wrap each `<text>` in a `<box>` to
  get block-level stacking, or combine into a single `<text>` with
  `<span>` children. `<scrollbox>` treats `<text>` children as
  block-level automatically.
- **Model aliasing**: The model spec format supports `~` for declaring
  endpoint equivalence: `provider:model~canonical_provider:canonical_model`.
  The canonical identity (right of `~`) is used for cache, labels, and
  ratings; the API endpoint (left of `~`) is used only for API calls.
  Multiple endpoints can alias to the same canonical model.
  `ModelConfig.apiModelIds` holds the API endpoint spec(s); only 4
  `resolveModel()` call sites use it. The `cache combine` command
  merges existing cache data between model key directories.

## Pull-Based Architecture

The runner (`src/engine/runner.ts`) uses a pull-based adaptive loop
instead of generating all work upfront:

1. **Phase 1 (cache seeding)** -- Exhaustively loads all cached artifacts
   before any API calls.
2. **Phase 2 (adaptive loop)** -- Iterates: compute WHR with CIs →
   identify highest-information-gain need → fulfill it via ensure-cascade
   → repeat until all 3 rating dimensions converge.

Three rating dimensions must converge independently: writing quality
(initial judgments), revised writing quality (revised judgments), and
feedback quality (improvement judgments).

### Rating System

Both per-run and cumulative ratings use World History Rankings (Bayesian BT
with CIs). Per-run ratings drive the adaptive loop's convergence criterion;
`--confidence N` sets the CI threshold (default 0 = overlap-based convergence).
Cumulative ratings (`elo-store.ts`) merge pairwise records across
runs and recompute WHR from scratch.

See `METHODOLOGY.md` at the repo root for full documentation on the
rating system. This file is also used to generate the methodology page
in the web viewer (via `web/src/build-methodology.ts`). If you change
the rating system, judging approach, or adaptive loop, update
`METHODOLOGY.md` to reflect those changes.
