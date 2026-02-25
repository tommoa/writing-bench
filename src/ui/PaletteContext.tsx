import { createContext, useContext } from "react";
import type { TerminalPalette } from "../types.js";

const PaletteContext = createContext<TerminalPalette | null>(null);

/** Wrap the component tree to provide the terminal palette. */
export const PaletteProvider = PaletteContext.Provider;

/** Access the terminal palette from any component in the tree. */
export function usePalette(): TerminalPalette {
  const palette = useContext(PaletteContext);
  if (!palette) throw new Error("usePalette() used outside <PaletteProvider>");
  return palette;
}
