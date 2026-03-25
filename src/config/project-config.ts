import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  resolveVenuePackRef,
  toResolvedVenuePack,
} from "./resolve-venue-pack.js";
import type { ResolvedVenuePack } from "../types/index.js";

const CONFIG_FILENAME = "latex-claw.yaml";

export interface ProjectConfig {
  /** Absolute path to the config file, if any. */
  configPath: string | null;
  /** Paper label for humans (optional). */
  label?: string;
  /** Target venue string (merged with CLI --venue). */
  venue?: string;
  /** Bundled pack name or path to a pack YAML file. */
  venuePackRef?: string;
  /** Rule IDs to suppress (structure-check). */
  disableRules: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseProjectYaml(text: string): Omit<ProjectConfig, "configPath"> {
  const data = parseYaml(text);
  if (data == null || data === undefined) {
    return { disableRules: [] };
  }
  if (!isRecord(data)) {
    return { disableRules: [] };
  }
  const out: Omit<ProjectConfig, "configPath"> = { disableRules: [] };
  if (typeof data.label === "string") out.label = data.label;
  if (typeof data.venue === "string") out.venue = data.venue;
  if (typeof data.venue_pack === "string") out.venuePackRef = data.venue_pack;
  if (isRecord(data.overrides) && Array.isArray(data.overrides.disable)) {
    out.disableRules = data.overrides.disable.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/** Walk upward from `startDir` looking for latex-claw.yaml */
export function findProjectConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 24; i++) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface LoadedProjectState {
  config: ProjectConfig;
  /** For cache invalidation when config / pack / disables change. */
  fingerprint: string;
  resolvedVenuePack: ResolvedVenuePack;
}

function hashFingerprint(parts: unknown[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Load latex-claw.yaml next to (or above) the main .tex file.
 * @param texFileDir — directory containing the entry .tex
 * @param explicitConfigPath — if set, use this file instead of searching
 */
export function loadProjectConfig(
  texFileDir: string,
  explicitConfigPath?: string | null
): LoadedProjectState {
  let configPath: string | null = null;

  if (explicitConfigPath != null && explicitConfigPath !== "") {
    const abs = path.resolve(explicitConfigPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`latex-claw: --config file not found: ${abs}`);
    }
    configPath = abs;
  } else {
    configPath = findProjectConfigFile(texFileDir);
  }

  const configDir = configPath ? path.dirname(configPath) : texFileDir;

  let base: ProjectConfig = {
    configPath: configPath,
    disableRules: [],
  };

  if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = parseProjectYaml(raw);
    base = {
      configPath,
      label: parsed.label,
      venue: parsed.venue,
      venuePackRef: parsed.venuePackRef,
      disableRules: parsed.disableRules,
    };
  }

  const packSource = resolveVenuePackRef(configDir, base.venuePackRef);
  const resolvedVenuePack = toResolvedVenuePack(packSource);

  const fingerprint = hashFingerprint([
    configPath,
    base.venue,
    base.venuePackRef,
    base.disableRules.slice().sort(),
    resolvedVenuePack.id,
    resolvedVenuePack.lateRelatedWorkVenues.slice().sort(),
  ]);

  return {
    config: base,
    fingerprint,
    resolvedVenuePack,
  };
}
