#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { join, dirname } from "path";
import { rm } from "fs/promises";
import { existsSync } from "fs";
import { parseArgs, type Command } from "./cli.js";
import { executeRun, resolveRunInputs, loadAndFilterPrompts, RunValidationError } from "./engine/run-manager.js";
import { loadRun, loadLatestRun, listRuns, deleteRunFull, listRunSummaries } from "./storage/run-store.js";
import { loadCumulativeElo, rebuildCumulativeElo } from "./storage/elo-store.js";
import { exportForWeb } from "./export/web-export.js";
import { analyzeCacheStatus, formatCacheStatusTable, formatCacheStatusJson } from "./storage/cache-status.js";
import { modelKey, trimModelOutputs, combineModelCaches } from "./storage/sample-cache.js";
import { removeIfEmpty } from "./storage/fs-utils.js";
import { parseModelSpec } from "./providers/registry.js";
import { App } from "./ui/App.js";
import { printFinalTables, printEloTablePlain } from "./ui/print-tables.js";
import type { BenchmarkEvent, TaskError, TerminalPalette, TuiRunConfig } from "./types.js";
import { formatConvergenceTarget, formatConvergenceDescription } from "./engine/need-identifier.js";

// ── TUI Setup ───────────────────────────────────────

const DEFAULT_PALETTE: TerminalPalette = {
  red: "#FF0000", green: "#00AA00", yellow: "#FFFF00", blue: "#0000FF",
  magenta: "#AA00AA", cyan: "#00AAAA", white: "#AAAAAA", gray: "#555555",
  brightRed: "#FF5555", brightGreen: "#55FF55", brightYellow: "#FFFF55",
  brightMagenta: "#FF55FF", brightCyan: "#55FFFF", fg: "#FFFFFF",
  bg: "#000000",
};

/**
 * Create the OpenTUI renderer, resolve the terminal palette, and
 * return a React root ready for rendering. Shared by `handleRun`
 * and `handleTui`.
 */
async function createTui() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
    useMouse: true,
    useConsole: false,
  });

  // Handle Ctrl+C: destroy the renderer (exits alternate screen) then exit.
  process.on("SIGINT", () => {
    renderer.destroy();
    process.exit(0);
  });

  let palette: TerminalPalette;
  try {
    const termColors = await renderer.getPalette({ size: 16, timeout: 1000 });
    palette = {
      red:           termColors.palette[1]  ?? DEFAULT_PALETTE.red,
      green:         termColors.palette[2]  ?? DEFAULT_PALETTE.green,
      yellow:        termColors.palette[3]  ?? DEFAULT_PALETTE.yellow,
      blue:          termColors.palette[4]  ?? DEFAULT_PALETTE.blue,
      magenta:       termColors.palette[5]  ?? DEFAULT_PALETTE.magenta,
      cyan:          termColors.palette[6]  ?? DEFAULT_PALETTE.cyan,
      white:         termColors.palette[7]  ?? DEFAULT_PALETTE.white,
      gray:          termColors.palette[8]  ?? DEFAULT_PALETTE.gray,
      brightRed:     termColors.palette[9]  ?? DEFAULT_PALETTE.brightRed,
      brightGreen:   termColors.palette[10] ?? DEFAULT_PALETTE.brightGreen,
      brightYellow:  termColors.palette[11] ?? DEFAULT_PALETTE.brightYellow,
      brightMagenta: termColors.palette[13] ?? DEFAULT_PALETTE.brightMagenta,
      brightCyan:    termColors.palette[14] ?? DEFAULT_PALETTE.brightCyan,
      fg:            termColors.defaultForeground ?? DEFAULT_PALETTE.fg,
      bg:            termColors.defaultBackground ?? DEFAULT_PALETTE.bg,
    };
  } catch {
    palette = DEFAULT_PALETTE;
  }

  const root = createRoot(renderer);
  return { renderer, palette, root };
}

/**
 * Cleanly shut down the TUI: unmount the React tree, wait for the
 * renderer to idle, and destroy (exits the alternate screen buffer).
 */
async function destroyTui(
  root: ReturnType<typeof createRoot>,
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
) {
  try {
    root.unmount();
    await renderer.idle();
  } finally {
    renderer.destroy();
  }
}

