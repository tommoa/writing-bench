import type { TabSelectKeyBinding, TabSelectOption, TabSelectRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { usePalette } from "./PaletteContext.js";

interface SelectInputProps<T extends string> {
  value: T;
  options: readonly T[];
  labels?: Partial<Record<T, string>>;
  onChange: (value: T) => void;
  focused?: boolean;
}

/** Inline enum selector showing all options with the active one highlighted. */
export function SelectInput<T extends string>({
  value,
  options,
  labels,
  onChange,
  focused = false,
}: SelectInputProps<T>) {
  const palette = usePalette();
  const selectRef = useRef<TabSelectRenderable | null>(null);
  const selectedIndex = Math.max(0, options.indexOf(value));

  const tabOptions = useMemo<TabSelectOption[]>(
    () => options.map((option) => ({
      name: labels?.[option] ?? option,
      description: "",
      value: option,
    })),
    [options, labels],
  );

  const tabWidth = useMemo(
    () => Math.max(8, ...tabOptions.map((option) => option.name.length + 2)),
    [tabOptions],
  );

  const keyBindings: TabSelectKeyBinding[] = useMemo(
    () => [
      { name: "h", action: "move-left" },
      { name: "l", action: "move-right" },
    ],
    [],
  );

  useEffect(() => {
    const current = selectRef.current;
    if (!current) {
      return;
    }
    if (current.getSelectedIndex() !== selectedIndex) {
      current.setSelectedIndex(selectedIndex);
    }
  }, [selectedIndex]);

  function handleChange(_index: number, option: TabSelectOption | null): void {
    if (!option) {
      return;
    }
    if (typeof option.value !== "string") {
      return;
    }
    onChange(option.value as T);
  }

  return (
    <box width={tabOptions.length * tabWidth}>
      <tab-select
        ref={selectRef}
        options={tabOptions}
        tabWidth={tabWidth}
        focused={focused}
        showDescription={false}
        showUnderline={false}
        showScrollArrows={false}
        wrapSelection={false}
        keyBindings={keyBindings}
        onChange={handleChange}
        style={{
          backgroundColor: "transparent",
          focusedBackgroundColor: "transparent",
          textColor: palette.gray,
          focusedTextColor: palette.gray,
          selectedBackgroundColor: "transparent",
          selectedTextColor: focused ? palette.cyan : palette.fg,
          selectedDescriptionColor: palette.gray,
        }}
      />
    </box>
  );
}
