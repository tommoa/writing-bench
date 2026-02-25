import type { KeyEvent } from "@opentui/core";
import { usePalette } from "./PaletteContext.js";
import { useKeyboardScope } from "./keyboard/use-keyboard-scope.js";
import { KEYBOARD_SCOPE_PRIORITY } from "./keyboard/types.js";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  /**
   * Optional validation: called before applying each keystroke.
   * Return true to accept the new text, false to reject it.
   * Not called for navigation keys (arrows, home/end) or submit/cancel.
   */
  validate?: (next: string) => boolean;
  placeholder?: string;
  focused?: boolean;
  /** Explicit width for the wrapper box. When omitted, uses flexGrow={1}. */
  width?: number;
}

/**
 * Single-line text input wrapper around OpenTUI's native `<input>`.
 * Keeps existing form semantics (submit/cancel/validate) while relying
 * on OpenTUI for editing behavior, cursor movement, and paste handling.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  validate,
  placeholder,
  focused = false,
  width,
}: TextInputProps) {
  const palette = usePalette();

  useKeyboardScope({
    priority: KEYBOARD_SCOPE_PRIORITY["input-edit"],
    enabled: focused,
    onKey: (key) => {
      if (key.name === "escape") {
        onCancel?.();
        return "handled";
      }

      if (!key.ctrl && !key.meta && !key.super && !key.hyper) {
        return "handled";
      }

      return "pass";
    },
  });

  function handleInput(next: string): void {
    if (validate && !validate(next)) {
      return;
    }
    onChange(next);
  }

  function handleSubmit(valueOrEvent: unknown): void {
    if (typeof valueOrEvent === "string") {
      onSubmit?.(valueOrEvent);
      return;
    }
    onSubmit?.(value);
  }

  function handleKeyDown(key: KeyEvent): void {
    if (key.name === "escape") {
      key.preventDefault();
    }
  }

  return (
    <box {...(width != null ? { width } : {})}>
      <input
        value={value}
        placeholder={placeholder}
        focused={focused}
        onInput={handleInput}
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        style={{
          backgroundColor: "transparent",
          focusedBackgroundColor: "transparent",
          textColor: palette.fg,
          focusedTextColor: palette.fg,
          placeholderColor: palette.gray,
        }}
      />
    </box>
  );
}
