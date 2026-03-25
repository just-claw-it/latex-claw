import type { VenuePackSource } from "./types.js";

/** Shipped packs — select with `venue_pack: <name>` in latex-claw.yaml */
export const BUNDLED_VENUE_PACKS: Record<string, VenuePackSource> = {
  default: {
    id: "latex-claw/default",
    version: "1.0.0",
    label: "Generic empirical CS paper (built-in defaults)",
  },
  icse: {
    id: "latex-claw/icse-family",
    version: "1.0.0",
    label: "ICSE / FSE / ASE / MSR-style (late Related Work is common)",
    late_related_work_venues_extra: ["icse", "fse", "ase"],
  },
  strict: {
    id: "latex-claw/strict-order",
    version: "1.0.0",
    label: "Strict section order (flag late Related Work even at SE venues)",
    late_related_work_venues_replace: [],
  },
};
