import * as vscode from "vscode";
import type { SidecarIssue } from "./sidecar-reader";

// ---------------------------------------------------------------------------
// DecorationManager
// Applies coloured squiggle underlines to section headings in .tex files,
// colour-coded by the worst-severity issue found in that section.
// Also renders gutter icons so issues are visible even when scrolled away.
// ---------------------------------------------------------------------------

// One decoration type per severity — created once and reused
const DEC_ERROR = vscode.window.createTextEditorDecorationType({
  // Wavy underline under the section heading
  textDecoration: "underline wavy #f44747",
  overviewRulerColor: "#f44747",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  gutterIconPath: undefined, // set dynamically via renderOptions if needed
  light: { textDecoration: "underline wavy #e51400" },
  dark:  { textDecoration: "underline wavy #f44747" },
});

const DEC_WARNING = vscode.window.createTextEditorDecorationType({
  textDecoration: "underline wavy #cca700",
  overviewRulerColor: "#cca700",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  light: { textDecoration: "underline wavy #bf8803" },
  dark:  { textDecoration: "underline wavy #cca700" },
});

const DEC_INFO = vscode.window.createTextEditorDecorationType({
  textDecoration: "underline wavy #3794ff",
  overviewRulerColor: "#3794ff",
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  light: { textDecoration: "underline wavy #0451a5" },
  dark:  { textDecoration: "underline wavy #3794ff" },
});

export type IssueWithSection = SidecarIssue & { sectionKey: string };

/** Map sidecar keys (e.g. sec-intro:lang) to extractor section ids for line lookup. */
export function baseSectionKeyForLineMap(sectionKey: string): string {
  if (
    sectionKey === "__document__" ||
    sectionKey === "__figures__" ||
    sectionKey === "__cross__"
  ) {
    return sectionKey;
  }
  return sectionKey.replace(/:(?:lang|stats)$/, "");
}

export class DecorationManager {
  private disposables: vscode.Disposable[] = [];

  // Apply decorations to a specific editor based on sidecar issues.
  // sectionLineMap: sectionId → 0-based line number of the \section{} command
  apply(
    editor: vscode.TextEditor,
    issues: IssueWithSection[],
    sectionLineMap: Map<string, number>
  ): void {
    const errors:   vscode.DecorationOptions[] = [];
    const warnings: vscode.DecorationOptions[] = [];
    const infos:    vscode.DecorationOptions[] = [];

    // Group issues by sectionKey so we can pick worst severity per section
    const bySectionKey = new Map<string, IssueWithSection[]>();
    for (const issue of issues) {
      if (!bySectionKey.has(issue.sectionKey)) bySectionKey.set(issue.sectionKey, []);
      bySectionKey.get(issue.sectionKey)!.push(issue);
    }

    for (const [sectionKey, sectionIssues] of bySectionKey) {
      const lineNum = sectionLineMap.get(baseSectionKeyForLineMap(sectionKey));
      if (lineNum === undefined) continue;

      const line = editor.document.lineAt(lineNum);
      const range = line.range;

      const worstSeverity = sectionIssues.some((i) => i.severity === "error")
        ? "error"
        : sectionIssues.some((i) => i.severity === "warning")
        ? "warning"
        : "info";

      const hoverMessages = sectionIssues.map((i) => {
        const icon = i.severity === "error" ? "$(error)" : i.severity === "warning" ? "$(warning)" : "$(info)";
        const policy =
          i.ruleId != null
            ? `\n\n_${(i.packId ?? "—").replace(/_/g, "\\_")} · \`${i.ruleId}\`_`
            : "";
        const md = new vscode.MarkdownString(
          `${icon} **[${i.id}]** ${i.message}${policy}\n\n→ ${i.suggestion}`
        );
        md.isTrusted = true;
        md.supportThemeIcons = true;
        return md;
      });

      const decOpts: vscode.DecorationOptions = {
        range,
        hoverMessage: hoverMessages,
      };

      if (worstSeverity === "error")        errors.push(decOpts);
      else if (worstSeverity === "warning") warnings.push(decOpts);
      else                                  infos.push(decOpts);
    }

    editor.setDecorations(DEC_ERROR,   errors);
    editor.setDecorations(DEC_WARNING, warnings);
    editor.setDecorations(DEC_INFO,    infos);
  }

  // Clear all decorations from an editor
  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(DEC_ERROR,   []);
    editor.setDecorations(DEC_WARNING, []);
    editor.setDecorations(DEC_INFO,    []);
  }

  dispose(): void {
    DEC_ERROR.dispose();
    DEC_WARNING.dispose();
    DEC_INFO.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// ---------------------------------------------------------------------------
// Parse the .tex source to find which line each \section{heading} is on.
// Returns a map from slug(heading) → 0-based line index.
// This mirrors the slugify logic in the CLI engine.
// ---------------------------------------------------------------------------

export function buildSectionLineMap(
  document: vscode.TextDocument
): Map<string, number> {
  const map = new Map<string, number>();
  const SECTION_RE = /^[^%\n]*\\(?:section|subsection|subsubsection|chapter)\s*\*?\s*\{([^}]+)\}/;
  const ABSTRACT_BEGIN = /\\begin\{abstract\}/;

  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;

    const abstractMatch = ABSTRACT_BEGIN.exec(text);
    if (abstractMatch) {
      map.set("sec-abstract", i);
      continue;
    }

    const sectionMatch = SECTION_RE.exec(text);
    if (sectionMatch) {
      const heading = stripLatex(sectionMatch[1]);
      const id = slugify(heading);
      map.set(id, i);
    }
  }

  return map;
}

function stripLatex(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1")
    .replace(/\{([^}]*)\}/g, "$1")
    .replace(/\\['"`.^~=|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(s: string): string {
  return "sec-" + s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
