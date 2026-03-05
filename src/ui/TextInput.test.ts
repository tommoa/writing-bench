import { describe, expect, it } from "bun:test";
import { getTextInputContainerProps, shouldForwardInputChange } from "./TextInput.js";

describe("getTextInputContainerProps", () => {
  it("uses explicit width when provided", () => {
    expect(getTextInputContainerProps(24)).toEqual({ width: 24 });
  });

  it("uses flex grow when width is omitted", () => {
    expect(getTextInputContainerProps()).toEqual({ flexGrow: 1 });
  });
});

describe("shouldForwardInputChange", () => {
  it("returns false when value is unchanged", () => {
    expect(shouldForwardInputChange("abc", "abc")).toBeFalse();
  });

  it("returns true when value changes", () => {
    expect(shouldForwardInputChange("abc", "abcd")).toBeTrue();
  });
});
