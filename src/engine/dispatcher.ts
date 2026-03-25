import type {
  Section,
  BibEntry,
} from "../types/index.js";
import { extractCiteKeys } from "./extractor.js";
import { runStructureCheck } from "../skills/structure-check/index.js";
import { runCitationCheck } from "../skills/citation-check/index.js";
import { runLanguageCheck } from "../skills/language-check/index.js";
import { runStatsCheck } from "../skills/stats-check/index.js";
import { runFigureCheck } from "../skills/figure-check/index.js";
import { runCrossSectionCheck } from "../skills/cross-section-check/index.js";

export type SkillName =
  | "structure-check"
  | "citation-check"
  | "language-check"
  | "stats-check"
  | "figure-check"
  | "cross-section-check"
  | "all";

/** All valid `--skill` CLI values (includes `all`). */
export const SKILL_NAME_VALUES: readonly SkillName[] = [
  "all",
  "structure-check",
  "citation-check",
  "language-check",
  "stats-check",
  "figure-check",
  "cross-section-check",
];

export function isSkillName(value: string): value is SkillName {
  return (SKILL_NAME_VALUES as readonly string[]).includes(value);
}

/** Sidecar JSON key and incremental-cache key — must stay in sync with cli `upsertSection`. */
export function sidecarStorageKey(skill: string, sectionId: string): string {
  switch (skill) {
    case "structure-check":
      return "__document__";
    case "citation-check":
      return sectionId;
    case "language-check":
      return `${sectionId}:lang`;
    case "stats-check":
      return `${sectionId}:stats`;
    case "figure-check":
      return "__figures__";
    case "cross-section-check":
      return "__cross__";
    default:
      return sectionId;
  }
}

export interface StructureCheckDispatchContext {
  venuePack: import("../types/index.js").ResolvedVenuePack;
  disabledRuleIds: string[];
  /** Bumps structure-check cache when config / pack / disables change. */
  fingerprint: string;
}

export interface DispatchOptions {
  skills: SkillName;
  paperType?: "full" | "short" | "workshop" | "tool-demo" | null;
  venue?: string | null;
  /** When set, structure-check uses pack + disables; hash includes fingerprint. */
  structureCheck?: StructureCheckDispatchContext | null;
  forceFull?: boolean; // skip hash cache check
}

export interface DispatchResult {
  sectionId: string;
  skill: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: { skill: string; version: string; issues: import('../types/index.js').Issue[]; summary: string; [key: string]: any };
  skipped: boolean;
}

// ---------------------------------------------------------------------------
// Dispatcher
// Routes sections and the full document to the appropriate skills.
// Per-section skills receive one section at a time.
// Document-scope skills receive all sections.
// ---------------------------------------------------------------------------

