import { describe, it, expect } from "vitest";
import {
  sidecarStorageKey,
  isSkillName,
  SKILL_NAME_VALUES,
} from "../src/engine/dispatcher.js";

describe("isSkillName", () => {
  it("accepts known skills and rejects unknown", () => {
    expect(isSkillName("all")).toBe(true);
    expect(isSkillName("structure-check")).toBe(true);
    expect(isSkillName("not-a-skill")).toBe(false);
    expect(SKILL_NAME_VALUES.length).toBe(7);
  });
});

describe("sidecarStorageKey", () => {
  it("matches dispatcher cache keys so skills do not overwrite the same sidecar entry", () => {
    const sec = "sec-introduction";
    expect(sidecarStorageKey("structure-check", "__document__")).toBe("__document__");
    expect(sidecarStorageKey("citation-check", sec)).toBe(sec);
    expect(sidecarStorageKey("language-check", sec)).toBe(`${sec}:lang`);
    expect(sidecarStorageKey("stats-check", sec)).toBe(`${sec}:stats`);
    expect(sidecarStorageKey("figure-check", "__figures__")).toBe("__figures__");
    expect(sidecarStorageKey("cross-section-check", "__cross__")).toBe("__cross__");
  });
});
