#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { parseArgs, type Command } from "./cli.js";
import { loadPrompts, parseModelConfigs, createRunConfig } from "./config.js";
import { BenchmarkRunner } from "./engine/runner.js";
import { saveRun, loadRun, loadLatestRun, listRuns } from "./storage/run-store.js";
import { updateCumulativeElo, loadCumulativeElo } from "./storage/elo-store.js";
import { exportForWeb } from "./export/web-export.js";
import { checkProviderEnv } from "./providers/models.js";
import { App } from "./ui/App.js";
import type { BenchmarkEvent, EloRating } from "./types.js";

async function handleRun(args: Extract<Command, { command: "run" }>["args"]) {
  const models = parseModelConfigs(args.models);
  const prompts = await loadPrompts(args.prompts);

  // Check provider env vars and warn about missing ones
  const providers = [...new Set(models.map((m) => m.provider))];
  const envWarnings = await checkProviderEnv(providers);
  for (const warn of envWarnings) {
    console.warn(`Warning: ${warn}`);
  }

  if (args.dryRun) {
    console.log("Dry run — would execute:");
    console.log(`  Models: ${models.map((m) => m.label).join(", ")}`);
    console.log(`  Prompts: ${prompts.map((p) => p.name).join(", ")}`);
    console.log(`  Outputs per model: ${args.outputs}`);

    const nSamples = models.length * prompts.length * args.outputs;
    const nPairsPerPrompt =
      (models.length * args.outputs * (models.length * args.outputs - 1)) / 2;
    const nJudgments = nPairsPerPrompt * models.length * prompts.length;
    const nFeedback = nSamples * models.length;

    console.log(`\n  Stage 1 writing: ${nSamples} samples`);
    console.log(`  Stage 1 judging: ${nJudgments} judgments`);
    console.log(`  Stage 2 feedback: ${nFeedback} reviews`);
    console.log(`  Stage 3 writing: ${nFeedback} revisions`);
    console.log(
      `  Stage 3 judging: ~${nJudgments * models.length} judgments`
    );
    console.log(
      `\n  Total API calls: ~${nSamples + nJudgments + nFeedback + nFeedback + nJudgments * models.length}`
    );
    return;
  }

  const config = createRunConfig({
    models,
    prompts,
    outputsPerModel: args.outputs,
    reasoning: args.reasoning,
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

async function handleServe(
  args: Extract<Command, { command: "serve" }>["args"]
) {
  // Export latest data first
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
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
