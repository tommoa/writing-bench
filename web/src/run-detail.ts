import type { RunManifest } from "./types.js";
import { el, $$, render, renderError, renderCostItem, formatDate, sectionDesc, SECTION_DESC } from "./helpers.js";
import { renderPromptSection } from "./prompt-section.js";
import { renderJudgmentsSection } from "./judgments.js";
import { renderJudgeQualitySection } from "./judge-quality.js";
import { createRatingToggle } from "./rating-toggle.js";
import { createRatingSettings } from "./rating-settings.js";
import { clearRatingSubscribers } from "./state.js";

// ── Data fetching ───────────────────────────────────

async function fetchManifest(id: string): Promise<RunManifest> {
  const res = await fetch(`data/runs/${id}.json`);
  if (!res.ok) throw new Error(`Run ${id} not found`);
  return res.json();
}

// ── Run Detail ──────────────────────────────────────

export function renderRunDetail(manifest: RunManifest): void {
  // Clear stale subscribers from previous page renders
  clearRatingSubscribers();

  const frag = document.createDocumentFragment();
  const runId = manifest.config.id;

  frag.appendChild(el("p", {}, el("a", { href: "?" }, "< back to leaderboard")));
  const totalCost = manifest.meta.totalCostUncached ?? manifest.meta.totalCost;
  frag.appendChild(
    el("h2", {}, `Run: ${formatDate(manifest.config.timestamp)} -- $${totalCost.toFixed(2)}`),
  );

  // Run info: writers and judges
  const writerLabels = manifest.config.models.map((m) => m.label).join(", ");
  if (manifest.config.judges && manifest.config.judges.length > 0) {
    const judgeLabels = manifest.config.judges.map((m) => m.label).join(", ");
    frag.appendChild(
      el("p", { className: "muted" }, `Writers: ${writerLabels} | Judges: ${judgeLabels}`),
    );
  } else {
    frag.appendChild(
      el("p", { className: "muted" }, `Models: ${writerLabels}`),
    );
  }

  // Unified rating settings (sticky tab bar + custom panel)
  frag.appendChild(createRatingSettings({
    alternativeRatings: manifest.alternativeRatings,
    manifest,
  }));

  // ELO tables -- per-run ratings have W/L/T instead of just match count
  const wlt = (r: { model: string; wins?: number; losses?: number; ties?: number }) =>
    r.wins != null ? `${r.wins}/${r.losses}/${r.ties}` : "-";

  const eloOpts = {
    costByModelByStage: manifest.meta.costByModelByStageUncached ?? {},
    tokensByModelByStage: manifest.meta.tokensByModelByStage ?? {},
    speedByModel: manifest.meta.speedByModel,
    wlt,
  };

  frag.appendChild(el("h2", {}, "Initial Writer ELO"));
  frag.appendChild(sectionDesc(SECTION_DESC.initialWriterElo));
  frag.appendChild(createRatingToggle({
    defaultRatings: manifest.elo.initial.ratings,
    alternativeRatings: manifest.alternativeRatings,
    manifest,
    dimension: "initial",
    eloTableOpts: { ...eloOpts, costStages: ["initial"] },
  }).container);

  frag.appendChild(el("h2", {}, "Revised Writer ELO"));
  frag.appendChild(sectionDesc(SECTION_DESC.revisedElo));
  frag.appendChild(createRatingToggle({
    defaultRatings: manifest.elo.revised.ratings,
    alternativeRatings: manifest.alternativeRatings,
    manifest,
    dimension: "revised",
    eloTableOpts: { ...eloOpts, costStages: ["revised"] },
  }).container);

  if (
    manifest.elo.revised.feedbackRatings &&
    manifest.elo.revised.feedbackRatings.length > 0
  ) {
    frag.appendChild(el("h2", {}, "Feedback Provider ELO"));
    frag.appendChild(sectionDesc(SECTION_DESC.feedbackElo));
    frag.appendChild(createRatingToggle({
      defaultRatings: manifest.elo.revised.feedbackRatings,
      alternativeRatings: manifest.alternativeRatings,
      manifest,
      dimension: "feedback",
      eloTableOpts: { ...eloOpts, costStages: ["feedback"] },
    }).container);
  }

  // Judge quality section (collapsed by default, lazy DOM on expand)
  if (manifest.judgeQuality && manifest.judgeQuality.length > 0) {
    frag.appendChild(el("h2", {}, "Judge Quality"));
    frag.appendChild(sectionDesc(SECTION_DESC.judgeQuality));
    const jqDetails = el("details");
    jqDetails.appendChild(el("summary", {}, "Judge Quality"));
    const jqInner = el("div", { className: "details-content" });
    jqDetails.appendChild(jqInner);

    let jqLoaded = false;
    jqDetails.addEventListener("toggle", () => {
      if (!(jqDetails as HTMLDetailsElement).open || jqLoaded) return;
      jqLoaded = true;
      const jqSection = renderJudgeQualitySection(manifest.judgeQuality!, "Judge Quality", manifest);
      if (jqSection) jqInner.appendChild(jqSection);
    });

    frag.appendChild(jqDetails);
  }

  // ELO by category (lazy DOM construction on expand)
  if (
    manifest.elo.initial.byTag &&
    Object.keys(manifest.elo.initial.byTag).length > 0
  ) {
    frag.appendChild(el("h2", {}, "ELO by Tag"));
    frag.appendChild(sectionDesc(SECTION_DESC.eloByTag));
    for (const [cat, ratings] of Object.entries(manifest.elo.initial.byTag)) {
      const d = el("details");
      d.appendChild(el("summary", {}, cat));
      const inner = el("div", { className: "details-content" });
      d.appendChild(inner);

      let loaded = false;
      d.addEventListener("toggle", () => {
        if (!(d as HTMLDetailsElement).open || loaded) return;
        loaded = true;

        inner.appendChild(el("h4", {}, "Initial"));
        inner.appendChild(createRatingToggle({
          defaultRatings: ratings,
          manifest,
          dimension: "initial",
          tagFilter: cat,
          eloTableOpts: { ...eloOpts, costStages: ["initial"] },
        }).container);

        if (manifest.elo.revised.byTag?.[cat]) {
          inner.appendChild(el("h4", {}, "Revised"));
          inner.appendChild(createRatingToggle({
            defaultRatings: manifest.elo.revised.byTag[cat],
            manifest,
            dimension: "revised",
            tagFilter: cat,
            eloTableOpts: { ...eloOpts, costStages: ["revised"] },
          }).container);
        }
      });

      frag.appendChild(d);
    }
  }

  // Per-prompt sections with filter
  const promptHeader = el("div", { className: "section-header" });
  promptHeader.appendChild(el("h2", {}, "Outputs by Prompt"));

  const promptFilterSelect = document.createElement("select");
  promptFilterSelect.className = "prompt-filter-select";
  promptFilterSelect.appendChild(new Option("All prompts", "all"));
  const tags = [...new Set(manifest.config.prompts.flatMap((p) => p.tags))].sort();
  if (tags.length > 1) {
    for (const tag of tags) {
      promptFilterSelect.appendChild(new Option(`Tag: ${tag}`, `tag:${tag}`));
    }
  }
  for (const p of manifest.config.prompts) {
    promptFilterSelect.appendChild(new Option(p.name, `id:${p.id}`));
  }
  promptHeader.appendChild(promptFilterSelect);
  frag.appendChild(promptHeader);

  const promptSections = el("div", { id: "prompt-sections" });
  for (const prompt of manifest.config.prompts) {
    const section = renderPromptSection(manifest, prompt, runId);
    section.setAttribute("data-prompt-id", prompt.id);
    section.setAttribute("data-prompt-tags", prompt.tags.join(","));
    promptSections.appendChild(section);
  }
  frag.appendChild(promptSections);

  promptFilterSelect.addEventListener("change", () => {
    const val = promptFilterSelect.value;
    for (const child of $$("[data-prompt-id]", promptSections)) {
      if (val === "all") {
        (child as HTMLElement).style.display = "";
      } else if (val.startsWith("tag:")) {
        const tag = val.slice(4);
        const childTags = (child.getAttribute("data-prompt-tags") ?? "").split(",");
        (child as HTMLElement).style.display =
          childTags.includes(tag) ? "" : "none";
      } else if (val.startsWith("id:")) {
        const id = val.slice(3);
        (child as HTMLElement).style.display =
          child.getAttribute("data-prompt-id") === id ? "" : "none";
      }
    }
  });

  // Judgments section
  frag.appendChild(el("h2", {}, "Judgments"));
  frag.appendChild(renderJudgmentsSection(manifest));

  // Run metadata
  frag.appendChild(el("h2", {}, "Run Metadata"));
  frag.appendChild(renderRunMetadata(manifest));

  render(frag);
}

