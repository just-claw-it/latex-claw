"use strict";

// popup.js — reads the sidecar from the active Overleaf tab via content script
// and renders a summary of issues.

async function loadReport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.includes("overleaf.com/project")) {
    showNotOverleaf();
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_SIDECAR_SUMMARY",
    });

    if (!response || !response.sidecar) {
      showNoReport();
      return;
    }

    renderReport(response.sidecar);
  } catch {
    showNoReport();
  }
}

function showNotOverleaf() {
  document.getElementById("status-text").textContent =
    "Open an Overleaf project to use latex-claw.";
  document.getElementById("empty-state").textContent =
    "Navigate to an Overleaf project page.";
}

function showNoReport() {
  document.getElementById("status-text").textContent =
    "No report found for this project.";
  document.getElementById("empty-state").textContent =
    "Save a .tex file in VS Code with latex-claw enabled to generate a report.";
}

function renderReport(sidecar) {
  // Count issues
  let errors = 0, warnings = 0, infos = 0;
  const allIssues = [];

  for (const [sectionKey, section] of Object.entries(sidecar.sections)) {
    for (const issue of section.issues) {
      if (issue.severity === "error")        errors++;
      else if (issue.severity === "warning") warnings++;
      else                                   infos++;
      allIssues.push({ ...issue, sectionKey });
    }
  }

  // Status line
  const generatedAt = new Date(sidecar.generatedAt).toLocaleTimeString();
  document.getElementById("status-text").textContent = `Report from ${generatedAt}`;

  const countRow = document.getElementById("count-row");
  countRow.style.display = "flex";
  document.getElementById("count-errors").textContent   = `${errors}✗`;
  document.getElementById("count-warnings").textContent = `${warnings}⚠`;
  document.getElementById("count-infos").textContent    = `${infos}ℹ`;

  // Issues list — show top 15 by severity
  const sorted = allIssues.sort((a, b) => {
    const sev = { error: 0, warning: 1, info: 2 };
    return sev[a.severity] - sev[b.severity];
  });
  const shown = sorted.slice(0, 15);

  const list = document.getElementById("issue-list");
  list.innerHTML = "";

  for (const issue of shown) {
    const li = document.createElement("li");
    li.className = `issue-item ${issue.severity}`;
    li.innerHTML =
      `<div class="issue-id">${issue.id} · ${issue.sectionKey.replace(/^sec-/, "").replace(/-/g, " ")}</div>` +
      `<div class="issue-msg">${escapeHtml(issue.message)}</div>`;
    list.appendChild(li);
  }

  if (allIssues.length > 15) {
    const li = document.createElement("li");
    li.style.cssText = "font-size:11px;color:#555;padding:4px 0;text-align:center";
    li.textContent = `…and ${allIssues.length - 15} more`;
    list.appendChild(li);
  }

  document.getElementById("empty-state").style.display = "none";
  document.getElementById("issues-section").style.display = "block";
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

loadReport();
