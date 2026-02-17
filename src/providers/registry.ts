import type { LanguageModel } from "ai";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { fetchModelsDb, getProviderMeta, type ProviderMeta } from "./models.js";

// ── Types ───────────────────────────────────────────

interface SDK {
  languageModel(modelId: string): LanguageModel;
}

// Each factory has different option types, but custom loaders
// are responsible for providing the correct shape. This boundary
// is intentional — same pattern as opencode's BUNDLED_PROVIDERS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDKFactory = (options?: any) => SDK;

interface CustomLoaderResult {
  options?: Record<string, unknown>;
}

// ── Bundled providers ───────────────────────────────
// Maps npm package name (from models.dev) to its SDK factory function.
// Adding a new provider = one line here.

const BUNDLED_PROVIDERS: Record<string, SDKFactory> = {
  "@ai-sdk/openai": createOpenAI,
  "@ai-sdk/anthropic": createAnthropic,
  "@ai-sdk/google": createGoogleGenerativeAI,
  "@ai-sdk/google-vertex": createVertex,
  "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
  "@ai-sdk/openai-compatible": createOpenAICompatible,
};

// ── Custom loaders ──────────────────────────────────
// Provider-specific initialization logic. Handles env var
// fallback chains and custom SDK options per provider.
// Receives provider metadata from models.dev when available.

const CUSTOM_LOADERS: Record<
  string,
  (meta: ProviderMeta | null) => CustomLoaderResult
> = {
  "google-vertex": () => {
    const project =
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.GCP_PROJECT ??
      process.env.GCLOUD_PROJECT;
    const location =
      process.env.GOOGLE_CLOUD_LOCATION ??
      process.env.VERTEX_LOCATION ??
      "us-central1";
    return { options: { project, location } };
  },

  "google-vertex-anthropic": () => {
    const project =
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.GCP_PROJECT ??
      process.env.GCLOUD_PROJECT;
    const location =
      process.env.GOOGLE_CLOUD_LOCATION ??
      process.env.VERTEX_LOCATION ??
      "global";
    return { options: { project, location } };
  },

  "openrouter": (meta) => ({
    options: {
      name: meta?.name ?? "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: meta?.api ?? "https://openrouter.ai/api/v1",
    },
  }),

  "opencode": (meta) => {
    // Check env var first, then OpenCode auth store as fallback
    let apiKey = process.env.OPENCODE_API_KEY;
    if (!apiKey) {
      try {
        const authPath = join(
          process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
          "opencode",
          "auth.json"
        );
        if (existsSync(authPath)) {
          const auth = JSON.parse(readFileSync(authPath, "utf-8"));
          const entry = auth.opencode;
          if (entry?.type === "api" && entry.key) {
            apiKey = entry.key;
          } else if (entry?.type === "oauth" && entry.access) {
            apiKey = entry.access;
          }
        }
      } catch {
        // Auth store unreadable, continue without key
      }
    }
    return {
      options: {
        name: meta?.name ?? "opencode",
        apiKey,
        baseURL: meta?.api ?? "https://opencode.ai/zen/v1",
      },
    };
  },

  "ollama": (meta) => ({
    options: {
      name: meta?.name ?? "ollama",
      baseURL: process.env.OLLAMA_BASE_URL ?? meta?.api ?? "http://localhost:11434/v1",
    },
  }),
};

// ── NPM overrides ──────────────────────────────────
// When models.dev maps a provider to an npm package we don't bundle,
// use the compatible bundled package instead.

const NPM_OVERRIDES: Record<string, string> = {
  openrouter: "@ai-sdk/openai-compatible",
  opencode: "@ai-sdk/openai-compatible",
  ollama: "@ai-sdk/openai-compatible",
};

// ── SDK cache ───────────────────────────────────────
// Keyed by hash of (npm + options) so the same provider
// with different options gets separate instances.

const sdkCache = new Map<string, SDK>();

function getSDK(
  npm: string,
  options?: Record<string, unknown>
): SDK {
  const key = JSON.stringify({ npm, options });
  const cached = sdkCache.get(key);
  if (cached) return cached;

  const factory = BUNDLED_PROVIDERS[npm];
  if (!factory) {
    throw new Error(
      `No bundled provider for npm package "${npm}". ` +
        `Known packages: ${Object.keys(BUNDLED_PROVIDERS).join(", ")}`
    );
  }

  const sdk = factory(options);
  sdkCache.set(key, sdk);
  return sdk;
}

// ── Provider resolution ─────────────────────────────
// Uses models.dev npm field to find the right SDK factory,
// custom loaders to configure it, and caches the result.

/**
 * Resolve a model string like "google-vertex:gemini-2.5-flash" to an AI SDK LanguageModel.
 *
 * SDK package resolution (same chain as OpenCode):
 *   model.provider.npm > NPM_OVERRIDES[provider] > provider.npm
 * This allows proxy providers (opencode, openrouter) to use the upstream
 * SDK for models that need specific streaming format handling.
 */
export async function resolveModel(modelId: string) {
  const { provider, model } = parseModelSpec(modelId);
  const db = await fetchModelsDb();
  const providerData = db[provider];
  const modelNpm = providerData?.models[model]?.provider?.npm;
  const npm = modelNpm ?? NPM_OVERRIDES[provider] ?? providerData?.npm;
  if (!npm) {
    throw new Error(
      `Unknown provider "${provider}". Not found in models.dev database.`
    );
  }
  const meta = await getProviderMeta(provider);
  const loader = CUSTOM_LOADERS[provider];
  const loaderResult = loader?.(meta);
  const sdk = getSDK(npm, loaderResult?.options);
  return sdk.languageModel(model);
}

/**
 * Parse a CLI model spec "provider:model[=label]" into its parts.
 * Provider names are models.dev provider IDs (e.g., google-vertex).
 *
 * The first colon separates provider from model. Everything after
 * that colon is the model ID — which may itself contain colons
 * (e.g. Ollama's "llama3.1:8b"). An optional "=label" suffix
 * provides an explicit display name.
 *
 * Examples:
 *   "openai:gpt-4o"              → provider=openai, model=gpt-4o
 *   "ollama:llama3.1:8b"         → provider=ollama, model=llama3.1:8b
 *   "openai:gpt-4o=fast"         → provider=openai, model=gpt-4o, label=fast
 *   "ollama:llama3.1:8b=my-llama"→ provider=ollama, model=llama3.1:8b, label=my-llama
 */
export function parseModelSpec(spec: string): {
  provider: string;
  model: string;
  label: string;
  registryId: string;
} {
  const firstColon = spec.indexOf(":");
  if (firstColon < 0) {
    throw new Error(
      `Invalid model spec "${spec}". Expected format: provider:model[=label]`
    );
  }

  const provider = spec.slice(0, firstColon);
  const rest = spec.slice(firstColon + 1);

  // Split on "=" for optional label; model may contain colons (e.g. ollama variants)
  const eqIdx = rest.indexOf("=");
  const model = eqIdx >= 0 ? rest.slice(0, eqIdx) : rest;
  const label = eqIdx >= 0 ? rest.slice(eqIdx + 1) : model;
  const registryId = `${provider}:${model}`;
  return { provider, model, label, registryId };
}
