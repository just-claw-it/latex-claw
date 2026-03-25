/** Raw pack definition (bundled or from YAML file). */
export interface VenuePackSource {
  id: string;
  version?: string;
  label: string;
  /** Union these substrings (lowercase) with the default late-RW allowlist. */
  late_related_work_venues_extra?: string[];
  /** If set, replaces the default allowlist entirely (empty = never allow late Related Work). */
  late_related_work_venues_replace?: string[];
}