interface BenchmarkEventBridge {
  subscribe: (handler: (event: BenchmarkEvent) => void) => void;
  subscribeWarning: (handler: (message: string) => void) => void;
  onEvent: (event: BenchmarkEvent) => void;
  onWarning: (message: string) => void;
}

function createBenchmarkEventBridge(): BenchmarkEventBridge {
  let eventHandler: ((event: BenchmarkEvent) => void) | null = null;
  let warningHandler: ((message: string) => void) | null = null;
  const pendingWarnings: string[] = [];

  function subscribe(handler: (event: BenchmarkEvent) => void) {
    eventHandler = handler;
  }

  function subscribeWarning(handler: (message: string) => void) {
    warningHandler = handler;
    while (pendingWarnings.length > 0) {
      const warning = pendingWarnings.shift();
      if (warning) {
        warningHandler(warning);
      }
    }
  }

  function onEvent(event: BenchmarkEvent) {
    if (eventHandler) {
      eventHandler(event);
    }
  }

  function onWarning(message: string) {
    if (warningHandler) {
      warningHandler(message);
      return;
    }
    pendingWarnings.push(message);
  }

  return {
    subscribe,
    subscribeWarning,
    onEvent,
    onWarning,
  };
}

// ── Helpers ─────────────────────────────────────────

/** Convert a CLI model spec ("provider:model") to a cache-safe key. */
function specToKey(spec: string): string {
  const { provider, model } = parseModelSpec(spec);
  return modelKey(provider, model);
}

/** Convert CLI run args into a TuiRunConfig for executeRun(). */
function cliArgsToTuiConfig(args: Extract<Command, { command: "run" }>["args"]): TuiRunConfig {
  return {
    models: args.models ?? [],
    judges: args.judges ?? [],
    prompts: args.prompts,
    filter: args.filter ?? [],
    outputs: args.outputs,
    reasoning: args.reasoning,
    noCache: args.noCache,
    cacheOnly: args.cacheOnly,
    skipSeeding: args.skipSeeding,
    speed: args.speed,
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    confidence: args.confidence,
    maxRounds: args.maxRounds,
    writingWeight: args.writingWeight,
    feedbackWeight: args.feedbackWeight,
    revisedWeight: args.revisedWeight,
    judgeQuality: args.judgeQuality,
    judgeQualityMode: args.judgeQualityMode,
    judgeSensitivity: args.judgeSensitivity,
    judgeDecay: args.judgeDecay,
    judgePruneThreshold: args.judgePruneThreshold,
  };
}

function sanitizeForJson(value: unknown): unknown {
  if (typeof value === "number") {
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Number.isNaN(value)) return "NaN";
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForJson(v);
    }
    return out;
  }
  return value;
}

function runResultForJson(result: Awaited<ReturnType<typeof loadRun>>): unknown {
  const normalized = {
    ...result,
    config: {
      ...result.config,
      outputsPerModel: Number.isFinite(result.config.outputsPerModel)
        ? result.config.outputsPerModel
        : "adaptive",
    },
  };
  return sanitizeForJson(normalized);
}

