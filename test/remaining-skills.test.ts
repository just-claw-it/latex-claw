import { describe, it, expect } from "vitest";
import { runLanguageCheck } from "../src/skills/language-check/index.js";
import { runStatsCheck }    from "../src/skills/stats-check/index.js";
import { runFigureCheck }   from "../src/skills/figure-check/index.js";
import { runCrossSectionCheck } from "../src/skills/cross-section-check/index.js";
import type { Section } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSection(
  id: string,
  heading: string,
  content: string,
  lineStart = 1
): Section {
  return {
    id,
    heading,
    level: 1,
    file: "paper.tex",
    lineStart,
    content,
    contentHash: id,
  };
}

// ---------------------------------------------------------------------------
// language-check
// ---------------------------------------------------------------------------

describe("language-check", () => {
  it("flags weasel words", () => {
    const s = makeSection("sec-intro", "Introduction",
      "It is very clear that our approach is quite better.");
    const r = runLanguageCheck(s);
    expect(r.issues.some((i) => i.message.includes("very") || i.message.includes("quite"))).toBe(true);
  });

  it("flags informal contractions", () => {
    const s = makeSection("sec-intro", "Introduction",
      "We don't report the results here. It can't be done easily.");
    const r = runLanguageCheck(s);
    expect(r.issues.some((i) => i.message.toLowerCase().includes("contraction"))).toBe(true);
  });

  it("flags hedging without evidence in methodology", () => {
    const s = makeSection("sec-method", "Methodology",
      "We believe this approach may be correct. It seems to work.");
    const r = runLanguageCheck(s);
    expect(r.issues.some((i) => i.message.includes("hedge") || i.message.includes("Unsupported"))).toBe(true);
  });

  it("allows hedging in conclusion/future work", () => {
    const s = makeSection("sec-conc", "Conclusion and Future Work",
      "We believe future work may explore multi-modal inputs.");
    const r = runLanguageCheck(s);
    // hedge rule suppressed in conclusion
    const hedgeIssues = r.issues.filter((i) => i.message.includes("Unsupported hedge"));
    expect(hedgeIssues).toHaveLength(0);
  });

  it("flags 'novel' in abstract", () => {
    const s = makeSection("sec-abstract", "Abstract",
      "We present a novel approach to automated testing.");
    const r = runLanguageCheck(s);
    expect(r.issues.some((i) => i.message.toLowerCase().includes("novel"))).toBe(true);
  });

  it("flags 'significant' without a test", () => {
    const s = makeSection("sec-intro", "Introduction",
      "Our method significantly reduces latency.");
    const r = runLanguageCheck(s);
    expect(r.issues.some((i) => i.id.startsWith("lang") && i.message.includes("significant"))).toBe(true);
  });

  it("returns no issues for clean academic prose", () => {
    const s = makeSection("sec-method", "Methodology",
      "We fine-tune a transformer model on a corpus of 50,000 pull requests. " +
      "Each sample consists of a diff and its review comments. " +
      "We use a learning rate of 2e-5 and train for 5 epochs.");
    const r = runLanguageCheck(s);
    const errors = r.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stats-check
// ---------------------------------------------------------------------------

describe("stats-check", () => {
  it("flags 'significantly' without p-value", () => {
    const s = makeSection("sec-eval", "Evaluation",
      "Our approach significantly reduces latency compared to the baseline.");
    const r = runStatsCheck(s);
    expect(r.issues.some((i) => i.message.includes("p-value") || i.message.includes("test statistic"))).toBe(true);
  });

  it("does not flag 'significantly' when p-value is nearby", () => {
    const s = makeSection("sec-eval", "Evaluation",
      "Our approach significantly reduces latency (t(38) = 3.2, p = 0.003).");
    const r = runStatsCheck(s);
    const sigIssues = r.issues.filter((i) => i.message.includes("without a reported p-value"));
    expect(sigIssues).toHaveLength(0);
  });

  it("flags effect size missing with significance claim", () => {
    const s = makeSection("sec-eval", "Evaluation",
      "The improvement is statistically significant (p < 0.001).");
    const r = runStatsCheck(s);
    expect(r.issues.some((i) => i.message.includes("effect size"))).toBe(true);
  });

  it("flags missing sample size with metric claims", () => {
    const s = makeSection("sec-eval", "Evaluation",
      "Our approach achieves an accuracy of 0.92 on the test set.");
    const r = runStatsCheck(s);
    expect(r.issues.some((i) => i.message.includes("sample size"))).toBe(true);
  });

  it("does not flag when sample size is present", () => {
    const s = makeSection("sec-eval", "Evaluation",
      "We evaluated on 1,000 pull requests (n = 1000). " +
      "Our approach achieves an accuracy of 0.92.");
    const r = runStatsCheck(s);
    const sampleIssues = r.issues.filter((i) => i.message.includes("sample size"));
    expect(sampleIssues).toHaveLength(0);
  });

  it("flags metric claim without baseline", () => {
    const s = makeSection("sec-eval", "Evaluation",
      "We achieved a 30% improvement in review latency.");
    const r = runStatsCheck(s);
    expect(r.issues.some((i) => i.message.includes("baseline"))).toBe(true);
  });

  it("returns no issues for clean results section", () => {
    const s = makeSection("sec-eval", "Evaluation",
      "We evaluated our approach on n = 5,000 pull requests from 12 repositories. " +
      "Compared to the baseline (GPT-4o), our method reduces latency by 42% (t(38) = 4.1, p < 0.001, Cohen's d = 0.65, 95% CI: [0.38, 0.92]).");
    const r = runStatsCheck(s);
    const errors = r.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// figure-check
// ---------------------------------------------------------------------------

describe("figure-check", () => {
  it("flags figure with label but never referenced", () => {
    const sections = [
      makeSection("sec-method", "Methodology",
        `\\begin{figure}\n\\includegraphics{fig1}\n\\caption{Overview of the system.}\n\\label{fig:overview}\n\\end{figure}\nWe present our approach.`),
    ];
    const r = runFigureCheck(sections);
    expect(r.issues.some((i) => i.message.includes("fig:overview") && i.message.includes("never referenced"))).toBe(true);
  });

  it("no issue when figure is referenced", () => {
    const sections = [
      makeSection("sec-method", "Methodology",
        `\\begin{figure}\n\\includegraphics{fig1}\n\\caption{Overview.}\n\\label{fig:overview}\n\\end{figure}\n` +
        `As shown in \\autoref{fig:overview}, the system processes inputs.`),
    ];
    const r = runFigureCheck(sections);
    expect(r.issues.some((i) => i.message.includes("never referenced"))).toBe(false);
  });

  it("flags reference to undefined label", () => {
    const sections = [
      makeSection("sec-intro", "Introduction",
        "As shown in \\ref{fig:missing}, the architecture is straightforward."),
    ];
    const r = runFigureCheck(sections);
    expect(r.issues.some((i) => i.severity === "error" && i.message.includes("fig:missing"))).toBe(true);
  });

  it("flags figure with no caption", () => {
    const sections = [
      makeSection("sec-method", "Methodology",
        `\\begin{figure}\n\\includegraphics{fig1}\n\\label{fig:overview}\n\\end{figure}`),
    ];
    const r = runFigureCheck(sections);
    expect(r.issues.some((i) => i.severity === "error" && i.message.includes("no \\caption"))).toBe(true);
  });

  it("flags very short caption", () => {
    const sections = [
      makeSection("sec-method", "Methodology",
        `\\begin{figure}\n\\caption{A figure.}\n\\label{fig:tiny}\n\\end{figure}\n` +
        `See \\ref{fig:tiny}.`),
    ];
    const r = runFigureCheck(sections);
    expect(r.issues.some((i) => i.message.toLowerCase().includes("short") && i.message.toLowerCase().includes("caption"))).toBe(true);
  });

  it("returns no issues for a well-formed figure", () => {
    const sections = [
      makeSection("sec-method", "Methodology",
        `\\begin{figure}\n\\includegraphics{fig1}\n` +
        `\\caption{Overview of our approach. The input diff is tokenised and passed to the transformer. The output is a ranked list of review comments.}\n` +
        `\\label{fig:overview}\n\\end{figure}\n` +
        `As shown in \\autoref{fig:overview}, the system processes the input diff.`),
    ];
    const r = runFigureCheck(sections);
    const errors = r.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cross-section-check
// ---------------------------------------------------------------------------

describe("cross-section-check", () => {
  it("flags acronym defined multiple times", () => {
    const sections = [
      makeSection("sec-intro", "Introduction",
        "Large Language Models (LLM) have shown promise in code review."),
      makeSection("sec-method", "Methodology",
        "We use a Large Language Model (LLM) as the core component."),
    ];
    const r = runCrossSectionCheck(sections);
    expect(r.issues.some((i) => i.message.includes("LLM") && i.message.includes("defined"))).toBe(true);
  });

  it("flags inconsistent metric values across sections", () => {
    const sections = [
      makeSection("sec-abstract", "Abstract",
        "Our approach achieves 92% accuracy on the test set."),
      makeSection("sec-eval", "Evaluation",
        "We report an accuracy of 87% on the same test set."),
    ];
    const r = runCrossSectionCheck(sections);
    expect(r.issues.some((i) => i.message.includes("accuracy") && i.message.includes("inconsistent"))).toBe(true);
  });

  it("flags abstract number not appearing in results", () => {
    const sections = [
      makeSection("sec-abstract", "Abstract",
        "We achieve a 45% reduction in review latency."),
      makeSection("sec-eval", "Evaluation",
        "Our method reduces latency by 42% compared to the baseline."),
    ];
    const r = runCrossSectionCheck(sections);
    expect(r.issues.some((i) => i.message.includes("45%"))).toBe(true);
  });

  it("flags terminology drift", () => {
    const sections = [
      makeSection("sec-intro", "Introduction",
        "We evaluate on a large dataset of pull requests."),
      makeSection("sec-method", "Methodology",
        "The corpus was collected from GitHub over 12 months."),
      makeSection("sec-eval", "Evaluation",
        "Our benchmark contains 10,000 examples."),
    ];
    const r = runCrossSectionCheck(sections);
    expect(r.issues.some((i) => i.message.includes("terminology drift") || i.message.includes("synonyms"))).toBe(true);
  });

  it("returns no issues for a clean consistent paper", () => {
    const sections = [
      makeSection("sec-abstract", "Abstract",
        "Our approach achieves 42% reduction in latency on a test set of 5,000 pull requests."),
      makeSection("sec-intro", "Introduction",
        "Large Language Models (LLM) have shown promise. We evaluate on 5,000 pull requests."),
      makeSection("sec-eval", "Evaluation",
        "We evaluated on 5,000 pull requests. Our method achieves a 42% latency reduction."),
    ];
    const r = runCrossSectionCheck(sections);
    const errors = r.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});
