import { describe, it, expect } from "vitest";
import { runStructureCheck } from "../src/skills/structure-check/index.js";
import type { StructureCheckInput } from "../src/types/index.js";

// Helpers
function makeSection(
  heading: string,
  level = 1,
  id?: string
) {
  const slug = id ?? "sec-" + heading.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { id: slug, heading, level, file: "paper.tex", lineStart: 1 };
}

function run(
  headings: string[],
  paperType: StructureCheckInput["paperType"] = "full",
  venue: string | null = null
) {
  return runStructureCheck({
    paperType,
    venue,
    sections: headings.map((h) => makeSection(h)),
  });
}

// ---------------------------------------------------------------------------
// Missing required sections
// ---------------------------------------------------------------------------

describe("structure-check: missing sections", () => {
  it("passes a complete full paper", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Methodology", "Evaluation", "Discussion", "Conclusion", "References",
    ]);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("flags missing Methodology", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Evaluation", "Conclusion", "References",
    ]);
    const errors = result.issues.filter(
      (i) => i.severity === "error" && i.message.includes("Methodology")
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("flags missing Conclusion", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Methodology", "Evaluation", "References",
    ]);
    expect(result.issues.some((i) => i.message.includes("Conclusion"))).toBe(true);
  });

  it("flags missing References", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Methodology", "Evaluation", "Conclusion",
    ]);
    expect(result.issues.some((i) => i.message.includes("References"))).toBe(true);
  });

  it("does not require Related Work for short papers", () => {
    const result = run(
      ["Abstract", "Introduction", "Methodology", "Evaluation", "Conclusion", "References"],
      "short"
    );
    expect(result.issues.some((i) => i.message.includes("Related Work"))).toBe(false);
  });

  it("accepts variant headings for required sections", () => {
    const result = run([
      "Abstract",
      "Introduction",
      "Prior Work",          // variant of Related Work
      "Our Approach",        // variant of Methodology
      "Experiments",         // variant of Evaluation
      "Concluding Remarks",  // variant of Conclusion
      "Bibliography",        // variant of References
    ]);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-standard section names
// ---------------------------------------------------------------------------

describe("structure-check: non-standard names", () => {
  it("flags non-academic tone", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Why We Win",  // non-academic
      "Evaluation", "Conclusion", "References",
    ]);
    expect(result.issues.some((i) => i.sectionId === "sec-why-we-win")).toBe(true);
  });

  it("flags ambiguous system name without structural signal", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "The CRABS System",  // ambiguous — no structural word
      "Evaluation", "Conclusion", "References",
    ]);
    expect(
      result.issues.some(
        (i) => i.sectionId === "sec-the-crabs-system" &&
               (i.severity === "warning" || i.severity === "info")
      )
    ).toBe(true);
  });

  it("does not flag known standard names", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Methodology", "Evaluation", "Threats to Validity",
      "Conclusion", "References",
    ]);
    // Threats to Validity is a known variant of Discussion — should not be flagged
    expect(
      result.issues.some((i) => i.message.includes("Threats to Validity"))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ordering checks
// ---------------------------------------------------------------------------

describe("structure-check: ordering", () => {
  it("flags References before Conclusion", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Methodology", "Evaluation", "References", "Conclusion",
    ]);
    expect(
      result.issues.some(
        (i) => i.severity === "error" && i.message.includes("before the Conclusion")
      )
    ).toBe(true);
  });

  it("flags Abstract not in first position", () => {
    const result = run([
      "Introduction", "Abstract", "Related Work",
      "Methodology", "Evaluation", "Conclusion", "References",
    ]);
    expect(
      result.issues.some(
        (i) => i.severity === "error" && i.message.includes("not the first section")
      )
    ).toBe(true);
  });

  it("warns when Related Work appears after Evaluation (non-SE venue)", () => {
    const result = run(
      [
        "Abstract", "Introduction", "Methodology",
        "Evaluation", "Related Work", "Conclusion", "References",
      ],
      "full",
      "SOSP" // not an SE venue
    );
    expect(
      result.issues.some(
        (i) => i.severity === "warning" && i.message.includes("Related Work appears after Evaluation")
      )
    ).toBe(true);
  });

  it("does not warn about late Related Work for ICSE/FSE papers", () => {
    const result = run(
      [
        "Abstract", "Introduction", "Methodology",
        "Evaluation", "Related Work", "Conclusion", "References",
      ],
      "full",
      "ICSE"
    );
    expect(
      result.issues.some((i) => i.message.includes("Related Work appears after Evaluation"))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural risks for downstream skills
// ---------------------------------------------------------------------------

describe("structure-check: structural risks", () => {
  it("flags duplicate section headings as error", () => {
    const result = run([
      "Abstract", "Introduction", "Introduction",
      "Methodology", "Evaluation", "Conclusion", "References",
    ]);
    expect(
      result.issues.some(
        (i) => i.severity === "error" && i.message.includes("2 times")
      )
    ).toBe(true);
  });

  it("returns empty issues for a structurally sound paper", () => {
    const result = run([
      "Abstract", "Introduction", "Related Work",
      "Methodology", "Evaluation", "Discussion",
      "Conclusion", "References",
    ]);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("handles empty section list gracefully", () => {
    const result = runStructureCheck({ paperType: "full", venue: null, sections: [] });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("error");
  });
});
