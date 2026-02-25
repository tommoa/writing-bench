import { describe, expect, it } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { routeKey } from "./scope-router.js";
import type { KeyboardScopeRegistration } from "./types.js";
import { KEYBOARD_SCOPE_PRIORITY } from "./types.js";

describe("routeKey", () => {
  it("routes to highest-priority enabled handler", () => {
    const calls: string[] = [];
    const scopes: KeyboardScopeRegistration[] = [
      makeScope("app", KEYBOARD_SCOPE_PRIORITY["app-global"], () => {
        calls.push("app");
        return "handled";
      }),
      makeScope("modal", KEYBOARD_SCOPE_PRIORITY.modal, () => {
        calls.push("modal");
        return "handled";
      }),
    ];

    const handled = routeKey(scopes, makeKey("1"));

    expect(handled).toBe(true);
    expect(calls).toEqual(["modal"]);
  });

  it("falls through when higher scope passes", () => {
    const calls: string[] = [];
    const scopes: KeyboardScopeRegistration[] = [
      makeScope("input", KEYBOARD_SCOPE_PRIORITY["input-edit"], () => {
        calls.push("input");
        return "pass";
      }),
      makeScope("app", KEYBOARD_SCOPE_PRIORITY["app-global"], () => {
        calls.push("app");
        return "handled";
      }),
    ];

    const handled = routeKey(scopes, makeKey("q"));

    expect(handled).toBe(true);
    expect(calls).toEqual(["input", "app"]);
  });

  it("skips disabled scopes", () => {
    const calls: string[] = [];
    const scopes: KeyboardScopeRegistration[] = [
      {
        ...makeScope("modal", KEYBOARD_SCOPE_PRIORITY.modal, () => {
          calls.push("modal");
          return "handled";
        }),
        enabled: () => false,
      },
      makeScope("app", KEYBOARD_SCOPE_PRIORITY["app-global"], () => {
        calls.push("app");
        return "handled";
      }),
    ];

    const handled = routeKey(scopes, makeKey("1"));

    expect(handled).toBe(true);
    expect(calls).toEqual(["app"]);
  });

  it("returns false when no scope handles key", () => {
    const scopes: KeyboardScopeRegistration[] = [
      makeScope("tab", KEYBOARD_SCOPE_PRIORITY["tab-local"], () => "pass"),
      makeScope("app", KEYBOARD_SCOPE_PRIORITY["app-global"], () => "pass"),
    ];

    const handled = routeKey(scopes, makeKey("x"));

    expect(handled).toBe(false);
  });
});

function makeScope(
  id: string,
  priority: number,
  onKey: KeyboardScopeRegistration["onKey"],
): KeyboardScopeRegistration {
  return {
    id,
    priority,
    enabled: () => true,
    onKey,
  };
}

function makeKey(name: string): KeyEvent {
  return {
    name,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    sequence: name,
    code: undefined,
    full: name,
    raw: name,
    eventType: "press",
    preventDefault: () => {},
    stopPropagation: () => {},
    defaultPrevented: false,
    propagationStopped: false,
  } as unknown as KeyEvent;
}
