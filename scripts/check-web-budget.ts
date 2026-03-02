import { basename, dirname, join } from "path";

const BASE_BUDGET_BYTES = 14 * 1024;
const RUN_BUDGET_BYTES = 24 * 1024;

export type RouteName = "base" | "run";
type RouteOption = RouteName | "all";

interface CliOptions {
  route: RouteOption;
  json: boolean;
}

interface JsGraph {
  files: Set<string>;
}

interface FileStat {
  path: string;
  gzipBytes: number;
}

interface RouteReport {
  route: RouteName;
  budgetBytes: number;
  totalBytes: number;
  files: FileStat[];
}

const ROUTE_FIXED_FILES = [
  "web/index.html",
  "web/style-base.css",
];

const ROUTE_ENTRYPOINTS: Record<RouteName, string[]> = {
  "base": ["web/app.js", "web/dashboard.js"],
  "run": ["web/app.js", "web/run-detail.js"],
};

const ROUTE_BUDGETS: Record<RouteName, number> = {
  "base": BASE_BUDGET_BYTES,
  "run": RUN_BUDGET_BYTES,
};

async function main(): Promise<void> {
  const options = parseCliOptions(Bun.argv.slice(2));
  const routes: RouteName[] = options.route === "all"
    ? ["base", "run"]
    : [options.route];

  const reports: RouteReport[] = [];
  for (const route of routes) {
    const files = await collectRouteFiles(route);
    reports.push(await buildRouteReport(route, ROUTE_BUDGETS[route], files));
  }

  const failures = reports.filter((report) => report.totalBytes > report.budgetBytes);

  if (options.json) {
    console.log(JSON.stringify({
      ok: failures.length === 0,
      reports,
    }, null, 2));
  } else {
    printReports(reports);
  }

  if (failures.length > 0) {
    const details = failures.map((report) => {
      const overBy = report.totalBytes - report.budgetBytes;
      return `${report.route} by ${overBy} B`;
    }).join(", ");
    throw new Error(`Web budget exceeded: ${details}`);
  }
}

function parseCliOptions(args: string[]): CliOptions {
  let route: RouteOption = "all";
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg.startsWith("--route=")) {
      route = parseRouteValue(arg.slice("--route=".length));
      continue;
    }

    if (arg === "--route") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("Missing value for --route");
      }
      route = parseRouteValue(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { route, json };
}

function parseRouteValue(value: string): RouteOption {
  if (value === "all" || value === "base" || value === "run") {
    return value;
  }
  throw new Error(`Invalid --route value: ${value}`);
}

export async function collectRouteFiles(route: RouteName): Promise<Set<string>> {
  const entryPaths = ROUTE_ENTRYPOINTS[route];
  const files = new Set<string>(ROUTE_FIXED_FILES);

  for (const entryPath of entryPaths) {
    const graph = await collectJsGraph([entryPath], false);
    for (const jsPath of graph.files) {
      files.add(jsPath);
    }
  }

  return files;
}

async function buildRouteReport(
  route: RouteName,
  budgetBytes: number,
  files: Set<string>,
): Promise<RouteReport> {
  const sortedPaths = [...files]
    .filter(shouldCountFile)
    .sort((a, b) => a.localeCompare(b));

  const stats: FileStat[] = [];
  for (const filePath of sortedPaths) {
    const size = await gzipFileSize(filePath);
    stats.push({ path: filePath, gzipBytes: size });
  }

  const totalBytes = stats.reduce((sum, stat) => sum + stat.gzipBytes, 0);

  return {
    route,
    budgetBytes,
    totalBytes,
    files: stats,
  };
}

function shouldCountFile(filePath: string): boolean {
  return !filePath.endsWith(".json");
}

async function gzipFileSize(filePath: string): Promise<number> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Missing required file: ${filePath}`);
  }

  const buffer = await file.arrayBuffer();
  return Bun.gzipSync(buffer).byteLength;
}

async function collectJsGraph(
  entryPaths: string[],
  includeDynamicImports: boolean,
): Promise<JsGraph> {
  const files = new Set<string>();
  const queue = [...entryPaths];

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    if (files.has(filePath)) {
      continue;
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      throw new Error(`Missing JS import target: ${filePath}`);
    }

    files.add(filePath);
    const source = await file.text();

    const staticImports = getStaticJsImports(source);
    for (const relImport of staticImports) {
      const resolved = resolveJsImport(filePath, relImport);
      if (!files.has(resolved)) {
        queue.push(resolved);
      }
    }

    if (includeDynamicImports) {
      const dynamicImports = getDynamicJsImports(source);
      for (const relImport of dynamicImports) {
        const resolved = resolveJsImport(filePath, relImport);
        if (!files.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }

  return { files };
}

function resolveJsImport(fromFilePath: string, relativeImport: string): string {
  return join(dirname(fromFilePath), relativeImport);
}

function getStaticJsImports(source: string): string[] {
  const imports: string[] = [];

  const fromImport = /from\s*["'](\.\/[^"']+\.js)["']/g;
  let match = fromImport.exec(source);
  while (match) {
    imports.push(match[1]);
    match = fromImport.exec(source);
  }

  const sideEffectImport = /import\s*["'](\.\/[^"']+\.js)["']/g;
  match = sideEffectImport.exec(source);
  while (match) {
    imports.push(match[1]);
    match = sideEffectImport.exec(source);
  }

  return imports;
}

function getDynamicJsImports(source: string): string[] {
  const imports: string[] = [];
  const dynamicImport = /import\(\s*["'](\.\/[^"']+\.js)["']\s*\)/g;
  let match = dynamicImport.exec(source);
  while (match) {
    imports.push(match[1]);
    match = dynamicImport.exec(source);
  }
  return imports;
}

function printReports(reports: RouteReport[]): void {
  console.log("Web budget check (gzip):");
  for (const report of reports) {
    console.log(`\n[${report.route}]`);
    for (const stat of report.files) {
      console.log(`  ${basename(stat.path)}: ${stat.gzipBytes} B`);
    }
    const status = report.totalBytes <= report.budgetBytes ? "pass" : "fail";
    console.log(`  total: ${report.totalBytes} B`);
    console.log(`  budget: ${report.budgetBytes} B`);
    console.log(`  status: ${status}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
