import type { Section, Issue } from "../../types/index.js";

// ---------------------------------------------------------------------------
// figure-check (scope: document — needs all sections to cross-reference)
// Checks: figures/tables referenced but not defined, figures defined but
// never referenced, missing captions, caption quality, label/ref mismatches.
// ---------------------------------------------------------------------------

const VERSION = "1.0.0";

export interface FigureCheckOutput {
  skill: "figure-check";
  version: string;
  issues: Issue[];
  summary: string;
}

interface FloatInfo {
  kind: "figure" | "table" | "algorithm" | "listing";
  label: string | null;
  hasCaption: boolean;
  captionLength: number; // word count
  sectionId: string;
  lineApprox: number;
}

// ---------------------------------------------------------------------------
// Main entry point — receives all sections (document scope)
// ---------------------------------------------------------------------------

export function runFigureCheck(sections: Section[]): FigureCheckOutput {
  const issues: Issue[] = [];
  let counter = 0;
  const nextId = () => `fig-${String(++counter).padStart(3, "0")}`;

  const fullSource = sections.map((s) => s.content).join("\n");

  // ------------------------------------------------------------------
  // 1. Extract all float environments (figure, table, algorithm, listing)
  // ------------------------------------------------------------------
  const floats = extractFloats(sections);

  // ------------------------------------------------------------------
  // 2. Extract all \ref{} and \autoref{} calls
  // ------------------------------------------------------------------
  const refs = extractRefs(fullSource);

  // ------------------------------------------------------------------
  // 3. Cross-check: defined labels vs referenced labels
  // ------------------------------------------------------------------
  const definedLabels = new Set(
    floats.filter((f) => f.label).map((f) => f.label!)
  );
  const referencedLabels = new Set(refs.filter((r) => r.startsWith("fig:") || r.startsWith("tab:") || r.startsWith("alg:") || r.startsWith("lst:")));

  // Defined but never referenced
  for (const float of floats) {
    if (float.label && !referencedLabels.has(float.label)) {
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: float.sectionId,
        message: `${capitalize(float.kind)} with label "${float.label}" is defined but never referenced in the text.`,
        suggestion: `Add a \\ref{${float.label}} or \\autoref{${float.label}} in the relevant section, or remove the float if it is not needed.`,
      });
    }
  }

  // Referenced but not defined
  for (const ref of referencedLabels) {
    if (!definedLabels.has(ref)) {
      issues.push({
        id: nextId(),
        severity: "error",
        sectionId: null,
        message: `Label "${ref}" is referenced (\\ref{${ref}}) but no matching \\label{${ref}} was found.`,
        suggestion: "Add the float with the corresponding \\label{}, or correct the reference key.",
      });
    }
  }

  // ------------------------------------------------------------------
  // 4. Missing captions
  // ------------------------------------------------------------------
  for (const float of floats) {
    if (!float.hasCaption) {
      issues.push({
        id: nextId(),
        severity: "error",
        sectionId: float.sectionId,
        message: `${capitalize(float.kind)} (label: ${float.label ?? "unlabelled"}) has no \\caption{}.`,
        suggestion: "Add a caption. Most venues require captions on all floats.",
      });
    }
  }

  // ------------------------------------------------------------------
  // 5. Caption quality
  // ------------------------------------------------------------------
  for (const float of floats) {
    if (!float.hasCaption) continue;

    if (float.captionLength < 5) {
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: float.sectionId,
        message: `Caption for ${float.kind} "${float.label ?? "unlabelled"}" is very short (${float.captionLength} words).`,
        suggestion:
          "A good caption is self-contained: a reader should understand the float without reading the surrounding text.",
      });
    }
  }

  // ------------------------------------------------------------------
  // 6. Missing label on floats that have a caption (common oversight)
  // ------------------------------------------------------------------
  for (const float of floats) {
    if (float.hasCaption && !float.label) {
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: float.sectionId,
        message: `${capitalize(float.kind)} has a caption but no \\label{} — it cannot be cross-referenced.`,
        suggestion: `Add \\label{${float.kind.slice(0, 3)}:descriptive-name} after the \\caption{}.`,
      });
    }
  }

  // ------------------------------------------------------------------
  // 7. Generic \ref{} usage (not fig:/tab: prefixed)
  // ------------------------------------------------------------------
  const genericRefs = refs.filter(
    (r) => !r.startsWith("fig:") && !r.startsWith("tab:") &&
            !r.startsWith("alg:") && !r.startsWith("lst:") &&
            !r.startsWith("sec:") && !r.startsWith("eq:")  &&
            !r.startsWith("ch:")
  );
  if (genericRefs.length > 0) {
    issues.push({
      id: nextId(),
      severity: "info",
      sectionId: null,
      message: `${genericRefs.length} \\ref{} call(s) use unlabelled keys without a type prefix (fig:, tab:, sec:, eq:, alg:).`,
      suggestion:
        "Use prefixed labels (fig:name, tab:name) for clarity and to enable autoref to generate correct link text.",
    });
  }

  const errorCount   = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    skill: "figure-check",
    version: VERSION,
    issues,
    summary:
      issues.length === 0
        ? "No figure/table issues found."
        : `${errorCount} error(s), ${warningCount} warning(s), ${issues.filter((i) => i.severity === "info").length} info(s). ${floats.length} float(s) checked.`,
  };
}

// ---------------------------------------------------------------------------
// Float extraction
// ---------------------------------------------------------------------------

const FLOAT_KINDS: Array<[RegExp, FloatInfo["kind"]]> = [
  [/\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g, "figure"],
  [/\\begin\{table\*?\}([\s\S]*?)\\end\{table\*?\}/g,   "table"],
  [/\\begin\{algorithm\*?\}([\s\S]*?)\\end\{algorithm\*?\}/g, "algorithm"],
  [/\\begin\{listing\*?\}([\s\S]*?)\\end\{listing\*?\}/g, "listing"],
];

function extractFloats(sections: Section[]): FloatInfo[] {
  const floats: FloatInfo[] = [];

  for (const section of sections) {
    for (const [pattern, kind] of FLOAT_KINDS) {
      const re = new RegExp(pattern.source, pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(section.content)) !== null) {
        const body = m[1] ?? m[0];
        const label = extractLabel(body);
        const caption = extractCaption(body);
        floats.push({
          kind,
          label,
          hasCaption: caption !== null,
          captionLength: caption ? caption.split(/\s+/).filter(Boolean).length : 0,
          sectionId: section.id,
          lineApprox: section.content.slice(0, m.index).split("\n").length + section.lineStart,
        });
      }
    }
  }

  return floats;
}

function extractLabel(body: string): string | null {
  const m = /\\label\{([^}]+)\}/.exec(body);
  return m ? m[1].trim() : null;
}

function extractCaption(body: string): string | null {
  // Handle \caption{text} — captures up to first unmatched }
  const m = /\\caption\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/.exec(body);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Ref extraction
// ---------------------------------------------------------------------------

function extractRefs(source: string): string[] {
  const refs: string[] = [];
  // \ref{}, \autoref{}, \cref{}, \Cref{}, \pageref{}
  const refRe = /\\(?:auto|c|C|page)?ref\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(source)) !== null) {
    // may be comma-separated: \cref{fig:a,fig:b}
    for (const key of m[1].split(",")) {
      refs.push(key.trim());
    }
  }
  return refs;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
