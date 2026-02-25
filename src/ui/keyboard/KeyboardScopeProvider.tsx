import { createContext, useContext, useMemo, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import type { KeyboardScopeRegistration } from "./types.js";
import { routeKey } from "./scope-router.js";

interface KeyboardScopeContextValue {
  registerScope: (scope: KeyboardScopeRegistration) => () => void;
}

const KeyboardScopeContext = createContext<KeyboardScopeContextValue | null>(null);

interface KeyboardScopeProviderProps {
  children: ReactNode;
}

export function KeyboardScopeProvider({ children }: KeyboardScopeProviderProps) {
  const scopesRef = useRef(new Map<string, KeyboardScopeRegistration>());

  const value = useMemo<KeyboardScopeContextValue>(() => ({
    registerScope(scope) {
      scopesRef.current.set(scope.id, scope);
      return () => {
        scopesRef.current.delete(scope.id);
      };
    },
  }), []);

  useKeyboard((key) => {
    routeKey([...scopesRef.current.values()], key);
  });

  return (
    <KeyboardScopeContext.Provider value={value}>
      {children}
    </KeyboardScopeContext.Provider>
  );
}

export function useKeyboardScopeContext(): KeyboardScopeContextValue {
  const context = useContext(KeyboardScopeContext);
  if (!context) {
    throw new Error("useKeyboardScope must be used within KeyboardScopeProvider");
  }
  return context;
}
