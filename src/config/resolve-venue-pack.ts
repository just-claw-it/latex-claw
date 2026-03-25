import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { BUNDLED_VENUE_PACKS } from "../venue-packs/bundled.js";
import type { VenuePackSource } from "../venue-packs/types.js";
import { DEFAULT_LATE_RELATED_WORK_VENUES } from "../skills/structure-check/default-late-venues.js";
import type { ResolvedVenuePack } from "../types/index.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePackYaml(raw: string): VenuePackSource {
  const data = parseYaml(raw);
  if (!isRecord(data)) throw new Error("Venue pack must be a YAML mapping");
  const id = data.id;
  const label = data.label;
  if (typeof id !== "string" || typeof label !== "string") {
    throw new Error("Venue pack requires string fields: id, label");
  }
  const out: VenuePackSource = { id, label };
  if (typeof data.version === "string") out.version = data.version;
  if (Array.isArray(data.late_related_work_venues_extra)) {
    out.late_related_work_venues_extra = data.late_related_work_venues_extra.filter(
      (x): x is string => typeof x === "string"
    );
  }
  if (Array.isArray(data.late_related_work_venues_replace)) {
    out.late_related_work_venues_replace = data.late_related_work_venues_replace.filter(
      (x): x is string => typeof x === "string"
    );
  }
  return out;
}

/** Merge default late-RW venue list with pack extras / replace. */
export function mergedLateRelatedVenues(pack: VenuePackSource): string[] {
  if (pack.late_related_work_venues_replace) {
    return [...pack.late_related_work_venues_replace];
  }
  const extra = pack.late_related_work_venues_extra ?? [];
  return [...new Set([...DEFAULT_LATE_RELATED_WORK_VENUES, ...extra])];
}

export function resolveVenuePackRef(
  configDir: string,
  packRef: string | undefined
): VenuePackSource {
  const ref = (packRef ?? "default").trim() || "default";

  if (BUNDLED_VENUE_PACKS[ref]) {
    return BUNDLED_VENUE_PACKS[ref];
  }

  const abs = path.isAbsolute(ref) ? ref : path.resolve(configDir, ref);
  const raw = fs.readFileSync(abs, "utf8");
  return parsePackYaml(raw);
}

export function toResolvedVenuePack(source: VenuePackSource): ResolvedVenuePack {
  return {
    id: source.id,
    version: source.version,
    label: source.label,
    lateRelatedWorkVenues: mergedLateRelatedVenues(source),
  };
}
