import { basename, resolve, join, sep } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { collectRouteFiles } from "./check-web-budget.js";
import type { RouteName } from "./check-web-budget.js";

type RouteOption = RouteName | "all";
const DEFAULT_PACKET_BYTES = 1460;
const DEFAULT_PACKETS = 10;
// curl reports protocol- and server-specific header sizes. Use a fixed
// per-response allowance for the enforced budget while retaining measured
// header bytes in the report for diagnostics.
const RESPONSE_HEADER_BUDGET_BYTES = 200;

interface CliOptions {
  baseUrl?: string;
  route: RouteOption;
  json: boolean;
  packetBytes: number;
  packets: number;
}

interface FlightStat {
  localPath: string;
  url: string;
  statusCode: number;
  requestBytes: number;
  headerBytes: number;
  budgetedHeaderBytes: number;
  bodyBytes: number;
  wireBytes: number;
}

interface FlightReport {
  route: RouteName;
  files: FlightStat[];
  packetBytes: number;
  packetBudgetBytes: number;
  totalRequestBytes: number;
  totalHeaderBytes: number;
  totalBudgetedHeaderBytes: number;
  totalBodyBytes: number;
  totalWireBytes: number;
}

async function main(): Promise<void> {
  const options = parseCliOptions(Bun.argv.slice(2));
  const server = options.baseUrl
    ? null
    : await startLocalGzipServer();
  const baseUrl = options.baseUrl ?? server!.baseUrl;

  if (!options.json && server) {
    console.log(`Using local Bun gzip server at ${baseUrl}`);
  }

  const routes: RouteName[] = options.route === "all"
    ? ["base", "run"]
    : [options.route];

  try {
    const reports: FlightReport[] = [];
    for (const route of routes) {
      reports.push(await measureRoute(
        route,
        baseUrl,
        options.packetBytes,
        options.packets,
        server?.socketPath,
      ));
    }

    const failures = reports.filter((report) => report.totalWireBytes > report.packetBudgetBytes);

    if (options.json) {
      console.log(JSON.stringify({
        ok: failures.length === 0,
        reports,
      }, null, 2));
    } else {
      printReports(reports);
    }

    if (failures.length > 0) {
      const details = failures
        .map((report) => `${report.route} by ${report.totalWireBytes - report.packetBudgetBytes} B`)
        .join(", ");
      throw new Error(`Web flight budget exceeded: ${details}`);
    }
  } finally {
    await server?.stop();
  }
}

