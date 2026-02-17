import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type {
  CumulativeElo,
  RunResult,
} from "../types.js";
import {
  createRating,
  extractPairwiseRecords,
  extractFeedbackPairwiseRecords,
  mergeRecords,
  computeRatingsFromRecords,
} from "../engine/elo.js";

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
  return JSON.parse(raw) as CumulativeElo;
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
 * Uses Bradley-Terry: extracts pairwise records from the run,
 * merges with existing accumulated records, and recomputes
 * ratings from scratch. This is order-independent — the same
 * set of judgments always produces the same ratings.
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
  const newWritingRecords = extractPairwiseRecords(run.judgments, sampleToModel);
  elo.pairwise.writing = mergeRecords(elo.pairwise.writing, newWritingRecords);
  const writingRatings = computeRatingsFromRecords(elo.pairwise.writing);
  elo.writing = Object.fromEntries(writingRatings.map((r) => [r.model, r]));

  // Backfill models from this run that have no matches yet
  for (const model of new Set(sampleToModel.values())) {
    if (!elo.writing[model]) {
      elo.writing[model] = createRating(model);
    }
  }

  // ── Feedback ELO ───────────────────────────────────
  const improvementJudgments = run.judgments.filter(
    (j) => j.stage === "improvement"
  );
  const newFeedbackRecords = extractFeedbackPairwiseRecords(
    improvementJudgments,
    sampleToFeedbackModel
  );
  elo.pairwise.feedbackGiving = mergeRecords(
    elo.pairwise.feedbackGiving,
    newFeedbackRecords
  );
  const feedbackRatings = computeRatingsFromRecords(elo.pairwise.feedbackGiving);
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
    const newTagRecords = extractPairwiseRecords(tagJudgments, sampleToModel);
    const existingTagRecords = elo.pairwise.writingByTag[tag] ?? [];
    elo.pairwise.writingByTag[tag] = mergeRecords(
      existingTagRecords,
      newTagRecords
    );
    const tagRatings = computeRatingsFromRecords(
      elo.pairwise.writingByTag[tag]
    );
    elo.writingByTag[tag] = Object.fromEntries(
      tagRatings.map((r) => [r.model, r])
    );

    // Backfill models that have samples for this tag
    for (const model of tagModels.get(tag) ?? []) {
      if (!elo.writingByTag[tag][model]) {
        elo.writingByTag[tag][model] = createRating(model);
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
