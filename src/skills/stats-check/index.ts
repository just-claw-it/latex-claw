import type { Section, Issue } from "../../types/index.js";

// ---------------------------------------------------------------------------
// stats-check (scope: section)
// Detects statistical reporting problems: missing tests, p-value misuse,
// unreported effect sizes, missing confidence intervals, and percentage
// arithmetic errors.
// ---------------------------------------------------------------------------

const VERSION = "1.0.0";

export interface StatsCheckOutput {
  skill: "stats-check";
  version: string;
  sectionId: string;
  issues: Issue[];
  summary: string;
}

export function runStatsCheck(section: Section): StatsCheckOutput {
  const issues: Issue[] = [];
  let counter = 0;
  const nextId = () => `stats-${String(++counter).padStart(3, "0")}`;

  const text = stripLatexForText(section.content);

  // ------------------------------------------------------------------
  // 1. "Significant" / "significantly" without a p-value nearby
  // ------------------------------------------------------------------
  const sigRe = /\b(significant(ly)?|statistically significant)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = sigRe.exec(text)) !== null) {
    // Check the surrounding ±300 chars for a p-value or test statistic
    const window = text.slice(Math.max(0, m.index - 300), m.index + 300);
    const hasPValue = /p\s*[<=>≤≥]\s*0?\.\d+|p-value/i.test(window);
    const hasTestStat = /\b(t|F|z|χ²|chi.?squared?|Mann.Whitney|Wilcoxon|ANOVA|Kruskal)\s*[\(\[=]/i.test(window);

    if (!hasPValue && !hasTestStat) {
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId: section.id,
        message: `"${m[0]}" used without a reported p-value or test statistic nearby.`,
        suggestion:
          "Report the test name, statistic (t, F, χ², etc.), degrees of freedom, and exact p-value. Example: t(38) = 3.2, p = 0.003.",
      });
      if (issues.length >= 3) break; // cap flood
    }
  }

  // ------------------------------------------------------------------
  // 2. p-value threshold only (p < 0.05 without context)
  // ------------------------------------------------------------------
  const pThreshRe = /\bp\s*<\s*0\.05\b/gi;
  while ((m = pThreshRe.exec(text)) !== null) {
    const window = text.slice(Math.max(0, m.index - 200), m.index + 200);
    // Check if exact p-value is also reported
    const hasExact = /p\s*[=≈]\s*0?\.\d+/.test(window);
    if (!hasExact) {
      issues.push({
        id: nextId(),
        severity: "info",
        sectionId: section.id,
        message: 'Threshold "p < 0.05" reported without the exact p-value.',
        suggestion:
          "Report the exact p-value (e.g., p = 0.03) in addition to the threshold. This allows readers to judge practical significance.",
      });
      break; // one is enough
    }
  }

  // ------------------------------------------------------------------
  // 3. Effect size missing alongside significance claims
  // ------------------------------------------------------------------
  const hasSigClaim = /\b(significant(ly)?|p\s*[<=>≤]\s*0?\.\d+)\b/i.test(text);
  const hasEffectSize = /\b(effect size|cohen'?s?\s*d|cohen'?s?\s*f|eta.?squared?|omega.?squared?|hedges'?\s*g|cliff'?s?\s*delta|glass'?\s*delta|r\s*=\s*[-−]?\d|odds ratio|OR\s*=|hazard ratio|HR\s*=|relative risk|RR\s*=)\b/i.test(text);

  if (hasSigClaim && !hasEffectSize) {
    issues.push({
      id: nextId(),
      severity: "warning",
      sectionId: section.id,
      message: "Statistical significance reported without an effect size measure.",
      suggestion:
        "Report an effect size (Cohen's d, η², Cliff's delta, etc.) alongside p-values. Statistical significance alone does not indicate practical importance.",
    });
  }

  // ------------------------------------------------------------------
  // 4. Confidence intervals missing for estimates
  // ------------------------------------------------------------------
  const hasEstimate = /\b(mean|median|average|accuracy|precision|recall|F1|AUC|BLEU|ROUGE)\s*[=:]\s*\d/i.test(text);
  const hasCI = /\b(95%\s*CI|confidence interval|±|\bCI\b|\[[\d.,\s]+,\s*[\d.,\s]+\])\b/i.test(text);

  if (hasEstimate && !hasCI) {
    issues.push({
      id: nextId(),
      severity: "info",
      sectionId: section.id,
      message: "Point estimates reported without confidence intervals.",
      suggestion:
        "Add 95% confidence intervals or standard errors for all reported metrics. Example: accuracy = 0.84 (95% CI: [0.79, 0.89]).",
    });
  }

  // ------------------------------------------------------------------
  // 5. Sample size not mentioned when results are reported
  // ------------------------------------------------------------------
  const hasResults = /\b(accuracy|precision|recall|F1|improvement|reduction|increase|decrease|outperform)\b/i.test(text);
  const hasSampleSize = /\b(n\s*=\s*\d|\d+\s*(participants?|subjects?|samples?|instances?|examples?|items?|projects?|repositories?|pull\s*requests?|papers?|articles?))\b/i.test(text);

  if (hasResults && !hasSampleSize) {
    issues.push({
      id: nextId(),
      severity: "warning",
      sectionId: section.id,
      message: "Results reported without mentioning sample size in this section.",
      suggestion:
        "State the sample size (n =) alongside all performance metrics. Reviewers will check this.",
    });
  }

  // ------------------------------------------------------------------
  // 6. Percentage arithmetic sanity check
  // ------------------------------------------------------------------
  checkPercentageArithmetic(text, section.id, nextId, issues);

  // ------------------------------------------------------------------
  // 7. Baseline comparison missing
  // ------------------------------------------------------------------
  const hasComparison = /\b(baseline|compared to|vs\.?|versus|outperform|better than|worse than|improvement over|reduction from)\b/i.test(text);
  const hasMetricClaim = /\b(\d+(\.\d+)?%?\s*(improvement|reduction|increase|decrease|gain|speedup|accuracy|precision|recall))\b/i.test(text);

  if (hasMetricClaim && !hasComparison) {
    issues.push({
      id: nextId(),
      severity: "warning",
      sectionId: section.id,
      message: "Metric improvement claimed without an explicit baseline comparison.",
      suggestion:
        "State what the improvement is relative to: which baseline, which metric, which dataset.",
    });
  }

  const errorCount   = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    skill: "stats-check",
    version: VERSION,
    sectionId: section.id,
    issues,
    summary:
      issues.length === 0
        ? "No statistical reporting issues found."
        : `${errorCount} error(s), ${warningCount} warning(s), ${issues.filter((i) => i.severity === "info").length} info(s).`,
  };
}

