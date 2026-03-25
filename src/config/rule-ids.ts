/** Stable IDs for structure-check — use in latex-claw.yaml `overrides.disable`. */
export const STRUCTURE_RULE = {
  EMPTY_DOCUMENT: "structure.empty-document",
  REQUIRED_ABSTRACT: "structure.required.abstract",
  REQUIRED_INTRODUCTION: "structure.required.introduction",
  REQUIRED_RELATED_WORK: "structure.required.related-work",
  REQUIRED_METHODOLOGY: "structure.required.methodology",
  REQUIRED_EVALUATION: "structure.required.evaluation",
  REQUIRED_CONCLUSION: "structure.required.conclusion",
  REQUIRED_REFERENCES: "structure.required.references",
  NAME_NON_ACADEMIC: "structure.name.non-academic",
  NAME_AMBIGUOUS: "structure.name.ambiguous",
  ORDER_ABSTRACT_FIRST: "structure.order.abstract-first",
  ORDER_INTRO_AFTER_ABSTRACT: "structure.order.intro-after-abstract",
  ORDER_REFERENCES_AFTER_CONCLUSION: "structure.order.references-after-conclusion",
  ORDER_RELATED_AFTER_EVALUATION: "structure.order.related-after-evaluation",
  DUPLICATE_HEADING: "structure.duplicate-heading",
} as const;

export type StructureRuleId = (typeof STRUCTURE_RULE)[keyof typeof STRUCTURE_RULE];
