import fs from "node:fs/promises";
import path from "node:path";
import type { Sidecar, SidecarSection, Issue, VerificationResult } from "../types/index.js";

const SIDECAR_VERSION = "1.0.0";
const SIDECAR_FILENAME = "latex-claw-report.json";

export function sidecarPath(texFile: string): string {
  return path.join(path.dirname(texFile), SIDECAR_FILENAME);
}

export async function loadSidecar(texFile: string): Promise<Sidecar> {
  const p = sidecarPath(texFile);
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as Sidecar;
  } catch {
    return {
      version: SIDECAR_VERSION,
      generatedAt: new Date().toISOString(),
      sections: {},
    };
  }
}

export async function writeSidecar(texFile: string, sidecar: Sidecar): Promise<void> {
  sidecar.generatedAt = new Date().toISOString();
  const p = sidecarPath(texFile);
  await fs.writeFile(p, JSON.stringify(sidecar, null, 2), "utf8");
}

export function upsertSection(
  sidecar: Sidecar,
  sectionId: string,
  hash: string,
  issues: Issue[],
  verificationResults?: VerificationResult[]
): void {
  const entry: SidecarSection = {
    hash,
    issues,
    checkedAt: new Date().toISOString(),
  };
  if (verificationResults) entry.verificationResults = verificationResults;
  sidecar.sections[sectionId] = entry;
}

// Returns true if the section hash matches what's already stored — skip re-run
export function isCached(sidecar: Sidecar, sectionId: string, hash: string): boolean {
  return sidecar.sections[sectionId]?.hash === hash;
}

// Count all issues across all sections by severity
export function summarizeSidecar(sidecar: Sidecar): {
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
