import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Section, BibEntry } from "../types/index.js";

// ---------------------------------------------------------------------------
// LaTeX section extractor
// Handles: single-file, multi-file via \input{} / \include{} / \bibliography{},
// abstract environments, and non-standard headings.
// ---------------------------------------------------------------------------

const SECTION_RE  = /^[^%\n]*\\(section|subsection|subsubsection|chapter)\s*\*?\s*\{([^}]+)\}/gm;
const INPUT_RE    = /^[^%\n]*\\(?:input|include)\s*\{([^}]+)\}/gm;
const BIBFILE_RE  = /^[^%\n]*\\bibliography\s*\{([^}]+)\}/gm;
const ABSTRACT_RE = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/;

export interface ExtractedDocument {
  sections: Section[];
  bibliography: BibEntry[];
  allCiteKeys: string[];
}

export async function extractDocument(
  entryFile: string
): Promise<ExtractedDocument> {
  const root = path.dirname(entryFile);
  const fullSource = await resolveIncludes(entryFile, root, new Set());

  const sections = extractSections(fullSource, entryFile);

  // Resolve each .bib file referenced via \bibliography{refs} or \bibliography{a,b}
  const bibliography = await extractBibliographyFromSource(fullSource, root);
  const allCiteKeys = bibliography.map((e) => e.key);

  return { sections, bibliography, allCiteKeys };
}

// ---------------------------------------------------------------------------
// Recursively resolve \input{} and \include{} into one flat string.
// ---------------------------------------------------------------------------

async function resolveIncludes(
  filePath: string,
  root: string,
  visited: Set<string>
): Promise<string> {
  const abs = path.resolve(root, filePath.endsWith(".tex") ? filePath : `${filePath}.tex`);

  if (visited.has(abs)) return "";
  visited.add(abs);

  let source: string;
  try {
    source = await fs.readFile(abs, "utf8");
  } catch {
    return `% latex-claw: could not resolve \\input{${filePath}}\n`;
  }

  const lines = source.split("\n");
  const resolved: string[] = [];

  for (const line of lines) {
    const inputMatch = INPUT_RE.exec(line);
    INPUT_RE.lastIndex = 0;

    if (inputMatch) {
      const included = await resolveIncludes(inputMatch[1], root, visited);
      resolved.push(included);
    } else {
      resolved.push(line);
    }
  }

  return resolved.join("\n");
}

// ---------------------------------------------------------------------------
// Section extraction
// Synthesises a virtual Abstract section from \begin{abstract}...\end{abstract}
// so structure-check can find it even when authors don't use \section{Abstract}.
// ---------------------------------------------------------------------------

