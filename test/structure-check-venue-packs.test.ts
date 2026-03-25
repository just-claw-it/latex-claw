import { describe, it, expect } from "vitest";
import { runStructureCheck } from "../src/skills/structure-check/index.js";
import { toResolvedVenuePack } from "../src/config/resolve-venue-pack.js";
import { BUNDLED_VENUE_PACKS } from "../src/venue-packs/bundled.js";
import { STRUCTURE_RULE } from "../src/config/rule-ids.js";
import type { StructureCheckInput } from "../src/types/index.js";

function makeSection(heading: string, id?: string) {
  const slug = id ?? "sec-" + heading.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { id: slug, heading, level: 1, file: "paper.tex", lineStart: 1 };
}

const lateRelatedOrderHeadings = [
  "Abstract",
  "Introduction",
  "Methodology",
  "Evaluation",
  "Related Work",
  "Conclusion",
  "References",
];

describe("structure-check: venue packs", () => {
  it("strict pack warns about late Related Work even when venue is ICSE", () => {
    const strict = toResolvedVenuePack(BUNDLED_VENUE_PACKS.strict);
    const result = runStructureCheck({
      paperType: "full",
      venue: "ICSE 2026",
      venuePack: strict,
      sections: lateRelatedOrderHeadings.map((h) => makeSection(h)),
    });
    expect(
      result.issues.some(
        (i) =>
          i.ruleId === STRUCTURE_RULE.ORDER_RELATED_AFTER_EVALUATION &&
          i.severity === "warning"
      )
    ).toBe(true);
  });

  it("default pack does not warn for late Related Work at ICSE", () => {
    const result = runStructureCheck({
      paperType: "full",
      venue: "ICSE",
      sections: lateRelatedOrderHeadings.map((h) => makeSection(h)),
    });
    expect(
      result.issues.some(
        (i) => i.message.includes("Related Work appears after Evaluation")
      )
    ).toBe(false);
  });

  it("respects disabledRuleIds from config", () => {
    const strict = toResolvedVenuePack(BUNDLED_VENUE_PACKS.strict);
    const input: StructureCheckInput = {
      paperType: "full",
      venue: "ICSE",
      venuePack: strict,
      disabledRuleIds: [STRUCTURE_RULE.ORDER_RELATED_AFTER_EVALUATION],
      sections: lateRelatedOrderHeadings.map((h) => makeSection(h)),
    };
    const result = runStructureCheck(input);
    expect(
      result.issues.some(
        (i) => i.ruleId === STRUCTURE_RULE.ORDER_RELATED_AFTER_EVALUATION
      )
    ).toBe(false);
  });

  it("tags issues with pack id", () => {
    const result = runStructureCheck({
      paperType: "full",
      venue: null,
      sections: [],
    });
    expect(result.issues[0].packId).toBe("latex-claw/default");
    expect(result.issues[0].ruleId).toBe(STRUCTURE_RULE.EMPTY_DOCUMENT);
  });
});
