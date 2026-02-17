import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export interface RunArgs {
  models: string[];
  judges?: string[];
  prompts: string;
  filter?: string[];
  outputs: number;
  concurrency: number;
  resume?: string;
  dryRun: boolean;
  speed: boolean;
  reasoning: boolean;
  noCache: boolean;
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
}

export interface ServeArgs {
  port: number;
  open: boolean;
}

export interface ClearCacheArgs {
  model: string;
  judgmentsOnly: boolean;
}

export type Command =
  | { command: "run"; args: RunArgs }
  | { command: "results"; args: ResultsArgs }
  | { command: "export"; args: ExportArgs }
  | { command: "elo"; args: EloArgs }
  | { command: "serve"; args: ServeArgs }
  | { command: "clear-cache"; args: ClearCacheArgs };

export async function parseArgs(): Promise<Command> {
  return new Promise((resolve, reject) => {
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
              demandOption: true,
              describe:
                "Model specs: provider:model[=label] (repeatable)",
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
              default: 1,
              describe: "Outputs per model per prompt (max 3)",
            })
            .option("concurrency", {
              type: "number",
              default: 5,
              describe: "Max parallel API calls",
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
            }),
        (argv) => {
          resolve({
            command: "run",
            args: {
              models: argv.models,
              judges: argv.judges,
              prompts: argv.prompts,
              filter: argv.filter,
              outputs: Math.min(Math.max(argv.outputs, 1), 3),
              concurrency: argv.concurrency,
              resume: argv.resume,
              dryRun: argv.dryRun,
              speed: argv.speed,
              reasoning: argv.reasoning,
              noCache: !argv.cache,
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
            }),
        (argv) => {
          resolve({
            command: "elo",
            args: {
              tag: argv.tag,
              format: argv.format,
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
      .command(
        "clear-cache <model>",
        "Clear cached outputs for a model (e.g. opencode:glm-4.7)",
        (y) =>
          y
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
            }),
        (argv) => {
          resolve({
            command: "clear-cache",
            args: {
              model: argv.model,
              judgmentsOnly: argv.judgmentsOnly,
            },
          });
        }
      )
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