// ── Run Detail Page (with loading state) ────────────

export async function renderRunDetailPage(id: string): Promise<void> {
  render(`<div id="loading">loading run...</div>`);
  try {
    const manifest = await fetchManifest(id);
    renderRunDetail(manifest);
  } catch (e) {
    renderError(e instanceof Error ? e.message : String(e));
  }
}

// ── Run Metadata ────────────────────────────────────

function renderRunMetadata(manifest: RunManifest): HTMLElement {
  const container = el("div");

  const costGrid = el("div", { className: "cost-grid" });
  const displayCost = manifest.meta.totalCostUncached ?? manifest.meta.totalCost;
  costGrid.appendChild(
    renderCostItem("Total Cost", `$${displayCost.toFixed(4)}`),
  );
  costGrid.appendChild(
    renderCostItem(
      "Duration",
      `${(manifest.meta.durationMs / 1000).toFixed(1)}s`,
    ),
  );
  costGrid.appendChild(
    renderCostItem("Total Tokens", manifest.meta.totalTokens.toLocaleString()),
  );
  container.appendChild(costGrid);

  if (manifest.modelInfo && Object.keys(manifest.modelInfo).length > 0) {
    container.appendChild(el("h3", {}, "Models"));
    const cards = el("div", { className: "model-cards" });
    for (const [label, info] of Object.entries(manifest.modelInfo)) {
      cards.appendChild(
        el(
          "div",
          { className: "model-card" },
          el("div", { className: "name" }, label),
          el("div", { className: "detail" }, info.name),
          el("div", { className: "detail" }, `Family: ${info.family}`),
          el(
            "div",
            { className: "detail" },
            `$${info.costPer1MInput}/M in, $${info.costPer1MOutput}/M out`,
          ),
          info.releaseDate
            ? el("div", { className: "detail" }, `Released: ${info.releaseDate}`)
            : null,
          el(
            "div",
            { className: "detail" },
            info.openWeights ? "Open weights" : "Proprietary",
          ),
        ),
      );
    }
    container.appendChild(cards);
  }

  return container;
}
