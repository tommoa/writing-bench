/**
 * Dev-time script: fetch model family logos from lobehub/lobe-icons,
 * using actual benchmark run data to discover which families need icons.
 *
 * Source: https://github.com/lobehub/lobe-icons (MIT license)
 * Raw SVGs at: packages/static-svg/icons/{name}.svg and {name}-color.svg
 *
 * Usage: bun scripts/fetch-logos.ts
 *
 * The generated file (web/src/model-logos.generated.ts) is committed to
 * the repo so the web build doesn't need network access. Re-run this
 * script when new model families appear in benchmark runs.
 */

import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RUNS_DIR = join(ROOT, "data", "runs");
const OUT_FILE = join(ROOT, "web", "src", "model-logos.generated.ts");

const LOBE_RAW =
  "https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons";

// ── Family -> lobe-icons name mapping ───────────────
// Maps a canonical family key to its lobe-icons file stem.
// The script fetches {name}-color.svg (light) and {name}.svg (dark,
// currentColor). If the color variant 404s, falls back to mono only.

const FAMILY_TO_LOBE: Record<string, string> = {
  "claude": "claude",
  "gemini": "gemini",
  "gpt": "openai",
  "kimi": "kimi",
  "glm": "zhipu",
  "minimax": "minimax",
  "deepseek": "deepseek",
  "mistral": "mistral",
  "qwen": "qwen",
  "cohere": "cohere",
  "llama": "meta",
  "command-r": "cohere",
};

// Families that share a logo (searched by prefix).
// E.g., "claude-sonnet" and "claude-opus" both use the "claude" logo.

// Sorted by descending length so longer prefixes match before shorter
// ones (e.g., a hypothetical "gpt-mini" prefix would match before "gpt").
const FAMILY_PREFIXES = [
  "claude",
  "gemini",
  "kimi",
  "gpt",
  // o1/o3 are prefix-only (no FAMILY_TO_LOBE entry yet). They exist
  // here so "o1-mini" normalizes to "o1" rather than being treated as
  // an unknown family. Add a FAMILY_TO_LOBE mapping when lobe-icons
  // has a distinct icon for them (currently they'd use "openai").
  "o1",
  "o3",
].sort((a, b) => b.length - a.length);

// ── Step 1: Discover families from run data ─────────

interface ModelInfo {
  family: string;
  [key: string]: unknown;
}

async function collectFamiliesFromRuns(): Promise<string[]> {
  if (!existsSync(RUNS_DIR)) {
    console.error(`No runs directory found at ${RUNS_DIR}`);
    process.exit(1);
  }

  const entries = await readdir(RUNS_DIR, { withFileTypes: true });
  const families = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runFile = join(RUNS_DIR, entry.name, "run.json");
    if (!existsSync(runFile)) continue;

    const raw = await Bun.file(runFile).text();
    const run = JSON.parse(raw, (_k, v) =>
      v === "__Infinity__" ? Infinity : v,
    );

    if (run.modelInfo) {
      for (const info of Object.values(run.modelInfo) as ModelInfo[]) {
        if (info.family) families.add(info.family);
      }
    }
  }

  return [...families].sort();
}

/**
 * Normalize a family name to its canonical key.
 * E.g., "claude-sonnet" -> "claude", "gpt-mini" -> "gpt"
 */
function normalizeFamily(family: string): string {
  // Check prefix matches (claude-sonnet -> claude)
  for (const prefix of FAMILY_PREFIXES) {
    if (family === prefix || family.startsWith(prefix + "-")) {
      return prefix;
    }
  }

  // Check if the family itself is a known key
  if (FAMILY_TO_LOBE[family]) return family;

  // Check if any known key is a prefix of this family
  for (const key of Object.keys(FAMILY_TO_LOBE)) {
    if (family.startsWith(key + "-")) return key;
  }

  return family;
}

// ── Step 2: Fetch from lobe-icons ───────────────────

