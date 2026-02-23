import type { TabId } from "./state.js";
import type { TerminalPalette } from "../types.js";

interface TabBarProps {
  activeTab: TabId;
  palette: TerminalPalette;
}

const TABS: Array<{ id: TabId; key: string; label: string }> = [
  { id: "benchmark", key: "1", label: "Benchmark" },
  { id: "cache", key: "2", label: "Cache" },
  { id: "runs", key: "3", label: "Runs" },
];

export function TabBar({ activeTab, palette }: TabBarProps) {
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
