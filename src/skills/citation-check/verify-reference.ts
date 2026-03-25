import type { BibEntry, VerificationResult } from "../../types/index.js";
import { stripLatex } from "./strip-latex.js";

// ---------------------------------------------------------------------------
// Reference verification: DOI → Semantic Scholar → CrossRef
// ---------------------------------------------------------------------------

const DELAY_MS = 200; // between external API calls, per endpoint
const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const CR_BASE = "https://api.crossref.org";
const TITLE_MATCH_THRESHOLD = 0.15; // normalised edit distance

// In-process cache so the same key isn't verified twice per run
const cache = new Map<string, VerificationResult>();

export function clearVerificationCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Main verification entry point
// ---------------------------------------------------------------------------

export async function verifyReference(entry: BibEntry): Promise<VerificationResult> {
  if (cache.has(entry.key)) return cache.get(entry.key)!;

  const result = await doVerify(entry);
  cache.set(entry.key, result);
  return result;
}

async function doVerify(entry: BibEntry): Promise<VerificationResult> {
  // Step 1: DOI (if present)
  const doi = entry.fields["doi"];
  if (doi) {
    const doiResult = await checkDoi(entry.key, doi.trim());
    if (doiResult.status !== "skipped") return doiResult;
    // Fall through to S2 if DOI check was inconclusive
  }

  // Only verify article and inproceedings via title lookup — misc entries are too unreliable
  const verifiableTypes = ["article", "inproceedings", "proceedings", "book", "phdthesis"];
  if (!verifiableTypes.includes(entry.type.toLowerCase())) {
    return skip(entry.key, `Entry type '${entry.type}' not verified via title lookup.`);
  }

  const title = entry.fields["title"];
  if (!title) {
    return skip(entry.key, "No title field — cannot look up.");
  }

  // Step 2: Semantic Scholar
  await delay(DELAY_MS);
  const s2Result = await checkSemanticScholar(entry, stripLatex(title));
  if (s2Result.status !== "not-found") return s2Result;

  // Step 3: CrossRef fallback (article + inproceedings only)
  if (["article", "inproceedings"].includes(entry.type.toLowerCase())) {
    await delay(DELAY_MS);
    return checkCrossRef(entry, stripLatex(title));
  }

  return { citeKey: entry.key, status: "not-found", confidence: "low" };
}

// ---------------------------------------------------------------------------
// Step 1: DOI check
// ---------------------------------------------------------------------------

