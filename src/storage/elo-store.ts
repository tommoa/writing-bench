import { existsSync } from "fs";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join, dirname } from "path";
import { createHash } from "crypto";
import type {
  CumulativeElo,
  PairwiseJudgment,
  RunResult,
  WritingSample,
} from "../types.js";
import {
  DEFAULT_RATING,
  type WhrRating,
  whrRatingsFromRecords,
  judgmentsToGames,
  improvementJudgmentsToGames,
  gamesToRecords,
  mergeRecords,
} from "../engine/whr.js";
import { computeJudgeQuality, computeEloBasedJudgeQuality } from "../engine/judge-quality.js";
import { computeJudgeBias, computeBiasCorrections, composeWeights } from "../engine/judge-bias.js";

const ELO_FILE = join(process.cwd(), "data", "elo.json");

/**
 * Load cumulative ELO state from disk.
 */
export async function loadCumulativeElo(): Promise<CumulativeElo> {
  if (!existsSync(ELO_FILE)) {
    return {
      lastUpdated: new Date().toISOString(),
      writing: {},
      initialWriting: {},
      revisedWriting: {},
      feedbackGiving: {},
      writingByTag: {},
      initialWritingByTag: {},
      revisedWritingByTag: {},
      pairwise: {
        writing: [],
        initialWriting: [],
        revisedWriting: [],
        feedbackGiving: [],
        writingByTag: {},
        initialWritingByTag: {},
        revisedWritingByTag: {},
      },
      history: [],
    };
  }

  const raw = await readFile(ELO_FILE, "utf-8");
  return normalizeCumulativeElo(JSON.parse(raw) as CumulativeElo);
}

function normalizeCumulativeElo(elo: CumulativeElo): CumulativeElo {
  elo.initialWriting = elo.initialWriting ?? elo.writing ?? {};
  elo.revisedWriting = elo.revisedWriting ?? {};
  elo.writing = elo.initialWriting;

  elo.initialWritingByTag = elo.initialWritingByTag ?? elo.writingByTag ?? {};
  elo.revisedWritingByTag = elo.revisedWritingByTag ?? {};
  elo.writingByTag = elo.initialWritingByTag;

  if (!elo.pairwise) {
    elo.pairwise = {
      writing: [],
      initialWriting: [],
      revisedWriting: [],
      feedbackGiving: [],
      writingByTag: {},
      initialWritingByTag: {},
      revisedWritingByTag: {},
    };
    return elo;
  }

  elo.pairwise.initialWriting = elo.pairwise.initialWriting ?? elo.pairwise.writing ?? [];
  elo.pairwise.revisedWriting = elo.pairwise.revisedWriting ?? [];
  elo.pairwise.writing = elo.pairwise.initialWriting;

  elo.pairwise.initialWritingByTag = elo.pairwise.initialWritingByTag ?? elo.pairwise.writingByTag ?? {};
  elo.pairwise.revisedWritingByTag = elo.pairwise.revisedWritingByTag ?? {};
  elo.pairwise.writingByTag = elo.pairwise.initialWritingByTag;

  return elo;
}

function convertRatingsToLabelMap(
  ratings: ReturnType<typeof whrRatingsFromRecords>,
  idToLabel: Record<string, string>,
): Record<string, ReturnType<typeof whrRatingsFromRecords>[number]> {
  return Object.fromEntries(
    ratings.map((r) => {
      const label = idToLabel[r.model] ?? r.model;
      return [label, { ...r, model: label }];
    }),
  );
}

function toWhrRatings(ratings: RunResult["elo"]["initial"]["ratings"]): WhrRating[] {
  return ratings.map((r) => ({
    model: r.model,
    rating: r.rating,
    wins: r.wins,
    losses: r.losses,
    ties: r.ties,
    matchCount: r.matchCount,
    ci95: r.ci95 ?? 0,
  }));
}

