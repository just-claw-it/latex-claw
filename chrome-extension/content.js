"use strict";

// ---------------------------------------------------------------------------
// latex-claw Chrome extension — content script
//
// Strategy:
//   1. Poll the Overleaf file tree for latex-claw-report.json
//   2. When found (via the Overleaf Workshop file sync), parse it
//   3. Find \section{} lines in the CodeMirror editor DOM
//   4. Render margin annotation markers next to those lines
//   5. Re-render whenever the sidecar content changes
//
// No analysis happens here — this is a pure renderer.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS  = 3000;  // how often to re-check for a new sidecar
const SIDECAR_FILENAME  = "latex-claw-report.json";

let currentSidecarHash  = "";    // detect changes without re-parsing identical content
let annotationContainer = null;  // single container for all markers
let tooltip             = null;  // single shared tooltip element

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  createTooltip();
  injectBadge();
  pollForSidecar();
}

// Wait for Overleaf's editor to be ready before starting
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  // Overleaf is a SPA — the editor DOM may not exist yet.
  // Wait until the CodeMirror container appears.
  waitForEditor(boot);
}

function waitForEditor(cb) {
  const check = () => {
    if (document.querySelector(".cm-editor, .CodeMirror")) {
      cb();
    } else {
      setTimeout(check, 500);
    }
  };
  check();
}

// ---------------------------------------------------------------------------
// Sidecar polling
// Overleaf Workshop syncs project files into the Overleaf file tree.
// We fetch the raw file content via Overleaf's internal file API.
// ---------------------------------------------------------------------------

function pollForSidecar() {
  fetchSidecar().then((sidecar) => {
    if (sidecar) render(sidecar);
  });
  setInterval(() => {
    fetchSidecar().then((sidecar) => {
      if (sidecar) render(sidecar);
    });
  }, POLL_INTERVAL_MS);
}

