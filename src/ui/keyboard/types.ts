import type { KeyEvent } from "@opentui/core";

export type KeyHandlerResult = "handled" | "pass";

export type KeyboardScopeId =
  | "emergency"
  | "modal"
  | "confirm"
  | "input-edit"
  | "tab-local"
  | "app-global";

export const KEYBOARD_SCOPE_PRIORITY: Record<KeyboardScopeId, number> = {
  emergency: 100,
  modal: 90,
  confirm: 80,
  "input-edit": 70,
  "tab-local": 60,
  "app-global": 50,
};

export interface KeyboardScopeRegistration {
  id: string;
  priority: number;
  enabled: () => boolean;
  onKey: (key: KeyEvent) => KeyHandlerResult;
}
