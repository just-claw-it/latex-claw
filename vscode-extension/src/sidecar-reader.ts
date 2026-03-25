import * as fs from "fs";
import * as path from "path";

// Minimal mirror of the sidecar types from the CLI — kept here to avoid
// importing the full engine into the extension bundle.

export interface SidecarIssue {
  id: string;
  severity: "error" | "warning" | "info";
  sectionId?: string | null;
  heading?: string | null;
  citeKey?: string | null;
  message: string;
  suggestion: string;
  ruleId?: string;
  packId?: string;
}

export interface SidecarVerification {
  citeKey: string;
  status: "verified" | "mismatch" | "not-found" | "skipped" | "doi-invalid";
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface SidecarSection {
  hash: string;
  issues: SidecarIssue[];
  verificationResults?: SidecarVerification[];
  checkedAt: string;
}

export interface Sidecar {
  version: string;
  generatedAt: string;
  sections: Record<string, SidecarSection>;
}

export function sidecarPath(texFile: string): string {
  return path.join(path.dirname(texFile), "latex-claw-report.json");
}

export function readSidecar(texFile: string): Sidecar | null {
  const p = sidecarPath(texFile);
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as Sidecar;
  } catch {
    return null;
  }
}

export function allIssues(sidecar: Sidecar): Array<SidecarIssue & { sectionKey: string }> {
  const out: Array<SidecarIssue & { sectionKey: string }> = [];
  for (const [sectionKey, section] of Object.entries(sidecar.sections)) {
    for (const issue of section.issues) {
      out.push({ ...issue, sectionKey });
    }
  }
  return out;
}

export function countBySeverity(sidecar: Sidecar): {
  errors: number;
  warnings: number;
  infos: number;
} {
  let errors = 0, warnings = 0, infos = 0;
  for (const section of Object.values(sidecar.sections)) {
    for (const issue of section.issues) {
      if (issue.severity === "error") errors++;
      else if (issue.severity === "warning") warnings++;
      else infos++;
    }
  }
  return { errors, warnings, infos };
}
