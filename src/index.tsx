#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { join } from "path";
import { rm } from "fs/promises";
import { existsSync } from "fs";
import { parseArgs, type Command } from "./cli.js";
import { loadPrompts, parseModelConfigs, createRunConfig, filterPrompts } from "./config.js";
import { BenchmarkRunner } from "./engine/runner.js";
import { saveRun, loadRun, loadLatestRun, listRuns } from "./storage/run-store.js";
import { updateCumulativeElo, loadCumulativeElo } from "./storage/elo-store.js";
import { exportForWeb } from "./export/web-export.js";
import { checkProviderEnv } from "./providers/models.js";
import { App } from "./ui/App.js";
import type { BenchmarkEvent, EloRating, TaskError } from "./types.js";

async function handleRun(args: Extract<Command, { command: "run" }>["args"]) {
  const models = parseModelConfigs(args.models);
  const judges = args.judges?.length
    ? parseModelConfigs(args.judges)
    : undefined;
  let prompts = await loadPrompts(args.prompts);

  // Apply prompt filter (match against id or category)
  if (args.filter && args.filter.length > 0) {
    const before = prompts.length;
    prompts = filterPrompts(prompts, args.filter);
    if (prompts.length === 0) {
      console.error(
        `No prompts matched filter: ${args.filter.join(", ")}`
      );
      process.exit(1);
    }
    if (prompts.length < before) {
      console.log(
        `Filtered to ${prompts.length} prompt(s): ${prompts.map((p) => p.name).join(", ")}`
      );
    }
  }

  // Check provider env vars and warn about missing ones
  const allProviders = [...new Set([
    ...models.map((m) => m.provider),
    ...(judges ?? []).map((m) => m.provider),
  ])];
  const envWarnings = await checkProviderEnv(allProviders);
  for (const warn of envWarnings) {
    console.warn(`Warning: ${warn}`);
  }

  const judgeModels = judges ?? models;
  const W = models.length;
  const J = judgeModels.length;

  if (args.dryRun) {
    console.log("Dry run — would execute:");
    console.log(`  Writers: ${models.map((m) => m.label).join(", ")}`);
    if (judges) {
      console.log(`  Judges:  ${judges.map((m) => m.label).join(", ")}`);
    }
    console.log(`  Prompts: ${prompts.map((p) => p.name).join(", ")}`);
    console.log(`  Outputs per model: ${args.outputs}`);

    const P = prompts.length;
    const N = args.outputs;
    const nSamples = W * P * N;
    const samplesPerPrompt = W * N;
    const nPairsPerPrompt =
      (samplesPerPrompt * (samplesPerPrompt - 1)) / 2;
    const nInitialJudgments = nPairsPerPrompt * J * P;
    const nFeedback = nSamples * W;
    const nRevisions = nFeedback;
    const nImprovementJudgments = nRevisions * J;
    // Revised pairs: W feedback groups per prompt, each with W*N revisions
    const revisionsPerFbGroup = W * N;
    const pairsPerFbGroup =
      (revisionsPerFbGroup * (revisionsPerFbGroup - 1)) / 2;
    const nRevisedJudgments = W * pairsPerFbGroup * J * P;

    console.log(`\n  Stage 1 writing: ${nSamples} samples`);
    console.log(`  Stage 1 judging: ${nInitialJudgments} judgments`);
    console.log(`  Stage 2 feedback: ${nFeedback} reviews`);
    console.log(`  Stage 3 writing: ${nRevisions} revisions`);
    console.log(`  Stage 3 improvement judging: ${nImprovementJudgments} judgments`);
    console.log(`  Stage 3 revised judging: ${nRevisedJudgments} judgments`);
    console.log(
      `\n  Total API calls: ~${nSamples + nInitialJudgments + nFeedback + nRevisions + nImprovementJudgments + nRevisedJudgments}`
    );
    return;
  }

  const config = createRunConfig({
    models,
    judges,
    prompts,
    outputsPerModel: args.outputs,
    reasoning: args.reasoning,
    noCache: args.noCache,
  });

  const runner = new BenchmarkRunner(config);

  // Set up Ink UI
  let eventHandler: ((event: BenchmarkEvent) => void) | null = null;
  const subscribe = (handler: (event: BenchmarkEvent) => void) => {
    eventHandler = handler;
  };

  const { unmount, waitUntilExit } = render(
    <App subscribe={subscribe} showSpeed={args.speed} />
  );

  runner.on((event) => {
    if (eventHandler) eventHandler(event);
  });

  try {
    const result = await runner.run();

    // Save run
    const path = await saveRun(result);

    // Update cumulative ELO
    await updateCumulativeElo(result);

    // Wait for UI to render final state
    await new Promise((resolve) => setTimeout(resolve, 500));
    unmount();

    console.log(`\nResults saved to: ${path}`);
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
          // Print the first few frames after the error line
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
    unmount();
    console.error("Benchmark failed:", error);
    process.exit(1);
  }
}