async function handleRun(args: Extract<Command, { command: "run" }>["args"]) {
  // Handle dry-run separately (no TUI needed)
  if (args.dryRun) {
    const tuiConfig = cliArgsToTuiConfig(args);
    let resolved;
    try {
      resolved = await resolveRunInputs(tuiConfig);
    } catch (err: unknown) {
      if (err instanceof RunValidationError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    const { models, judges, prompts } = resolved;
    const outputsCap = args.outputs != null ? args.outputs : Infinity;
    const outputsDesc = outputsCap === Infinity ? "unlimited (adaptive)" : String(outputsCap);
    const ciThreshold = args.confidence;
    console.log("Dry run -- would execute:");
    console.log(`  Writers: ${models.map((m) => m.label).join(", ")}`);
    if (judges) {
      console.log(`  Judges:  ${judges.map((m) => m.label).join(", ")}`);
    }
    console.log(`  Prompts: ${prompts.map((p) => p.name).join(", ")}`);
    console.log(`  Outputs per model: ${outputsDesc}`);
    if (args.cacheOnly) {
      console.log(`  Mode: cache-only (no API calls)`);
    } else {
      console.log(`  Convergence target: ${formatConvergenceTarget(ciThreshold)}`);
      console.log(`\n  The adaptive loop will generate outputs and judgments as needed`);
      console.log(`  until ${formatConvergenceDescription(ciThreshold)}.`);
    }
    return;
  }

  const tuiConfig = cliArgsToTuiConfig(args);

  const bridge = createBenchmarkEventBridge();

  const { renderer, palette, root } = await createTui();

  // Exit promise: resolved when the user presses q after completion
  let resolveExit: () => void;
  const exitPromise = new Promise<void>((r) => { resolveExit = r; });
  const onExit = () => { resolveExit(); };

  root.render(
    <App
      subscribe={bridge.subscribe}
      subscribeWarning={bridge.subscribeWarning}
      initialBenchmarkMode="running"
      showSpeed={args.speed}
      palette={palette}
      onExit={onExit}
    />
  );

  try {
    const { result, savePath } = await executeRun(tuiConfig, {
      onEvent: bridge.onEvent,
      onWarning: bridge.onWarning,
    });

    // Wait for user to press q
    await exitPromise;

    await destroyTui(root, renderer);
    printFinalTables(result, palette);

    console.log(`Results saved to: ${savePath}`);
    console.log(
      `Total cost: $${result.meta.totalCost.toFixed(4)}`
    );
    console.log(
      `Duration: ${(result.meta.durationMs / 1000).toFixed(1)}s`
    );

    if (result.meta.errors && result.meta.errors.length > 0) {
      const unique = new Map<string, { count: number; example: TaskError }>();
      for (const e of result.meta.errors) {
        const key = e.model ? `${e.model}: ${e.message}` : e.message;
        const existing = unique.get(key);
        if (existing) {
          existing.count++;
        } else {
          unique.set(key, { count: 1, example: e });
        }
      }
      console.log(`\n${result.meta.errors.length} task(s) failed:`);
      for (const [msg, { count, example }] of unique) {
        const prefix = count > 1 ? `(${count}x) ` : "";
        console.log(`  ${prefix}${msg}`);
        const pad = "    ";
        if (example.statusCode != null || example.url) {
          const parts: string[] = [];
          if (example.statusCode != null) parts.push(`status=${example.statusCode}`);
          if (example.url) parts.push(example.url);
          console.log(`${pad}${parts.join(" ")}`);
        }
        if (example.responseBody) {
          console.log(`${pad}body: ${example.responseBody}`);
        }
        if (example.stack) {
          const frames = example.stack
            .split("\n")
            .filter((l) => l.trimStart().startsWith("at "))
            .slice(0, 5);
          if (frames.length > 0) {
            for (const frame of frames) {
              console.log(`${pad}${frame.trim()}`);
            }
          }
        }
      }
    }
  } catch (error) {
    await destroyTui(root, renderer);
    console.error("Benchmark failed:", error);
    process.exit(1);
  }
}

async function handleTui() {
  const { renderer, palette, root } = await createTui();
  const bridge = createBenchmarkEventBridge();

  async function startRun(tuiConfig: TuiRunConfig): Promise<void> {
    await executeRun(tuiConfig, {
      onEvent: bridge.onEvent,
      onWarning: bridge.onWarning,
    });
  }

  let resolveExit: () => void;
  const exitPromise = new Promise<void>((r) => { resolveExit = r; });
  const onExit = () => { resolveExit(); };

  root.render(
    <App
      subscribe={bridge.subscribe}
      subscribeWarning={bridge.subscribeWarning}
      onStartRun={startRun}
      initialBenchmarkMode="configure"
      palette={palette}
      onExit={onExit}
    />,
  );

  await exitPromise;
  await destroyTui(root, renderer);
}

async function handleResults(
  args: Extract<Command, { command: "results" }>["args"]
) {
  if (args.latest && args.runId) {
    throw new Error("Use either [run-id] or --latest, not both.");
  }

  let result;
  if (args.runId) {
    result = await loadRun(args.runId);
  } else {
    result = await loadLatestRun();
    if (!result) {
      console.log("No runs found.");
      return;
    }
  }

  if (args.format === "json") {
    console.log(JSON.stringify(runResultForJson(result), null, 2));
    return;
  }

  // Table format
  console.log(`\nRun: ${result.config.id}`);
  console.log(
    `Models: ${result.config.models.map((m) => m.label).join(", ")}`
  );
  console.log(
    `Prompts: ${result.config.prompts.map((p) => p.name).join(", ")}`
  );
  console.log(`Cost: $${result.meta.totalCost.toFixed(4)}`);
  console.log(
    `Duration: ${(result.meta.durationMs / 1000).toFixed(1)}s`
  );
  console.log(
    `Termination: ${result.meta.terminationReason}${result.meta.converged ? "" : " (not converged)"}`
  );

  printEloTablePlain("Initial Writer ELO", result.elo.initial.ratings);
  printEloTablePlain("Revised Writer ELO", result.elo.revised.ratings);
  if (result.elo.revised.feedbackRatings) {
    printEloTablePlain(
      "Feedback Provider ELO",
      result.elo.revised.feedbackRatings
    );
  }
}

async function handleElo(
  args: Extract<Command, { command: "elo" }>["args"]
) {
  if (args.recompute) {
    await recomputeCumulativeElo();
  }

  const elo = await loadCumulativeElo();

  if (args.format === "json") {
    console.log(JSON.stringify(elo, null, 2));
    return;
  }

  const writingRatings = Object.values(elo.writing).sort(
    (a, b) => b.rating - a.rating
  );
  const feedbackRatings = Object.values(elo.feedbackGiving).sort(
    (a, b) => b.rating - a.rating
  );

  const taggedWritingRatings = args.tag
    ? Object.values(elo.writingByTag?.[args.tag] ?? {}).sort(
      (a, b) => b.rating - a.rating,
    )
    : [];

  if (!args.tag && writingRatings.length === 0) {
    console.log("No cumulative ELO data yet. Run a benchmark first.");
    return;
  }

  if (args.tag && taggedWritingRatings.length === 0) {
    console.log(`No cumulative writer ELO data found for tag: ${args.tag}`);
    return;
  }

  if (args.tag) {
    printEloTablePlain(`Cumulative Writer ELO (tag: ${args.tag})`, taggedWritingRatings);
  } else {
    printEloTablePlain("Cumulative Writer ELO", writingRatings);
  }
  if (feedbackRatings.length > 0) {
    printEloTablePlain("Cumulative Feedback Provider ELO", feedbackRatings);
  }

  console.log(`\nLast updated: ${elo.lastUpdated}`);
  console.log(`Total runs: ${elo.history.length}`);
}

/** Delete cumulative ELO and rebuild from all stored run results. */
async function recomputeCumulativeElo(): Promise<void> {
  const runIds = await listRuns();
  if (runIds.length === 0) {
    console.log("No stored runs found. Nothing to recompute.");
    return;
  }

  console.log(`Replaying ${runIds.length} runs...`);
  await rebuildCumulativeElo((id) => {
    console.log(`  Replayed ${id}`);
  });
  console.log("Cumulative ELO recomputed.\n");
}

async function handleRunsList(
  args: Extract<Command, { command: "runs-list" }>["args"]
) {
  const summaries = await listRunSummaries();

  if (summaries.length === 0) {
    console.log("No runs found.");
    return;
  }

  if (args.format === "json") {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  console.log(`\n${summaries.length} run(s):\n`);
  console.log(
    `${"ID".padEnd(28)}${"Models".padEnd(30)}${"Prompts".padStart(8)}${"Cost".padStart(10)}${"Duration".padStart(10)}`
  );
  console.log("─".repeat(86));
  for (const s of summaries) {
    const models = s.models.join(", ");
    const modelsTrunc = models.length > 28 ? models.slice(0, 25) + "..." : models;
    console.log(
      `${s.id.padEnd(28)}${modelsTrunc.padEnd(30)}${String(s.promptCount).padStart(8)}${("$" + s.totalCost.toFixed(4)).padStart(10)}${(s.durationMs / 1000).toFixed(1).padStart(9)}s`
    );
  }
}

async function handleRunsDelete(
  args: Extract<Command, { command: "runs-delete" }>["args"]
) {
  console.log(`Deleting run ${args.runId}...`);
  try {
    await deleteRunFull(args.runId, (step) => {
      console.log(`  ${step}`);
    });
    console.log(`\nRun ${args.runId} deleted.`);
  } catch (error) {
    console.error(
      `Failed to delete run: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}

async function handleExport(
  args: Extract<Command, { command: "export" }>["args"]
) {
  console.log("Rebuilding cumulative ELO from stored runs...");
  await rebuildCumulativeElo();
  const count = await exportForWeb(args.out);
  console.log(`Exported ${count} run(s) to ${args.out}/`);
}

async function buildWeb() {
  // Refresh model logo asset map
  const logosProc = Bun.spawn(
    ["bun", "scripts/fetch-logos.ts"],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await logosProc.exited !== 0) {
    throw new Error("Logo build failed");
  }

  // Generate standalone methodology.html
  const methodologyProc = Bun.spawn(
    ["bun", "web/src/build-methodology.ts"],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await methodologyProc.exited !== 0) {
    throw new Error("Methodology build failed");
  }

  // Bundle route JS entrypoints
  const result = await Bun.build({
    entrypoints: [
      "web/src/app.ts",
      "web/src/dashboard.ts",
      "web/src/run-detail.ts",
    ],
    outdir: "web",
    target: "browser",
    minify: true,
    splitting: true,
    format: "esm",
    naming: {
      entry: "[name].js",
      chunk: "chunk-[hash].js",
      asset: "asset-[hash].[ext]",
    },
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Web build failed");
  }

  // Minify static CSS files used by the web viewer
  const cssResult = await Bun.build({
    entrypoints: [
      "web/src/style-base.css",
      "web/src/style-methodology.css",
      "web/src/style-run-detail.css",
    ],
    outdir: "web",
    target: "browser",
    minify: true,
  });
  if (!cssResult.success) {
    for (const log of cssResult.logs) {
      console.error(log);
    }
    throw new Error("Web CSS minification failed");
  }
}

async function handleServe(
  args: Extract<Command, { command: "serve" }>["args"],
) {
  // Build web viewer from TypeScript
  await buildWeb();
  console.log("Built web viewer");

  console.log("Rebuilding cumulative ELO from stored runs...");
  await rebuildCumulativeElo();

  // Export latest data
  const count = await exportForWeb("web/data");
  console.log(`Exported ${count} run(s)`);

  const server = Bun.serve({
    port: args.port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = url.pathname === "/" ? "/index.html" : url.pathname;

      // Serve pre-compressed .gz variant if client accepts gzip
      const acceptsGzip = req.headers.get("accept-encoding")?.includes("gzip");
      if (acceptsGzip) {
        const gzFile = Bun.file(`web${path}.gz`);
        if (await gzFile.exists()) {
          return new Response(gzFile, {
            headers: {
              "Content-Encoding": "gzip",
              "Content-Type": Bun.file(`web${path}`).type,
            },
          });
        }
      }

      const file = Bun.file(`web${path}`);
      if (await file.exists()) return new Response(file);
      return new Response("Not found", { status: 404 });
    },
  });

  const viewUrl = `http://localhost:${server.port}`;
  console.log(`Serving at ${viewUrl}`);

  if (args.open) {
    const proc = Bun.spawn(["open", viewUrl]);
    await proc.exited;
  }
}

async function handleCacheStatus(
  args: Extract<Command, { command: "cache-status" }>["args"]
) {
  const prompts = await loadAndFilterPrompts(args.prompts, args.filter);

  const writerKeys = args.models?.map(specToKey);
  const judgeKeys = args.judges?.map(specToKey);

  const result = await analyzeCacheStatus({
    prompts,
    outputsPerModel: args.outputs,
    writerKeys,
    judgeKeys,
  });

  if (result.writerKeys.length === 0) {
    console.log("No cache data found.");
    return;
  }

  if (args.format === "json") {
    console.log(formatCacheStatusJson(result));
  } else {
    console.log(formatCacheStatusTable(result));
  }
}

async function handleClearCache(
  args: Extract<Command, { command: "cache-clear" }>["args"]
) {
  const mk = specToKey(args.model);
  const cacheBase = join(process.cwd(), "data", "cache");

  // ── Trim mode: keep first N outputs, delete the rest ──
  if (args.outputs !== undefined) {
    const result = await trimModelOutputs(cacheBase, mk, args.outputs);

    if (result.writesDeleted === 0) {
      if (result.totalPrompts === 0) {
        console.log(`No cache found for ${args.model}.`);
      } else {
        console.log(
          `Nothing to trim -- all prompts already have \u2264 ${args.outputs} outputs for ${args.model}.`,
        );
      }
      return;
    }

    console.log(`Trimmed ${args.model} to ${args.outputs} outputs per prompt:`);
    console.log(`  ${result.promptsAffected} prompts affected (of ${result.totalPrompts} total)`);
    console.log(`  ${result.writesDeleted} writes removed`);
    console.log(`  ${result.feedbackDeleted} feedback files removed`);
    console.log(`  ${result.revisionsDeleted} revisions removed`);
    console.log(`  ${result.judgmentsDeleted} stale judgments removed`);
    return;
  }

  // ── Full clear mode (existing behavior) ──
  let totalRemoved = 0;

  if (!args.judgmentsOnly) {
    const categories = ["writes", "feedback", "revisions"] as const;
    for (const category of categories) {
      const dir = join(cacheBase, category, mk);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true });
        await removeIfEmpty(dirname(dir), join(cacheBase, category));
        console.log(`  Removed ${category}/${mk}/`);
        totalRemoved++;
      }
    }
  }

  // Always clear judgments involving this model.
  // Judgments are stored under the judge model's directory, but stale
  // entries (referencing deleted sample IDs) waste disk. Clear them all.
  const judgmentsDir = join(cacheBase, "judgments");
  if (existsSync(judgmentsDir)) {
    await rm(judgmentsDir, { recursive: true });
    console.log("  Removed judgments/ (all judges)");
    totalRemoved++;
  }

  if (totalRemoved === 0) {
    console.log(`No cache found for ${args.model}`);
  } else {
    console.log(`\nCleared cache for ${args.model}.`);
  }
}

async function handleCacheCombine(
  args: Extract<Command, { command: "cache-combine" }>["args"]
) {
  const sourceKey = specToKey(args.source);
  const targetKey = specToKey(args.target);

  if (sourceKey === targetKey) {
    console.log("Source and target resolve to the same cache key. Nothing to do.");
    return;
  }

  const cacheBase = join(process.cwd(), "data", "cache");
  const result = await combineModelCaches(cacheBase, sourceKey, targetKey);

  const conflicts = result.feedbackConflicts + result.revisionsConflicts + result.judgmentsConflicts;
  const total = result.writesMoved + result.feedbackMoved + result.feedbackDeduped
    + result.revisionsMoved + result.revisionsRekeyed + result.judgmentsMoved
    + conflicts;
  if (total === 0) {
    console.log(`No cache data found for ${args.source}.`);
    return;
  }

  console.log(`Combined cache from ${args.source} into ${args.target}:`);
  console.log(`  ${result.writesMoved} writes moved`);
  console.log(`  ${result.feedbackMoved} feedback files moved${result.feedbackDeduped > 0 ? `, ${result.feedbackDeduped} deduplicated` : ""}`);
  console.log(`  ${result.revisionsMoved} revisions moved${result.revisionsRekeyed > 0 ? `, ${result.revisionsRekeyed} re-keyed` : ""}`);
  console.log(`  ${result.judgmentsMoved} judgments moved`);
  if (conflicts > 0) {
    console.log(
      `  ${conflicts} same-key conflict${conflicts === 1 ? "" : "s"} skipped `
      + `(feedback: ${result.feedbackConflicts}, revisions: ${result.revisionsConflicts}, judgments: ${result.judgmentsConflicts})`
    );
  }
}

// Main
async function main() {
  try {
    const cmd = await parseArgs();

    switch (cmd.command) {
      case "run":
        await handleRun(cmd.args);
        break;
      case "results":
        await handleResults(cmd.args);
        break;
      case "export":
        await handleExport(cmd.args);
        break;
      case "elo":
        await handleElo(cmd.args);
        break;
      case "serve":
        await handleServe(cmd.args);
        break;
      case "cache-clear":
        await handleClearCache(cmd.args);
        break;
      case "cache-combine":
        await handleCacheCombine(cmd.args);
        break;
      case "cache-status":
        await handleCacheStatus(cmd.args);
        break;
      case "runs-list":
        await handleRunsList(cmd.args);
        break;
      case "runs-delete":
        await handleRunsDelete(cmd.args);
        break;
      case "tui":
        await handleTui();
        break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
