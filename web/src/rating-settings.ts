import type { AlternativeRatings, RunManifest } from "./types.js";
import type { RatingMode, QualityMode } from "./state.js";
import { el } from "./helpers.js";
import {
  getRatingState,
  setRatingMode,
  setQualityMode,
  setJudgeDecay,
  toggleJudge,
  includeAllJudges,
  excludeAllJudges,
  toggleBiasCorrection,
  subscribeRating,
} from "./state.js";
import { DEFAULT_CONVERGENCE } from "../../src/types.js";

// ── Rating Settings ─────────────────────────────────

export interface RatingSettingsConfig {
  /** Pre-computed alternative rating sets. If absent, only "default" tab shown. */
  alternativeRatings?: AlternativeRatings;
  /** Run manifest (has judgments + samples). Omit for dashboard (no custom tab). */
  manifest?: RunManifest;
}

/**
 * Create a unified rating settings bar with optional custom panel.
 *
 * The returned element contains:
 * - A sticky tab bar (default / equal weights / no bias corr. / custom)
 * - A custom panel (judge pills, quality mode, decay, bias correction)
 *   that appears below the sticky bar when "custom" is active
 *
 * All controls write to the shared rating state in state.ts. Tables
 * subscribe to state changes independently.
 */
export function createRatingSettings(config: RatingSettingsConfig): HTMLElement {
  const wrapper = el("div", { className: "rating-settings" });

  // If no alternatives available, don't render any settings
  if (!config.alternativeRatings) return wrapper;

  let customPanel: HTMLElement | null = null;
  let customPanelCollapsed = false;

  // ── Sticky tab bar ──

  const bar = el("div", { className: "tabs" });

  const modes: Array<{ mode: RatingMode; label: string; needsManifest: boolean }> = [
    { mode: "default", label: "default", needsManifest: false },
    { mode: "equalWeight", label: "equal weights", needsManifest: false },
    { mode: "noBiasCorrection", label: "no bias corr.", needsManifest: false },
    { mode: "custom", label: "custom", needsManifest: true },
  ];

  const tabButtons: HTMLElement[] = [];

  for (const { mode, label, needsManifest } of modes) {
    // Hide Custom tab on dashboard (no manifest)
    if (needsManifest && !config.manifest) continue;

    const state = getRatingState();
    const btn = el("button", {
      className: mode === state.ratingMode ? "tab active" : "tab",
      onClick: () => {
        // Re-clicking the active custom tab toggles the panel
        if (mode === "custom" && getRatingState().ratingMode === "custom" && customPanel) {
          customPanelCollapsed = !customPanelCollapsed;
          customPanel.style.display = customPanelCollapsed ? "none" : "";
          return;
        }
        setRatingMode(mode);
      },
    }, label);
    tabButtons.push(btn);
    bar.appendChild(btn);
  }

  wrapper.appendChild(bar);

  // ── Tab description (updates reactively) ──

  const TAB_DESCRIPTIONS: Record<RatingMode, string> = {
    default:
      "Judges weighted by estimated reliability, with position-bias correction.",
    equalWeight:
      "All judges treated equally -- no quality weighting or bias correction.",
    noBiasCorrection:
      "Judges weighted by reliability, without position-bias correction.",
    custom:
      "Customize judge inclusion, quality weighting, and bias correction.",
  };

  // Anchors validated at build time by build-methodology.ts REQUIRED_ANCHORS.
  // If you add a new anchor here, add it to REQUIRED_ANCHORS in build-methodology.ts.
  const TAB_METHODOLOGY_LINKS: Record<RatingMode, string> = {
    default: "methodology.html#judge-quality-estimation",
    equalWeight: "methodology.html#judge-quality-estimation",
    noBiasCorrection: "methodology.html#position-bias-mitigation",
    custom: "methodology.html#judge-quality-estimation",
  };

  const initMode = getRatingState().ratingMode;
  const descText = document.createTextNode(TAB_DESCRIPTIONS[initMode] + " ");
  const learnMoreLink = el("a", { href: TAB_METHODOLOGY_LINKS[initMode] }, "Learn more");
  const descEl = el("p", { className: "section-desc" });
  descEl.appendChild(descText);
  descEl.appendChild(learnMoreLink);
  wrapper.appendChild(descEl);

  // ── Custom panel (below sticky bar, scrolls normally) ──

  function buildCustomPanel(): HTMLElement {
    const panel = el("div", { className: "custom-panel" });
    const manifest = config.manifest!;

    const judgeLabels = [...new Set(manifest.judgments.map((j) => j.judgeModel))];

    // ── Row 1: Judge pills ──

    if (judgeLabels.length > 1) {
      const header = el("div", { className: "custom-header" });
      const headerLeft = el("span", {},
        el("span", { className: "label" }, "judges"),
        el("span", { className: "custom-row-desc" },
          " \u2014 include or exclude individual judges from the rating computation",
        ),
      );
      header.appendChild(headerLeft);

      const quickToggles = el("span", {});
      const allBtn = el("button", {
        className: "quick-toggle",
        onClick: () => {
          includeAllJudges();
          for (const pill of judgePills) pill.classList.remove("excluded");
        },
      }, "all");
      const separator = el("span", { className: "separator" }, "\u00b7");
      const noneBtn = el("button", {
        className: "quick-toggle",
        onClick: () => {
          excludeAllJudges(judgeLabels);
          for (const pill of judgePills) pill.classList.add("excluded");
        },
      }, "none");
      quickToggles.appendChild(allBtn);
      quickToggles.appendChild(separator);
      quickToggles.appendChild(noneBtn);
      header.appendChild(quickToggles);
      panel.appendChild(header);

      const pillContainer = el("div", { className: "judge-pills" });
      const judgePills: HTMLElement[] = [];

      for (const judge of judgeLabels) {
        const state = getRatingState();
        const pill = el("button", {
          className: state.excludedJudges.has(judge) ? "judge-pill excluded" : "judge-pill",
          onClick: () => {
            toggleJudge(judge);
            pill.classList.toggle("excluded");
          },
        }, judge);
        judgePills.push(pill);
        pillContainer.appendChild(pill);
      }
      panel.appendChild(pillContainer);
    }

    // ── Row 2: Quality mode pills ──

    const modeHeader = el("div", { className: "custom-header" });
    modeHeader.appendChild(el("span", {},
      el("span", { className: "label" }, "quality mode"),
      el("span", { className: "custom-row-desc" },
        " \u2014 how judge reliability is estimated. Consensus uses " +
        "cross-evaluation majority vote; others use the judge's own Elo",
      ),
    ));
    panel.appendChild(modeHeader);

    const modeContainer = el("div", { className: "mode-pills" });
    const qualityModes: QualityMode[] = ["consensus", "writing", "feedback", "revised"];
    const modePills: HTMLElement[] = [];

    for (const mode of qualityModes) {
      const state = getRatingState();
      const pill = el("button", {
        className: mode === state.qualityMode ? "mode-pill active" : "mode-pill",
        onClick: () => {
          setQualityMode(mode);
          for (const p of modePills) p.classList.remove("active");
          pill.classList.add("active");
        },
      }, mode);
      modePills.push(pill);
      modeContainer.appendChild(pill);
    }
    panel.appendChild(modeContainer);

    // ── Row 3: Decay slider ──

    const initState = getRatingState();

    const decayHeader = el("div", { className: "custom-header" });
    decayHeader.appendChild(el("span", {},
      el("span", { className: "label" }, "quality decay"),
      el("span", { className: "custom-row-desc" },
        " \u2014 how sharply lower-rated judges are down-weighted. " +
        "Lower half-life = more aggressive",
      ),
    ));
    panel.appendChild(decayHeader);

    const decayRow = el("div", { className: "decay-row" });

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.005";
    slider.max = "0.06";
    slider.step = "0.001";
    slider.value = String(initState.judgeDecay);

    const valueDisplay = el("span", { className: "decay-value" },
      `${initState.judgeDecay.toFixed(3)}  half-life: ${Math.round(Math.LN2 / initState.judgeDecay)} elo`);

    slider.addEventListener("input", () => {
      const k = parseFloat(slider.value);
      const halfLife = Math.round(Math.LN2 / k);
      valueDisplay.textContent = `${k.toFixed(3)}  half-life: ${halfLife} elo`;
      setJudgeDecay(k);
    });

    decayRow.appendChild(slider);
    decayRow.appendChild(valueDisplay);
    panel.appendChild(decayRow);

    // ── Row 4: Bias correction pill ──

    const biasRow = el("div", { className: "bias-row" });
    const biasPill = el("button", {
      className: initState.applyBiasCorrection ? "bias-pill active" : "bias-pill",
      onClick: () => {
        toggleBiasCorrection();
        const s = getRatingState();
        biasPill.className = s.applyBiasCorrection ? "bias-pill active" : "bias-pill";
        biasPill.textContent = s.applyBiasCorrection ? "\u2713 bias correction" : "bias correction";
      },
    }, initState.applyBiasCorrection ? "\u2713 bias correction" : "bias correction");
    biasRow.appendChild(biasPill);
    biasRow.appendChild(el("span", { className: "custom-row-desc" },
      "Adjusts judgment weights to compensate for remaining " +
      "position bias after randomization.",
    ));
    panel.appendChild(biasRow);

    return panel;
  }

  // ── Subscribe to state for tab bar + custom panel sync ──

  subscribeRating(() => {
    const s = getRatingState();

    // Update tab active states
    let i = 0;
    for (const { mode, needsManifest } of modes) {
      if (needsManifest && !config.manifest) continue;
      const btn = tabButtons[i];
      if (btn) {
        if (mode === s.ratingMode) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      }
      i++;
    }

    // Update tab description text and link
    descText.textContent = TAB_DESCRIPTIONS[s.ratingMode] + " ";
    learnMoreLink.setAttribute("href", TAB_METHODOLOGY_LINKS[s.ratingMode]);

    // Show/hide custom panel
    if (config.manifest) {
      if (s.ratingMode === "custom") {
        if (!customPanel) {
          customPanel = buildCustomPanel();
          descEl.after(customPanel);
        }
        customPanel.style.display = customPanelCollapsed ? "none" : "";
      } else if (customPanel) {
        customPanelCollapsed = false;
        customPanel.style.display = "none";
      }
    }
  });

  return wrapper;
}
