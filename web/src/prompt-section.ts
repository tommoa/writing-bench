import type { RunManifest, PromptConfig, SampleMeta, PromptContent } from "./types.js";
import { el, $, $$ } from "./helpers.js";
import { sampleMetaEl, feedbackMetaEl } from "./helpers.js";
import { getJudgmentApi, fetchPromptContent } from "./state.js";

// ── Prompt Section ──────────────────────────────────
// Tabs select which model's output to view. The active tab shows the
// initial output, a "view judgments" link, and collapsible feedback
// with revisions nested underneath.
//
// Content is loaded lazily (Tier 2) when the user expands the prompt
// <details> element. The collapsed view renders from manifest metadata
// only.

// Map from prompt <details> element to its load promise, so
// scrollToSample can await content before scrolling.
const promptLoadPromises = new WeakMap<HTMLElement, Promise<void>>();

export function renderPromptSection(
  manifest: RunManifest,
  prompt: PromptConfig,
  runId: string,
): HTMLElement {
  const outerDetails = el("details");
  outerDetails.appendChild(
    el("summary", {}, `${prompt.name} (${prompt.tags.join(", ")})`),
  );

  const content = el("div", { className: "details-content" });
  content.appendChild(el("p", { className: "muted small" }, prompt.description));

  const initialSamples = manifest.samples
    .filter((s) => s.promptId === prompt.id && s.stage === "initial")
    .sort((a, b) => a.model.localeCompare(b.model) || a.outputIndex - b.outputIndex);

  if (initialSamples.length === 0) {
    content.appendChild(el("p", { className: "muted" }, "No outputs."));
    outerDetails.appendChild(content);
    return outerDetails;
  }

  // Loading placeholder — replaced when content fetches
  const loadingEl = el("p", { className: "muted" }, "Loading...");
  content.appendChild(loadingEl);
  outerDetails.appendChild(content);

  let loaded = false;

  outerDetails.addEventListener("toggle", () => {
    if (!(outerDetails as HTMLDetailsElement).open || loaded) return;
    loaded = true;

    const loadPromise = (async () => {
      try {
        const promptData = await fetchPromptContent(runId, prompt.id);
        loadingEl.remove();
        renderPromptContent(content, manifest, prompt, promptData, initialSamples, runId);
      } catch (e) {
        loadingEl.textContent = `Failed to load: ${e instanceof Error ? e.message : String(e)}`;
      }
    })();

    promptLoadPromises.set(outerDetails, loadPromise);
  });

  return outerDetails;
}

/** Render the full prompt content (tabs, outputs, feedback, revisions). */
function renderPromptContent(
  content: HTMLElement,
  manifest: RunManifest,
  prompt: PromptConfig,
  promptData: PromptContent,
  initialSamples: SampleMeta[],
  runId: string,
): void {
  // Pre-compute judgment counts per sample for this prompt only,
  // using promptJudgmentSlices to avoid scanning all judgments.
  const judgmentCountBySample = new Map<string, number>();
  const slice = manifest.promptJudgmentSlices[prompt.id];
  if (slice) {
    for (let i = slice.start; i < slice.start + slice.count; i++) {
      const j = manifest.judgments[i];
      judgmentCountBySample.set(j.sampleA, (judgmentCountBySample.get(j.sampleA) ?? 0) + 1);
      judgmentCountBySample.set(j.sampleB, (judgmentCountBySample.get(j.sampleB) ?? 0) + 1);
    }
  }
  const useDropdown = initialSamples.length > 4;
  const panels = el("div");

  // Build labels for each sample
  const sampleLabels = initialSamples.map((sample) => {
    const sameModelCount = initialSamples.filter(
      (s) => s.model === sample.model,
    ).length;
    const suffix = sameModelCount > 1 ? ` #${sample.outputIndex + 1}` : "";
    return `${sample.model}${suffix}`;
  });

  function activatePanel(index: number): void {
    $$(".tab-content", panels).forEach((p) => p.classList.remove("active"));
    const tabId = `prompt-${prompt.id}-${index}`;
    $(`#${tabId}`, panels)?.classList.add("active");
  }

  let tabBar: HTMLElement;

  if (useDropdown) {
    const select = document.createElement("select");
    select.className = "model-select";
    for (let i = 0; i < sampleLabels.length; i++) {
      select.appendChild(new Option(sampleLabels[i], String(i)));
    }
    select.addEventListener("change", () => {
      activatePanel(Number(select.value));
    });
    tabBar = el("div", { className: "tabs tabs-dropdown" });
    tabBar.appendChild(select);
  } else {
    tabBar = el("div", { className: "tabs" });
    for (let i = 0; i < sampleLabels.length; i++) {
      const tab = el(
        "button",
        {
          className: i === 0 ? "tab active" : "tab",
          onClick: () => {
            $$(".tab", tabBar).forEach((t) => t.classList.remove("active"));
            tab.classList.add("active");
            activatePanel(i);
          },
        },
        sampleLabels[i],
      );
      tabBar.appendChild(tab);
    }
  }

  initialSamples.forEach((sample, i) => {
    const tabId = `prompt-${prompt.id}-${i}`;
    const sampleContent = promptData.samples[sample.id];

    const panel = el("div", {
      id: tabId,
      "data-sample-id": sample.id,
      className: i === 0 ? "tab-content active" : "tab-content",
    });

    // Initial output text
    panel.appendChild(el("div", { className: "output-text" }, sampleContent?.text ?? ""));
    panel.appendChild(sampleMetaEl(sample, sampleContent));

    // View judgments for initial output
    const initJudgmentCount = judgmentCountBySample.get(sample.id) ?? 0;
    if (initJudgmentCount > 0) {
      panel.appendChild(
        el(
          "button",
          {
            className: "view-judgments-btn",
            onClick: () => getJudgmentApi()?.focusSample(sample.id),
          },
          `view ${initJudgmentCount} judgments \u2192`,
        ),
      );
    }

    // Feedback on this output, with revisions nested
    const sampleFeedback = manifest.feedback
      .filter((f) => f.targetSampleId === sample.id)
      .sort((a, b) => a.sourceModel.localeCompare(b.sourceModel));

    for (const fb of sampleFeedback) {
      const fbDetails = el("details");
      fbDetails.appendChild(
        el("summary", {}, `Feedback from ${fb.sourceModel}`),
      );
      const fbInner = el("div", { className: "details-content" });

      const fbContent = promptData.feedback[fb.id];
      const fbBlock = el("div", { className: "feedback-text" });
      fbBlock.appendChild(document.createTextNode(fbContent?.text ?? ""));
      fbBlock.appendChild(feedbackMetaEl(fb, fbContent));
      fbInner.appendChild(fbBlock);

      // The revision the original writer made using this feedback
      const revision = manifest.samples.find(
        (s) =>
          s.stage === "revised" &&
          s.feedbackUsed === fb.id &&
          s.promptId === prompt.id,
      );
      if (revision) {
        const revContent = promptData.samples[revision.id];
        const revBlock = el("div", {
          className: "revision-nested",
          id: `sample-${revision.id}`,
        });
        revBlock.appendChild(
          el(
            "div",
            { className: "muted small" },
            `${revision.model}'s revision:`,
          ),
        );
        revBlock.appendChild(
          el("div", { className: "output-text" }, revContent?.text ?? ""),
        );
        revBlock.appendChild(sampleMetaEl(revision, revContent));

        // View judgments for revision
        const revJudgmentCount = judgmentCountBySample.get(revision.id) ?? 0;
        if (revJudgmentCount > 0) {
          revBlock.appendChild(
            el(
              "button",
              {
                className: "view-judgments-btn",
                onClick: () => getJudgmentApi()?.focusSample(revision.id),
              },
              `view ${revJudgmentCount} judgments \u2192`,
            ),
          );
        }

        fbInner.appendChild(revBlock);
      }

      fbDetails.appendChild(fbInner);
      panel.appendChild(fbDetails);
    }

    panels.appendChild(panel);
  });

  content.appendChild(tabBar);
  content.appendChild(panels);
}

