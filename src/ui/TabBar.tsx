import type { TabId } from "./state.js";
import { usePalette } from "./PaletteContext.js";

interface TabBarProps {
  activeTab: TabId;
}

const TABS: Array<{ id: TabId; key: string; label: string }> = [
  { id: "benchmark", key: "1", label: "Benchmark" },
  { id: "cache", key: "2", label: "Cache" },
  { id: "runs", key: "3", label: "Runs" },
];

export function TabBar({ activeTab }: TabBarProps) {
  const palette = usePalette();
  return (
    <box paddingLeft={1} marginBottom={1}>
      <text>
        {TABS.map((tab, i) => {
          const active = tab.id === activeTab;
          return (
            <span key={tab.id}>
              {i > 0 && <span fg={palette.gray}>  </span>}
              <span
                fg={active ? palette.cyan : palette.gray}
                attributes={active ? 1 : 0}
              >
                [{tab.key}] {tab.label}
              </span>
            </span>
          );
        })}
      </text>
    </box>
  );
}
