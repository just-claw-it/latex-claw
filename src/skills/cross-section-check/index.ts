import type { Section, Issue } from "../../types/index.js";

// ---------------------------------------------------------------------------
// cross-section-check (scope: document)
// Checks consistency across sections without calling an LLM:
//   1. Terminology: same concept referred to by different names
//   2. Numbers: values stated in one section that differ in another
//   3. Claims: abstract/introduction claims not supported by results
//   4. Acronyms: defined more than once, or used before definition
// ---------------------------------------------------------------------------

const VERSION = "1.0.0";

export interface CrossSectionCheckOutput {
  skill: "cross-section-check";
  version: string;
  issues: Issue[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function runCrossSectionCheck(sections: Section[]): CrossSectionCheckOutput {
  const issues: Issue[] = [];
  let counter = 0;
  const nextId = () => `cross-${String(++counter).padStart(3, "0")}`;

  checkAcronyms(sections, nextId, issues);
  checkNumberConsistency(sections, nextId, issues);
  checkAbstractClaimsVsResults(sections, nextId, issues);
  checkTerminologyDrift(sections, nextId, issues);

  const errorCount   = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    skill: "cross-section-check",
    version: VERSION,
    issues,
    summary:
      issues.length === 0
        ? "No cross-section consistency issues found."
        : `${errorCount} error(s), ${warningCount} warning(s), ${issues.filter((i) => i.severity === "info").length} info(s).`,
  };
}

// ---------------------------------------------------------------------------
// 1. Acronym consistency
// ---------------------------------------------------------------------------

function checkAcronyms(
  sections: Section[],
  nextId: () => string,
  issues: Issue[]
): void {
  // Find all definitions: "Full Name (ACR)" or "ACR (Full Name)"
  const defRe = /([A-Z][a-zA-Z\s-]{3,})\s+\(([A-Z]{2,8})\)|([A-Z]{2,8})\s+\(([A-Z][a-zA-Z\s-]{3,})\)/g;
  // Track: acronym → [{ fullForm, sectionId }]
  const definitions = new Map<string, Array<{ fullForm: string; sectionId: string }>>();

  // Track which sections each acronym is used in
  const uses = new Map<string, string[]>(); // acronym → sectionIds where used bare

  for (const section of sections) {
    const text = stripLatex(section.content);
    let m: RegExpExecArray | null;
    const re = new RegExp(defRe.source, defRe.flags);

    while ((m = re.exec(text)) !== null) {
      const acronym = m[2] ?? m[3];
      const fullForm = (m[1] ?? m[4]).trim();
      if (!definitions.has(acronym)) definitions.set(acronym, []);
      definitions.get(acronym)!.push({ fullForm, sectionId: section.id });
    }
  }

  // Check for re-definitions (defined in more than one section)
  for (const [acronym, defs] of definitions) {
    if (defs.length > 1) {
      const sectionNames = defs.map((d) => d.sectionId).join(", ");
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: defs[1].sectionId,
        message: `Acronym "${acronym}" is defined ${defs.length} times (in: ${sectionNames}).`,
        suggestion:
          "Define each acronym only once, on first use. Remove subsequent re-definitions.",
      });
    }
  }

  // Check for use before definition: acronym used in earlier section than where it's defined
  const sectionOrder = new Map(sections.map((s, i) => [s.id, i]));

  for (const section of sections) {
    const text = stripLatex(section.content);
    // Match bare uppercase acronyms (2–8 letters)
    const bareRe = /\b([A-Z]{2,8})\b/g;
    let m: RegExpExecArray | null;

    while ((m = bareRe.exec(text)) !== null) {
      const acronym = m[1];
      if (!definitions.has(acronym)) continue;

      const defs = definitions.get(acronym)!;
      const firstDefIdx = Math.min(
        ...defs.map((d) => sectionOrder.get(d.sectionId) ?? Infinity)
      );
      const currentIdx = sectionOrder.get(section.id) ?? Infinity;

      if (currentIdx < firstDefIdx) {
        if (!uses.has(acronym)) uses.set(acronym, []);
        if (!uses.get(acronym)!.includes(section.id)) {
          uses.get(acronym)!.push(section.id);
          issues.push({
            id: nextId(),
            severity: "warning",
            sectionId: section.id,
            message: `Acronym "${acronym}" used in "${section.heading}" before its first definition.`,
            suggestion: `Define "${acronym}" on its first use, or move the definition earlier.`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Number consistency across sections
// ---------------------------------------------------------------------------

function checkNumberConsistency(
  sections: Section[],
  nextId: () => string,
  issues: Issue[]
): void {
  // Extract (metric name, value) pairs from each section
  // Pattern: "metric = X" or "metric: X" or "X metric"
  const metricPatterns = [
    /\b(accuracy|precision|recall|F1|AUC|BLEU|ROUGE|METEOR|latency|throughput|speedup)\s*(?:of|:|=|is|was|are|were)?\s*([\d]+(?:\.\d+)?)\s*(%?)/gi,
    /\b([\d]+(?:\.\d+)?)\s*(%?)\s*(accuracy|precision|recall|F1|AUC|BLEU|ROUGE|improvement|reduction)/gi,
    /\b(n|N)\s*=\s*([\d,]+)/gi,
  ];

  // Map: metricKey → { value, sectionId, section }
  const metricMap = new Map<string, Array<{ value: number; sectionId: string; heading: string }>>();

  for (const section of sections) {
    const text = stripLatex(section.content);

    for (let pi = 0; pi < metricPatterns.length; pi++) {
      const re = new RegExp(metricPatterns[pi].source, metricPatterns[pi].flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        let metric: string;
        let rawVal: string;

        if (pi === 0) {
          // "accuracy of 87%"  → m[1]=metric, m[2]=number
          metric = m[1].toLowerCase().replace(/[^a-z0-9]/g, "");
          rawVal = m[2];
        } else if (pi === 1) {
          // "92% accuracy"  → m[1]=number, m[2]=pct, m[3]=metric
          metric = m[3].toLowerCase().replace(/[^a-z0-9]/g, "");
          rawVal = m[1];
        } else {
          // "n = 1000"  → m[2]=number
          metric = "samplesize";
          rawVal = m[2];
        }

        const value = parseFloat(rawVal.replace(/,/g, ""));
        if (isNaN(value) || value === 0) continue;

        if (!metricMap.has(metric)) metricMap.set(metric, []);
        const entries = metricMap.get(metric)!;
        if (!entries.some((e) => e.sectionId === section.id && e.value === value)) {
          entries.push({ value, sectionId: section.id, heading: section.heading });
        }
      }
    }
  }

  // Flag metrics whose values differ across sections
  for (const [metric, entries] of metricMap) {
    if (entries.length < 2) continue;
    const values = entries.map((e) => e.value);
    const min = Math.min(...values);
    const max = Math.max(...values);

    // Only flag if values differ by more than 1% (avoids float noise)
    if ((max - min) / max > 0.01) {
      const pairs = entries.map((e) => `${e.value} (in "${e.heading}")`).join(" vs ");
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: entries[1].sectionId,
        message: `Metric "${metric}" has inconsistent values across sections: ${pairs}.`,
        suggestion:
          "Verify the values are reporting the same experiment. If they differ legitimately (e.g., dev vs test), clarify explicitly.",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Abstract claims vs results section
// ---------------------------------------------------------------------------

function checkAbstractClaimsVsResults(
  sections: Section[],
  nextId: () => string,
  issues: Issue[]
): void {
  const abstract = sections.find((s) => s.id === "sec-abstract");
  const results = sections.find(
    (s) => /evaluation|results|experiments?/i.test(s.heading)
  );

  if (!abstract || !results) return;

  const abstractText = stripLatex(abstract.content);
  const resultsText  = stripLatex(results.content);

  // Extract percentage claims from abstract
  const pctRe = /(\d+(?:\.\d+)?)\s*%\s*\w+/g;
  let m: RegExpExecArray | null;
  const abstractNumbers = new Set<number>();

  while ((m = pctRe.exec(abstractText)) !== null) {
    abstractNumbers.add(parseFloat(m[1]));
  }

  // Check each number appears (within ±2%) in results section
  for (const num of abstractNumbers) {
    const resultsNumbers = [...resultsText.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(
      (n) => parseFloat(n[1])
    );
    const found = resultsNumbers.some((n) => Math.abs(n - num) / num < 0.02);

    if (!found) {
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: abstract.id,
        message: `Number "${num}%" appears in the abstract but not (within 2%) in the results/evaluation section.`,
        suggestion:
          "Ensure abstract figures match the reported results exactly. Copy-paste the numbers, then update the abstract last.",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Terminology drift
// ---------------------------------------------------------------------------

const SYNONYM_GROUPS: string[][] = [
  ["approach", "method", "technique", "system", "framework", "model", "algorithm", "tool"],
  ["dataset", "data set", "corpus", "benchmark", "collection"],
  ["evaluation", "experiment", "study", "assessment", "analysis"],
  ["baseline", "comparison", "reference method", "state of the art"],
  ["code review", "code inspection", "peer review"],
  ["pull request", "merge request", "patch"],
  ["bug", "defect", "fault", "error", "issue"],
];

function checkTerminologyDrift(
  sections: Section[],
  nextId: () => string,
  issues: Issue[]
): void {
  // For each section, find which terms from each synonym group are used
  // Flag if the same paper uses multiple synonyms for the same concept
  for (const group of SYNONYM_GROUPS) {
    const usedPerSection = new Map<string, Set<string>>();

    for (const section of sections) {
      const text = stripLatex(section.content).toLowerCase();
      const used = new Set<string>();
      for (const term of group) {
        const re = new RegExp(`\\b${escapeRegex(term)}s?\\b`, "gi");
        if (re.test(text)) used.add(term);
      }
      if (used.size > 0) usedPerSection.set(section.id, used);
    }

    // Collect all used terms across sections
    const allUsed = new Set<string>();
    for (const used of usedPerSection.values()) {
      for (const t of used) allUsed.add(t);
    }

    if (allUsed.size > 1) {
      // Check if the variation is cross-section (not the same section using both)
      const sectionsWithMultiple = [...usedPerSection.entries()].filter(
        ([, used]) => used.size > 1
      );

      if (allUsed.size >= 3 || sectionsWithMultiple.length > 0) {
        issues.push({
          id: nextId(),
          severity: "info",
          sectionId: null,
          message: `Possible terminology drift: the paper uses ${allUsed.size} synonyms for the same concept: "${[...allUsed].join('", "')}".`,
          suggestion: `Pick one term and use it consistently throughout. The Introduction or Methodology is the right place to establish it.`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripLatex(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, " ")
    .replace(/\$[^$]+\$/g, " ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
