import yargs from "yargs";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { hideBin } from "yargs/helpers";
import type { JudgeQualityMode } from "./types.js";
import { DEFAULT_CONVERGENCE } from "./types.js";

export interface RunArgs {
  models?: string[];
  judges?: string[];
  prompts: string;
  filter?: string[];
  outputs?: number;
  resume?: string;
  dryRun: boolean;
  speed: boolean;
  reasoning: boolean;
  noCache: boolean;
  confidence: number;
  maxRounds: number;
  writingWeight: number;
  feedbackWeight: number;
  revisedWeight: number;
  judgeQuality: boolean;
  judgeQualityMode: JudgeQualityMode;
  judgeSensitivity: "low" | "medium" | "high";
  judgeDecay?: number;
  judgePruneThreshold?: number;
  cacheOnly: boolean;
  skipSeeding: boolean;
}

export interface ResultsArgs {
  runId?: string;
  latest: boolean;
  format: "table" | "json";
}

export interface ExportArgs {
  out: string;
}

export interface EloArgs {
  tag?: string;
  format: "table" | "json";
  recompute: boolean;
}

export interface ServeArgs {
  port: number;
  open: boolean;
}

export interface ClearCacheArgs {
  model: string;
  judgmentsOnly: boolean;
  outputs?: number;
}

export interface CacheStatusArgs {
  prompts: string;
  filter?: string[];
  outputs: number;
  models?: string[];
  judges?: string[];
  format: "table" | "json";
}

export type Command =
  | { command: "run"; args: RunArgs }
  | { command: "results"; args: ResultsArgs }
  | { command: "export"; args: ExportArgs }
  | { command: "elo"; args: EloArgs }
  | { command: "serve"; args: ServeArgs }
  | { command: "cache-clear"; args: ClearCacheArgs }
  | { command: "cache-status"; args: CacheStatusArgs };

function buildCacheCommand(resolve: (cmd: Command) => void) {
  const statusOpts = <T>(sy: Argv<T>) =>
    sy
      .option("prompts", {
        alias: "p",
        type: "string",
        default: "prompts/*.toml",
        describe: "Glob pattern for prompt files",
      })
      .option("filter", {
        alias: "f",
        type: "string",
        array: true,
        describe:
          "Filter prompts by id or tag (e.g. --filter sermon theological)",
      })
      .option("outputs", {
        alias: "n",
        type: "number",
        default: 0,
        describe:
          "Max outputs per model per prompt (0 = auto-detect from cache)",
      })
      .option("models", {
        alias: "m",
        type: "string",
        array: true,
        describe:
          "Restrict to specific writer models (auto-discovers from cache if omitted)",
      })
      .option("judges", {
        alias: "j",
        type: "string",
        array: true,
        describe:
          "Separate judge models (assumes judges=writers if omitted)",
      })
      .option("format", {
        type: "string",
        choices: ["table", "json"] as const,
        default: "table" as const,
        describe: "Output format",
      });

  const resolveCacheStatus = (argv: ArgumentsCamelCase<CacheStatusArgs>) => {
    resolve({
      command: "cache-status",
      args: {
        prompts: argv.prompts,
        filter: argv.filter,
        outputs: Math.max(argv.outputs, 0),
        models: argv.models,
        judges: argv.judges,
        format: argv.format,
      },
    });
  };

  // Builder: apply status options to the parent (so bare "cache" works)
  // and register subcommands.
  const builder = <T>(y: Argv<T>) =>
    statusOpts(y)
      .command("status", "Show what runs are possible from cache without API calls", statusOpts, resolveCacheStatus)
      .command(
        "clear <model>",
        "Clear cached outputs for a model (e.g. opencode:glm-4.7)",
        <U>(sy: Argv<U>) =>
          sy
            .positional("model", {
              type: "string",
              demandOption: true,
              describe:
                "Model spec: provider:model (e.g. opencode:glm-4.7)",
            })
            .option("judgments-only", {
              type: "boolean",
              default: false,
              describe:
                "Only clear judgment caches, keep writes/feedback/revisions",
            })
            .option("outputs", {
              alias: "n",
              type: "number",
              describe:
                "Keep first N outputs per prompt; trim the rest and linked artifacts",
            })
            .check((argv) => {
              if (argv.outputs !== undefined && argv.judgmentsOnly) {
                throw new Error("--outputs and --judgments-only are mutually exclusive");
              }
              if (argv.outputs !== undefined && argv.outputs < 0) {
                throw new Error("--outputs must be non-negative");
              }
              return true;
            }),
        (argv: ArgumentsCamelCase<ClearCacheArgs>) => {
          resolve({
            command: "cache-clear",
            args: {
              model: argv.model,
              judgmentsOnly: argv.judgmentsOnly,
              outputs: argv.outputs,
            },
          });
        }
      );

  // Bare "cache" (no subcommand) defaults to "cache status"
  return { builder, handler: resolveCacheStatus };
}

