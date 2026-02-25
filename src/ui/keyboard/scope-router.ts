import type { KeyEvent } from "@opentui/core";
import type { KeyboardScopeRegistration } from "./types.js";

export function routeKey(
  scopes: KeyboardScopeRegistration[],
  key: KeyEvent,
): boolean {
  const ordered = [...scopes].sort((a, b) => b.priority - a.priority);

  for (const scope of ordered) {
    if (!scope.enabled()) {
      continue;
    }
    if (scope.onKey(key) === "handled") {
      return true;
    }
  }

  return false;
}