// ── Navigation utilities ────────────────────────────

/** Open all ancestor <details> elements so the target is visible. */
export function openParentDetails(node: Element): void {
  let current = node.parentElement;
  while (current) {
    if (current.tagName === "DETAILS") {
      current.setAttribute("open", "");
    }
    current = current.parentElement;
  }
}

/**
 * Scroll to a sample's output in the prompt section, opening
 * the right details and activating the right tab.
 *
 * With lazy loading, the prompt section content may not be in the DOM
 * yet. This function opens the prompt <details> (triggering content
 * load), waits for it to complete, then scrolls.
 */
export async function scrollToSample(
  sampleId: string,
  manifest: RunManifest,
): Promise<void> {
  const sample = manifest.samples.find((s) => s.id === sampleId);
  if (!sample) return;

  const initialSamples = manifest.samples
    .filter((s) => s.promptId === sample.promptId && s.stage === "initial")
    .sort((a, b) => a.model.localeCompare(b.model) || a.outputIndex - b.outputIndex);

  // Find the prompt <details> and ensure it's open (which triggers lazy load)
  const promptDetails = $(`[data-prompt-id="${sample.promptId}"]`) as HTMLDetailsElement | null;
  if (promptDetails) {
    if (!promptDetails.open) promptDetails.open = true;
    const loadPromise = promptLoadPromises.get(promptDetails);
    if (loadPromise) await loadPromise;
  }

  let target: Element | null = null;

  if (sample.stage === "initial") {
    const tabIndex = initialSamples.findIndex((s) => s.id === sampleId);
    if (tabIndex === -1) return;
    const tabId = `prompt-${sample.promptId}-${tabIndex}`;
    const panel = $(`#${tabId}`);
    if (!panel) return;

    openParentDetails(panel);
    activateTab(panel, tabIndex);
    target = panel;
  } else {
    // Revised sample — find by id, activate the original's tab
    const revEl = $(`#sample-${sampleId}`);
    if (!revEl) return;

    openParentDetails(revEl);

    if (sample.originalSampleId) {
      const origIndex = initialSamples.findIndex(
        (s) => s.id === sample.originalSampleId,
      );
      if (origIndex !== -1) {
        const tabId = `prompt-${sample.promptId}-${origIndex}`;
        const panel = $(`#${tabId}`);
        if (panel) {
          activateTab(panel, origIndex);
        }
      }
    }
    target = revEl;
  }

  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("scroll-highlight");
    target.addEventListener(
      "animationend",
      () => target.classList.remove("scroll-highlight"),
      { once: true },
    );
  }
}

/** Activate the tab at `index` within the tab group containing `panel`. */
export function activateTab(panel: Element, index: number): void {
  const panelsContainer = panel.parentElement;
  if (!panelsContainer) return;
  const tabsBar = panelsContainer.previousElementSibling;
  if (tabsBar && tabsBar.classList.contains("tabs")) {
    // Dropdown mode — update the select value
    const select = $("select.model-select", tabsBar);
    if (select) {
      (select as HTMLSelectElement).value = String(index);
    }
    // Tab button mode — toggle active class
    $$(".tab", tabsBar).forEach((t, i) => {
      t.classList.toggle("active", i === index);
    });
  }
  $$(".tab-content", panelsContainer).forEach((p) =>
    p.classList.remove("active"),
  );
  panel.classList.add("active");
}
