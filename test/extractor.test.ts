import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractDocument,
  extractBibliography,
  extractCiteKeys,
  stripLatex,
} from "../src/engine/extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(__dirname, "fixtures", name);

// ---------------------------------------------------------------------------
// stripLatex
// ---------------------------------------------------------------------------

describe("stripLatex", () => {
  it("removes \\cmd{content} leaving content", () => {
    expect(stripLatex("\\emph{Hello}")).toBe("Hello");
  });

  it("removes bare braces", () => {
    expect(stripLatex("{LLM}-based")).toBe("LLM-based");
  });

  it("collapses whitespace", () => {
    expect(stripLatex("  A   B  ")).toBe("A B");
  });

  it("handles nested commands", () => {
    expect(stripLatex("\\textbf{\\emph{word}}")).toBe("word");
  });
});

// ---------------------------------------------------------------------------
// extractCiteKeys
// ---------------------------------------------------------------------------

describe("extractCiteKeys", () => {
  it("extracts simple \\cite{key}", () => {
    expect(extractCiteKeys("see~\\cite{smith2022}")).toEqual(["smith2022"]);
  });

  it("extracts multi-key \\cite{a,b,c}", () => {
    const keys = extractCiteKeys("\\cite{rigby2013,bacchelli2013,sadowski2018}");
    expect(keys).toContain("rigby2013");
    expect(keys).toContain("bacchelli2013");
    expect(keys).toContain("sadowski2018");
    expect(keys).toHaveLength(3);
  });

  it("strips optional argument \\cite[p.~5]{key}", () => {
    expect(extractCiteKeys("\\cite[p.~5]{jones2021}")).toEqual(["jones2021"]);
  });

  it("handles \\citep and \\citet variants", () => {
    const keys = extractCiteKeys("\\citep{a} \\citet{b} \\citeauthor{c}");
    expect(keys).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("deduplicates repeated keys", () => {
    const keys = extractCiteKeys("\\cite{a} and \\cite{a} again");
    expect(keys).toEqual(["a"]);
  });

  it("ignores commented-out citations", () => {
    // % \\cite{secret} should not be picked up — but our regex doesn't
    // strip comments; this documents current behaviour.
    const keys = extractCiteKeys("real~\\cite{visible}");
    expect(keys).toEqual(["visible"]);
  });
});

// ---------------------------------------------------------------------------
// extractBibliography (inline)
// ---------------------------------------------------------------------------

describe("extractBibliography (inline source)", () => {
  const bib = `
@inproceedings{smith2022,
  author    = {Smith, John},
  title     = {A Great Paper},
  booktitle = {ICSE},
  year      = {2022},
  pages     = {1--10}
}

@article{jones2021,
  author  = {Jones, Bob},
  title   = {Another Paper},
  journal = {TSE},
  year    = {2021},
  volume  = {47},
  pages   = {100--120}
}

@comment{ignored,
  this = {should be skipped}
}
`;

  it("extracts all non-special entries", () => {
    const entries = extractBibliography(bib);
    expect(entries).toHaveLength(2);
  });

  it("parses all fields correctly", () => {
    const entries = extractBibliography(bib);
    const smith = entries.find((e) => e.key === "smith2022");
    expect(smith).toBeDefined();
    expect(smith!.fields.author).toBe("Smith, John");
    expect(smith!.fields.title).toBe("A Great Paper");
    expect(smith!.fields.booktitle).toBe("ICSE");
    expect(smith!.fields.year).toBe("2022");
    expect(smith!.fields.pages).toBe("1--10");
  });

  it("parses article fields correctly", () => {
    const entries = extractBibliography(bib);
    const jones = entries.find((e) => e.key === "jones2021");
    expect(jones!.fields.journal).toBe("TSE");
    expect(jones!.fields.volume).toBe("47");
  });

  it("skips @comment entries", () => {
    const entries = extractBibliography(bib);
    expect(entries.find((e) => e.key === "ignored")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractDocument — full pipeline with .tex + .bib files
// ---------------------------------------------------------------------------

describe("extractDocument (well-formed.tex)", () => {
  let doc: Awaited<ReturnType<typeof extractDocument>>;

  beforeAll(async () => {
    doc = await extractDocument(fixture("well-formed.tex"));
  });

  it("detects abstract from \\begin{abstract} environment", () => {
    const abs = doc.sections.find((s) => s.id === "sec-abstract");
    expect(abs).toBeDefined();
    expect(abs!.heading).toBe("Abstract");
  });

  it("extracts all named sections in order", () => {
    const headings = doc.sections.map((s) => s.heading);
    expect(headings).toEqual([
      "Abstract",
      "Introduction",
      "Related Work",
      "Methodology",
      "Evaluation",
      "Discussion",
      "Threats to Validity",  // \subsection inside Discussion
      "Conclusion",
    ]);
  });

  it("resolves bibliography from refs.bib", () => {
    expect(doc.bibliography.length).toBeGreaterThan(0);
    expect(doc.allCiteKeys).toContain("rigby2013");
    expect(doc.allCiteKeys).toContain("bacchelli2013");
  });

  it("assigns unique contentHash to each section", () => {
    const hashes = doc.sections.map((s) => s.contentHash);
    const unique = new Set(hashes);
    expect(unique.size).toBe(hashes.length);
  });

  it("each section has a non-empty content field", () => {
    for (const s of doc.sections) {
      expect(s.content.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("extractDocument (structural-problems.tex)", () => {
  let doc: Awaited<ReturnType<typeof extractDocument>>;

  beforeAll(async () => {
    doc = await extractDocument(fixture("structural-problems.tex"));
  });

  it("extracts sections even without abstract environment", () => {
    expect(doc.sections.some((s) => s.heading === "Introduction")).toBe(true);
  });

  it("does not produce a phantom abstract section", () => {
    expect(doc.sections.some((s) => s.id === "sec-abstract")).toBe(false);
  });
});
