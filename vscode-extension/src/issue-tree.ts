import * as vscode from "vscode";
import type { Sidecar, SidecarIssue } from "./sidecar-reader";

// ---------------------------------------------------------------------------
// IssueTreeProvider
// Drives the "latex-claw Issues" sidebar panel.
// Tree structure:  Skill group → Section → Individual issue
// ---------------------------------------------------------------------------

type SkillGroup = {
  kind: "skill";
  skill: string;
  issues: Array<SidecarIssue & { sectionKey: string }>;
};

type SectionNode = {
  kind: "section";
  skill: string;
  sectionKey: string;
  issues: SidecarIssue[];
};

type IssueNode = {
  kind: "issue";
  issue: SidecarIssue;
  sectionKey: string;
};

type TreeNode = SkillGroup | SectionNode | IssueNode;

export class IssueTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sidecar: Sidecar | null = null;
  private texFile: string | null = null;

  update(texFile: string, sidecar: Sidecar | null): void {
    this.texFile = texFile;
    this.sidecar = sidecar;
    this._onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    this.sidecar = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "skill") {
      const errorCount = node.issues.filter((i) => i.severity === "error").length;
      const warnCount  = node.issues.filter((i) => i.severity === "warning").length;
      const label = `${skillLabel(node.skill)}  (${errorCount}✗ ${warnCount}⚠)`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = skillIcon(node.skill);
      item.contextValue = "skillGroup";
      return item;
    }

    if (node.kind === "section") {
      const rawKey = node.sectionKey.replace(/:(?:lang|stats)$/, "");
      const label =
        rawKey === "__document__"
          ? "Document"
          : rawKey === "__figures__"
          ? "Figures"
          : rawKey === "__cross__"
          ? "Cross-section"
          : rawKey.replace(/^sec-/, "").replace(/-/g, " ");
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = "sectionNode";
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
      return item;
    }

    // IssueNode
    const { issue } = node;
    const prefix = issue.citeKey ? `[${issue.citeKey}] ` : "";
    const item = new vscode.TreeItem(`${prefix}${issue.message}`);
    item.description = issue.suggestion;
    const policy =
      issue.ruleId != null
        ? `\n\n\`${issue.packId ?? "—"} · ${issue.ruleId}\``
        : "";
    item.tooltip = new vscode.MarkdownString(
      `**${issue.id}** · ${issue.severity}${policy}\n\n${issue.message}\n\n→ ${issue.suggestion}`
    );
    item.iconPath = severityIcon(issue.severity);
    item.contextValue = "issueNode";

    // Navigate to the section in the document when clicked
    if (this.texFile) {
      item.command = {
        command: "latex-claw.navigateToSection",
        title: "Go to section",
        arguments: [this.texFile, node.sectionKey],
      };
    }

    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.sidecar) return [];

    // Root: group by skill
    if (!node) {
      const bySkill = new Map<string, Array<SidecarIssue & { sectionKey: string }>>();
      for (const [sectionKey, section] of Object.entries(this.sidecar.sections)) {
        for (const issue of section.issues) {
          const skill = inferSkillFromIssueId(issue.id);
          if (!bySkill.has(skill)) bySkill.set(skill, []);
          bySkill.get(skill)!.push({ ...issue, sectionKey });
        }
      }

      return [...bySkill.entries()].map(([skill, issues]) => ({
        kind: "skill" as const,
        skill,
        issues,
      }));
    }

    if (node.kind === "skill") {
      // Group the skill's issues by sectionKey
      const bySection = new Map<string, SidecarIssue[]>();
      for (const issue of node.issues) {
        if (!bySection.has(issue.sectionKey)) bySection.set(issue.sectionKey, []);
        bySection.get(issue.sectionKey)!.push(issue);
      }

      return [...bySection.entries()].map(([sectionKey, issues]) => ({
        kind: "section" as const,
        skill: node.skill,
        sectionKey,
        issues,
      }));
    }

    if (node.kind === "section") {
      return node.issues.map((issue) => ({
        kind: "issue" as const,
        issue,
        sectionKey: node.sectionKey,
      }));
    }

    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferSkillFromIssueId(id: string): string {
  if (id.startsWith("struct-")) return "structure-check";
  if (id.startsWith("cite-")) return "citation-check";
  if (id.startsWith("lang-")) return "language-check";
  if (id.startsWith("stats-")) return "stats-check";
  if (id.startsWith("fig-")) return "figure-check";
  if (id.startsWith("cross-")) return "cross-section-check";
  return "other";
}

function skillLabel(skill: string): string {
  switch (skill) {
    case "structure-check": return "Structure";
    case "citation-check": return "Citations";
    case "language-check": return "Language";
    case "stats-check": return "Statistics";
    case "figure-check": return "Figures";
    case "cross-section-check": return "Cross-section";
    default: return skill;
  }
}

function skillIcon(skill: string): vscode.ThemeIcon {
  switch (skill) {
    case "structure-check":
      return new vscode.ThemeIcon("symbol-structure");
    case "citation-check":
      return new vscode.ThemeIcon("references");
    case "language-check":
      return new vscode.ThemeIcon("book");
    case "stats-check":
      return new vscode.ThemeIcon("graph");
    case "figure-check":
      return new vscode.ThemeIcon("file-media");
    case "cross-section-check":
      return new vscode.ThemeIcon("link");
    default:
      return new vscode.ThemeIcon("tools");
  }
}

function severityIcon(severity: string): vscode.ThemeIcon {
  switch (severity) {
    case "error":   return new vscode.ThemeIcon("error",   new vscode.ThemeColor("problemsErrorIcon.foreground"));
    case "warning": return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
    default:        return new vscode.ThemeIcon("info",    new vscode.ThemeColor("problemsInfoIcon.foreground"));
  }
}