// ---------------------------------------------------------------------------
// Percentage arithmetic checker
// Looks for patterns like "X% improvement" and checks if the calculation
// is arithmetically consistent with other numbers in the section.
// ---------------------------------------------------------------------------

function checkPercentageArithmetic(
  text: string,
  sectionId: string,
  nextId: () => string,
  issues: Issue[]
): void {
  // Extract "X% improvement/reduction/increase/decrease" claims
  const claimRe = /(\d+(?:\.\d+)?)\s*%\s*(improvement|reduction|increase|decrease|gain|speedup)/gi;
  let m: RegExpExecArray | null;

  while ((m = claimRe.exec(text)) !== null) {
    const pct = parseFloat(m[1]);
    const direction = m[2].toLowerCase();

    // Look for two adjacent numbers that could be the before/after values
    const window = text.slice(Math.max(0, m.index - 400), m.index + 100);
    const numRe = /(\d+(?:\.\d+)?)/g;
    const nums: number[] = [];
    let nm: RegExpExecArray | null;
    while ((nm = numRe.exec(window)) !== null) {
      const v = parseFloat(nm[1]);
      if (v > 0 && v !== pct && v < 1e6) nums.push(v);
    }

    // Try all pairs for consistency
    let foundConsistent = false;
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const a = nums[i], b = nums[j];
        if (a === 0) continue;
        const computedPct = direction.startsWith("red") || direction === "decrease"
          ? Math.abs((a - b) / a) * 100
          : Math.abs((b - a) / a) * 100;
        if (Math.abs(computedPct - pct) < 2) { // 2% tolerance
          foundConsistent = true;
          break;
        }
      }
      if (foundConsistent) break;
    }

    // Only flag when we found surrounding numbers but they don't match
    if (!foundConsistent && nums.length >= 2) {
      issues.push({
        id: nextId(),
        severity: "warning",
        sectionId,
        message: `Claimed ${pct}% ${direction} — surrounding numbers in context don't verify this calculation.`,
        suggestion:
          "Double-check the arithmetic. If the numbers are elsewhere in the paper, add a cross-reference.",
      });
    }
  }
}

function stripLatexForText(content: string): string {
  return content
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " DISPLAYMATH ")
    .replace(/\$[^$\n]*\$/g, " INLINEMATH ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ");
}