function computeRunWeights(
  run: RunResult,
  sampleToModel: Map<string, string>,
): {
  judgeWeights: Map<string, number> | undefined;
  judgmentWeights: Map<string, number> | undefined;
} {
  if (!run.config.convergence.judgeQuality) {
    return { judgeWeights: undefined, judgmentWeights: undefined };
  }

  const judgeLabels = [...new Set(run.judgments.map((j) => j.judgeModel))];
  const k = run.config.convergence.judgeDecay;
  const mode = run.config.convergence.judgeQualityMode;

  const quality = mode === "consensus"
    ? computeJudgeQuality(run.judgments, judgeLabels, k)
    : computeEloBasedJudgeQuality(
      mode === "writing"
        ? toWhrRatings(run.elo.initial.ratings)
        : mode === "feedback"
          ? toWhrRatings(run.elo.revised.feedbackRatings ?? [])
          : toWhrRatings(run.elo.revised.ratings),
      judgeLabels,
      k,
    );

  const judgeWeights = quality.active ? quality.weights : undefined;
  const biasData = computeJudgeBias(run.judgments, sampleToModel, judgeLabels);
  const biasCorrections = computeBiasCorrections(run.judgments, sampleToModel, biasData);
  const judgmentWeights = biasCorrections.size > 0
    ? composeWeights(run.judgments, judgeWeights, biasCorrections)
    : undefined;

  return { judgeWeights, judgmentWeights };
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

// ── Judgment Deduplication ──────────────────────────

/**
 * Build a stable identity string for a sample based on its semantic
 * properties rather than its random nanoid. Two samples from different
 * runs that represent the same model output on the same prompt are
 * considered identical.
 */
function sampleStableId(s: WritingSample): string {
  const modelId = s.registryId ?? s.model;
  const feedbackId = s.feedbackRegistryId ?? s.feedbackModel;
  const textHash = createHash("sha256").update(s.text).digest("hex").slice(0, 16);
  const parts = [modelId, s.promptId, s.outputIndex, s.stage, textHash];
  if (feedbackId) parts.push(feedbackId);
  return parts.join(":");
}

/**
 * Compute a stable key for a judgment that is deterministic across runs.
 * Two judgments with the same judge, stage, and sample pair (by semantic
 * identity) will produce the same key regardless of random IDs.
 *
 * Exported for testing.
 */
export function judgmentStableKey(
  j: PairwiseJudgment,
  sampleMap: Map<string, WritingSample>,
): string | null {
  const sA = sampleMap.get(j.sampleA);
  const sB = sampleMap.get(j.sampleB);
  if (!sA || !sB) return null;

  const idA = sampleStableId(sA);
  const idB = sampleStableId(sB);
  const sorted = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
  const judgeId = j.judgeRegistryId ?? j.judgeModel;
  return `${judgeId}|${j.stage}|${sorted}`;
}

/**
 * Update cumulative ELO ratings with results from a new run.
 * Uses WHR: extracts pairwise records from the run, merges with
 * existing accumulated records, and recomputes ratings from
 * scratch. This is order-independent -- the same set of judgments
 * always produces the same ratings.
 *
 * Deduplication: each judgment is assigned a stable key based on its
 * judge, stage, and sample pair (by semantic identity, not random ID).
 * Judgments whose keys are already in the persisted set are skipped.
 * This prevents double-counting when cache-seeded runs re-include
 * judgments from previous runs, and works correctly for cache-only
 * runs and full rebuilds.
 *
 * Model identity: pairwise records use registryId ("provider:model")
 * for stable keying across label changes. Ratings are translated back
 * to the latest display label before storage so the display chain is
 * unaffected. Old runs without registryId fall back to label keying.
 */
export async function updateCumulativeElo(
  run: RunResult
): Promise<CumulativeElo> {
  const elo = normalizeCumulativeElo(await loadCumulativeElo());
  const pairwise = elo.pairwise!;

  // Build sample lookup by ID
  const sampleMap = new Map<string, WritingSample>();
  for (const s of run.samples) {
    sampleMap.set(s.id, s);
  }

  // Build processed-key set from persisted state
  const processedKeys = new Set<string>(elo.processedJudgmentKeys ?? []);

  // Deduplicate: keep only judgments not yet ingested
  const novelJudgments: PairwiseJudgment[] = [];
  for (const j of run.judgments) {
    const key = judgmentStableKey(j, sampleMap);
    if (!key || processedKeys.has(key)) continue;
    processedKeys.add(key);
    novelJudgments.push(j);
  }

  // Build registryId → label mapping from this run's config.
  // Accumulate into the persisted mapping so labels stay current.
  const idToLabel: Record<string, string> = { ...elo.modelLabels };
  for (const m of run.config.models) {
    idToLabel[m.registryId] = m.label;
  }
  for (const m of run.config.judges ?? []) {
    idToLabel[m.registryId] = m.label;
  }

  // Build sample-to-identity maps.
  // sampleToId: uses registryId for pairwise record keying (stable).
  // sampleToLabel: uses label for display (backfill, etc.).
  // sampleToFeedbackId: registryId for feedback model.
  const sampleToId = new Map<string, string>();
  const sampleToLabel = new Map<string, string>();
  const sampleToFeedbackId = new Map<string, string>();

  for (const s of run.samples) {
    const id = s.registryId ?? s.model;
    sampleToId.set(s.id, id);
    sampleToLabel.set(s.id, s.model);
    // Ensure the id→label mapping covers samples without registryId
    if (!idToLabel[id]) idToLabel[id] = s.model;
    if (s.feedbackModel) {
      const fbId = s.feedbackRegistryId ?? s.feedbackModel;
      sampleToFeedbackId.set(s.id, fbId);
      if (!idToLabel[fbId]) idToLabel[fbId] = s.feedbackModel;
    }
  }

  const sampleToRevisedModelId = new Map(
    run.samples
      .filter((s) => s.stage === "revised")
      .map((s) => [s.id, s.registryId ?? s.model]),
  );

  const { judgeWeights, judgmentWeights } = computeRunWeights(run, sampleToLabel);

  const novelInitialJudgments = novelJudgments.filter((j) => j.stage === "initial");
  const novelRevisedJudgments = novelJudgments.filter((j) => j.stage === "revised");
  const novelImprovementJudgments = novelJudgments.filter((j) => j.stage === "improvement");

  // ── Initial Writing ELO ────────────────────────────
  const newInitialWritingRecords = gamesToRecords(judgmentsToGames(
    novelInitialJudgments,
    sampleToId,
    judgeWeights,
    judgmentWeights,
  ));
  pairwise.initialWriting = mergeRecords(pairwise.initialWriting, newInitialWritingRecords);
  const initialWritingRatings = whrRatingsFromRecords(pairwise.initialWriting);
  elo.initialWriting = convertRatingsToLabelMap(initialWritingRatings, idToLabel);
  elo.writing = elo.initialWriting;

  // ── Revised Writing ELO ────────────────────────────
  const newRevisedWritingRecords = gamesToRecords(judgmentsToGames(
    novelRevisedJudgments,
    sampleToRevisedModelId,
    judgeWeights,
    judgmentWeights,
  ));
  pairwise.revisedWriting = mergeRecords(pairwise.revisedWriting, newRevisedWritingRecords);
  const revisedWritingRatings = whrRatingsFromRecords(pairwise.revisedWriting);
  elo.revisedWriting = convertRatingsToLabelMap(revisedWritingRatings, idToLabel);

  // Backfill models from this run that have no matches yet
  for (const label of new Set(sampleToLabel.values())) {
    if (!elo.initialWriting[label]) {
      elo.initialWriting[label] = {
        model: label, rating: DEFAULT_RATING,
        wins: 0, losses: 0, ties: 0, matchCount: 0,
      };
    }
    if (!elo.revisedWriting[label]) {
      elo.revisedWriting[label] = {
        model: label, rating: DEFAULT_RATING,
        wins: 0, losses: 0, ties: 0, matchCount: 0,
      };
    }
  }
  elo.writing = elo.initialWriting;

  // ── Feedback ELO ───────────────────────────────────
  const newFeedbackRecords = gamesToRecords(
    improvementJudgmentsToGames(
      novelImprovementJudgments,
      sampleToFeedbackId,
      judgeWeights,
      judgmentWeights,
    ),
  );
  pairwise.feedbackGiving = mergeRecords(
    pairwise.feedbackGiving,
    newFeedbackRecords
  );
  const feedbackRatings = whrRatingsFromRecords(pairwise.feedbackGiving);
  elo.feedbackGiving = convertRatingsToLabelMap(feedbackRatings, idToLabel);

  // ── Per-tag Writing ELO (initial + revised) ────────
  const promptToTags = new Map<string, string[]>();
  for (const p of run.config.prompts) {
    promptToTags.set(p.id, p.tags);
  }
  const allTags = new Set(run.config.prompts.flatMap((p) => p.tags));

  const initialTagModels = new Map<string, Set<string>>();
  const revisedTagModels = new Map<string, Set<string>>();
  for (const s of run.samples) {
    const tags = promptToTags.get(s.promptId) ?? [];
    for (const tag of tags) {
      const byStage = s.stage === "initial" ? initialTagModels : revisedTagModels;
      const models = byStage.get(tag) ?? new Set<string>();
      models.add(s.model);
      byStage.set(tag, models);
    }
  }

  for (const tag of allTags) {
    const initialTagJudgments = novelInitialJudgments.filter((j) =>
      promptToTags.get(j.promptId)?.includes(tag),
    );
    const revisedTagJudgments = novelRevisedJudgments.filter((j) =>
      promptToTags.get(j.promptId)?.includes(tag),
    );

    const newInitialTagRecords = gamesToRecords(judgmentsToGames(
      initialTagJudgments,
      sampleToId,
      judgeWeights,
      judgmentWeights,
    ));
    const newRevisedTagRecords = gamesToRecords(judgmentsToGames(
      revisedTagJudgments,
      sampleToRevisedModelId,
      judgeWeights,
      judgmentWeights,
    ));

    pairwise.initialWritingByTag[tag] = mergeRecords(
      pairwise.initialWritingByTag[tag] ?? [],
      newInitialTagRecords,
    );
    pairwise.revisedWritingByTag[tag] = mergeRecords(
      pairwise.revisedWritingByTag[tag] ?? [],
      newRevisedTagRecords,
    );

    elo.initialWritingByTag[tag] = convertRatingsToLabelMap(
      whrRatingsFromRecords(pairwise.initialWritingByTag[tag]),
      idToLabel,
    );
    elo.revisedWritingByTag[tag] = convertRatingsToLabelMap(
      whrRatingsFromRecords(pairwise.revisedWritingByTag[tag]),
      idToLabel,
    );

    for (const label of initialTagModels.get(tag) ?? []) {
      if (!elo.initialWritingByTag[tag][label]) {
        elo.initialWritingByTag[tag][label] = {
          model: label, rating: DEFAULT_RATING,
          wins: 0, losses: 0, ties: 0, matchCount: 0,
        };
      }
    }

    for (const label of revisedTagModels.get(tag) ?? []) {
      if (!elo.revisedWritingByTag[tag][label]) {
        elo.revisedWritingByTag[tag][label] = {
          model: label, rating: DEFAULT_RATING,
          wins: 0, losses: 0, ties: 0, matchCount: 0,
        };
      }
    }
  }

  elo.writingByTag = elo.initialWritingByTag;
  pairwise.writing = pairwise.initialWriting;
  pairwise.writingByTag = pairwise.initialWritingByTag;

  // Persist processed keys (sorted for deterministic serialization)
  elo.processedJudgmentKeys = Array.from(processedKeys).sort();
  elo.modelLabels = idToLabel;

  // Build snapshot for history (keyed by label for display)
  const snapshot: Record<string, number> = {};
  for (const [label, rating] of Object.entries(elo.initialWriting)) {
    snapshot[label] = rating.rating;
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

// ── Rebuild ─────────────────────────────────────────

/**
 * Delete cumulative ELO and rebuild from all stored run results.
 * Reusable from both CLI and TUI contexts -- uses a progress callback
 * instead of console output.
 */
export async function rebuildCumulativeElo(
  onProgress?: (runId: string, index: number, total: number) => void,
): Promise<CumulativeElo> {
  if (existsSync(ELO_FILE)) {
    await rm(ELO_FILE);
  }

  const { listRuns, loadRun } = await import("./run-store.js");

  const runIds = (await listRuns()).reverse(); // chronological order for history
  for (let i = 0; i < runIds.length; i++) {
    const id = runIds[i];
    let run;
    try {
      run = await loadRun(id);
    } catch {
      // Skip unloadable runs (corrupt or missing data)
      continue;
    }
    await updateCumulativeElo(run);
    onProgress?.(id, i, runIds.length);
  }

  return loadCumulativeElo();
}
