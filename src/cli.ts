import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export interface RunArgs {
  models: string[];
  prompts: string;
  outputs: number;
  concurrency: number;
  resume?: string;
  dryRun: boolean;
  speed: boolean;
  reasoning: boolean;
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
  category?: string;
  format: "table" | "json";
}

export interface ServeArgs {
  port: number;
  open: boolean;
}

export type Command =
  | { command: "run"; args: RunArgs }
  | { command: "results"; args: ResultsArgs }
  | { command: "export"; args: ExportArgs }
  | { command: "elo"; args: EloArgs }
  | { command: "serve"; args: ServeArgs };

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
                "Model specs: provider:model[:label] (repeatable)",
            })
            .option("prompts", {
              alias: "p",
              type: "string",
              default: "prompts/*.toml",
              describe: "Glob pattern for prompt files",
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
            .option("no-reasoning", {
              type: "boolean",
              default: false,
              describe: "Skip reasoning in judgments (reduces output tokens)",
            }),
        (argv) => {
          resolve({
            command: "run",
            args: {
              models: argv.models,
              prompts: argv.prompts,
              outputs: Math.min(Math.max(argv.outputs, 1), 3),
              concurrency: argv.concurrency,
              resume: argv.resume,
              dryRun: argv.dryRun,
              speed: argv.speed,
              reasoning: !argv.noReasoning,
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
            .option("category", {
              type: "string",
              describe: "Filter by prompt category",
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
              category: argv.category,
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
