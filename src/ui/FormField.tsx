import type { ReactNode } from "react";
import { usePalette } from "./PaletteContext.js";

const LABEL_WIDTH = 24;

interface FormFieldProps {
  label: string;
  focused: boolean;
  children: ReactNode;
  hint?: string;
  /** Show "[Enter to edit]" hint when focused. */
  showEditHint?: boolean;
  /** Contextual help shown inline after the value when focused. */
  description?: string;
}

/**
 * Layout helper: renders a label + input in a horizontal row.
 * When focused, shows the description inline after the value.
 */
export function FormField({ label, focused, children, hint, showEditHint, description }: FormFieldProps) {
  const palette = usePalette();
  return (
    <box flexDirection="row">
      <box width={LABEL_WIDTH}>
        <text fg={focused ? palette.cyan : palette.gray}>{label}</text>
      </box>
      <box flexGrow={1} flexDirection="row">
        {children}
        {hint && !focused && (
          <box marginLeft={1}>
            <text fg={palette.gray}>{hint}</text>
          </box>
        )}
        {showEditHint && focused && (
          <box marginLeft={1}>
            <text fg={palette.gray}>[Enter to edit]</text>
          </box>
        )}
        {focused && description && !showEditHint && (
          <box marginLeft={2}>
            <text fg={palette.gray}>{description}</text>
          </box>
        )}
      </box>
    </box>
  );
}
