import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCitationCheck } from "../src/skills/citation-check/index.js";
import type { CitationCheckInput, BibEntry } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Mock the verification module so tests don't hit external APIs
// ---------------------------------------------------------------------------

vi.mock("../src/skills/citation-check/verify-reference.js", () => ({
  verifyReference: vi.fn().mockResolvedValue({
    citeKey: "mock",
    status: "skipped",
    confidence: "low",
    note: "mocked in tests",
  }),
  clearVerificationCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBib(
  key: string,
  type: string,
  fields: Record<string, string>
): BibEntry {
  return { key, type, fields };
}

function makeInput(overrides: Partial<CitationCheckInput> = {}): CitationCheckInput {
  return {
    sectionId: "sec-related",
    heading: "Related Work",
    content: "",
    bibliography: [],
    allCiteKeys: [],
    allCitedInDoc: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Undefined citations
// ---------------------------------------------------------------------------

describe("citation-check: undefined citations", () => {
  it("flags a key used in content but absent from allCiteKeys", async () => {
    const result = await runCitationCheck(
      makeInput({
        content: "see~\\cite{ghost2023} for details",
        allCiteKeys: [],
        bibliography: [],
        allCitedInDoc: [],
      })
    );
    const errors = result.issues.filter(
      (i) => i.severity === "error" && i.citeKey === "ghost2023"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("ghost2023");
  });

  it("does not flag keys that exist in allCiteKeys", async () => {
    const result = await runCitationCheck(
      makeInput({
        content: "see~\\cite{smith2022}",
        allCiteKeys: ["smith2022"],
        bibliography: [
          makeBib("smith2022", "inproceedings", {
            author: "Smith, John",
            title: "A Paper",
            booktitle: "ICSE",
            year: "2022",
            pages: "1--10",
          }),
        ],
        allCitedInDoc: ["smith2022"],
      })
    );
    const undefinedErrors = result.issues.filter(
      (i) => i.citeKey === "smith2022" && i.message.includes("no matching BibTeX")
    );
    expect(undefinedErrors).toHaveLength(0);
  });

  it("handles multi-key \\cite{a,b,c} — flags missing keys", async () => {
    const result = await runCitationCheck(
      makeInput({
        content: "\\cite{present,missing1,missing2}",
        allCiteKeys: ["present"],
        bibliography: [makeBib("present", "misc", { title: "Something" })],
        allCitedInDoc: ["present"],
      })
    );
    const missing = result.issues.filter((i) => i.message.includes("no matching BibTeX"));
    expect(missing.map((i) => i.citeKey)).toContain("missing1");
    expect(missing.map((i) => i.citeKey)).toContain("missing2");
  });
});

// ---------------------------------------------------------------------------
// Format consistency
// ---------------------------------------------------------------------------

describe("citation-check: format consistency", () => {
  it("flags inproceedings with inconsistent pages field", async () => {
    const bib = [
      makeBib("a2022", "inproceedings", { author: "A", title: "T1", booktitle: "B", year: "2022", pages: "1--10" }),
      makeBib("b2022", "inproceedings", { author: "B", title: "T2", booktitle: "B", year: "2022", pages: "11--20" }),
      makeBib("c2022", "inproceedings", { author: "C", title: "T3", booktitle: "B", year: "2022" }), // missing pages
    ];
    const result = await runCitationCheck(
      makeInput({
        content: "\\cite{a2022,b2022,c2022}",
        allCiteKeys: ["a2022", "b2022", "c2022"],
        bibliography: bib,
        allCitedInDoc: ["a2022", "b2022", "c2022"],
      })
    );
    const pageWarning = result.issues.find(
      (i) => i.severity === "warning" && i.citeKey === "c2022" && i.message.includes("pages")
    );
    expect(pageWarning).toBeDefined();
  });

  it("does not warn about pages if no entry has pages (consistent absence)", async () => {
    const bib = [
      makeBib("a2022", "inproceedings", { author: "A", title: "T1", booktitle: "B", year: "2022" }),
      makeBib("b2022", "inproceedings", { author: "B", title: "T2", booktitle: "B", year: "2022" }),
    ];
    const result = await runCitationCheck(
      makeInput({
        content: "\\cite{a2022,b2022}",
        allCiteKeys: ["a2022", "b2022"],
        bibliography: bib,
        allCitedInDoc: ["a2022", "b2022"],
      })
    );
    const pageWarnings = result.issues.filter(
      (i) => i.message.includes("pages")
    );
    expect(pageWarnings).toHaveLength(0);
  });

  it("flags missing required author field", async () => {
    const bib = [
      makeBib("x2022", "inproceedings", {
        title: "No Author Paper",
        booktitle: "ICSE",
        year: "2022",
        pages: "1--5",
      }),
    ];
    const result = await runCitationCheck(
      makeInput({
        content: "\\cite{x2022}",
        allCiteKeys: ["x2022"],
        bibliography: bib,
        allCitedInDoc: ["x2022"],
      })
    );
    expect(
      result.issues.some((i) => i.citeKey === "x2022" && i.message.includes("author"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Year anomalies
// ---------------------------------------------------------------------------

describe("citation-check: year anomalies", () => {
  it("warns on future year", async () => {
    const futureYear = (new Date().getFullYear() + 5).toString();
    const bib = [
      makeBib("future", "article", {
        author: "A", title: "T", journal: "J", year: futureYear, volume: "1", pages: "1",
      }),
    ];
    const result = await runCitationCheck(
      makeInput({
        content: "\\cite{future}",
        allCiteKeys: ["future"],
        bibliography: bib,
        allCitedInDoc: ["future"],
      })
    );
    expect(
      result.issues.some(
        (i) => i.severity === "warning" && i.citeKey === "future" && i.message.includes("future")
      )
    ).toBe(true);
  });

  it("notes pre-1950 year as info", async () => {
    const bib = [
      makeBib("turing1936", "article", {
        author: "Turing, Alan",
        title: "On Computable Numbers",
        journal: "Proc. London Mathematical Society",
        year: "1936",
        volume: "42",
        pages: "230--265",
      }),
    ];
    const result = await runCitationCheck(
      makeInput({
        content: "\\cite{turing1936}",
        allCiteKeys: ["turing1936"],
        bibliography: bib,
        allCitedInDoc: ["turing1936"],
      })
    );
    expect(
      result.issues.some(
        (i) => i.severity === "info" && i.citeKey === "turing1936"
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate keys
// ---------------------------------------------------------------------------

describe("citation-check: duplicate keys", () => {
  it("flags duplicate BibTeX keys", async () => {
    const bib = [
      makeBib("dup2022", "inproceedings", { author: "A", title: "First", booktitle: "B", year: "2022" }),
      makeBib("dup2022", "inproceedings", { author: "B", title: "Second", booktitle: "B", year: "2022" }),
    ];
    const result = await runCitationCheck(
      makeInput({
        content: "\\cite{dup2022}",
        allCiteKeys: ["dup2022"],
        bibliography: bib,
        allCitedInDoc: ["dup2022"],
      })
    );
    expect(
      result.issues.some(
        (i) => i.severity === "error" && i.citeKey === "dup2022" && i.message.includes("2 times")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Uncited entries
// ---------------------------------------------------------------------------

describe("citation-check: uncited entries", () => {
  it("flags uncited entries when checking the References section", async () => {
    const bib = [
      makeBib("used2022", "inproceedings", { author: "A", title: "T", booktitle: "B", year: "2022" }),
      makeBib("unused2021", "inproceedings", { author: "B", title: "U", booktitle: "B", year: "2021" }),
    ];
    const result = await runCitationCheck(
      makeInput({
        sectionId: "sec-references",
        heading: "References",
        content: "",
        allCiteKeys: ["used2022", "unused2021"],
        bibliography: bib,
        allCitedInDoc: ["used2022"], // unused2021 never cited
      })
    );
    expect(
      result.issues.some(
        (i) => i.severity === "info" && i.citeKey === "unused2021"
      )
    ).toBe(true);
    expect(
      result.issues.some((i) => i.citeKey === "used2022" && i.message.includes("never cited"))
    ).toBe(false);
  });

  it("does not flag uncited entries in non-references sections", async () => {
    const bib = [
      makeBib("unused2021", "inproceedings", { author: "B", title: "U", booktitle: "B", year: "2021" }),
    ];
    const result = await runCitationCheck(
      makeInput({
        sectionId: "sec-introduction",
        heading: "Introduction",
        content: "we do stuff",
        allCiteKeys: ["unused2021"],
        bibliography: bib,
        allCitedInDoc: [],
      })
    );
    expect(
      result.issues.some((i) => i.message.includes("never cited"))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cite key parsing edge cases
// ---------------------------------------------------------------------------

describe("citation-check: cite key parsing", () => {
  it("handles \\cite[p.~5]{key} optional args", async () => {
    const result = await runCitationCheck(
      makeInput({
        content: "as shown~\\cite[p.~5]{present}",
        allCiteKeys: ["present"],
        bibliography: [makeBib("present", "misc", { title: "T" })],
        allCitedInDoc: ["present"],
      })
    );
    const undefinedErrors = result.issues.filter(
      (i) => i.message.includes("no matching BibTeX")
    );
    expect(undefinedErrors).toHaveLength(0);
  });
});
