import type { RunManifest, SampleMeta, JudgmentMeta } from "./types.js";
import { el, $$ } from "./helpers.js";
import { setJudgmentApi, fetchPromptContent } from "./state.js";
import { scrollToSample } from "./prompt-section.js";

// ── Judgment label helpers ──────────────────────────

interface JudgmentLabels {
  labelA: string;
  labelB: string;
  winnerLabel: string;
  outputIdxA: number | null;
  outputIdxB: number | null;
}

export function buildJudgmentLabel(
  j: JudgmentMeta,
  sampleMap: Map<string, SampleMeta>,
): JudgmentLabels {
  const sA = sampleMap.get(j.sampleA);
  const sB = sampleMap.get(j.sampleB);
  const outputIdxA = sA?.outputIndex ?? null;
  const outputIdxB = sB?.outputIndex ?? null;
  const defaultWinnerLabel =
    j.winner === "tie" ? "Tie" : (j.winner === "A" ? sA?.model : sB?.model) ?? "?";

  if (j.stage === "improvement") {
    // One sample is initial, one is revised (same writer)
    const aIsOriginal = sA?.stage === "initial";
    const orig = aIsOriginal ? sA : sB;
    const rev = aIsOriginal ? sB : sA;
    const fbModel = rev?.feedbackModel ?? "?";

    const origLabel = `${orig?.model ?? "?"} (original)`;
    const revLabel = `${rev?.model ?? "?"} (revised, fb: ${fbModel})`;

    let winnerLabel: string;
    if (j.winner === "tie") {
      winnerLabel = "Tie";
    } else {
      const winSample = j.winner === "A" ? sA : sB;
      winnerLabel = winSample?.stage === "initial" ? "original" : "revised";
    }

    return aIsOriginal
      ? { labelA: origLabel, labelB: revLabel, winnerLabel, outputIdxA, outputIdxB }
      : { labelA: revLabel, labelB: origLabel, winnerLabel, outputIdxA: outputIdxB, outputIdxB: outputIdxA };
  }

  if (j.stage === "revised") {
    const fbA = sA?.feedbackModel ? ` (fb: ${sA.feedbackModel})` : "";
    const fbB = sB?.feedbackModel ? ` (fb: ${sB.feedbackModel})` : "";
    return {
      labelA: `${sA?.model ?? "?"}${fbA}`,
      labelB: `${sB?.model ?? "?"}${fbB}`,
      winnerLabel: defaultWinnerLabel,
      outputIdxA,
      outputIdxB,
    };
  }

  // initial -- plain model names
  return {
    labelA: sA?.model ?? "?",
    labelB: sB?.model ?? "?",
    winnerLabel: defaultWinnerLabel,
    outputIdxA,
    outputIdxB,
  };
}

// ── Judgments Section with Model vs Model comparison ─

