import type {
  StructureCheckInput,
  StructureCheckOutput,
  Issue,
  ResolvedVenuePack,
} from "../../types/index.js";
import { STRUCTURE_RULE } from "../../config/rule-ids.js";
import { toResolvedVenuePack } from "../../config/resolve-venue-pack.js";
import { BUNDLED_VENUE_PACKS } from "../../venue-packs/bundled.js";

// ---------------------------------------------------------------------------
// structure-check
// Validates section structure: missing required sections, non-standard names,
// ordering anomalies, and structural risks for downstream skills.
// Policy: venue pack + rule IDs (see latex-claw.yaml).
// ---------------------------------------------------------------------------

const VERSION = "1.1.0";

const DEFAULT_RESOLVED_PACK: ResolvedVenuePack = toResolvedVenuePack(
  BUNDLED_VENUE_PACKS.default
);

// Canonical sections → accepted variants (lowercased for matching)
const REQUIRED_SECTIONS: Array<{
  canonical: string;
  variants: string[];
  /** Set for every required section; omitted for optional-only rows like Discussion. */
  ruleId?: string;
  optional?: boolean;
  shortPaperOptional?: boolean;
}> = [
  {
    canonical: "Abstract",
    ruleId: STRUCTURE_RULE.REQUIRED_ABSTRACT,
    variants: ["abstract", "summary"],
  },
  {
    canonical: "Introduction",
    ruleId: STRUCTURE_RULE.REQUIRED_INTRODUCTION,
    variants: ["introduction", "intro", "background and motivation", "motivation"],
  },
  {
    canonical: "Related Work",
    ruleId: STRUCTURE_RULE.REQUIRED_RELATED_WORK,
    variants: [
      "related work",
      "prior work",
      "background",
      "literature review",
      "state of the art",
      "related works",
    ],
    shortPaperOptional: true,
  },
  {
    canonical: "Methodology",
    ruleId: STRUCTURE_RULE.REQUIRED_METHODOLOGY,
    variants: [
      "methodology",
      "approach",
      "method",
      "design",
      "proposed approach",
      "our approach",
      "proposed method",
      "framework",
      "formalization",
      "the approach",
      "technical approach",
    ],
  },
  {
    canonical: "Evaluation",
    ruleId: STRUCTURE_RULE.REQUIRED_EVALUATION,
    variants: [
      "evaluation",
      "experiments",
      "results",
      "empirical evaluation",
      "study",
      "experimental results",
      "empirical study",
      "experimental evaluation",
    ],
  },
  {
    canonical: "Discussion",
    variants: [
      "discussion",
      "analysis",
      "threats to validity",
      "limitations",
      "threats and limitations",
    ],
    optional: true,
    shortPaperOptional: true,
  },
  {
    canonical: "Conclusion",
    ruleId: STRUCTURE_RULE.REQUIRED_CONCLUSION,
    variants: [
      "conclusion",
      "conclusions",
      "summary and future work",
      "concluding remarks",
      "conclusions and future work",
    ],
  },
  {
    canonical: "References",
    ruleId: STRUCTURE_RULE.REQUIRED_REFERENCES,
    variants: ["references", "bibliography"],
  },
];

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function runStructureCheck(input: StructureCheckInput): StructureCheckOutput {
  const issues: Issue[] = [];
  const { sections, paperType, venue } = input;
  const pack = input.venuePack ?? DEFAULT_RESOLVED_PACK;
  const disabled = new Set(input.disabledRuleIds ?? []);
  let counter = 0;

  const nextId = () => `struct-${String(++counter).padStart(3, "0")}`;

  const push = (issue: Omit<Issue, "id"> & { ruleId: string }) => {
    if (disabled.has(issue.ruleId)) return;
    issues.push({
      ...issue,
      id: nextId(),
      packId: pack.id,
    });
  };

  // Guard: empty section list
  if (sections.length === 0) {
    if (!disabled.has(STRUCTURE_RULE.EMPTY_DOCUMENT)) {
      issues.push({
        id: nextId(),
        severity: "error",
        sectionId: null,
        heading: null,
        ruleId: STRUCTURE_RULE.EMPTY_DOCUMENT,
        packId: pack.id,
        message:
          "No sections were detected. The .tex file may be empty, non-standard, or failed to parse.",
        suggestion:
          "Ensure the file contains \\section{} commands and that \\input{} includes resolve correctly.",
      });
    }
    return {
      skill: "structure-check",
      version: VERSION,
      issues,
      summary: "Section extraction failed — no sections found.",
    };
  }

  const isShort = paperType === "short" || paperType === "tool-demo";
  const isWorkshop = paperType === "workshop";
  const venueLower = (venue ?? "").toLowerCase();
  const lateRelatedWorkOk = pack.lateRelatedWorkVenues.some((v) =>
    venueLower.includes(v.toLowerCase())
  );

  const headings = sections.map((s) => s.heading.toLowerCase().trim());

  // ------------------------------------------------------------------
  // Check 1: Missing required sections
  // ------------------------------------------------------------------
  for (const req of REQUIRED_SECTIONS) {
    if (req.optional) continue;
    if (!req.ruleId) continue; // e.g. Discussion
    if (isShort && req.shortPaperOptional) continue;

    const found = headings.some(
      (h) => req.variants.includes(h) || variantPartialMatch(h, req.variants)
    );

    if (!found) {
      push({
        severity: "error",
        sectionId: null,
        heading: null,
        ruleId: req.ruleId,
        message: `No section mapping to "${req.canonical}" was found.`,
        suggestion: suggestMissing(req.canonical, isShort, isWorkshop),
      });
    }
  }

  // ------------------------------------------------------------------
  // Check 2: Non-standard section names
  // ------------------------------------------------------------------
  const allVariants = REQUIRED_SECTIONS.flatMap((r) => r.variants);

  for (const section of sections) {
    const h = section.heading.toLowerCase().trim();
    const isKnown =
      allVariants.includes(h) || variantPartialMatch(h, allVariants);

    if (!isKnown) {
      const vagueness = scoreVagueness(section.heading);
      if (vagueness === "non-academic") {
        push({
          severity: "warning",
          sectionId: section.id,
          heading: section.heading,
          ruleId: STRUCTURE_RULE.NAME_NON_ACADEMIC,
          message: `Section name "${section.heading}" has non-academic tone.`,
          suggestion: `Rename to a conventional heading (e.g., "Methodology", "Evaluation") or add a subtitle: "${section.heading}: A [Conventional Name]".`,
        });
      } else if (vagueness === "ambiguous") {
        push({
          severity: "info",
          sectionId: section.id,
          heading: section.heading,
          ruleId: STRUCTURE_RULE.NAME_AMBIGUOUS,
          message: `Section name "${section.heading}" is non-standard and may confuse reviewers unfamiliar with your system/domain.`,
          suggestion: `Consider adding a subtitle to clarify the role of this section, e.g., "Methodology: ${section.heading}".`,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Check 3: Ordering anomalies
  // ------------------------------------------------------------------
  const introIdx = findSectionIndex(headings, REQUIRED_SECTIONS[1].variants);
  const relatedIdx = findSectionIndex(headings, REQUIRED_SECTIONS[2].variants);
  const evalIdx = findSectionIndex(headings, REQUIRED_SECTIONS[4].variants);
  const conclusionIdx = findSectionIndex(headings, REQUIRED_SECTIONS[6].variants);
  const refsIdx = findSectionIndex(headings, REQUIRED_SECTIONS[7].variants);

  const abstractIdx = findSectionIndex(headings, REQUIRED_SECTIONS[0].variants);
  if (abstractIdx !== -1 && abstractIdx !== 0) {
    push({
      severity: "error",
      sectionId: sections[abstractIdx].id,
      heading: sections[abstractIdx].heading,
      ruleId: STRUCTURE_RULE.ORDER_ABSTRACT_FIRST,
      message: "Abstract is not the first section.",
      suggestion: "Move the Abstract to before the Introduction.",
    });
  }

  if (introIdx !== -1 && abstractIdx !== -1 && introIdx < abstractIdx) {
    push({
      severity: "error",
      sectionId: sections[introIdx].id,
      heading: sections[introIdx].heading,
      ruleId: STRUCTURE_RULE.ORDER_INTRO_AFTER_ABSTRACT,
      message: "Introduction appears before the Abstract.",
      suggestion: "Move the Abstract to be the first section.",
    });
  }

  if (refsIdx !== -1 && conclusionIdx !== -1 && refsIdx < conclusionIdx) {
    push({
      severity: "error",
      sectionId: sections[refsIdx].id,
      heading: sections[refsIdx].heading,
      ruleId: STRUCTURE_RULE.ORDER_REFERENCES_AFTER_CONCLUSION,
      message: "References section appears before the Conclusion.",
      suggestion: "Move References to after the Conclusion.",
    });
  }

  if (
    relatedIdx !== -1 &&
    evalIdx !== -1 &&
    relatedIdx > evalIdx &&
    !lateRelatedWorkOk
  ) {
    push({
      severity: "warning",
      sectionId: sections[relatedIdx].id,
      heading: sections[relatedIdx].heading,
      ruleId: STRUCTURE_RULE.ORDER_RELATED_AFTER_EVALUATION,
      message:
        "Related Work appears after Evaluation. This is uncommon and may confuse reviewers at some venues.",
      suggestion: isWorkshop
        ? "Consider merging Related Work into the Introduction for shorter page limits."
        : "Consider moving Related Work to before Methodology, or after Introduction.",
    });
  }

  // ------------------------------------------------------------------
  // Check 4: Structural risks for downstream skills
  // ------------------------------------------------------------------
  const headingCounts = new Map<string, number>();
  for (const h of headings) {
    headingCounts.set(h, (headingCounts.get(h) ?? 0) + 1);
  }
  for (const [h, count] of headingCounts) {
    if (count > 1) {
      push({
        severity: "error",
        sectionId: null,
        heading: h,
        ruleId: STRUCTURE_RULE.DUPLICATE_HEADING,
        message: `Section heading "${h}" appears ${count} times. Downstream skills cannot disambiguate these sections.`,
        suggestion: "Give each section a unique heading.",
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;

  const summary =
    issues.length === 0
      ? "Section structure is sound."
      : `${errorCount} error(s), ${warnCount} warning(s), ${issues.filter((i) => i.severity === "info").length} info(s).`;

  return {
    skill: "structure-check",
    version: VERSION,
    issues,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSectionIndex(headings: string[], variants: string[]): number {
  return headings.findIndex(
    (h) => variants.includes(h) || variantPartialMatch(h, variants)
  );
}

function variantPartialMatch(heading: string, variants: string[]): boolean {
  return variants.some((v) => heading.includes(v) || v.includes(heading));
}

type Vagueness = "non-academic" | "ambiguous" | "ok";

function scoreVagueness(heading: string): Vagueness {
  const nonAcademicPatterns = [
    /^why we/i,
    /^how we/i,
    /^doing the/i,
    /^let['']s/i,
    /^making it/i,
  ];
  if (nonAcademicPatterns.some((p) => p.test(heading))) return "non-academic";

  const STOP_WORDS = new Set(["a", "an", "the", "of", "in", "and", "or", "for", "to", "with"]);
  const allVariantWords = new Set(
    REQUIRED_SECTIONS.flatMap((r) =>
      r.variants.flatMap((v) => v.split(" "))
    ).filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
  const headingWords = heading
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !STOP_WORDS.has(w));
  const hasStructuralWord = headingWords.some((w) => allVariantWords.has(w));

  if (!hasStructuralWord && heading.split(" ").length <= 5) return "ambiguous";

  return "ok";
}

function suggestMissing(
  canonical: string,
  isShort: boolean,
  isWorkshop: boolean
): string {
  switch (canonical) {
    case "Related Work":
      if (isWorkshop)
        return "For workshop papers, consider merging related work into the Introduction to save space.";
      return "Add a Related Work section before or after the Introduction. At minimum, differentiate from prior work inside the Introduction.";
    case "Methodology":
      return "Add a section describing your approach. Even a short paper needs to explain what you did.";
    case "Evaluation":
      return "Add an Evaluation or Results section. Claims without evidence are unlikely to be accepted.";
    case "Conclusion":
      return isShort
        ? "Add a brief Conclusion section (1–2 paragraphs)."
        : "Add a Conclusion section summarising contributions and future work.";
    case "References":
      return "Add a References section. Without it, \\cite{} commands will produce [?] in the output.";
    default:
      return `Add a section for "${canonical}".`;
  }
}
