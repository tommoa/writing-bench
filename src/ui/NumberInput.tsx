import { useState, useCallback, useEffect } from "react";
import { TextInput } from "./TextInput.js";

/** Pattern for valid numeric text (including intermediate states like "0." or "-"). */
const FLOAT_PATTERN = /^-?(\d+\.?\d*)?$/;
const INT_PATTERN = /^-?\d*$/;

interface NumberInputProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  allowFloat?: boolean;
  placeholder?: string;
  focused?: boolean;
}

/**
 * Numeric input with local display state to support intermediate text
 * like "0." or "-" during float entry. Uses TextInput's validate
 * callback to reject non-numeric characters at the keystroke level.
 *
 * Range validation (min/max) is intentionally omitted here -- use
 * form-level validation at submit time instead, so the display always
 * matches the committed form state.
 */
export function NumberInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  allowFloat = true,
  placeholder,
  focused = false,
}: NumberInputProps) {
  // Local display text to handle intermediate states like "0." or "-"
  const [displayValue, setDisplayValue] = useState(
    value != null ? String(value) : "",
  );

  // Sync display when parent's numeric value changes externally.
  useEffect(() => {
    setDisplayValue(value != null ? String(value) : "");
  }, [value]);

  const validate = useCallback(
    (text: string): boolean => {
      if (text === "" || text === "-") return true;
      const pattern = allowFloat ? FLOAT_PATTERN : INT_PATTERN;
      return pattern.test(text);
    },
    [allowFloat],
  );

  function handleChange(text: string) {
    setDisplayValue(text);
    if (text === "" || text === "-") {
      onChange(undefined);
      return;
    }
    // Intermediate float state like "0." -- display it but don't
    // commit a numeric value yet
    if (allowFloat && text.endsWith(".")) return;
    const num = allowFloat ? parseFloat(text) : parseInt(text, 10);
    if (isNaN(num)) return;
    onChange(num);
  }

  return (
    <TextInput
      value={displayValue}
      onChange={handleChange}
      validate={validate}
      onSubmit={onSubmit ? () => onSubmit() : undefined}
      onCancel={onCancel}
      placeholder={placeholder}
      focused={focused}
      width={12}
    />
  );
}