async function handleResults(
  args: Extract<Command, { command: "results" }>["args"]
) {
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
    console.log(JSON.stringify(result, null, 2));
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

  printEloTable("Initial Writer ELO", result.elo.initial.ratings);
  printEloTable("Revised Writer ELO", result.elo.revised.ratings);
  if (result.elo.revised.feedbackRatings) {
    printEloTable(
      "Feedback Provider ELO",
      result.elo.revised.feedbackRatings
    );
  }
}

async function handleElo(
  args: Extract<Command, { command: "elo" }>["args"]
) {
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

  if (writingRatings.length === 0) {
    console.log("No cumulative ELO data yet. Run a benchmark first.");
    return;
  }

  printEloTable("Cumulative Writer ELO", writingRatings);
  if (feedbackRatings.length > 0) {
    printEloTable("Cumulative Feedback Provider ELO", feedbackRatings);
  }

  console.log(`\nLast updated: ${elo.lastUpdated}`);
  console.log(`Total runs: ${elo.history.length}`);
}

async function handleExport(
  args: Extract<Command, { command: "export" }>["args"]
) {
  const count = await exportForWeb(args.out);
  console.log(`Exported ${count} run(s) to ${args.out}/`);
}

async function buildWeb() {
  const result = await Bun.build({
    entrypoints: ["web/src/app.ts"],
    outdir: "web",
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Web build failed");
  }
}

async function handleServe(
  args: Extract<Command, { command: "serve" }>["args"]
) {
  // Build web viewer from TypeScript
  await buildWeb();
  console.log("Built web viewer");

  // Export latest data
  const count = await exportForWeb("web/data");
  console.log(`Exported ${count} run(s)`);

  const server = Bun.serve({
    port: args.port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = url.pathname === "/" ? "/index.html" : url.pathname;
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

function printEloTable(title: string, ratings: EloRating[]) {
  console.log(`\n${title}`);
  console.log("─".repeat(50));
  console.log(
    `${"#".padEnd(4)}${"Model".padEnd(25)}${"ELO".padStart(6)}  ${"W/L/T".padStart(11)}`
  );
  console.log("─".repeat(50));
  for (let i = 0; i < ratings.length; i++) {
    const r = ratings[i];
    const wlt = `${r.wins}/${r.losses}/${r.ties}`;
    console.log(
      `${String(i + 1).padEnd(4)}${r.model.padEnd(25)}${String(r.rating).padStart(6)}  ${wlt.padStart(11)}`
    );
  }
}

async function handleClearCache(
  args: Extract<Command, { command: "clear-cache" }>["args"]
) {
  // Parse "provider:model" into a filesystem-safe key
  const parts = args.model.split(":");
  if (parts.length < 2) {
    console.error(
      'Invalid model spec. Use provider:model format (e.g. opencode:glm-4.7)'
    );
    process.exit(1);
  }
  const modelKey = `${parts[0]}_${parts.slice(1).join("_")}`.replace(
    /[:/\\]/g,
    "_"
  );

  const cacheBase = join(process.cwd(), "data", "cache");
  let totalRemoved = 0;

  if (!args.judgmentsOnly) {
    const categories = ["writes", "feedback", "revisions"] as const;
    for (const category of categories) {
      const dir = join(cacheBase, category, modelKey);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true });
        console.log(`  Removed ${category}/${modelKey}/`);
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
      case "clear-cache":
        await handleClearCache(cmd.args);
        break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