async function checkDoi(citeKey: string, doi: string): Promise<VerificationResult> {
  const url = `https://doi.org/${doi}`;
  try {
    const res = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" }, 5000);
    if (res.ok || res.status === 302 || res.status === 301) {
      return { citeKey, status: "verified", confidence: "high", note: `DOI ${doi} resolved.` };
    }
    if (res.status === 404 || res.status === 410) {
      return { citeKey, status: "doi-invalid", confidence: "high", note: `DOI ${doi} returned HTTP ${res.status}.` };
    }
    // Unexpected status — treat as inconclusive
    return skip(citeKey, `DOI check returned HTTP ${res.status} — falling back to title lookup.`);
  } catch (err) {
    return skip(citeKey, `DOI check timed out or failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Semantic Scholar
// ---------------------------------------------------------------------------

interface S2Paper {
  title: string;
  year?: number;
  authors?: { name: string }[];
  venue?: string;
  externalIds?: Record<string, string>;
}

async function checkSemanticScholar(
  entry: BibEntry,
  cleanTitle: string
): Promise<VerificationResult> {
  const query = encodeURIComponent(cleanTitle);
  const url = `${S2_BASE}/paper/search?query=${query}&fields=title,authors,year,venue,externalIds&limit=1`;

  let paper: S2Paper;
  try {
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) {
      return skip(entry.key, `Semantic Scholar returned HTTP ${res.status}.`);
    }
    const data = (await res.json()) as { data?: S2Paper[] };
    if (!data.data || data.data.length === 0) {
      return { citeKey: entry.key, status: "not-found", confidence: "low" };
    }
    paper = data.data[0];
  } catch {
    return skip(entry.key, "Semantic Scholar request failed.");
  }

  // Compare title
  const dist = normalizedEditDistance(
    normTitle(cleanTitle),
    normTitle(paper.title ?? "")
  );

  if (dist > TITLE_MATCH_THRESHOLD) {
    return { citeKey: entry.key, status: "not-found", confidence: "low", note: `Best title match distance: ${dist.toFixed(2)}` };
  }

  // Title matched — now check authors and year
  const issues: string[] = [];

  const bibYear = parseInt(entry.fields["year"] ?? "0", 10);
  if (paper.year && bibYear && Math.abs(bibYear - paper.year) > 1) {
    issues.push(`Year: BibTeX ${bibYear}, found ${paper.year}.`);
  }

  const bibAuthors = parseAuthorSurnames(entry.fields["author"] ?? "");
  const s2Authors = (paper.authors ?? []).map((a) =>
    a.name.split(/\s+/).at(-1)?.toLowerCase() ?? ""
  );
  const authorOverlap = bibAuthors.filter((a) => s2Authors.includes(a)).length;

  if (authorOverlap === 0 && bibAuthors.length > 0 && s2Authors.length > 0) {
    const note = `Title match (distance ${dist.toFixed(2)}). Author overlap: 0 of ${bibAuthors.length}. BibTeX: ${bibAuthors.join(", ")}; found: ${s2Authors.join(", ")}.${issues.length ? " " + issues.join(" ") : ""}`;
    return { citeKey: entry.key, status: "mismatch", confidence: "high", note };
  }

  if (issues.length > 0) {
    return {
      citeKey: entry.key,
      status: "mismatch",
      confidence: "medium",
      note: `Title matched. ${issues.join(" ")} Authors overlap: ${authorOverlap}/${bibAuthors.length}.`,
    };
  }

  return {
    citeKey: entry.key,
    status: "verified",
    confidence: "high",
    note: `Title match (distance ${dist.toFixed(2)}), authors overlap: ${authorOverlap}/${Math.max(bibAuthors.length, 1)}.`,
  };
}

// ---------------------------------------------------------------------------
// Step 3: CrossRef fallback
// ---------------------------------------------------------------------------

async function checkCrossRef(
  entry: BibEntry,
  cleanTitle: string
): Promise<VerificationResult> {
  const firstAuthorSurname = parseAuthorSurnames(entry.fields["author"] ?? "")[0] ?? "";
  const params = new URLSearchParams({
    "query.title": cleanTitle,
    ...(firstAuthorSurname ? { "query.author": firstAuthorSurname } : {}),
    rows: "1",
  });
  const url = `${CR_BASE}/works?${params}`;

  try {
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) {
      return skip(entry.key, `CrossRef returned HTTP ${res.status}.`);
    }

    const data = (await res.json()) as {
      message?: { items?: Array<{ title?: string[]; author?: Array<{ family: string }> }> };
    };

    const items = data.message?.items;
    if (!items || items.length === 0) {
      return { citeKey: entry.key, status: "not-found", confidence: "low", note: "Not found in CrossRef." };
    }

    const item = items[0];
    const foundTitle = item.title?.[0] ?? "";
    const dist = normalizedEditDistance(normTitle(cleanTitle), normTitle(foundTitle));

    if (dist > TITLE_MATCH_THRESHOLD) {
      return { citeKey: entry.key, status: "not-found", confidence: "low", note: `CrossRef best match distance: ${dist.toFixed(2)}.` };
    }

    const crAuthors = (item.author ?? []).map((a) => a.family.toLowerCase());
    const bibAuthors = parseAuthorSurnames(entry.fields["author"] ?? "");
    const overlap = bibAuthors.filter((a) => crAuthors.includes(a)).length;

    if (overlap === 0 && bibAuthors.length > 0 && crAuthors.length > 0) {
      return {
        citeKey: entry.key,
        status: "mismatch",
        confidence: "medium",
        note: `CrossRef title match (distance ${dist.toFixed(2)}). Author overlap: 0. BibTeX: ${bibAuthors.join(", ")}; found: ${crAuthors.join(", ")}.`,
      };
    }

    return {
      citeKey: entry.key,
      status: "verified",
      confidence: "medium",
      note: `CrossRef title match (distance ${dist.toFixed(2)}), author overlap: ${overlap}/${Math.max(bibAuthors.length, 1)}.`,
    };
  } catch {
    return skip(entry.key, "CrossRef request failed.");
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function skip(citeKey: string, note: string): VerificationResult {
  return { citeKey, status: "skipped", confidence: "low", note };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function parseAuthorSurnames(authorField: string): string[] {
  // BibTeX formats: "Last, First and Last, First" or "First Last and First Last"
  if (!authorField.trim()) return [];
  return authorField
    .split(/\s+and\s+/i)
    .map((a) => {
      const parts = a.trim().split(",");
      if (parts.length >= 2) return parts[0].trim().toLowerCase(); // "Last, First"
      return a.trim().split(/\s+/).at(-1)?.toLowerCase() ?? ""; // "First Last"
    })
    .filter(Boolean);
}

// Levenshtein edit distance, normalised by max(len(a), len(b))
function normalizedEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return 1;
  if (n === 0) return 1;

  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n] / Math.max(m, n);
}
