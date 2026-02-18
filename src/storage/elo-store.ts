import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type {
  CumulativeElo,
  EloRating,
  PairwiseRecord,
  RunResult,
} from "../types.js";
import {
  DEFAULT_RATING,
  whrRatingsFromRecords,
  judgmentsToGames,
  improvementJudgmentsToGames,
  gamesToRecords,
  mergeRecords,
} from "../engine/whr.js";
import { getModelDisplayName, getProviderDisplayName } from "../providers/models.js";

const ELO_FILE = join(process.cwd(), "data", "elo.json");

/**
 * Load cumulative ELO state from disk.
 */
export async function loadCumulativeElo(): Promise<CumulativeElo> {
  if (!existsSync(ELO_FILE)) {
    return {
      lastUpdated: new Date().toISOString(),
      writing: {},
      feedbackGiving: {},
      writingByTag: {},
      history: [],
    };
  }

  const raw = await readFile(ELO_FILE, "utf-8");
  const elo = JSON.parse(raw) as CumulativeElo;

  // Migrate old provider:model keys to display names
  const migrated = await migrateEloKeys(elo);
  if (migrated) {
    await saveCumulativeElo(elo);
  }

  return elo;
}

/**
 * Save cumulative ELO state to disk.
 */
export async function saveCumulativeElo(
  elo: CumulativeElo
): Promise<void> {
  const dir = dirname(ELO_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(ELO_FILE, JSON.stringify(elo, null, 2));
}

/**
 * Update cumulative ELO ratings with results from a new run.
 * Uses WHR: extracts pairwise records from the run, merges with
 * existing accumulated records, and recomputes ratings from
 * scratch. This is order-independent — the same set of judgments
 * always produces the same ratings.
 */
export async function updateCumulativeElo(
  run: RunResult
): Promise<CumulativeElo> {
  const elo = await loadCumulativeElo();

  // Build sample-to-model maps
  const sampleToModel = new Map<string, string>();
  const sampleToFeedbackModel = new Map<string, string>();

  for (const s of run.samples) {
    sampleToModel.set(s.id, s.model);
    if (s.feedbackModel) {
      sampleToFeedbackModel.set(s.id, s.feedbackModel);
    }
  }

  // Initialize pairwise storage if missing (e.g. migrating from old format)
  if (!elo.pairwise) {
    elo.pairwise = { writing: [], feedbackGiving: [], writingByTag: {} };
  }

  // ── Writing ELO ────────────────────────────────────
  const newWritingRecords = gamesToRecords(judgmentsToGames(run.judgments, sampleToModel));
  elo.pairwise.writing = mergeRecords(elo.pairwise.writing, newWritingRecords);
  const writingRatings = whrRatingsFromRecords(elo.pairwise.writing);
  elo.writing = Object.fromEntries(writingRatings.map((r) => [r.model, r]));

  // Backfill models from this run that have no matches yet
  for (const model of new Set(sampleToModel.values())) {
    if (!elo.writing[model]) {
      elo.writing[model] = {
        model, rating: DEFAULT_RATING,
        wins: 0, losses: 0, ties: 0, matchCount: 0,
      };
    }
  }

  // ── Feedback ELO ───────────────────────────────────
  const improvementJudgments = run.judgments.filter(
    (j) => j.stage === "improvement"
  );
  const newFeedbackRecords = gamesToRecords(
    improvementJudgmentsToGames(improvementJudgments, sampleToFeedbackModel),
  );
  elo.pairwise.feedbackGiving = mergeRecords(
    elo.pairwise.feedbackGiving,
    newFeedbackRecords
  );
  const feedbackRatings = whrRatingsFromRecords(elo.pairwise.feedbackGiving);
  elo.feedbackGiving = Object.fromEntries(
    feedbackRatings.map((r) => [r.model, r])
  );

  // ── Per-tag Writing ELO ────────────────────────────
  const promptToTags = new Map<string, string[]>();
  for (const p of run.config.prompts) {
    promptToTags.set(p.id, p.tags);
  }
  const allTags = new Set(run.config.prompts.flatMap((p) => p.tags));

  if (!elo.writingByTag) {
    elo.writingByTag = {};
  }

  // Build per-tag model sets for backfilling
  const tagModels = new Map<string, Set<string>>();
  for (const s of run.samples) {
    const tags = promptToTags.get(s.promptId) ?? [];
    for (const tag of tags) {
      const models = tagModels.get(tag) ?? new Set<string>();
      models.add(s.model);
      tagModels.set(tag, models);
    }
  }

  for (const tag of allTags) {
    // Use initial + revised judgments for this tag (exclude improvement)
    const tagJudgments = run.judgments.filter(
      (j) =>
        j.stage !== "improvement" &&
        (promptToTags.get(j.promptId)?.includes(tag) ?? false)
    );
    const newTagRecords = gamesToRecords(judgmentsToGames(tagJudgments, sampleToModel));
    const existingTagRecords = elo.pairwise.writingByTag[tag] ?? [];
    elo.pairwise.writingByTag[tag] = mergeRecords(
      existingTagRecords,
      newTagRecords
    );
    const tagRatings = whrRatingsFromRecords(elo.pairwise.writingByTag[tag]);
    elo.writingByTag[tag] = Object.fromEntries(
      tagRatings.map((r) => [r.model, r])
    );

    // Backfill models that have samples for this tag
    for (const model of tagModels.get(tag) ?? []) {
      if (!elo.writingByTag[tag][model]) {
        elo.writingByTag[tag][model] = {
          model, rating: DEFAULT_RATING,
          wins: 0, losses: 0, ties: 0, matchCount: 0,
        };
      }
    }
  }

  // Build snapshot for history
  const snapshot: Record<string, number> = {};
  for (const [model, rating] of Object.entries(elo.writing)) {
    snapshot[model] = rating.rating;
  }

  // Update state
  elo.lastUpdated = new Date().toISOString();
  elo.history.push({
    runId: run.config.id,
    timestamp: run.config.timestamp,
    snapshot,
  });

  await saveCumulativeElo(elo);
  return elo;
}

// ── Key Migration ───────────────────────────────────

/**
 * Remap model keys in a rating record from old keys to new keys.
 */
function remapRatings(
  ratings: Record<string, EloRating>,
  keyMap: Map<string, string>
): void {
  for (const [oldKey, newKey] of keyMap) {
    if (ratings[oldKey]) {
      ratings[newKey] = { ...ratings[oldKey], model: newKey };
      delete ratings[oldKey];
    }
  }
}

/**
 * Remap model names in pairwise records from old keys to new keys.
 */
function remapPairwiseRecords(
  records: PairwiseRecord[],
  keyMap: Map<string, string>
): void {
  for (const r of records) {
    const newA = keyMap.get(r.modelA);
    if (newA) r.modelA = newA;
    const newB = keyMap.get(r.modelB);
    if (newB) r.modelB = newB;
  }
}

/**
 * Migrate old "provider:model" keys in cumulative ELO data to
 * models.dev display names. Idempotent — keys that don't contain
 * a colon or can't be resolved are left untouched.
 * Returns true if any keys were migrated.
 */
async function migrateEloKeys(elo: CumulativeElo): Promise<boolean> {
  // Collect all old-format keys across every rating map
  const oldKeySet = new Set<string>();
  const addOldKeys = (obj: Record<string, unknown>) => {
    for (const k of Object.keys(obj)) {
      if (k.includes(":")) oldKeySet.add(k);
    }
  };
  addOldKeys(elo.writing);
  addOldKeys(elo.feedbackGiving);
  for (const tag of Object.keys(elo.writingByTag ?? {})) {
    addOldKeys(elo.writingByTag[tag]);
  }
  if (oldKeySet.size === 0) return false;

  // Build mapping of old key -> new display name
  const keyMap = new Map<string, string>();
  for (const oldKey of oldKeySet) {
    const colonIdx = oldKey.indexOf(":");
    const provider = oldKey.slice(0, colonIdx);
    const model = oldKey.slice(colonIdx + 1);
    const displayName = await getModelDisplayName(provider, model);
    if (displayName) {
      keyMap.set(oldKey, displayName);
    }
  }

  if (keyMap.size === 0) return false;

  // Disambiguate: if multiple old keys map to the same display name,
  // append the provider name to avoid silently merging different models
  const byName = new Map<string, string[]>();
  for (const [oldKey, newName] of keyMap) {
    const group = byName.get(newName) ?? [];
    group.push(oldKey);
    byName.set(newName, group);
  }
  for (const [, group] of byName) {
    if (group.length <= 1) continue;
    for (const oldKey of group) {
      const provider = oldKey.slice(0, oldKey.indexOf(":"));
      const providerLabel = (await getProviderDisplayName(provider)) ?? provider;
      keyMap.set(oldKey, `${keyMap.get(oldKey)} (${providerLabel})`);
    }
  }

  // Remap all rating maps
  remapRatings(elo.writing, keyMap);
  remapRatings(elo.feedbackGiving, keyMap);
  for (const tag of Object.keys(elo.writingByTag ?? {})) {
    remapRatings(elo.writingByTag[tag], keyMap);
  }

  // Remap pairwise records
  if (elo.pairwise) {
    remapPairwiseRecords(elo.pairwise.writing, keyMap);
    remapPairwiseRecords(elo.pairwise.feedbackGiving, keyMap);
    for (const tag of Object.keys(elo.pairwise.writingByTag ?? {})) {
      remapPairwiseRecords(elo.pairwise.writingByTag[tag], keyMap);
    }
  }

  // Remap history snapshots
  for (const entry of elo.history) {
    for (const [oldKey, newKey] of keyMap) {
      if (oldKey in entry.snapshot) {
        entry.snapshot[newKey] = entry.snapshot[oldKey];
        delete entry.snapshot[oldKey];
      }
    }
  }

  return true;
}