async function fetchSidecar() {
  // Extract the project ID from the current URL: /project/<id>
  const projectId = extractProjectId();
  if (!projectId) return null;

  // Find the file entity ID for latex-claw-report.json by querying the project metadata
  const fileId = await findFileId(projectId, SIDECAR_FILENAME);
  if (!fileId) return null;

  // Fetch raw content
  const url = `/project/${projectId}/file/${fileId}`;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const text = await res.text();

    // Skip re-render if nothing changed (cheap hash)
    const hash = simpleHash(text);
    if (hash === currentSidecarHash) return null;
    currentSidecarHash = hash;

    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Cache project metadata to avoid re-fetching on every poll
let projectMetaCache = null;
let projectMetaCacheId = null;

async function findFileId(projectId, filename) {
  if (projectMetaCacheId !== projectId) {
    projectMetaCache = null;
    projectMetaCacheId = projectId;
  }

  if (!projectMetaCache) {
    try {
      const res = await fetch(`/project/${projectId}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      projectMetaCache = await res.json();
    } catch {
      return null;
    }
  }

  return findInTree(projectMetaCache?.project?.rootFolder, filename);
}

function findInTree(folders, filename) {
  if (!folders) return null;
  for (const folder of folders) {
    for (const file of folder.fileRefs ?? []) {
      if (file.name === filename) return file._id;
    }
    for (const doc of folder.docs ?? []) {
      if (doc.name === filename) return doc._id;
    }
    const found = findInTree(folder.folders, filename);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(sidecar) {
  clearAnnotations();

  const issues = collectIssues(sidecar);
  if (issues.length === 0) {
    updateBadge(0, 0, 0);
    return;
  }

  // Group issues by section
  const bySection = new Map();
  for (const issue of issues) {
    if (!bySection.has(issue.sectionKey)) bySection.set(issue.sectionKey, []);
    bySection.get(issue.sectionKey).push(issue);
  }

  // Find lines in the CodeMirror DOM and attach markers
  const lineElements = getEditorLines();

  for (const [sectionKey, sectionIssues] of bySection) {
    const lineEl = findSectionLine(lineElements, sectionKey);
    if (!lineEl) continue;

    const worstSeverity = sectionIssues.some((i) => i.severity === "error")
      ? "error"
      : sectionIssues.some((i) => i.severity === "warning")
      ? "warning"
      : "info";

    const marker = createMarker(sectionIssues, worstSeverity);
    attachMarker(lineEl, marker);
  }

  const errors   = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos    = issues.filter((i) => i.severity === "info").length;
  updateBadge(errors, warnings, infos);
}

function collectIssues(sidecar) {
  const out = [];
  for (const [sectionKey, section] of Object.entries(sidecar.sections)) {
    for (const issue of section.issues) {
      out.push({ ...issue, sectionKey });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CodeMirror DOM line traversal
// Overleaf uses CodeMirror 6. Lines are in .cm-line elements inside .cm-content.
// ---------------------------------------------------------------------------

function getEditorLines() {
  return Array.from(
    document.querySelectorAll(".cm-content .cm-line, .CodeMirror-line")
  );
}

// Find the line element whose text contains the \section{} heading matching sectionKey.
// sectionKey is "sec-introduction" — we reverse-slug it for a loose match.
function findSectionLine(lineElements, sectionKey) {
  if (sectionKey === "__document__" || sectionKey === "__figures__" || sectionKey === "__cross__") {
    return null; // document-level: no single line
  }

  // Align with VS Code: per-skill sidecar keys use :lang / :stats suffixes
  const baseKey = sectionKey.replace(/:(?:lang|stats)$/, "");

  // Reverse-slug: sec-related-work → ["related", "work"]
  const words = baseKey
    .replace(/^sec-/, "")
    .split("-")
    .filter(Boolean);

  // Also check for sec-abstract → \begin{abstract}
  const isAbstract = baseKey === "sec-abstract";

  for (const el of lineElements) {
    const text = el.textContent ?? "";
    if (isAbstract && text.includes("\\begin{abstract}")) return el;
    if (
      !isAbstract &&
      (text.includes("\\section") ||
        text.includes("\\subsection") ||
        text.includes("\\chapter")) &&
      words.every((w) => text.toLowerCase().includes(w))
    ) {
      return el;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Marker creation and attachment
// ---------------------------------------------------------------------------

function clearAnnotations() {
  document.querySelectorAll(".lc-annotation-marker").forEach((el) => el.remove());
}

function createMarker(issues, severity) {
  const marker = document.createElement("span");
  marker.className = `lc-annotation-marker lc-${severity}`;

  const icon = severity === "error" ? "✗" : severity === "warning" ? "⚠" : "ℹ";
  const count = issues.length;
  const firstMsg = issues[0].message.slice(0, 60) + (issues[0].message.length > 60 ? "…" : "");
  marker.textContent = `${icon} ${count > 1 ? count + " issues" : firstMsg}`;

  // Show tooltip on hover
  marker.addEventListener("mouseenter", (e) => {
    showTooltip(e, issues, severity);
  });
  marker.addEventListener("mouseleave", () => {
    hideTooltip();
  });

  return marker;
}

function attachMarker(lineEl, marker) {
  // Overleaf lines use position:relative — we can inject position:absolute children
  lineEl.style.position = "relative";
  lineEl.appendChild(marker);
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function createTooltip() {
  tooltip = document.createElement("div");
  tooltip.className = "lc-tooltip";
  document.body.appendChild(tooltip);
}

function showTooltip(event, issues, severity) {
  const lines = issues
    .map(
      (issue) =>
        `<div class="lc-tooltip-id">${issue.id}</div>` +
        `<div class="lc-tooltip-message lc-${issue.severity}">${escapeHtml(issue.message)}</div>` +
        `<div class="lc-tooltip-suggestion">${escapeHtml(issue.suggestion)}</div>`
    )
    .join('<hr style="border-color:#333;margin:8px 0">');

  tooltip.innerHTML = lines;
  tooltip.classList.add("lc-visible");

  // Position near cursor but avoid screen edge
  const x = Math.min(event.clientX + 12, window.innerWidth - 400);
  const y = Math.min(event.clientY + 12, window.innerHeight - 200);
  tooltip.style.left = `${x}px`;
  tooltip.style.top  = `${y}px`;
}

function hideTooltip() {
  tooltip.classList.remove("lc-visible");
}

// ---------------------------------------------------------------------------
// Badge injection into Overleaf toolbar
// ---------------------------------------------------------------------------

function injectBadge() {
  // Wait for the Overleaf toolbar to appear
  const tryInject = () => {
    const toolbar =
      document.querySelector(".toolbar-right") ||
      document.querySelector(".toolbar") ||
      document.querySelector("[class*='toolbar']");

    if (!toolbar) {
      setTimeout(tryInject, 1000);
      return;
    }

    if (document.getElementById("lc-badge")) return; // already injected

    const badge = document.createElement("span");
    badge.id = "lc-badge";
    badge.title = "latex-claw — click to refresh";
    badge.textContent = "🦞 --";
    badge.addEventListener("click", () => {
      // Force a fresh sidecar fetch
      currentSidecarHash = "";
      projectMetaCache = null;
    });
    toolbar.appendChild(badge);
  };
  tryInject();
}

function updateBadge(errors, warnings, infos) {
  const badge = document.getElementById("lc-badge");
  if (!badge) return;

  if (errors > 0) {
    badge.innerHTML = `🦞 <span class="lc-count-error">${errors}✗</span> <span class="lc-count-warning">${warnings}⚠</span>`;
  } else if (warnings > 0) {
    badge.innerHTML = `🦞 <span class="lc-count-warning">${warnings}⚠</span> <span style="color:#858585">${infos}ℹ</span>`;
  } else if (infos > 0) {
    badge.innerHTML = `🦞 <span style="color:#3794ff">${infos}ℹ</span>`;
  } else {
    badge.innerHTML = `🦞 <span class="lc-count-ok">✓</span>`;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractProjectId() {
  const m = location.pathname.match(/\/project\/([a-f0-9]+)/);
  return m ? m[1] : null;
}

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Message listener — respond to popup requesting the current sidecar summary
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_SIDECAR_SUMMARY") {
    // Re-fetch and return the latest sidecar
    fetchSidecar()
      .then((sidecar) => sendResponse({ sidecar }))
      .catch(() => sendResponse({ sidecar: null }));
    return true; // keep channel open for async response
  }
});
