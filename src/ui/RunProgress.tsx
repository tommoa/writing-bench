import { usePalette } from "./PaletteContext.js";
import { truncate } from "./format-utils.js";

interface RunProgressProps {
  progress: number;
  opsDone: number;
  width?: number;
  /** Available width in columns for this row. */
  contentWidth?: number;
}

export function RunProgress({ progress, opsDone, width = 40, contentWidth }: RunProgressProps) {
  const palette = usePalette();
  const clamped = Math.min(1, Math.max(0, progress));
  const expectedOps = clamped > 0.01
    ? Math.round(opsDone / clamped)
    : undefined;

  const rawOpsLabel = expectedOps != null
    ? `${opsDone}/~${expectedOps} ops`
    : `${opsDone} ops`;
  const pctLabel = `${Math.round(clamped * 100)}%`;

  const maxLineWidth = contentWidth != null && Number.isFinite(contentWidth)
    ? Math.max(0, contentWidth - 2)
    : undefined;

  let barWidth = width;
  let opsLabel = rawOpsLabel;

  if (maxLineWidth != null) {
    const minWithBarAndPct = pctLabel.length + 2;
    barWidth = maxLineWidth > minWithBarAndPct
      ? Math.min(width, maxLineWidth - minWithBarAndPct)
      : 0;

    const remaining = maxLineWidth - (barWidth > 0 ? barWidth + 2 + pctLabel.length : pctLabel.length);
    opsLabel = remaining >= 3 ? truncate(rawOpsLabel, Math.max(1, remaining - 2)) : "";
  }

  const parts: string[] = [];
  if (barWidth > 0) {
    parts.push(`${"█".repeat(Math.round(clamped * barWidth))}${"░".repeat(barWidth - Math.round(clamped * barWidth))}`);
  }
  parts.push(pctLabel);
  if (opsLabel.length > 0) {
    parts.push(opsLabel);
  }
  const lineText = parts.join("  ");
  const lineWidth = maxLineWidth != null ? Math.min(maxLineWidth, lineText.length) : lineText.length;

  const filled = Math.round(clamped * barWidth);
  const empty = barWidth - filled;

  return (
    <box height={1} width={lineWidth} flexShrink={0}>
      <text>
        {barWidth > 0 && (
          <>
            <span fg={palette.green}>{"█".repeat(filled)}</span>
            <span fg={palette.gray}>{"░".repeat(empty)}</span>
            <span fg={palette.gray}>{"  "}</span>
          </>
        )}
        <span fg={palette.gray}>{pctLabel}</span>
        {opsLabel.length > 0 && <span fg={palette.gray}>{"  "}{opsLabel}</span>}
      </text>
    </box>
  );
}
