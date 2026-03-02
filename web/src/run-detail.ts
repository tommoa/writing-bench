import type { RunManifest } from "./types.js";
import { el, $$, render, renderError, renderCostItem, formatDate, sectionDesc, SECTION_DESC } from "./helpers.js";
import { createRatingToggle } from "./rating-toggle.js";
import { createRatingSettings } from "./rating-settings.js";
import { clearRatingSubscribers, focusJudgmentsForModel, getPromptLoadPromise, registerPromptLoadPromise, setJudgmentsSectionLoader } from "./state.js";

const RUN_DETAIL_STYLESHEET_PATH = "style-run-detail.css";

// ── Data fetching ───────────────────────────────────

async function fetchManifest(id: string, signal?: AbortSignal): Promise<RunManifest> {
  const res = await fetch(`data/runs/${id}.json`, { signal });
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
  const uncachedNote = manifest.meta.totalCostUncached != null
    ? ` -- est uncached $${manifest.meta.totalCostUncached.toFixed(2)}`
    : "";
  frag.appendChild(
    el("h2", {}, `Run: ${formatDate(manifest.config.timestamp)} -- actual $${manifest.meta.totalCost.toFixed(2)}${uncachedNote}`),
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
  const ratingSettings = createRatingSettings({
    alternativeRatings: manifest.alternativeRatings,
    manifest,
  });
  ratingSettings.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.classList.contains("tab") && target.textContent === "custom") {
      ensureRunDetailStyles();
    }
  });
  frag.appendChild(ratingSettings);

  // ELO tables -- per-run ratings have W/L/T instead of just match count
  const wlt = (r: { model: string; wins?: number; losses?: number; ties?: number }) =>
    r.wins != null ? `${r.wins}/${r.losses}/${r.ties}` : "-";

  const eloOpts = {
    costByModelByStage: manifest.meta.costByModelByStageUncached ?? {},
    tokensByModelByStage: manifest.meta.tokensByModelByStage ?? {},
    speedByModel: manifest.meta.speedByModel,
    wlt,
    onModelClick: focusJudgmentsForModel,
  };

  appendRunRatingSection(
    frag,
    "Initial Writer ELO",
    SECTION_DESC.initialWriterElo,
    manifest.elo.initial.ratings,
    "initial",
    "initial",
    manifest,
    eloOpts,
  );
  appendRunRatingSection(
    frag,
    "Revised Writer ELO",
    SECTION_DESC.revisedElo,
    manifest.elo.revised.ratings,
    "revised",
    "revised",
    manifest,
    eloOpts,
  );

  if (
    manifest.elo.revised.feedbackRatings &&
    manifest.elo.revised.feedbackRatings.length > 0
  ) {
    appendRunRatingSection(
      frag,
      "Feedback Provider ELO",
      SECTION_DESC.feedbackElo,
      manifest.elo.revised.feedbackRatings,
      "feedback",
      "feedback",
      manifest,
      eloOpts,
    );
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
    jqDetails.addEventListener("toggle", async () => {
      if (!(jqDetails as HTMLDetailsElement).open || jqLoaded) return;
      jqLoaded = true;
      ensureRunDetailStyles();

      try {
        const { renderJudgeQualitySection } = await import("./judge-quality.js");
        const jqSection = renderJudgeQualitySection(manifest.judgeQuality!, "Judge Quality", manifest);
        if (jqSection) jqInner.appendChild(jqSection);
      } catch (e) {
        jqLoaded = false;
        jqInner.appendChild(
          el("p", { className: "muted" }, `Load failed: ${errorMessage(e)}`),
        );
      }
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
        ensureRunDetailStyles();

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
    const section = createLazyPromptSection(manifest, prompt, runId);
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
  frag.appendChild(createLazyJudgmentsSection(manifest));

  // Run metadata
  frag.appendChild(el("h2", {}, "Run Metadata"));
  frag.appendChild(createLazyRunMetadataSection(manifest));

  render(frag);
}

function appendRunRatingSection(
  frag: DocumentFragment,
  title: string,
  description: string,
  ratings: RunManifest["elo"]["initial"]["ratings"],
  dimension: "initial" | "revised" | "feedback",
  costStage: "initial" | "revised" | "feedback",
  manifest: RunManifest,
  eloOpts: {
    costByModelByStage: Record<string, Record<string, number>>;
    tokensByModelByStage: Record<string, Record<string, number>>;
    speedByModel: RunManifest["meta"]["speedByModel"];
    wlt: (r: { model: string; wins?: number; losses?: number; ties?: number }) => string;
    onModelClick: (model: string) => void;
  },
): void {
  frag.appendChild(el("h2", {}, title));
  frag.appendChild(sectionDesc(description));
  frag.appendChild(createRatingToggle({
    defaultRatings: ratings,
    alternativeRatings: manifest.alternativeRatings,
    manifest,
    dimension,
    eloTableOpts: { ...eloOpts, costStages: [costStage] },
  }).container);
}

function createLazyPromptSection(
  manifest: RunManifest,
  prompt: RunManifest["config"]["prompts"][number],
  runId: string,
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.appendChild(el("summary", {}, `${prompt.name} (${prompt.tags.join(", ")})`));

  const inner = el("div", { className: "details-content" });
  inner.appendChild(el("p", { className: "muted small" }, prompt.description));
  inner.appendChild(el("p", { className: "muted" }, "Expand to load."));
  details.appendChild(inner);

  let loaded = false;
  details.addEventListener("toggle", () => {
    if (!details.open || loaded) return;
    loaded = true;

    const loadPromise = (async () => {
      ensureRunDetailStyles();

      try {
        const { renderPromptSection } = await import("./prompt-section.js");
        const fullSection = renderPromptSection(manifest, prompt, runId);
        fullSection.setAttribute("data-prompt-id", prompt.id);
        fullSection.setAttribute("data-prompt-tags", prompt.tags.join(","));
        details.replaceWith(fullSection);

        const fullDetails = fullSection as HTMLDetailsElement;
        fullDetails.open = true;
        fullDetails.dispatchEvent(new Event("toggle"));

        const promptLoadPromise = getPromptLoadPromise(prompt.id);
        if (promptLoadPromise) {
          await promptLoadPromise;
        }
      } catch (e) {
        loaded = false;
        inner.appendChild(
          el("p", { className: "muted" }, `Load failed: ${errorMessage(e)}`),
        );
      }
    })();

    registerPromptLoadPromise(prompt.id, loadPromise);
  });

  return details;
}

function createLazyJudgmentsSection(manifest: RunManifest): HTMLElement {
  const details = el("details");
  details.appendChild(el("summary", {}, "Judgments"));

  const inner = el("div", { className: "details-content" });
  inner.appendChild(el("p", { className: "muted" }, "Expand to load."));
  details.appendChild(inner);

  let loaded = false;
  let loadPromise: Promise<void> | undefined;
  setJudgmentsSectionLoader({
    open: () => {
      if (!(details as HTMLDetailsElement).open) {
        (details as HTMLDetailsElement).open = true;
        details.dispatchEvent(new Event("toggle"));
      }
    },
    getLoadPromise: () => loadPromise,
  });
  details.addEventListener("toggle", () => {
    if (!(details as HTMLDetailsElement).open || loaded) return;
    loaded = true;
    ensureRunDetailStyles();

    loadPromise = (async () => {
      inner.replaceChildren(el("p", { className: "muted" }, "Loading..."));
      try {
        const { renderJudgmentsSection } = await import("./judgments.js");
        inner.replaceChildren(renderJudgmentsSection(manifest));
      } catch (e) {
        loaded = false;
        inner.replaceChildren(
          el("p", { className: "muted" }, `Load failed: ${errorMessage(e)}`),
        );
      }
    })();

  });

  return details;
}

function createLazyRunMetadataSection(manifest: RunManifest): HTMLElement {
  const details = el("details");
  details.appendChild(el("summary", {}, "Metadata"));

  const inner = el("div", { className: "details-content" });
  inner.appendChild(el("p", { className: "muted" }, "Expand to load."));
  details.appendChild(inner);

  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!(details as HTMLDetailsElement).open || loaded) return;
    loaded = true;
    ensureRunDetailStyles();
    inner.replaceChildren(el("p", { className: "muted" }, "Loading..."));
    try {
      const { modelLogo } = await import("./model-logos.js");
      inner.replaceChildren(renderRunMetadata(manifest, modelLogo));
    } catch (e) {
      loaded = false;
      inner.replaceChildren(
        el("p", { className: "muted" }, `Load failed: ${errorMessage(e)}`),
      );
    }
  });

  return details;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ensureRunDetailStyles(): void {
  if (document.getElementById("run-detail-css")) return;
  const link = document.createElement("link");
  link.id = "run-detail-css";
  link.rel = "stylesheet";
  link.href = RUN_DETAIL_STYLESHEET_PATH;
  document.head.appendChild(link);
}

