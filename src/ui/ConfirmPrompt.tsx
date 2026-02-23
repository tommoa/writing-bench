import { useKeyboard } from "@opentui/react";
import type { TerminalPalette } from "../types.js";

interface ConfirmPromptProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  palette: TerminalPalette;
}

/**
 * Inline y/n confirmation prompt. Handles keyboard input
 * internally -- `y` confirms, `n` or Escape cancels.
 */
export function ConfirmPrompt({ message, onConfirm, onCancel, palette }: ConfirmPromptProps) {
  useKeyboard((key) => {
    if (key.name === "y") onConfirm();
    else if (key.name === "n" || key.name === "escape") onCancel();
  });

  return (
    <box paddingLeft={1}>
      <text>
        <span fg={palette.yellow}>{message} </span>
        <span fg={palette.gray}>(y/n)</span>
      </text>
    </box>
  );
}
