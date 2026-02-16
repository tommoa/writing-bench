import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type {
  CumulativeElo,
  EloRating,
  RunResult,
} from "../types.js";
import { applyCumulativeJudgments, applyCumulativeFeedbackJudgments, createRating } from "../engine/elo.js";

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

  // Update writing ELO with all judgments (initial + revised)
  const writingRatings = new Map<string, EloRating>();
  for (const [model, rating] of Object.entries(elo.writing)) {
    writingRatings.set(model, { ...rating });
  }
  applyCumulativeJudgments(writingRatings, run.judgments, sampleToModel);

  // Update feedback ELO with improvement judgments (revision vs original).
  // Groups by (prompt, judge) and compares improvement rates across
  // different feedback providers.
  const feedbackRatings = new Map<string, EloRating>();
  for (const [model, rating] of Object.entries(elo.feedbackGiving)) {
    feedbackRatings.set(model, { ...rating });
  }
  const improvementJudgments = run.judgments.filter(
    (j) => j.stage === "improvement"
  );
  applyCumulativeFeedbackJudgments(
    feedbackRatings,
    improvementJudgments,
    sampleToFeedbackModel
  );

  // Update per-tag writing ELO
  const promptToTags = new Map<string, string[]>();
  for (const p of run.config.prompts) {
    promptToTags.set(p.id, p.tags);
  }
  const allTags = new Set(run.config.prompts.flatMap((p) => p.tags));

  if (!elo.writingByTag) {
    elo.writingByTag = {};
  }

  for (const tag of allTags) {
    const tagRatings = new Map<string, EloRating>();
    const existing = elo.writingByTag[tag] ?? {};
    for (const [model, rating] of Object.entries(existing)) {
      tagRatings.set(model, { ...rating });
    }
    // Use initial + revised judgments for this tag
    const tagJudgments = run.judgments.filter(
      (j) =>
        j.stage !== "improvement" &&
        (promptToTags.get(j.promptId)?.includes(tag) ?? false)
    );
    applyCumulativeJudgments(tagRatings, tagJudgments, sampleToModel);
    elo.writingByTag[tag] = Object.fromEntries(tagRatings);
  }

  // Build snapshot for history
  const snapshot: Record<string, number> = {};
  for (const [model, rating] of writingRatings) {
    snapshot[model] = rating.rating;
  }

  // Update state
  elo.lastUpdated = new Date().toISOString();
  elo.writing = Object.fromEntries(writingRatings);
  elo.feedbackGiving = Object.fromEntries(feedbackRatings);
  elo.history.push({
    runId: run.config.id,
    timestamp: run.config.timestamp,
    snapshot,
  });

  await saveCumulativeElo(elo);
  return elo;
}
