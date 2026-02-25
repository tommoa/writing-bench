import { useEffect, useId, useRef } from "react";
import type { KeyEvent } from "@opentui/core";
import { useKeyboardScopeContext } from "./KeyboardScopeProvider.js";
import type { KeyHandlerResult } from "./types.js";

interface UseKeyboardScopeOptions {
  id?: string;
  priority: number;
  enabled: boolean;
  onKey: (key: KeyEvent) => KeyHandlerResult;
}

export function useKeyboardScope({
  id,
  priority,
  enabled,
  onKey,
}: UseKeyboardScopeOptions): void {
  const stableId = useId();
  const registrationId = id ?? stableId;
  const { registerScope } = useKeyboardScopeContext();

  const enabledRef = useRef(enabled);
  const onKeyRef = useRef(onKey);
  enabledRef.current = enabled;
  onKeyRef.current = onKey;

  useEffect(() => {
    return registerScope({
      id: registrationId,
      priority,
      enabled: () => enabledRef.current,
      onKey: (key) => onKeyRef.current(key),
    });
  }, [registerScope, registrationId, priority]);
}
