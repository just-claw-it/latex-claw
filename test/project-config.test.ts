import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findProjectConfigFile,
  loadProjectConfig,
} from "../src/config/project-config.js";

describe("project config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lc-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds latex-claw.yaml in the same directory as the .tex", () => {
    const yaml = "venue: TOSEM\nvenue_pack: default\n";
    fs.writeFileSync(path.join(tmp, "latex-claw.yaml"), yaml, "utf8");
    expect(findProjectConfigFile(tmp)).toBe(path.join(tmp, "latex-claw.yaml"));
  });

  it("finds latex-claw.yaml in a parent directory", () => {
    fs.writeFileSync(path.join(tmp, "latex-claw.yaml"), "venue_pack: icse\n", "utf8");
    const nested = path.join(tmp, "paper", "ch");
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectConfigFile(nested)).toBe(path.join(tmp, "latex-claw.yaml"));
  });

  it("loadProjectConfig merges venue, pack, and disable rules", () => {
    fs.writeFileSync(
      path.join(tmp, "latex-claw.yaml"),
      [
        'label: "My submission"',
        "venue: ICSE",
        "venue_pack: strict",
        "overrides:",
        "  disable:",
        "    - structure.order.related-after-evaluation",
      ].join("\n"),
      "utf8"
    );
    const state = loadProjectConfig(tmp, null);
    expect(state.config.label).toBe("My submission");
    expect(state.config.venue).toBe("ICSE");
    expect(state.config.disableRules).toContain(
      "structure.order.related-after-evaluation"
    );
    expect(state.resolvedVenuePack.id).toBe("latex-claw/strict-order");
    expect(state.resolvedVenuePack.lateRelatedWorkVenues).toEqual([]);
    expect(state.fingerprint.length).toBe(16);
  });

  it("throws when --config points to a missing file", () => {
    expect(() =>
      loadProjectConfig(tmp, path.join(tmp, "nope.yaml"))
    ).toThrow(/not found/);
  });
});