// ── Run Detail Page (with loading state) ────────────

export async function renderRunDetailPage(id: string, signal?: AbortSignal): Promise<void> {
  render(`<div id="loading">loading run...</div>`);
  try {
    const manifest = await fetchManifest(id, signal);
    if (signal?.aborted) return;
    renderRunDetail(manifest);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    renderError(e instanceof Error ? e.message : String(e));
  }
}

// ── Run Metadata ────────────────────────────────────

function renderRunMetadata(
  manifest: RunManifest,
  modelLogoFn: (family: string | undefined, size?: number) => HTMLElement | null,
): HTMLElement {
  const container = el("div");

  const costGrid = el("div", { className: "cost-grid" });
  costGrid.appendChild(
    renderCostItem("Actual Cost", `$${manifest.meta.totalCost.toFixed(4)}`),
  );
  if (manifest.meta.totalCostUncached != null) {
    costGrid.appendChild(
      renderCostItem("Estimated Uncached Cost", `$${manifest.meta.totalCostUncached.toFixed(4)}`),
    );
  }
  costGrid.appendChild(
    renderCostItem(
      "Termination",
      manifest.meta.converged
        ? `${manifest.meta.terminationReason} (converged)`
        : `${manifest.meta.terminationReason} (not converged)`,
    ),
  );
  costGrid.appendChild(
    renderCostItem("Rounds Completed", String(manifest.meta.roundsCompleted)),
  );
  costGrid.appendChild(renderCostItem("Duration", `${(manifest.meta.durationMs / 1000).toFixed(1)}s`));
  costGrid.appendChild(
    renderCostItem("Total Tokens", manifest.meta.totalTokens.toLocaleString()),
  );
  container.appendChild(costGrid);

  if (manifest.modelInfo && Object.keys(manifest.modelInfo).length > 0) {
    container.appendChild(el("h3", {}, "Models"));
    const cards = el("div", { className: "model-cards" });
    for (const [label, info] of Object.entries(manifest.modelInfo)) {
      const logo = modelLogoFn(info.family, 24);
      cards.appendChild(
        el(
          "div",
          { className: "model-card" },
          logo,
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
