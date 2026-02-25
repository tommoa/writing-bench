import type { TabSelectKeyBinding, TabSelectOption, TabSelectRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { usePalette } from "./PaletteContext.js";

interface ToggleInputProps {
  value: boolean;
  onChange: (value: boolean) => void;
  focused?: boolean;
}

/** Boolean toggle -- press space or enter to flip. */
export function ToggleInput({ value, onChange, focused = false }: ToggleInputProps) {
  const palette = usePalette();
  const toggleRef = useRef<TabSelectRenderable | null>(null);
  const selectedIndex = value ? 1 : 0;

  const options = useMemo<TabSelectOption[]>(
    () => [
      { name: "OFF", description: "", value: false },
      { name: "ON", description: "", value: true },
    ],
    [],
  );

  const keyBindings: TabSelectKeyBinding[] = useMemo(
    () => [
      { name: "space", action: "move-right" },
      { name: "return", action: "move-right" },
      { name: "linefeed", action: "move-right" },
      { name: "h", action: "move-left" },
      { name: "l", action: "move-right" },
    ],
    [],
  );

  useEffect(() => {
    const current = toggleRef.current;
    if (!current) {
      return;
    }
    if (current.getSelectedIndex() !== selectedIndex) {
      current.setSelectedIndex(selectedIndex);
    }
  }, [selectedIndex]);

  function handleChange(_index: number, option: TabSelectOption | null): void {
    if (!option || typeof option.value !== "boolean") {
      return;
    }
    onChange(option.value);
  }

  const selectedColor = focused
    ? (value ? palette.green : palette.red)
    : palette.gray;

  return (
    <box width={12}>
      <tab-select
        ref={toggleRef}
        options={options}
        tabWidth={6}
        focused={focused}
        showDescription={false}
        showUnderline={false}
        showScrollArrows={false}
        wrapSelection={true}
        keyBindings={keyBindings}
        onChange={handleChange}
        style={{
          backgroundColor: "transparent",
          focusedBackgroundColor: "transparent",
          textColor: palette.gray,
          focusedTextColor: palette.gray,
          selectedBackgroundColor: "transparent",
          selectedTextColor: selectedColor,
          selectedDescriptionColor: palette.gray,
        }}
      />
    </box>
  );
}