async function fetchSvg(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

/** Clean an SVG for inline use: strip width/height/style/title, collapse whitespace. */
function cleanSvg(raw: string): string {
  let svg = raw.trim();
  svg = svg.replace(/<title>[^<]*<\/title>/gi, "");
  svg = svg.replace(/\s+width="[^"]*"/gi, "");
  svg = svg.replace(/\s+height="[^"]*"/gi, "");
  svg = svg.replace(/\s+style="[^"]*"/gi, "");
  svg = svg.replace(/\s+/g, " ").trim();
  return svg;
}

interface LogoData {
  light: string;
  dark?: string;
}

/**
 * Per-icon fixups applied to the color (light) SVG after cleanSvg().
 * Key is the lobe-icons name. Each entry is an array of [search, replace]
 * pairs applied in order.
 *
 * Kimi: The upstream color SVG has fill="#fff" on the K letterform,
 * intended for dark backgrounds. Replace with currentColor so it adapts
 * to the page text color on both light and dark themes.
 */
const POST_CLEAN: Record<string, [string, string][]> = {
  "kimi": [['fill="#fff"', 'fill="currentColor"']],
};

async function fetchLobeIcon(lobeName: string): Promise<LogoData | null> {
  // Try color variant first (brand colors, for light theme)
  // and mono variant (currentColor, for dark theme)
  const [colorSvg, monoSvg] = await Promise.all([
    fetchSvg(`${LOBE_RAW}/${lobeName}-color.svg`),
    fetchSvg(`${LOBE_RAW}/${lobeName}.svg`),
  ]);

  if (colorSvg) {
    let light = cleanSvg(colorSvg);
    const fixups = POST_CLEAN[lobeName];
    if (fixups) {
      for (const [search, replace] of fixups) {
        light = light.replace(search, replace);
      }
    }
    return {
      light,
      dark: monoSvg ? cleanSvg(monoSvg) : undefined,
    };
  }

  // Fall back to mono only
  if (monoSvg) {
    return { light: cleanSvg(monoSvg) };
  }

  return null;
}

// ── Step 3: Fetch and generate ──────────────────────

function escapeForTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

async function main() {
  console.log("Scanning run data for model families...");
  const allFamilies = await collectFamiliesFromRuns();
  console.log(`Found ${allFamilies.length} families: ${allFamilies.join(", ")}\n`);

  // Normalize families to unique canonical keys
  const keyToFamilies = new Map<string, string[]>();
  for (const family of allFamilies) {
    const key = normalizeFamily(family);
    const existing = keyToFamilies.get(key);
    if (existing) {
      existing.push(family);
    } else {
      keyToFamilies.set(key, [family]);
    }
  }

  console.log(`Deduplicated to ${keyToFamilies.size} icon lookups\n`);
  console.log("Fetching logos from lobehub/lobe-icons...\n");

  const icons: Array<{
    key: string;
    light: string;
    dark?: string;
  }> = [];
  const familyToIcon: Array<{ family: string; key: string }> = [];
  const fetchedLobeNames = new Set<string>();

  for (const [key, families] of keyToFamilies) {
    const lobeName = FAMILY_TO_LOBE[key];
    if (!lobeName) {
      console.log(`  ${key} -- no lobe-icons mapping, skipping`);
      continue;
    }

    // Skip if already fetched (multiple families can share a lobe name)
    if (fetchedLobeNames.has(lobeName)) {
      for (const family of families) {
        familyToIcon.push({ family, key: lobeName });
      }
      console.log(`  ${key} -> ${lobeName}... (shared, already fetched) [${families.join(", ")}]`);
      continue;
    }

    process.stdout.write(`  ${key} -> ${lobeName}... `);
    const logo = await fetchLobeIcon(lobeName);

    if (!logo) {
      console.log("not found");
      continue;
    }

    fetchedLobeNames.add(lobeName);
    icons.push({ key: lobeName, light: logo.light, dark: logo.dark });
    for (const family of families) {
      familyToIcon.push({ family, key: lobeName });
    }

    const variants = logo.dark ? "color + mono" : "mono only";
    console.log(`OK (${variants}) [${families.join(", ")}]`);
  }

  // Generate TypeScript
  const lines: string[] = [
    "// Auto-generated by scripts/fetch-logos.ts -- do not edit manually.",
    `// Source: lobehub/lobe-icons (MIT license, fetched ${new Date().toISOString().split("T")[0]})`,
    "//",
    "// To regenerate: bun scripts/fetch-logos.ts",
    "",
    "export interface IconData {",
    "  /** SVG for light theme (brand-colored icon). */",
    "  light: string;",
    "  /** SVG for dark theme (currentColor icon). Falls back to light if absent. */",
    "  dark?: string;",
    "}",
    "",
    "/** Inline SVG strings keyed by lobe-icons name. */",
    "export const ICONS: Record<string, IconData> = {",
  ];

  for (const { key, light, dark } of icons) {
    lines.push(`  "${key}": {`);
    lines.push(`    light: \`${escapeForTemplate(light)}\`,`);
    if (dark) {
      lines.push(`    dark: \`${escapeForTemplate(dark)}\`,`);
    }
    lines.push(`  },`);
  }

  lines.push("};");
  lines.push("");
  lines.push("/** Maps models.dev family names to ICONS keys. */");
  lines.push("export const FAMILY_TO_ICON: Record<string, string> = {");

  familyToIcon.sort((a, b) => a.family.localeCompare(b.family));
  for (const { family, key } of familyToIcon) {
    lines.push(`  "${family}": "${key}",`);
  }

  lines.push("};");
  lines.push("");

  await Bun.write(OUT_FILE, lines.join("\n"));
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`  ${icons.length} icons, ${familyToIcon.length} family mappings`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
