import type { JudgeQualityEntry } from "./types.js";
import { el, formatWeight, formatBias, biasClass } from "./helpers.js";

// ── Judge Quality (Dashboard) ───────────────────────

export function renderDashboardJudgeQualitySection(
  entries: JudgeQualityEntry[],
  _title = "Judge Quality",
): HTMLElement | null {
  if (entries.length === 0) return null;
  const container = el("div");
  container.appendChild(renderJudgeQualityTable(entries));
  return container;
}

function renderJudgeQualityTable(entries: JudgeQualityEntry[]): HTMLElement {
  const table = el("table");

  const hasCi = entries.some((e) => e.ci95 != null && isFinite(e.ci95));
  const hasSelfBias = entries.some((e) => e.selfBias != null || e.selfBiasSufficient);
  const hasPosBias = entries.some((e) => e.positionBias != null || e.positionBiasSufficient);

  const headerCells = [
    el("th", { className: "rank" }, "#"),
    el("th", {}, "Judge"),
    el("th", {}, "Rating"),
  ];
  if (hasCi) {
    headerCells.push(el("th", {
      className: "ci ci-toggle",
      onClick: () => table.classList.toggle("show-ci-range"),
    }, "\u00b1CI"));
  }
  headerCells.push(el("th", {}, "W/L/T"));
  headerCells.push(el("th", {}, "Weight"));
  if (hasSelfBias) headerCells.push(el("th", {}, "Self Bias"));
  if (hasPosBias) headerCells.push(el("th", {}, "Pos Bias"));
  headerCells.push(el("th", {}, "Status"));

  table.appendChild(el("thead", {}, el("tr", {}, ...headerCells)));

  const tbody = el("tbody");
  entries.forEach((e, i) => {
    const ratingCls =
      i === 0
        ? "rating top"
        : i === entries.length - 1
          ? "rating bottom"
          : "rating";

    const rowCls = e.status === "pruned" ? "judge-row pruned" : "judge-row";

    const cells = [
      el("td", { className: "rank" }, String(i + 1)),
      el("td", {}, e.model),
      el("td", { className: ratingCls }, String(e.rating)),
    ];

    if (hasCi) {
      if (isFinite(e.ci95)) {
        const lo = Math.round(e.rating - e.ci95);
        const hi = Math.round(e.rating + e.ci95);
        cells.push(el("td", { className: "ci" },
          el("span", { className: "ci-pm" }, `\u00b1${e.ci95}`),
          el("span", { className: "ci-range" }, `${lo}\u2013${hi}`),
        ));
      } else {
        cells.push(el("td", { className: "ci" }, "-"));
      }
    }

    cells.push(el("td", { className: "wlt" }, `${e.wins}/${e.losses}/${e.ties}`));
    cells.push(el("td", { className: "muted" }, formatWeight(e.weight)));

    if (hasSelfBias) {
      cells.push(
        el("td", { className: biasClass(e.selfBias, e.selfBiasSufficient) },
          formatBias(e.selfBias, e.selfBiasSufficient)),
      );
    }

    if (hasPosBias) {
      cells.push(
        el("td", { className: biasClass(e.positionBias, e.positionBiasSufficient) },
          formatBias(e.positionBias, e.positionBiasSufficient)),
      );
    }

    const statusCls = e.status === "pruned" ? "bias-high" : "bias-low";
    cells.push(el("td", { className: statusCls }, e.status));

    tbody.appendChild(el("tr", { className: rowCls }, ...cells));
  });

  table.appendChild(tbody);
  const wrapper = el("div", { className: "table-scroll" });
  wrapper.appendChild(table);
  return wrapper;
}
