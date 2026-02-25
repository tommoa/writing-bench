import { usePalette } from "./PaletteContext.js";

interface RunProgressProps {
  progress: number;
  opsDone: number;
  width?: number;
}

export function RunProgress({ progress, opsDone, width = 40 }: RunProgressProps) {
  const palette = usePalette();
  const clamped = Math.min(1, Math.max(0, progress));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const expectedOps = clamped > 0.01
    ? Math.round(opsDone / clamped)
    : undefined;

  const opsLabel = expectedOps != null
    ? `${opsDone}/~${expectedOps} ops`
    : `${opsDone} ops`;

  return (
    <box>
      <text>
        <span fg={palette.green}>{"█".repeat(filled)}</span>
        <span fg={palette.gray}>{"░".repeat(empty)}</span>
        <span fg={palette.gray}>{"  "}{Math.round(clamped * 100)}%{"  "}{opsLabel}</span>
      </text>
    </box>
  );
}
