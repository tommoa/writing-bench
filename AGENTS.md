# AGENTS.md

Guidelines for AI coding agents working in this repository. If you
discover that any section is outdated or encounter behavior that
contradicts what is documented here, update this file as part of your
change.

## Build & Run

Runtime is **Bun** (not Node). The CLI entry point is `src/index.tsx`.

```bash
bun install                       # install dependencies
bun run start run -m provider:model -m provider:model   # run benchmark
bun run start serve               # build + export + serve web viewer
bun run build:web                 # bundle web/src/app.ts -> web/app.js
```

## Testing

Test framework: `bun:test`. Tests are co-located with source files
(`foo.ts` -> `foo.test.ts`).

```bash
bun test                          # run all tests
bun test src/engine/elo.test.ts   # run one test file
bun test --test-name-pattern "returns 0.5 for equal ratings"  # one case
```

There is no linter or formatter configured. TypeScript strict mode is
enabled (`tsconfig.json`). There is no `tsc --noEmit` check in CI --
Bun runs TypeScript directly.

## Code Style

### Formatting
- 2-space indentation, semicolons always, double quotes
- Trailing commas in multi-line objects, arrays, and parameters
- No enforced line length limit

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
  // ── Bradley-Terry Core ──────────────────────────────
  ```
- JSDoc for exported functions (brief, imperative mood)
- Single-line comments for inline explanations

### Async
- `async/await` throughout, no `.then()` chains
- `Promise.all()` for parallel work, `Promise.allSettled()` when partial
  failure is acceptable
- `streamText` results: `await result.text`, `await result.usage`

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
- Test pure logic and storage. No tests for runner, UI, or providers.

## Project Structure

```
src/
  index.tsx          CLI dispatcher and command handlers
  cli.ts             yargs command definitions
  config.ts          TOML loading, model parsing
  types.ts           ALL shared interfaces and types
  engine/            Core benchmark logic
    runner.ts        Reactive pipeline orchestrator
    judge.ts         Pairwise judging, position randomization
    elo.ts           Bradley-Terry rating computation
    scheduler.ts     Inflight promise tracker
    retry.ts         Exponential backoff retry
  providers/         AI SDK provider resolution
    registry.ts      Provider factory, model spec parsing
    models.ts        models.dev API, cost calculation
  storage/           Persistence layer
    run-store.ts     Run result JSON persistence
    elo-store.ts     Cumulative ELO with pairwise records
    sample-cache.ts  Disk cache for API outputs
  export/
    web-export.ts    Export data for web viewer
  ui/                Ink terminal UI components (React/JSX)
prompts/             TOML prompt definitions
web/                 Static SPA viewer (vanilla TS, bundled by Bun)
data/                Runtime data (gitignored)
```

Dependencies flow downward: CLI -> Engine -> Providers/Storage -> Types.

## Key Architectural Notes

- ESM module (`"type": "module"` in package.json)
- Bun is both runtime and bundler (no separate compile step for CLI)
- The web viewer (`web/`) is a separate vanilla TypeScript SPA, built
  with `bun run build:web`. It is independent from the Ink terminal UI.
- LSP errors in `src/ui/*.tsx` files are pre-existing Ink/React JSX
  type issues -- they are harmless and unrelated to actual bugs.
- The `ai` SDK `Intl.Segmenter` type error is a known upstream issue.