function extractSections(source: string, file: string): Section[] {
  const lines = source.split("\n");
  const rawMatches: { heading: string; level: number; lineStart: number }[] = [];

  // Synthesise abstract section from \begin{abstract} environment
  const abstractEnvMatch = ABSTRACT_RE.exec(source);
  if (abstractEnvMatch) {
    const lineStart = source.slice(0, abstractEnvMatch.index).split("\n").length;
    rawMatches.push({ heading: "Abstract", level: 0, lineStart });
  }

  // Collect all \section{} etc.
  let match: RegExpExecArray | null;
  while ((match = SECTION_RE.exec(source)) !== null) {
    const level =
      match[1] === "chapter" ? 0
      : match[1] === "section" ? 1
      : match[1] === "subsection" ? 2
      : 3;
    const lineStart = source.slice(0, match.index).split("\n").length;
    rawMatches.push({ heading: stripLatex(match[2]), level, lineStart });
  }

  // Sort by line position (abstract env may interleave with \section commands)
  rawMatches.sort((a, b) => a.lineStart - b.lineStart);

  // Deduplicate: if a \section{Abstract} also exists right after the abstract env,
  // keep only the environment-based one (it contains the actual text).
  const deduped = rawMatches.filter((m, i) => {
    if (i === 0) return true;
    const prev = rawMatches[i - 1];
    return !(
      m.heading.toLowerCase() === "abstract" &&
      prev.heading.toLowerCase() === "abstract" &&
      m.lineStart - prev.lineStart < 5
    );
  });

  const sections: Section[] = [];

  for (let i = 0; i < deduped.length; i++) {
    const { heading, level, lineStart } = deduped[i];
    const lineEnd = deduped[i + 1]?.lineStart ?? lines.length;
    const content = lines.slice(lineStart - 1, lineEnd - 1).join("\n");

    sections.push({
      id: slugify(heading),
      heading,
      level,
      file,
      lineStart,
      content,
      contentHash: sha256(content),
    });
  }

  // Fallback: no sections at all
  if (sections.length === 0) {
    sections.push({
      id: "document",
      heading: "(no sections detected)",
      level: 1,
      file,
      lineStart: 1,
      content: source,
      contentHash: sha256(source),
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// BibTeX resolution — follows \bibliography{refs} to load the actual .bib file(s).
// Falls back to scanning inline @-entries in the .tex source itself.
// ---------------------------------------------------------------------------

async function extractBibliographyFromSource(
  source: string,
  root: string
): Promise<BibEntry[]> {
  const entries: BibEntry[] = [];
  const bibFiles: string[] = [];

  // Collect all \bibliography{} references (may be comma-separated)
  let m: RegExpExecArray | null;
  while ((m = BIBFILE_RE.exec(source)) !== null) {
    for (const name of m[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed) bibFiles.push(trimmed);
    }
  }
  BIBFILE_RE.lastIndex = 0;

  // Read each .bib file
  for (const bibName of bibFiles) {
    const bibPath = path.resolve(
      root,
      bibName.endsWith(".bib") ? bibName : `${bibName}.bib`
    );
    let bibSource: string;
    try {
      bibSource = await fs.readFile(bibPath, "utf8");
    } catch {
      // .bib file not found — skip silently; citation-check will catch undefined keys
      continue;
    }
    entries.push(...extractBibliography(bibSource));
  }

  // If no \bibliography{} command found, fall back to scanning inline @-entries
  if (bibFiles.length === 0) {
    entries.push(...extractBibliography(source));
  }

  // Deduplicate by key (last definition wins, matching LaTeX behaviour)
  const byKey = new Map<string, BibEntry>();
  for (const e of entries) byKey.set(e.key, e);

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// BibTeX parser — parses raw .bib source content into BibEntry[]
// Uses brace-counting to correctly find entry boundaries rather than regex,
// which fails on nested braces inside field values.
// ---------------------------------------------------------------------------

export function extractBibliography(source: string): BibEntry[] {
  const entries: BibEntry[] = [];
  let i = 0;

  while (i < source.length) {
    // Find next @ that starts an entry
    const atIdx = source.indexOf("@", i);
    if (atIdx === -1) break;

    // Extract entry type
    const typeMatch = /^@(\w+)\s*\{/m.exec(source.slice(atIdx));
    if (!typeMatch) { i = atIdx + 1; continue; }

    const type = typeMatch[1].toLowerCase();
    const bodyStart = atIdx + typeMatch[0].length;

    // Walk forward counting braces to find the matching closing brace
    let depth = 1;
    let j = bodyStart;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") depth--;
      j++;
    }

    const entryBody = source.slice(bodyStart, j - 1); // content between outer braces
    i = j;

    if (type === "comment" || type === "preamble" || type === "string") continue;

    // Extract key: first token before first comma
    const keyMatch = /^\s*([^,\s]+)\s*,/.exec(entryBody);
    if (!keyMatch) continue;

    const key = keyMatch[1].trim();
    const fieldBody = entryBody.slice(keyMatch[0].length);
    const fields = parseBibFields(fieldBody);
    entries.push({ key, type, fields });
  }

  return entries;
}

function parseBibFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const fieldRe = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)"|(\d+))/gs;

  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const name = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    fields[name] = value;
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Cite key extractor — from LaTeX content
// ---------------------------------------------------------------------------

export function extractCiteKeys(content: string): string[] {
  const keys = new Set<string>();
  // Matches \cite, \citep, \citet, \citeauthor, \citeyear, \citealt, etc.
  // Strips optional args: \cite[p.~5]{key}
  const citeRe = /\\cite[a-zA-Z]*\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

  let m: RegExpExecArray | null;
  while ((m = citeRe.exec(content)) !== null) {
    for (const key of m[1].split(",")) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }

  return [...keys];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function stripLatex(s: string): string {
  // Phase 1: strip \cmd{content} iteratively until no more matches.
  // Must be separate from bare-brace stripping to avoid \textbf{\emph{x}}
  // collapsing to \emphx (bare-brace regex eating the inner arg prematurely).
  let prev = "";
  let cur = s;
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, "$1");
  }
  // Phase 2: remove any remaining bare braces, accents, dashes, whitespace
  return cur
    .replace(/\{([^{}]*)\}/g, "$1")
    .replace(/\\['"`.^~=|]/g, "")
    .replace(/\\[-\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(s: string): string {
  return "sec-" + s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}
