/**
 * Build-time script: converts METHODOLOGY.md to a standalone
 * methodology.html page. LaTeX math ($...$ and $$...$$) is rendered
 * to HTML at build time via KaTeX.
 *
 * Usage: bun web/src/build-methodology.ts
 */
import { readFile, writeFile } from "fs/promises";
import { Marked } from "marked";
import katex from "katex";

const MD_PATH = new URL("../../METHODOLOGY.md", import.meta.url).pathname;
const HTML_OUT_PATH = new URL("../methodology.html", import.meta.url).pathname;
const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/katex.min.css";

const md = await readFile(MD_PATH, "utf-8");

// ── KaTeX rendering ────────────────────────────────

/** Render a LaTeX string to HTML via KaTeX. */
function renderLatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: "html",
    });
  } catch {
    // Fall back to escaped raw LaTeX if rendering fails
    return `<code>${escapeHtml(latex)}</code>`;
  }
}

/**
 * Extract LaTeX delimiters from raw Markdown, replacing them with
 * placeholders so that `marked` does not HTML-escape characters like
 * `<` inside math expressions. After marked runs, the placeholders are
 * swapped for KaTeX-rendered HTML via `restoreMath`.
 */
const mathStore: { placeholder: string; latex: string; display: boolean }[] = [];

function extractMath(markdown: string): string {
  // Display math: $$...$$
  markdown = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex: string) => {
    const id = mathStore.length;
    const placeholder = `%%MATH:${id}%%`;
    mathStore.push({ placeholder, latex: latex.trim(), display: true });
    return placeholder;
  });

  // Inline math: $...$  (not preceded/followed by $)
  markdown = markdown.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g, (_, latex: string) => {
    const id = mathStore.length;
    const placeholder = `%%MATH:${id}%%`;
    mathStore.push({ placeholder, latex: latex.trim(), display: false });
    return placeholder;
  });

  return markdown;
}

function restoreMath(html: string): string {
  for (const { placeholder, latex, display } of mathStore) {
    const rendered = renderLatex(latex, display);
    html = html.replace(placeholder, () => rendered);
  }
  return html;
}

// ── Custom Marked renderer ─────────────────────────

const marked = new Marked();

marked.use({
  renderer: {
    // Map blockquotes to <p class="note">
    blockquote({ text }: { text: string }) {
      // Strip wrapping <p> tags that marked adds inside blockquotes
      const inner = text.replace(/^<p>/, "").replace(/<\/p>\s*$/, "");
      return `<p class="note">${inner}</p>\n`;
    },
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const mdWithPlaceholders = extractMath(md);
const rawHtml = await marked.parse(mdWithPlaceholders);
const methodologyHtml = restoreMath(rawHtml);

// ── Generate standalone HTML page ──────────────────

const fullPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>methodology — writing-bench</title>
  <link rel="stylesheet" href="style.css">
  <link rel="stylesheet" href="${KATEX_CSS_URL}">
</head>
<body>
  <h1>writing-bench</h1>
  <p class="muted">LLM writing quality benchmark</p>

  <nav class="nav">
    <a href="index.html">leaderboard</a>
    <a href="index.html?page=runs">runs</a>
    <a href="methodology.html" class="active">methodology</a>
    <a href="https://github.com/tommoa/writing-bench" target="_blank" rel="noopener noreferrer" class="nav-github">github</a>
  </nav>

  <div id="app">
    <div class="methodology">
${methodologyHtml}
    </div>
  </div>
</body>
</html>
`;

await writeFile(HTML_OUT_PATH, fullPage, "utf-8");
console.log(`wrote ${HTML_OUT_PATH}`);