export async function dispatch(
  sections: Section[],
  bibliography: BibEntry[],
  allCiteKeys: string[],
  cachedHashes: Map<string, string>, // sectionId → last known hash
  opts: DispatchOptions
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  const runAll = opts.skills === "all";

  // ------------------------------------------------------------------
  // Document-scope: structure-check
  // ------------------------------------------------------------------
  if (runAll || opts.skills === "structure-check") {
    const docHash = sections.map((s) => s.contentHash).join(":");
    const fp = opts.structureCheck?.fingerprint ?? "";
    const structureDocHash = fp ? `${docHash}:${fp}` : docHash;
    const cached =
      !opts.forceFull && cachedHashes.get("__document__") === structureDocHash;

    if (!cached) {
      const output = runStructureCheck({
        paperType: opts.paperType ?? null,
        venue: opts.venue ?? null,
        venuePack: opts.structureCheck?.venuePack,
        disabledRuleIds: opts.structureCheck?.disabledRuleIds,
        sections: sections.map((s) => ({
          id: s.id,
          heading: s.heading,
          level: s.level,
          file: s.file,
          lineStart: s.lineStart,
        })),
      });

      results.push({
        sectionId: "__document__",
        skill: "structure-check",
        output,
        skipped: false,
      });
    } else {
      results.push({
        sectionId: "__document__",
        skill: "structure-check",
        output: { skill: "structure-check", version: "cached", issues: [], summary: "cached" },
        skipped: true,
      });
    }
  }

  // ------------------------------------------------------------------
  // Per-section: citation-check
  // ------------------------------------------------------------------
  if (runAll || opts.skills === "citation-check") {
    // Pre-compute all cite keys used anywhere in the document for the uncited check
    const allCitedInDoc = sections.flatMap((s) => extractCiteKeys(s.content));

    let firstSection = true;
    for (const section of sections) {
      const cached =
        !opts.forceFull && cachedHashes.get(section.id) === section.contentHash;

      if (!cached) {
        const output = await runCitationCheck(
          {
            sectionId: section.id,
            heading: section.heading,
            content: section.content,
            bibliography,
            allCiteKeys,
            allCitedInDoc,
          },
          { clearCache: firstSection } // clear the in-process verification cache once per run
        );
        firstSection = false;

        results.push({
          sectionId: section.id,
          skill: "citation-check",
          output,
          skipped: false,
        });
      } else {
        results.push({
          sectionId: section.id,
          skill: "citation-check",
          output: {
            skill: "citation-check",
            version: "cached",
            sectionId: section.id,
            issues: [],
            verificationResults: [],
            summary: "cached",
          },
          skipped: true,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Per-section: language-check
  // ------------------------------------------------------------------
  if (runAll || opts.skills === "language-check") {
    for (const section of sections) {
      const cached = !opts.forceFull && cachedHashes.get(section.id + ":lang") === section.contentHash;
      if (!cached) {
        const output = runLanguageCheck(section);
        results.push({ sectionId: section.id, skill: "language-check", output, skipped: false });
      } else {
        results.push({ sectionId: section.id, skill: "language-check", output: { skill: "language-check", version: "cached", sectionId: section.id, issues: [], summary: "cached" }, skipped: true });
      }
    }
  }

  // ------------------------------------------------------------------
  // Per-section: stats-check
  // ------------------------------------------------------------------
  if (runAll || opts.skills === "stats-check") {
    for (const section of sections) {
      const cached = !opts.forceFull && cachedHashes.get(section.id + ":stats") === section.contentHash;
      if (!cached) {
        const output = runStatsCheck(section);
        results.push({ sectionId: section.id, skill: "stats-check", output, skipped: false });
      } else {
        results.push({ sectionId: section.id, skill: "stats-check", output: { skill: "stats-check", version: "cached", sectionId: section.id, issues: [], summary: "cached" }, skipped: true });
      }
    }
  }

  // ------------------------------------------------------------------
  // Document-scope: figure-check
  // ------------------------------------------------------------------
  if (runAll || opts.skills === "figure-check") {
    const docHash = sections.map((s) => s.contentHash).join(":");
    const cached = !opts.forceFull && cachedHashes.get("__figures__") === docHash;
    if (!cached) {
      const output = runFigureCheck(sections);
      results.push({ sectionId: "__figures__", skill: "figure-check", output, skipped: false });
    } else {
      results.push({ sectionId: "__figures__", skill: "figure-check", output: { skill: "figure-check", version: "cached", issues: [], summary: "cached" }, skipped: true });
    }
  }

  // ------------------------------------------------------------------
  // Document-scope: cross-section-check
  // ------------------------------------------------------------------
  if (runAll || opts.skills === "cross-section-check") {
    const docHash = sections.map((s) => s.contentHash).join(":");
    const cached = !opts.forceFull && cachedHashes.get("__cross__") === docHash;
    if (!cached) {
      const output = runCrossSectionCheck(sections);
      results.push({ sectionId: "__cross__", skill: "cross-section-check", output, skipped: false });
    } else {
      results.push({ sectionId: "__cross__", skill: "cross-section-check", output: { skill: "cross-section-check", version: "cached", issues: [], summary: "cached" }, skipped: true });
    }
  }

  return results;
}
