import type { Section, Issue } from "../../types/index.js";

// ---------------------------------------------------------------------------
// language-check (scope: section)
// Flags non-academic tone, vague language, passive overuse, weasel words,
// and common academic writing anti-patterns — without calling an LLM.
// All rules are deterministic regex/heuristic, so this skill is fast and
// always available offline.
// ---------------------------------------------------------------------------

const VERSION = "1.0.0";

export interface LanguageCheckOutput {
  skill: "language-check";
  version: string;
  sectionId: string;
  issues: Issue[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

interface Rule {
  id: string;
  severity: "error" | "warning" | "info";
  pattern: RegExp;
  message: (match: string) => string;
  suggestion: string;
  // Sections where this rule is suppressed (e.g. future-work hedges ok in conclusion)
  skipSections?: RegExp;
}

const RULES: Rule[] = [
  // ---- Weasel words ----
  {
    id: "lang-001",
    severity: "warning",
    pattern: /\b(very|quite|rather|somewhat|fairly|pretty|mostly|generally|usually|often|sometimes|clearly|obviously|certainly|surely|definitely|basically|essentially|actually|really)\b/gi,
    message: (m) => `Weasel word "${m}" weakens the claim.`,
    suggestion: "Remove it or quantify: replace vague intensifiers with specific data.",
  },
  // ---- Passive voice overuse (simple detector) ----
  {
    id: "lang-002",
    severity: "info",
    pattern: /\b(is|are|was|were|be|been|being)\s+(\w+ed)\b/gi,
    message: (m) => `Possible passive construction: "${m}".`,
    suggestion: "Consider active voice where the agent is known. Passive is fine when the agent is irrelevant.",
    skipSections: /introduction|abstract/i,
  },
  // ---- Hedging without evidence ----
  {
    id: "lang-003",
    severity: "warning",
    pattern: /\b(we believe|we think|we feel|we hope|we expect|it seems|it appears|it is likely|it is possible|might be|may be|could be|should be)\b/gi,
    message: (m) => `Unsupported hedge: "${m}".`,
    suggestion: "Back the claim with data or rephrase as a research question/future work.",
    skipSections: /future|conclusion|limitation|discussion/i,
  },
  // ---- Vague quantifiers ----
  {
    id: "lang-004",
    severity: "warning",
    pattern: /\b(many|few|several|some|numerous|various|a number of|a lot of|large number|small number|a variety of)\b/gi,
    message: (m) => `Vague quantifier "${m}".`,
    suggestion: "Replace with a specific number or percentage where possible.",
    skipSections: /abstract|introduction/i,
  },
  // ---- "In this paper we" — overused opener ----
  {
    id: "lang-005",
    severity: "info",
    pattern: /\bin this (paper|work|article|study),?\s+we\b/gi,
    message: () => '"In this paper we" is an overused opener.',
    suggestion: 'Lead with the finding or contribution instead: "We show that…" or "This work presents…".',
  },
  // ---- Informal contractions ----
  {
    id: "lang-006",
    severity: "warning",
    pattern: /\b(don't|doesn't|didn't|can't|couldn't|won't|wouldn't|isn't|aren't|wasn't|weren't|it's|we're|they're|that's|there's)\b/gi,
    message: (m) => `Informal contraction: "${m}".`,
    suggestion: "Use the expanded form in academic writing.",
  },
  // ---- First person overuse ----
  {
    id: "lang-007",
    severity: "info",
    pattern: /\bI\b(?!\s*\.)/g,
    message: () => 'First-person singular "I" in a multi-author paper.',
    suggestion: 'Use "we" for multi-author papers. Reserve "I" for single-author work.',
  },
  // ---- "Significant" without a test ----
  {
    id: "lang-008",
    severity: "warning",
    pattern: /\b(significant(ly)?|substantial(ly)?)\b/gi,
    message: (m) => `"${m}" implies statistical significance — confirm a test was reported.`,
    suggestion: 'Report the test, effect size, and p-value, or use a non-statistical synonym like "notable" or "marked".',
    skipSections: /statistics|evaluation|results/i,
  },
  // ---- Banned phrases (known to annoy reviewers) ----
  {
    id: "lang-009",
    severity: "warning",
    pattern: /\b(state of the art|state-of-the-art)\b(?!\s+\w+)/gi,
    message: () => '"State of the art" used without naming the specific approach.',
    suggestion: 'Name the specific baseline: "outperforms GPT-4o" rather than "outperforms state-of-the-art".',
  },
  {
    id: "lang-010",
    severity: "info",
    pattern: /\bnovel\b/gi,
    message: () => '"Novel" is overused in paper abstracts.',
    suggestion: "Let the contribution speak for itself. Remove or replace with a specific claim.",
    skipSections: /related|background/i,
  },
  // ---- Double negatives ----
  {
    id: "lang-011",
    severity: "warning",
    pattern: /\bnot\s+\w*in(effective|efficient|accurate|sufficient|significant|correct|valid|consistent|complete|reliable)\b/gi,
    message: (m) => `Double negative: "${m}".`,
    suggestion: "Rewrite with a positive assertion for clarity.",
  },
  // ---- Dangling "this" without a referent ----
  {
    id: "lang-012",
    severity: "info",
    pattern: /\bThis\s+(shows?|demonstrates?|proves?|suggests?|indicates?|confirms?|implies?)\b/gi,
    message: (m) => `"${m}" — ensure "This" has a clear referent.`,
    suggestion: 'Replace "This shows" with "These results show" or name the referent explicitly.',
  },
];

// ---------------------------------------------------------------------------
// Section-level heuristics (not per-sentence)
// ---------------------------------------------------------------------------

function checkSectionLevelIssues(
  section: Section,
  nextId: () => string,
  issues: Issue[]
): void {
  const words = section.content.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return;

  // Passive voice density — warn if > 25% of sentences appear passive
  const sentences = section.content
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 10);
  if (sentences.length >= 4) {
    const passiveCount = sentences.filter((s) =>
      /\b(is|are|was|were|be|been|being)\s+\w+ed\b/i.test(s)
    ).length;
    const rate = passiveCount / sentences.length;
    if (rate > 0.5) {
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: section.id,
        heading: section.heading,
        message: `High passive voice density in "${section.heading}": ~${Math.round(rate * 100)}% of sentences appear passive.`,
        suggestion:
          "Aim for ≤30% passive sentences. Rewrite the most important claims in active voice.",
      });
    }
  }

  // Paragraph length — warn if any paragraph exceeds 250 words
  const paragraphs = section.content
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 0);
  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).filter((w) => w.length > 0);
    if (paraWords.length > 250) {
      issues.push({
        id: nextId(),
        severity: "info",
        sectionId: section.id,
        heading: section.heading,
        message: `A paragraph in "${section.heading}" has ~${paraWords.length} words — reviewers may skip it.`,
        suggestion:
          "Break paragraphs longer than ~150 words into two or more focused paragraphs.",
      });
      break; // one per section is enough
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function runLanguageCheck(section: Section): LanguageCheckOutput {
  const issues: Issue[] = [];
  let counter = 0;
  const nextId = () => `lang-${String(++counter).padStart(3, "0")}`;

  // Strip LaTeX commands from content before applying text rules
  const plainText = section.content
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, " ")   // \cmd{arg}
    .replace(/\$[^$]+\$/g, " MATH ")          // inline math
    .replace(/\\[a-zA-Z]+/g, " ")             // lone commands
    .replace(/[{}]/g, " ");

  // Track which rule IDs have fired to avoid flooding (max 3 matches per rule)
  const ruleHits = new Map<string, number>();

  for (const rule of RULES) {
    // Suppress in certain sections
    if (rule.skipSections?.test(section.heading)) continue;

    const MAX_PER_RULE = 3;
    let match: RegExpExecArray | null;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);

    while ((match = re.exec(plainText)) !== null) {
      const hits = ruleHits.get(rule.id) ?? 0;
      if (hits >= MAX_PER_RULE) break;

      issues.push({
        id: nextId(),
        severity: rule.severity,
        sectionId: section.id,
        message: rule.message(match[0]),
        suggestion: rule.suggestion,
      });

      ruleHits.set(rule.id, hits + 1);
    }
  }

  // Section-level checks
  checkSectionLevelIssues(section, nextId, issues);

  const errorCount   = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    skill: "language-check",
    version: VERSION,
    sectionId: section.id,
    issues,
    summary:
      issues.length === 0
        ? "No language issues found."
        : `${errorCount} error(s), ${warningCount} warning(s), ${issues.filter((i) => i.severity === "info").length} info(s).`,
  };
}
