import type {
  CitationCheckInput,
  CitationCheckOutput,
  BibEntry,
  Issue,
  VerificationResult,
} from "../../types/index.js";
import { extractCiteKeys } from "../../engine/extractor.js";
import { verifyReference, clearVerificationCache } from "./verify-reference.js";

// ---------------------------------------------------------------------------
// citation-check
// Checks: undefined keys, format consistency, year anomalies, duplicate keys,
// uncited entries, self-citation density, and hallucinated references.
// ---------------------------------------------------------------------------

const VERSION = "1.1.0";
const CURRENT_YEAR = new Date().getFullYear();
const VERIFICATION_SAMPLE_LIMIT = 15;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runCitationCheck(
  input: CitationCheckInput,
  opts: { clearCache?: boolean } = {}
): Promise<CitationCheckOutput> {
  if (opts.clearCache) clearVerificationCache();

  const { sectionId, heading, content, bibliography, allCiteKeys } = input;
  const issues: Issue[] = [];
  const verificationResults: VerificationResult[] = [];
  let counter = 0;
  const nextId = () => `cite-${String(++counter).padStart(3, "0")}`;

  const usedKeys = extractCiteKeys(content);
  const bibByKey = new Map(bibliography.map((e) => [e.key, e]));

  // ------------------------------------------------------------------
  // Check 1: Undefined citations
  // ------------------------------------------------------------------
  for (const key of usedKeys) {
    if (!allCiteKeys.includes(key)) {
      issues.push({
        id: nextId(),
        severity: "error",
        citeKey: key,
        message: `\\cite{${key}} is used in this section but has no matching BibTeX entry.`,
        suggestion: `Add a BibTeX entry with key '${key}', or correct the cite key if this is a typo.`,
      });
    }
  }

  // ------------------------------------------------------------------
  // Check 2: Format consistency (per entry type, among entries cited in this section)
  // ------------------------------------------------------------------
  const citedEntries = usedKeys
    .map((k) => bibByKey.get(k))
    .filter((e): e is BibEntry => !!e);

  const byType = groupBy(citedEntries, (e) => e.type.toLowerCase());

  for (const [type, entries] of byType) {
    checkFormatConsistency(type, entries, nextId, issues);
  }

  // ------------------------------------------------------------------
  // Check 3: Year anomalies
  // ------------------------------------------------------------------
  for (const entry of citedEntries) {
    const year = parseInt(entry.fields["year"] ?? "0", 10);
    if (!year) continue;

    if (year > CURRENT_YEAR + 1) {
      issues.push({
        id: nextId(),
        severity: "warning",
        citeKey: entry.key,
        message: `Entry '${entry.key}' has year ${year}, which is in the future.`,
        suggestion: "Check the year field for a typo.",
      });
    } else if (year < 1950) {
      issues.push({
        id: nextId(),
        severity: "info",
        citeKey: entry.key,
        message: `Entry '${entry.key}' has year ${year}. This is an unusually early reference for a CS paper.`,
        suggestion:
          "Verify this is the correct year; it may be a typo or misformatted date.",
      });
    }
  }

  // ------------------------------------------------------------------
  // Check 4: Duplicate keys
  // ------------------------------------------------------------------
  const keyCounts = new Map<string, number>();
  for (const e of bibliography) {
    keyCounts.set(e.key, (keyCounts.get(e.key) ?? 0) + 1);
  }
  for (const [key, count] of keyCounts) {
    if (count > 1) {
      issues.push({
        id: nextId(),
        severity: "error",
        citeKey: key,
        message: `BibTeX key '${key}' is defined ${count} times. LaTeX will silently use only the last definition.`,
        suggestion: "Remove the duplicate entry or rename one of them.",
      });
    }
  }

  // ------------------------------------------------------------------
  // Check 5: Uncited entries (only when we're in the references section itself)
  // ------------------------------------------------------------------
  const isRefsSection = /^(references|bibliography)/i.test(heading.trim());
  if (isRefsSection) {
    const citedEverywhere = new Set(input.allCitedInDoc);
    for (const entry of bibliography) {
      if (!citedEverywhere.has(entry.key)) {
        issues.push({
          id: nextId(),
          severity: "info",
          citeKey: entry.key,
          message: `Entry '${entry.key}' is defined in the bibliography but never cited.`,
          suggestion:
            "Remove it if unused, or add a citation in the appropriate section.",
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Check 6: Self-citation density
  // ------------------------------------------------------------------
  detectSelfCitationDensity(citedEntries, usedKeys, nextId, issues);

  // ------------------------------------------------------------------
  // Check 7: Hallucination detection
  // ------------------------------------------------------------------
  const toVerify = citedEntries.filter(
    (e) => !["misc"].includes(e.type.toLowerCase()) || e.fields["title"]
  );

  const sampled =
    toVerify.length > VERIFICATION_SAMPLE_LIMIT
      ? shuffleSample(toVerify, VERIFICATION_SAMPLE_LIMIT)
      : toVerify;

  const wasSampled = sampled.length < toVerify.length;

  // Run verifications concurrently in batches of 5 to respect rate limits
  const batchSize = 5;
  for (let i = 0; i < sampled.length; i += batchSize) {
    const batch = sampled.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((e) => verifyReference(e)));
    verificationResults.push(...results);
  }

  // Raise issues from verification results
  for (const vr of verificationResults) {
    if (vr.status === "doi-invalid") {
      issues.push({
        id: nextId(),
        severity: "error",
        citeKey: vr.citeKey,
        message: `DOI for '${vr.citeKey}' returned a 404. The DOI may be wrong or the entry may be hallucinated.`,
        suggestion:
          "Verify this reference manually. Correct the DOI, or remove it if the entry was generated incorrectly.",
      });
    } else if (vr.status === "mismatch" && vr.confidence === "high") {
      issues.push({
        id: nextId(),
        severity: "error",
        citeKey: vr.citeKey,
        message: `Possible hallucinated reference: title matches a real paper but authors do not overlap. ${vr.note ?? ""}`,
        suggestion:
          "Verify this reference manually. The entry may have been generated with incorrect author information.",
      });
    } else if (vr.status === "mismatch" && vr.confidence === "medium") {
      issues.push({
        id: nextId(),
        severity: "warning",
        citeKey: vr.citeKey,
        message: `Reference '${vr.citeKey}' has metadata that does not fully match what was found online. ${vr.note ?? ""}`,
        suggestion:
          "This may be a pre-print vs. published version difference, or a metadata error. Verify the year and venue.",
      });
    }
  }

  // Build summary
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;
  const verifiedCount = verificationResults.filter(
    (r) => r.status === "verified"
  ).length;
  const hallucCount = verificationResults.filter(
    (r) => r.status === "mismatch" || r.status === "doi-invalid"
  ).length;

  const parts: string[] = [];
  if (errorCount) parts.push(`${errorCount} error(s)`);
  if (warnCount) parts.push(`${warnCount} warning(s)`);
  if (verifiedCount) parts.push(`${verifiedCount} verified`);
  if (hallucCount) parts.push(`${hallucCount} hallucination suspect(s)`);
  if (wasSampled)
    parts.push(
      `hallucination check sampled ${sampled.length} of ${toVerify.length} entries`
    );

  const summary =
    parts.length === 0
      ? "No citation issues found."
      : parts.join("; ") + ".";

  return {
    skill: "citation-check",
    version: VERSION,
    sectionId,
    issues,
    verificationResults,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Format consistency check
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: Record<string, string[]> = {
  inproceedings: ["author", "title", "booktitle", "year"],
  article: ["author", "title", "journal", "year"],
  book: ["title", "year"],
  phdthesis: ["author", "title", "school", "year"],
  techreport: ["author", "title", "institution", "year"],
};

const OPTIONAL_CONSISTENT_FIELDS: Record<string, string[]> = {
  inproceedings: ["pages", "publisher"],
  article: ["volume", "pages", "number"],
};

function checkFormatConsistency(
  type: string,
  entries: BibEntry[],
  nextId: () => string,
  issues: Issue[]
): void {
  const required = REQUIRED_FIELDS[type] ?? [];

  // Required fields: flag if missing
  for (const entry of entries) {
    const missing = required.filter(
      (f) => f !== "author" && !entry.fields[f] // skip author — handled separately
    );
    // Check author OR editor for book
    if (type === "book" && !entry.fields["author"] && !entry.fields["editor"]) {
      missing.push("author or editor");
    } else if (type !== "book" && required.includes("author") && !entry.fields["author"]) {
      missing.push("author");
    }

    if (missing.length > 0) {
      issues.push({
        id: nextId(),
        severity: "warning",
        citeKey: entry.key,
        message: `Entry '${entry.key}' (${type}) is missing required field(s): ${missing.join(", ")}.`,
        suggestion: `Add the missing field(s) to the BibTeX entry.`,
      });
    }
  }

  // Optional but consistent fields: only meaningful when comparing multiple entries
  if (entries.length < 2) return;
  const optFields = OPTIONAL_CONSISTENT_FIELDS[type] ?? [];
  for (const field of optFields) {
    const haveField = entries.filter((e) => !!e.fields[field]);
    if (haveField.length > 0 && haveField.length < entries.length) {
      const missing = entries.filter((e) => !e.fields[field]);
      for (const entry of missing) {
        issues.push({
          id: nextId(),
          severity: "warning",
          citeKey: entry.key,
          message: `Entry '${entry.key}' (${type}) is missing '${field}'; ${haveField.length} of ${entries.length} other ${type} entries include it.`,
          suggestion: `Add the '${field}' field, or remove it from all ${type} entries for consistency.`,
        });
      }
    }
  }

  // url vs howpublished inconsistency for misc entries
  if (type === "misc") {
    const useUrl = entries.filter((e) => !!e.fields["url"]);
    const useHowPublished = entries.filter((e) => !!e.fields["howpublished"]);
    if (useUrl.length > 0 && useHowPublished.length > 0) {
      issues.push({
        id: nextId(),
        severity: "warning",
        citeKey: null,
        message: `Some misc entries use 'url' and others use 'howpublished' for web references.`,
        suggestion: "Pick one convention and apply it consistently across all misc entries.",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Self-citation density
// ---------------------------------------------------------------------------

function detectSelfCitationDensity(
  citedEntries: BibEntry[],
  usedKeys: string[],
  nextId: () => string,
  issues: Issue[]
): void {
  if (citedEntries.length < 4) return; // not enough signal below this threshold

  // Try to detect dominant author surname from the majority of entries
  const surnameFreq = new Map<string, number>();
  for (const entry of citedEntries) {
    const authors = entry.fields["author"] ?? "";
    for (const surname of extractSurnames(authors)) {
      surnameFreq.set(surname, (surnameFreq.get(surname) ?? 0) + 1);
    }
  }

  const [[topSurname, topCount] = []] = [...surnameFreq.entries()].sort(
    ([, a], [, b]) => b - a
  );

  if (!topSurname || !topCount) return;

  const selfCiteRate = topCount / citedEntries.length;
  if (selfCiteRate >= 0.25) {
    issues.push({
      id: nextId(),
      severity: "info",
      citeKey: null,
      message: `High self-citation rate in this section: "${topSurname}" appears in ${topCount} of ${citedEntries.length} cited entries (${Math.round(selfCiteRate * 100)}%).`,
      suggestion:
        "Consider whether all self-citations are necessary. Reviewers may notice a high rate of self-promotion.",
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupBy<T>(arr: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const group = map.get(k) ?? [];
    group.push(item);
    map.set(k, group);
  }
  return map;
}

function extractSurnames(authorField: string): string[] {
  if (!authorField.trim()) return [];
  return authorField
    .split(/\s+and\s+/i)
    .map((a) => {
      const parts = a.trim().split(",");
      return (parts[0] ?? a.trim().split(/\s+/).at(-1) ?? "").trim().toLowerCase();
    })
    .filter(Boolean);
}

function shuffleSample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
