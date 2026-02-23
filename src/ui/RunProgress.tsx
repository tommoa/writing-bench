import type { TerminalPalette } from "../types.js";

interface RunProgressProps {
  progress: number;
  opsDone: number;
  palette: TerminalPalette;
  width?: number;
}

export function RunProgress({ progress, opsDone, palette, width = 40 }: RunProgressProps) {
  const clamped = Math.min(1, Math.max(0, progress));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const expectedOps = clamped > 0.01
    ? Math.round(opsDone / clamped)
    : undefined;

  return (
    <box flexDirection="row">
      <text fg={palette.green}>{"█".repeat(filled)}</text>
      <text fg={palette.gray}>{"░".repeat(empty)}</text>
      <text fg={palette.gray}>
        {"  "}
        {Math.round(clamped * 100)}%{"  "}
        {expectedOps != null
          ? `${opsDone}/~${expectedOps} ops`
          : `${opsDone} ops`}
      </text>
    </box>
  );
}
