// ---------------------------------------------------------------------------
// Shared types across latex-claw engine and skills
// ---------------------------------------------------------------------------

export type IssueSeverity = "error" | "warning" | "info";
export type SkillScope = "section" | "document";

export interface Section {
  id: string;
  heading: string;
  level: number;
  file: string;
  lineStart: number;
  content: string;
  contentHash: string; // sha256 of content, for incremental dispatch
}

export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Skill input/output contracts
// ---------------------------------------------------------------------------

/** Human-curated venue policy (from `venue_pack` + YAML). */
export interface ResolvedVenuePack {
  id: string;
  version?: string;
  label: string;
  /** Lowercase substrings matched against `venue` for late Related Work ordering. */
  lateRelatedWorkVenues: string[];
}

export interface StructureCheckInput {
  paperType: "full" | "short" | "workshop" | "tool-demo" | null;
  venue: string | null;
  sections: Pick<Section, "id" | "heading" | "level" | "file" | "lineStart">[];
  /** Defaults to built-in generic pack when omitted. */
  venuePack?: ResolvedVenuePack;
  /** From latex-claw.yaml `overrides.disable` — matching rules produce no issues. */
  disabledRuleIds?: string[];
}

export interface CitationCheckInput {
  sectionId: string;
  heading: string;
  content: string;
  bibliography: BibEntry[];
  allCiteKeys: string[];
  allCitedInDoc: string[]; // cite keys used anywhere in the document — for uncited-entry check
}

export interface Issue {
  id: string;
  severity: IssueSeverity;
  sectionId?: string | null;
  heading?: string | null;
  citeKey?: string | null;
  message: string;
  suggestion: string;
  /** Stable id for overrides and issue trackers (structure-check). */
  ruleId?: string;
  /** Venue pack id that produced this issue (structure-check). */
  packId?: string;
}

export interface VerificationResult {
  citeKey: string;
  status: "verified" | "mismatch" | "not-found" | "skipped" | "doi-invalid";
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface StructureCheckOutput {
  skill: "structure-check";
  version: string;
  issues: Issue[];
  summary: string;
}

export interface CitationCheckOutput {
  skill: "citation-check";
  version: string;
  sectionId: string;
  issues: Issue[];
  verificationResults: VerificationResult[];
  summary: string;
}

export type SkillOutput = StructureCheckOutput | CitationCheckOutput;

// ---------------------------------------------------------------------------
// Sidecar JSON format (written alongside the .tex file)
// ---------------------------------------------------------------------------

export interface SidecarSection {
  hash: string;
  issues: Issue[];
  verificationResults?: VerificationResult[];
  checkedAt: string; // ISO timestamp
}

export interface Sidecar {
  version: string;
  generatedAt: string;
  sections: Record<string, SidecarSection>; // keyed by sectionId
}
