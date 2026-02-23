import type { IconData } from "./model-logos.generated.js";
import type { ModelInfo } from "./types.js";
import { ICONS, FAMILY_TO_ICON } from "./model-logos.generated.js";

// ── Model Logo Helper ───────────────────────────────

let logoUid = 0;

/** Reset the SVG ID counter. Call on page navigation to prevent unbounded growth. */
export function resetLogoUids(): void {
  logoUid = 0;
}

/** Build a label -> family map from a modelInfo record. */
export function buildModelFamilies(
  modelInfo: Record<string, ModelInfo> | undefined,
): Record<string, string> {
  const families: Record<string, string> = {};
  if (!modelInfo) return families;
  for (const [label, info] of Object.entries(modelInfo)) {
    if (info.family) families[label] = info.family;
  }
  return families;
}

/**
 * Uniquify SVG id/url(#id) references so that multiple instances of
 * the same logo on a page don't share gradient/mask IDs.
 */
function uniquifySvgIds(svg: string): string {
  // Collect all id="..." values
  const ids = new Set<string>();
  svg.replace(/\bid="([^"]+)"/g, (_, id) => { ids.add(id); return _; });
  if (ids.size === 0) return svg;

  const suffix = `_${logoUid++}`;
  let result = svg;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Replace id="X" and all url(#X) / href="#X" references
    result = result.replace(
      new RegExp(`(id="|url\\(#|href="#)${escaped}(?="|\\))`, "g"),
      `$1${id}${suffix}`,
    );
  }
  return result;
}

/**
 * Create an inline SVG logo element for a model family.
 *
 * Takes the family string directly (from ModelInfo.family or
 * RunsIndex.modelFamilies). Returns null if no icon is available,
 * so callers can pass the result to el() which ignores null children.
 */
export function modelLogo(
  family: string | undefined,
  size?: number,
): HTMLElement | null {
  if (!family) return null;

  const iconKey = FAMILY_TO_ICON[family];
  if (!iconKey) return null;

  const icon: IconData | undefined = ICONS[iconKey];
  if (!icon) return null;

  const px = size ?? 16;
  const container = document.createElement("span");
  container.className = "model-logo";
  container.style.width = `${px}px`;
  container.style.height = `${px}px`;

  // Brand-color icon (fades in on hover in leaderboard rows; always visible in cards)
  const lightEl = document.createElement("span");
  lightEl.className = "model-logo-light";
  lightEl.innerHTML = uniquifySvgIds(icon.light);
  container.appendChild(lightEl);

  // Mono icon (currentColor; visible by default, brand-color overlays on hover)
  if (icon.dark) {
    const darkEl = document.createElement("span");
    darkEl.className = "model-logo-dark";
    darkEl.innerHTML = uniquifySvgIds(icon.dark);
    container.appendChild(darkEl);
  }

  return container;
}
