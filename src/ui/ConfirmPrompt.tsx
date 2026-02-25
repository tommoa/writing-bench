import { usePalette } from "./PaletteContext.js";
import { useKeyboardScope } from "./keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "./keyboard/types.js";

interface ConfirmPromptProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Inline y/n confirmation prompt. Handles keyboard input
 * internally -- `y` confirms, `n` or Escape cancels.
 */
export function ConfirmPrompt({ message, onConfirm, onCancel }: ConfirmPromptProps) {
  const palette = usePalette();
  useKeyboardScope({
    id: `confirm:${message}`,
    priority: KEYBOARD_SCOPE_PRIORITY.confirm,
    enabled: true,
    onKey: (key) => {
      if (key.name === "y") {
        onConfirm();
        return "handled";
      }
      if (key.name === "n" || key.name === "escape") {
        onCancel();
        return "handled";
      }
      return "pass";
    },
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