export function renderJudgmentsSection(manifest: RunManifest): HTMLElement {
  const container = el("div");
  container.id = "judgments-section";
  const judgments = manifest.judgments;
  if (judgments.length === 0) {
    container.appendChild(el("p", { className: "muted" }, "No judgments."));
    return container;
  }

  const runId = manifest.config.id;

  // Build sample lookup once
  const sampleMap = new Map(manifest.samples.map((s) => [s.id, s]));

  // Collect unique values for filters
  const stages = [...new Set(judgments.map((j) => j.stage))].sort();
  const judges = [...new Set(judgments.map((j) => j.judgeModel))].sort();
  const allModels = [...new Set(manifest.samples.map((s) => s.model))].sort();
  const allPrompts = manifest.config.prompts;
  const judgmentTags = [...new Set(allPrompts.flatMap((p) => p.tags))].sort();

  // Filter state
  let filterStage = "all";
  let filterJudge = "all";
  let filterModelA = "all";
  let filterModelB = "all";
  let filterPrompt = "all";
  let filterSampleId: string | null = null;

  // Named setters (one per filter, reused across all call sites)
  const setStage = (v: string) => { filterStage = v; };
  const setJudge = (v: string) => { filterJudge = v; };
  const setModelA = (v: string) => { filterModelA = v; };
  const setModelB = (v: string) => { filterModelB = v; };
  const setPrompt = (v: string) => { filterPrompt = v; };

  // Pagination state
  let pageSize = 25;
  let currentPage = 0;

  // Build filter bar
  const filterBar = el("div", { className: "judgment-filters" });

  const promptSelect = document.createElement("select");
  promptSelect.appendChild(new Option("All prompts", "all"));
  if (judgmentTags.length > 1) {
    for (const tag of judgmentTags) {
      promptSelect.appendChild(new Option(`Tag: ${tag}`, `tag:${tag}`));
    }
  }
  for (const p of allPrompts) {
    promptSelect.appendChild(new Option(p.name, `id:${p.id}`));
  }

  const stageSelect = document.createElement("select");
  stageSelect.appendChild(new Option("All stages", "all"));
  for (const s of stages) stageSelect.appendChild(new Option(s, s));

  const judgeSelect = document.createElement("select");
  judgeSelect.appendChild(new Option("All judges", "all"));
  for (const j of judges) judgeSelect.appendChild(new Option(j, j));

  const modelASelect = document.createElement("select");
  modelASelect.appendChild(new Option("All models", "all"));
  for (const m of allModels) modelASelect.appendChild(new Option(m, m));

  const modelBSelect = document.createElement("select");
  modelBSelect.appendChild(new Option("All models", "all"));
  for (const m of allModels) modelBSelect.appendChild(new Option(m, m));

  filterBar.appendChild(el("span", { className: "muted small" }, "Prompt: "));
  filterBar.appendChild(promptSelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " Stage: "));
  filterBar.appendChild(stageSelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " Judge: "));
  filterBar.appendChild(judgeSelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " Model A: "));
  filterBar.appendChild(modelASelect);
  filterBar.appendChild(el("span", { className: "muted small" }, " vs B: "));
  filterBar.appendChild(modelBSelect);

  container.appendChild(filterBar);

  // Sample filter badge (shown when filtering by specific output)
  const sampleBadge = el("div", { className: "sample-filter-badge" });
  sampleBadge.style.display = "none";
  container.appendChild(sampleBadge);

  // Head-to-head summary (shown when both models selected)
  const h2hContainer = el("div", { className: "h2h-summary" });
  h2hContainer.style.display = "none";
  container.appendChild(h2hContainer);

  // Judgment list container
  const listContainer = el("div");
  container.appendChild(listContainer);

  // Track indexed pairs: [manifestIndex, judgment]
  // so we can look up reasoning by position later
  const indexed: Array<[number, JudgmentMeta]> = judgments.map((j, i) => [i, j]);

  const multiOutput = manifest.config.outputsPerModel > 1;

  function buildMatchupLink(
    sampleId: string,
    label: string,
    side: "side-a" | "side-b",
    outputIdx: number | null,
  ): HTMLElement {
    const select = side === "side-a" ? modelASelect : modelBSelect;
    const setter = side === "side-a" ? setModelA : setModelB;
    const model = sampleMap.get(sampleId)?.model ?? label;

    const idxEl = multiOutput && outputIdx != null
      ? el("span", { className: "judgment-output-idx" }, ` #${outputIdx + 1}`)
      : null;

    const nameLink = el(
      "a",
      {
        href: "#",
        className: `judgment-filter-link ${side}`,
        onClick: (e: Event) => {
          e.preventDefault();
          setFilter(select, model, setter);
          resetAndRerender();
        },
      },
      el("span", { className: "judgment-model-name" }, label),
      idxEl,
    );

    const viewLink = el(
      "a",
      {
        href: "#",
        className: "view-output-link",
        onClick: (e: Event) => {
          e.preventDefault();
          scrollToSample(sampleId, manifest);
        },
      },
      "view output",
    );

    return el("span", { className: "judgment-matchup-item" }, nameLink, viewLink);
  }

  const rerender = (): void => {
    let filtered = indexed;

    // Sample ID filter (from "view judgments" button)
    if (filterSampleId) {
      filtered = filtered.filter(
        ([, j]) => j.sampleA === filterSampleId || j.sampleB === filterSampleId,
      );
      const sample = sampleMap.get(filterSampleId);
      sampleBadge.innerHTML = "";
      sampleBadge.style.display = "flex";
      sampleBadge.appendChild(
        el(
          "span",
          {},
          `Showing judgments for ${sample?.model ?? "unknown"}'s output`,
        ),
      );
      sampleBadge.appendChild(
        el(
          "button",
          {
            className: "badge-clear",
            onClick: () => {
              filterSampleId = null;
              rerender();
            },
          },
          "\u2715 clear",
        ),
      );
    } else {
      sampleBadge.style.display = "none";
    }

    if (filterPrompt !== "all") {
      if (filterPrompt.startsWith("tag:")) {
        const tag = filterPrompt.slice(4);
        const promptIds = new Set(
          allPrompts.filter((p) => p.tags.includes(tag)).map((p) => p.id),
        );
        filtered = filtered.filter(([, j]) => promptIds.has(j.promptId));
      } else if (filterPrompt.startsWith("id:")) {
        const id = filterPrompt.slice(3);
        filtered = filtered.filter(([, j]) => j.promptId === id);
      }
    }
    if (filterStage !== "all") {
      filtered = filtered.filter(([, j]) => j.stage === filterStage);
    }
    if (filterJudge !== "all") {
      filtered = filtered.filter(([, j]) => j.judgeModel === filterJudge);
    }

    // Model A/B filtering
    if (filterModelA !== "all" && filterModelB !== "all") {
      filtered = filtered.filter(([, j]) => {
        const mA = sampleMap.get(j.sampleA)?.model;
        const mB = sampleMap.get(j.sampleB)?.model;
        return (
          (mA === filterModelA && mB === filterModelB) ||
          (mA === filterModelB && mB === filterModelA)
        );
      });
    } else if (filterModelA !== "all") {
      filtered = filtered.filter(([, j]) => {
        const mA = sampleMap.get(j.sampleA)?.model;
        const mB = sampleMap.get(j.sampleB)?.model;
        return mA === filterModelA || mB === filterModelA;
      });
    } else if (filterModelB !== "all") {
      filtered = filtered.filter(([, j]) => {
        const mA = sampleMap.get(j.sampleA)?.model;
        const mB = sampleMap.get(j.sampleB)?.model;
        return mA === filterModelB || mB === filterModelB;
      });
    }

    // Head-to-head summary
    if (filterModelA !== "all" && filterModelB !== "all" && filterModelA !== filterModelB) {
      let winsA = 0;
      let winsB = 0;
      let ties = 0;
      for (const [, j] of filtered) {
        const mA = sampleMap.get(j.sampleA)?.model;
        if (j.winner === "tie") {
          ties++;
        } else if (j.winner === "A") {
          if (mA === filterModelA) winsA++;
          else winsB++;
        } else {
          if (mA === filterModelA) winsB++;
          else winsA++;
        }
      }
      h2hContainer.innerHTML = "";
      h2hContainer.style.display = "block";
      h2hContainer.appendChild(
        el(
          "div",
          { className: "h2h-record" },
          el("span", { className: "h2h-model" }, filterModelA),
          el("span", { className: "h2h-wins" }, ` ${winsA}W`),
          el("span", { className: "muted" }, " / "),
          el("span", { className: "h2h-losses" }, `${winsB}L`),
          el("span", { className: "muted" }, " / "),
          el("span", { className: "h2h-ties" }, `${ties}T`),
          el("span", { className: "muted" }, ` vs `),
          el("span", { className: "h2h-model" }, filterModelB),
        ),
      );
    } else {
      h2hContainer.style.display = "none";
    }

    listContainer.innerHTML = "";

    // Pagination
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    const start = currentPage * pageSize;
    const pageItems = filtered.slice(start, start + pageSize);

    function buildPaginationNav(): HTMLElement {
      const nav = el("div", { className: "pagination" });
      const prevBtn = el(
        "button",
        {
          disabled: currentPage === 0,
          onClick: () => { currentPage--; rerender(); },
        },
        "< prev",
      );
      const nextBtn = el(
        "button",
        {
          disabled: currentPage >= totalPages - 1,
          onClick: () => { currentPage++; rerender(); },
        },
        "next >",
      );
      nav.appendChild(prevBtn);
      nav.appendChild(
        el("span", { className: "muted" }, ` page ${currentPage + 1} of ${totalPages} `),
      );
      nav.appendChild(nextBtn);

      const sizeSelect = document.createElement("select");
      sizeSelect.className = "page-size-select";
      for (const size of [10, 25, 50, 100]) {
        const opt = new Option(`${size} per page`, String(size));
        if (size === pageSize) opt.selected = true;
        sizeSelect.appendChild(opt);
      }
      sizeSelect.addEventListener("change", () => {
        pageSize = Number(sizeSelect.value);
        currentPage = 0;
        rerender();
      });
      nav.appendChild(sizeSelect);
      return nav;
    }

    const showPagination = filtered.length > 10;

    if (showPagination) {
      listContainer.appendChild(buildPaginationNav());
    } else {
      listContainer.appendChild(
        el(
          "p",
          { className: "muted small mb-1" },
          `${filtered.length} judgments`,
        ),
      );
    }

    for (const [manifestIdx, j] of pageItems) {
      const prompt = allPrompts.find((p) => p.id === j.promptId);
      const { labelA, labelB, winnerLabel, outputIdxA, outputIdxB } =
        buildJudgmentLabel(j, sampleMap);
      const winnerClass =
        j.winner === "A" ? "a" : j.winner === "B" ? "b" : "tie";

      const linkA = buildMatchupLink(j.sampleA, labelA, "side-a", outputIdxA);
      const linkB = buildMatchupLink(j.sampleB, labelB, "side-b", outputIdxB);

      const winnerBorder =
        j.winner === "A" ? "winner-a" : j.winner === "B" ? "winner-b" : "";
      const judgEl = el("div", { className: `judgment ${winnerBorder}`.trim() });

      // Line 1: stage, prompt (filter link), judge (filter link)
      const promptLink = el(
        "a",
        {
          href: "#",
          className: "judgment-filter-link",
          onClick: (e: Event) => {
            e.preventDefault();
            setFilter(promptSelect, `id:${j.promptId}`, setPrompt);
            resetAndRerender();
          },
        },
        prompt?.name ?? j.promptId,
      );
      const judgeLink = el(
        "a",
        {
          href: "#",
          className: "judgment-filter-link",
          onClick: (e: Event) => {
            e.preventDefault();
            setFilter(judgeSelect, j.judgeModel, setJudge);
            resetAndRerender();
          },
        },
        j.judgeModel,
      );
      judgEl.appendChild(
        el(
          "div",
          { className: "judgment-header" },
          el("span", { className: "judgment-stage" }, j.stage),
          el("span", {}, " "),
          promptLink,
          el("span", { className: "judgment-judge" }, "Judge: ", judgeLink),
        ),
      );

      // View matchup button (goes in the "vs" column)
      const modelNameA = sampleMap.get(j.sampleA)?.model;
      const modelNameB = sampleMap.get(j.sampleB)?.model;
      const alreadyFiltered =
        (filterModelA === modelNameA && filterModelB === modelNameB) ||
        (filterModelA === modelNameB && filterModelB === modelNameA);
      const isCrossModel = modelNameA && modelNameB && modelNameA !== modelNameB;

      const matchupBtn = isCrossModel && !alreadyFiltered
        ? el(
            "button",
            {
              className: "judgment-action",
              onClick: (e: Event) => {
                e.stopPropagation();
                setFilter(modelASelect, modelNameA, setModelA);
                setFilter(modelBSelect, modelNameB, setModelB);
                resetAndRerender();
                container.scrollIntoView({ behavior: "smooth" });
              },
            },
            "view matchup",
          )
        : null;

      // "vs" column: "vs" label + optional "view matchup" below
      const vsColumn = el(
        "span",
        { className: "judgment-matchup-item" },
        el("span", { className: "muted" }, "vs"),
        matchupBtn,
      );

      // Matchup line (left side)
      const matchupLine = el(
        "div",
        { className: "judgment-matchup" },
        linkA,
        vsColumn,
        linkB,
      );

      // Reasoning: lazy-loaded via expand/collapse (right side)
      const reasoningContainer = el("div", { className: "judgment-reasoning-container" });
      const expandBtn = el(
        "button",
        {
          className: "judgment-action",
          onClick: async () => {
            if (reasoningContainer.dataset.loaded === "true") {
              const text = reasoningContainer.querySelector(".judgment-reasoning");
              if (text) {
                text.classList.toggle("hidden");
                expandBtn.textContent = text.classList.contains("hidden")
                  ? "show reasoning" : "hide reasoning";
              }
              return;
            }
            expandBtn.textContent = "loading...";
            try {
              const promptData = await fetchPromptContent(runId, j.promptId);
              const slice = manifest.promptJudgmentSlices[j.promptId];
              const localIndex = manifestIdx - slice.start;
              const reasoning = promptData.reasoning[localIndex];

              reasoningContainer.dataset.loaded = "true";
              reasoningContainer.appendChild(
                el("div", { className: "judgment-reasoning" }, reasoning ?? ""),
              );
              expandBtn.textContent = "hide reasoning";
            } catch {
              expandBtn.textContent = "failed to load";
            }
          },
        },
        "show reasoning",
      );

      // Winner + show reasoning toggle (right side)
      const rightSide = el(
        "div",
        { className: "judgment-body-right" },
        el(
          "div",
          { className: "judgment-result" },
          el("span", { className: "muted" }, "winner: "),
          el(
            "span",
            { className: `judgment-winner ${winnerClass}` },
            winnerLabel,
          ),
        ),
        expandBtn,
      );

      // Two-column body
      judgEl.appendChild(
        el("div", { className: "judgment-body" }, matchupLine, rightSide),
      );

      // Reasoning expands below the full card width
      judgEl.appendChild(reasoningContainer);

      listContainer.appendChild(judgEl);
    }

    if (showPagination) {
      listContainer.appendChild(buildPaginationNav());
    }
  };

  /** Clear sample filter, reset pagination, and rerender. */
  function resetAndRerender(): void {
    filterSampleId = null;
    currentPage = 0;
    rerender();
  }

  /** Set a filter variable and sync its <select> element. */
  function setFilter(select: HTMLSelectElement, value: string, setter: (v: string) => void): void {
    setter(value);
    select.value = value;
  }

  function bindFilter(select: HTMLSelectElement, setter: (v: string) => void): void {
    select.addEventListener("change", () => {
      setFilter(select, select.value, setter);
      resetAndRerender();
    });
  }

  bindFilter(promptSelect, setPrompt);
  bindFilter(stageSelect, setStage);
  bindFilter(judgeSelect, setJudge);
  bindFilter(modelASelect, setModelA);
  bindFilter(modelBSelect, setModelB);

  /** Reset all filters to defaults, sync selects, and rerender. */
  function resetAllFilters(): void {
    setFilter(promptSelect, "all", setPrompt);
    setFilter(stageSelect, "all", setStage);
    setFilter(judgeSelect, "all", setJudge);
    setFilter(modelASelect, "all", setModelA);
    setFilter(modelBSelect, "all", setModelB);
  }

  // Expose API for cross-section interaction
  setJudgmentApi({
    focusSample(sampleId: string) {
      const sample = sampleMap.get(sampleId);
      filterSampleId = sampleId;
      resetAllFilters();
      setFilter(modelASelect, sample?.model ?? "all", setModelA);
      currentPage = 0;
      rerender();
      container.scrollIntoView({ behavior: "smooth" });
    },
    focusModel(model: string) {
      filterSampleId = null;
      resetAllFilters();
      setFilter(modelASelect, model, setModelA);
      currentPage = 0;
      rerender();
      container.scrollIntoView({ behavior: "smooth" });
    },
  });

  rerender();
  return container;
}