export async function parseArgs(): Promise<Command> {
  return new Promise((resolve, reject) => {
    const cache = buildCacheCommand(resolve);
    yargs(hideBin(process.argv))
      .scriptName("writing-bench")
      .usage("$0 <command> [options]")
      .command(
        "run",
        "Run a benchmark",
        (y) =>
          y
            .option("models", {
              alias: "m",
              type: "string",
              array: true,
              describe:
                "Model specs: provider:model[=label] (repeatable). Required unless --cache-only is used.",
            })
            .option("judges", {
              alias: "j",
              type: "string",
              array: true,
              describe:
                "Judge model specs: provider:model[=label] (repeatable). If omitted, --models are used for judging.",
            })
            .option("prompts", {
              alias: "p",
              type: "string",
              default: "prompts/*.toml",
              describe: "Glob pattern for prompt files",
            })
            .option("filter", {
              alias: "f",
              type: "string",
              array: true,
              describe:
                "Filter prompts by id or tag (e.g. --filter sermon theological)",
            })
            .option("outputs", {
              alias: "n",
              type: "number",
              describe:
                "Max outputs per model per prompt (default: unlimited, adaptive)",
            })
            .option("resume", {
              type: "string",
              describe: "Resume an interrupted run by ID",
            })
            .option("dry-run", {
              type: "boolean",
              default: false,
              describe: "Preview without API calls",
            })
            .option("speed", {
              type: "boolean",
              default: false,
              describe: "Show raw tok/s speed per model",
            })
            .option("reasoning", {
              type: "boolean",
              default: true,
              describe:
                "Include reasoning in judgments (use --no-reasoning to skip)",
            })
            .option("cache", {
              type: "boolean",
              default: true,
              describe:
                "Read from sample cache (use --no-cache to skip, still writes to cache)",
            })
            .option("confidence", {
              type: "number",
              default: DEFAULT_CONVERGENCE.ciThreshold,
              describe:
                "CI convergence threshold in Elo points (0 = stop when no CIs overlap, N > 0 = stop when all CIs < \u00b1N)",
            })
            .option("max-rounds", {
              type: "number",
              default: DEFAULT_CONVERGENCE.maxRounds,
              describe:
                "Maximum number of productive adaptive rounds",
            })
            .option("writing-weight", {
              type: "number",
              default: DEFAULT_CONVERGENCE.writingWeight,
              describe:
                "Priority weight for writing judgments",
            })
            .option("feedback-weight", {
              type: "number",
              default: DEFAULT_CONVERGENCE.feedbackWeight,
              describe:
                "Priority weight for feedback judgments",
            })
            .option("revised-weight", {
              type: "number",
              default: DEFAULT_CONVERGENCE.revisedWeight,
              describe:
                "Priority weight for revised judgments",
            })
            .option("cache-only", {
              type: "boolean",
              default: false,
              describe:
                "Only use cached data, no API calls. Auto-discovers models from cache if --models is omitted.",
            })
            .option("judge-quality", {
              type: "boolean",
              default: DEFAULT_CONVERGENCE.judgeQuality,
              describe:
                "Enable judge quality estimation and weighted ratings (use --no-judge-quality to disable)",
            })
            .option("judge-quality-mode", {
              type: "string",
              choices: ["consensus", "writing", "feedback", "revised"] as const,
              default: "consensus" as const,
              describe:
                "Signal for judge quality weights: consensus (majority vote), or use model ELO from writing/feedback/revised dimension",
            })
            .option("judge-sensitivity", {
              type: "string",
              choices: ["low", "medium", "high"] as const,
              default: "high" as const,
              describe:
                "Judge quality sensitivity preset: low (gentle), medium, high (aggressive)",
            })
            .option("judge-decay", {
              type: "number",
              describe:
                "Judge weight exponential decay rate (overrides --judge-sensitivity). Higher = sharper.",
            })
            .option("judge-prune-threshold", {
              type: "number",
              describe:
                "Prune judges with weight below this (0-1). Default from --judge-sensitivity.",
            })
            .option("skip-seeding", {
              type: "boolean",
              default: false,
              describe:
                "Skip exhaustive cache scan (Phase 1). The adaptive loop discovers cached data lazily.",
            })
            .check((argv) => {
              if (!argv.cacheOnly && (!argv.models || argv.models.length === 0)) {
                throw new Error("--models is required unless --cache-only is used");
              }
              if (argv.cacheOnly && !argv.cache) {
                throw new Error("--cache-only and --no-cache are mutually exclusive");
              }
              if ((argv.writingWeight as number) < 0) throw new Error("--writing-weight must be non-negative");
              if ((argv.feedbackWeight as number) < 0) throw new Error("--feedback-weight must be non-negative");
              if ((argv.revisedWeight as number) < 0) throw new Error("--revised-weight must be non-negative");
              if (argv.judgeDecay != null && (argv.judgeDecay as number) <= 0) throw new Error("--judge-decay must be positive");
              if (argv.judgePruneThreshold != null && ((argv.judgePruneThreshold as number) < 0 || (argv.judgePruneThreshold as number) > 1)) throw new Error("--judge-prune-threshold must be between 0 and 1");
              return true;
            }),
        (argv) => {
          resolve({
            command: "run",
            args: {
              models: argv.models,
              judges: argv.judges,
              prompts: argv.prompts,
              filter: argv.filter,
              outputs: argv.outputs != null ? Math.max(argv.outputs, 1) : undefined,
              resume: argv.resume,
              dryRun: argv.dryRun,
              speed: argv.speed,
              reasoning: argv.reasoning,
              noCache: !argv.cache,
              confidence: argv.confidence,
              maxRounds: argv.maxRounds,
              writingWeight: argv.writingWeight,
              feedbackWeight: argv.feedbackWeight,
              revisedWeight: argv.revisedWeight,
              judgeQuality: argv.judgeQuality,
              judgeQualityMode: argv.judgeQualityMode as JudgeQualityMode,
              judgeSensitivity: argv.judgeSensitivity as "low" | "medium" | "high",
              judgeDecay: argv.judgeDecay,
              judgePruneThreshold: argv.judgePruneThreshold,
              cacheOnly: argv.cacheOnly,
              skipSeeding: argv.skipSeeding,
            },
          });
        }
      )
      .command(
        "results [run-id]",
        "Show results from previous runs",
        (y) =>
          y
            .positional("run-id", {
              type: "string",
              describe: "Run ID to show",
            })
            .option("latest", {
              type: "boolean",
              default: false,
              describe: "Show most recent run",
            })
            .option("format", {
              type: "string",
              choices: ["table", "json"] as const,
              default: "table" as const,
              describe: "Output format",
            }),
        (argv) => {
          resolve({
            command: "results",
            args: {
              runId: argv.runId,
              latest: argv.latest,
              format: argv.format,
            },
          });
        }
      )
      .command(
        "export",
        "Export run data for web viewer",
        (y) =>
          y.option("out", {
            type: "string",
            default: "web/data",
            describe: "Output directory",
          }),
        (argv) => {
          resolve({
            command: "export",
            args: { out: argv.out },
          });
        }
      )
      .command(
        "elo",
        "Show cumulative ELO leaderboard",
        (y) =>
          y
            .option("tag", {
              type: "string",
              describe: "Filter by prompt tag",
            })
            .option("format", {
              type: "string",
              choices: ["table", "json"] as const,
              default: "table" as const,
              describe: "Output format",
            })
            .option("recompute", {
              type: "boolean",
              default: false,
              describe: "Recompute cumulative ELO from all stored runs",
            }),
        (argv) => {
          resolve({
            command: "elo",
            args: {
              tag: argv.tag,
              format: argv.format,
              recompute: argv.recompute,
            },
          });
        }
      )
      .command(
        "serve",
        "Export data and serve web viewer in browser",
        (y) =>
          y
            .option("port", {
              type: "number",
              default: 3000,
              describe: "Port to serve on",
            })
            .option("open", {
              type: "boolean",
              default: true,
              describe: "Open browser automatically",
            }),
        (argv) => {
          resolve({
            command: "serve",
            args: {
              port: argv.port,
              open: argv.open,
            },
          });
        }
      )
      .command("cache", "Cache management commands (defaults to status)", cache.builder, cache.handler)
      .demandCommand(1, "Please specify a command")
      .strict()
      .help()
      .fail((msg, err) => {
        if (err) reject(err);
        else reject(new Error(msg));
      })
      .parse();
  });
}
