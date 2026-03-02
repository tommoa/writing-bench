import type { IconData } from "./model-logos.generated.js";
import type { ModelInfo } from "./types.js";
import { ICONS, FAMILY_TO_ICON } from "./model-logos.generated.js";

const MODEL_LOGO_SPRITE_PATH = "model-logos.svg";

// ── Model Logo Helper ───────────────────────────────

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

function createSpriteSvg(symbolId: string, viewBox: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);

  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  const href = `${MODEL_LOGO_SPRITE_PATH}#${symbolId}`;
  use.setAttribute("href", href);
  use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
  svg.appendChild(use);

  return svg;
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
  lightEl.appendChild(createSpriteSvg(icon.lightId, icon.lightViewBox));
  container.appendChild(lightEl);

  // Mono icon (currentColor; visible by default, brand-color overlays on hover)
  if (icon.darkId) {
    const darkEl = document.createElement("span");
    darkEl.className = "model-logo-dark";
    darkEl.appendChild(
      createSpriteSvg(icon.darkId, icon.darkViewBox ?? icon.lightViewBox),
    );
    container.appendChild(darkEl);
  }

  return container;
}