function parseCliOptions(args: string[]): CliOptions {
  let baseUrl = "";
  let route: RouteOption = "all";
  let json = false;
  let packetBytes = DEFAULT_PACKET_BYTES;
  let packets = DEFAULT_PACKETS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg.startsWith("--url=")) {
      baseUrl = arg.slice("--url=".length);
      continue;
    }

    if (arg === "--url") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --url");
      baseUrl = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--route=")) {
      route = parseRouteValue(arg.slice("--route=".length));
      continue;
    }

    if (arg.startsWith("--packet-bytes=")) {
      packetBytes = parsePositiveInt(arg.slice("--packet-bytes=".length), "--packet-bytes");
      continue;
    }

    if (arg === "--packet-bytes") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --packet-bytes");
      packetBytes = parsePositiveInt(value, "--packet-bytes");
      i += 1;
      continue;
    }

    if (arg.startsWith("--packets=")) {
      packets = parsePositiveInt(arg.slice("--packets=".length), "--packets");
      continue;
    }

    if (arg === "--packets") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --packets");
      packets = parsePositiveInt(value, "--packets");
      i += 1;
      continue;
    }

    if (arg === "--route") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --route");
      route = parseRouteValue(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    baseUrl: baseUrl ? normalizeBaseUrl(baseUrl) : undefined,
    route,
    json,
    packetBytes,
    packets,
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseRouteValue(value: string): RouteOption {
  if (value === "all" || value === "base" || value === "run") {
    return value;
  }
  throw new Error(`Invalid --route value: ${value}`);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function measureRoute(
  route: RouteName,
  baseUrl: string,
  packetBytes: number,
  packets: number,
  socketPath?: string,
): Promise<FlightReport> {
  const localFiles = [...await collectRouteFiles(route)]
    .filter((path) => !path.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  const files: FlightStat[] = [];
  for (const localPath of localFiles) {
    const url = toAssetUrl(baseUrl, route, localPath);
    const measured = await measureUrl(url, socketPath);
    if (measured.statusCode >= 400) {
      throw new Error(`HTTP ${measured.statusCode} for ${url}`);
    }
    if (socketPath && measured.headerBytes > RESPONSE_HEADER_BUDGET_BYTES) {
      throw new Error(
        `Local response headers exceeded the fixed allowance for ${url}: `
        + `${measured.headerBytes} B > ${RESPONSE_HEADER_BUDGET_BYTES} B`,
      );
    }

    // Local measurements use a fixed policy allowance so curl/OS details do
    // not move the gate. Explicit --url checks retain actual wire headers.
    const budgetedHeaderBytes = socketPath
      ? RESPONSE_HEADER_BUDGET_BYTES
      : measured.headerBytes;

    files.push({
      localPath,
      url,
      statusCode: measured.statusCode,
      requestBytes: measured.requestBytes,
      headerBytes: measured.headerBytes,
      budgetedHeaderBytes,
      bodyBytes: measured.bodyBytes,
      // Request bytes vary significantly by curl build and HTTP/2
      // implementation details. Keep them in the report, but budget only
      // the response path users pay to receive.
      wireBytes: budgetedHeaderBytes + measured.bodyBytes,
    });
  }

  const packetBudgetBytes = packetBytes * packets;

  return {
    route,
    files,
    packetBytes,
    packetBudgetBytes,
    totalRequestBytes: sum(files, (f) => f.requestBytes),
    totalHeaderBytes: sum(files, (f) => f.headerBytes),
    totalBudgetedHeaderBytes: sum(files, (f) => f.budgetedHeaderBytes),
    totalBodyBytes: sum(files, (f) => f.bodyBytes),
    totalWireBytes: sum(files, (f) => f.wireBytes),
  };
}

function toAssetUrl(baseUrl: string, route: RouteName, localPath: string): string {
  if (localPath === "web/index.html") {
    const documentPath = route === "run" ? "?run=budget-probe" : "";
    return new URL(documentPath, baseUrl).toString();
  }

  const rel = localPath.startsWith("web/") ? localPath.slice("web/".length) : localPath;
  return new URL(rel, baseUrl).toString();
}

interface CurlMeasure {
  statusCode: number;
  requestBytes: number;
  headerBytes: number;
  bodyBytes: number;
}

interface LocalServer {
  baseUrl: string;
  socketPath: string;
  stop: () => Promise<void>;
}

/** Start an isolated local gzip server without allocating a TCP port. */
export async function startLocalGzipServer(): Promise<LocalServer> {
  const webRoot = resolve(process.cwd(), "web");
  const indexFile = Bun.file(join(webRoot, "index.html"));
  if (!(await indexFile.exists())) {
    throw new Error("Missing web/index.html -- run `bun run build:web` first or pass --url");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "wb-flight-"));
  const socketPath = join(tempDir, "s.sock");
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: socketPath,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const relPath = toRelativeWebPath(url.pathname);
        const filePath = resolve(webRoot, relPath);

        if (!isPathUnderRoot(filePath, webRoot)) {
          return new Response("Forbidden", { status: 403 });
        }

        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return new Response("Not found", { status: 404 });
        }

        const source = new Uint8Array(await file.arrayBuffer());
        const body = Bun.gzipSync(source);
        const headers = new Headers();
        headers.set("Content-Encoding", "gzip");
        headers.set("Vary", "Accept-Encoding");
        headers.set("Cache-Control", "no-store");
        if (file.type) {
          headers.set("Content-Type", file.type);
        }

        return new Response(body, {
          status: 200,
          headers,
        });
      },
    });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    // curl still needs an HTTP URL for the Host header and request path;
    // --unix-socket changes only the transport used to reach the server.
    baseUrl: "http://localhost/",
    socketPath,
    stop: async () => {
      server.stop(true);
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function toRelativeWebPath(pathname: string): string {
  if (pathname === "/" || pathname === "") {
    return "index.html";
  }

  return decodeURIComponent(pathname.replace(/^\/+/, ""));
}

function isPathUnderRoot(filePath: string, rootDir: string): boolean {
  return filePath === rootDir || filePath.startsWith(rootDir + sep);
}

async function measureUrl(url: string, socketPath?: string): Promise<CurlMeasure> {
  const socketArgs = socketPath ? ["--unix-socket", socketPath] : [];
  const proc = Bun.spawn({
    cmd: [
      "curl",
      "--http2",
      "--compressed",
      ...socketArgs,
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}\t%{size_request}\t%{size_header}\t%{size_download}\n",
      url,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const err = stderr.trim();
    throw new Error(`curl failed for ${url}${err ? `: ${err}` : ""}`);
  }

  const parts = stdout.trim().split("\t");
  if (parts.length !== 4) {
    throw new Error(`Unexpected curl output for ${url}: ${stdout.trim()}`);
  }

  return {
    statusCode: Number(parts[0]),
    requestBytes: Number(parts[1]),
    headerBytes: Number(parts[2]),
    bodyBytes: Number(parts[3]),
  };
}

function sum<T>(items: T[], toNumber: (item: T) => number): number {
  return items.reduce((acc, item) => acc + toNumber(item), 0);
}

function printReports(reports: FlightReport[]): void {
  console.log("Web flight check (wire bytes via curl --http2 --compressed):");
  for (const report of reports) {
    console.log(`\n[${report.route}]`);
    for (const file of report.files) {
      console.log(
        `  ${basename(file.localPath)}: req ${file.requestBytes} B, measured hdr ${file.headerBytes} B, body ${file.bodyBytes} B, budgeted wire ${file.wireBytes} B`,
      );
    }
    console.log(`  total req: ${report.totalRequestBytes} B`);
    console.log(`  total measured hdr: ${report.totalHeaderBytes} B`);
    console.log(`  total budgeted hdr: ${report.totalBudgetedHeaderBytes} B`);
    console.log(`  total body: ${report.totalBodyBytes} B`);
    console.log(`  total wire: ${report.totalWireBytes} B`);
    console.log(`  packet budget: ${report.packetBudgetBytes} B (${report.packetBytes} B x ${Math.round(report.packetBudgetBytes / report.packetBytes)} packets)`);
    console.log(`  status: ${report.totalWireBytes <= report.packetBudgetBytes ? "pass" : "fail"}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
