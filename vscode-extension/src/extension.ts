import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  readSidecar,
  allIssues,
  countBySeverity,
  sidecarPath,
} from "./sidecar-reader";
import {
  DecorationManager,
  buildSectionLineMap,
  baseSectionKeyForLineMap,
} from "./decorations";
import { IssueTreeProvider } from "./issue-tree";
import { runCli } from "./cli-runner";

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem;
let decorationManager: DecorationManager;
let treeProvider: IssueTreeProvider;
let outputChannel: vscode.OutputChannel;

// Debounce handle per file path
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("latex-claw");
  decorationManager = new DecorationManager();
  treeProvider = new IssueTreeProvider();

  // Status bar — right side, shows error/warning count
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "latex-claw.runCheck";
  statusBarItem.tooltip = "latex-claw — click to run check";
  context.subscriptions.push(statusBarItem);

  // Tree view
  const treeView = vscode.window.createTreeView("latexClawIssues", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // ---- Commands ----

  context.subscriptions.push(
    vscode.commands.registerCommand("latex-claw.runCheck", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && isTexFile(editor.document)) {
        triggerCheck(editor.document.fileName, false);
      }
    }),

    vscode.commands.registerCommand("latex-claw.runCheckForce", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && isTexFile(editor.document)) {
        triggerCheck(editor.document.fileName, true);
      }
    }),

    vscode.commands.registerCommand("latex-claw.clearDiagnostics", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) decorationManager.clear(editor);
      treeProvider.clear();
      setStatusBar(null);
    }),

    vscode.commands.registerCommand("latex-claw.openSidecar", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isTexFile(editor.document)) return;
      const sp = sidecarPath(editor.document.fileName);
      if (fs.existsSync(sp)) {
        vscode.workspace.openTextDocument(sp).then((doc) => {
          vscode.window.showTextDocument(doc, { preview: true });
        });
      } else {
        vscode.window.showWarningMessage("No latex-claw-report.json found. Run a check first.");
      }
    }),

    // Called by tree item click: scroll editor to the section heading
    vscode.commands.registerCommand(
      "latex-claw.navigateToSection",
      (texFile: string, sectionKey: string) => {
        navigateToSection(texFile, sectionKey);
      }
    )
  );

  // ---- Event hooks ----

  // Run on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isTexFile(doc)) return;
      const cfg = getConfig();
      if (!cfg.enableOnSave) return;
      scheduleCheck(doc.fileName, cfg.debounceMs);
    })
  );

  // Re-apply decorations when switching to a .tex editor that has a sidecar
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !isTexFile(editor.document)) {
        setStatusBar(null);
        return;
      }
      applyExistingSidecar(editor);
    })
  );

  // Watch the sidecar file for external changes (e.g. watch mode from CLI)
  const sidecarWatcher = vscode.workspace.createFileSystemWatcher(
    "**/latex-claw-report.json"
  );
  sidecarWatcher.onDidChange(() => refreshActiveEditor());
  sidecarWatcher.onDidCreate(() => refreshActiveEditor());
  context.subscriptions.push(sidecarWatcher);

  // Apply to current editor on activation
  const editor = vscode.window.activeTextEditor;
  if (editor && isTexFile(editor.document)) {
    applyExistingSidecar(editor);
  }

  outputChannel.appendLine("🦞 latex-claw extension activated.");
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

export function deactivate(): void {
  decorationManager?.dispose();
  for (const t of debounceTimers.values()) clearTimeout(t);
}

// ---------------------------------------------------------------------------
// Check orchestration
// ---------------------------------------------------------------------------

function scheduleCheck(texFile: string, debounceMs: number): void {
  const existing = debounceTimers.get(texFile);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(texFile);
    triggerCheck(texFile, false);
  }, debounceMs);

  debounceTimers.set(texFile, timer);
}

async function triggerCheck(texFile: string, force: boolean): Promise<void> {
  const cfg = getConfig();

  setStatusBar("running");
  outputChannel.appendLine(`\n[${timestamp()}] Checking ${path.basename(texFile)}…`);

  const result = await runCli({
    texFile,
    cliPath:   cfg.cliPath,
    venue:     cfg.venue,
    paperType: cfg.paperType,
    skills:    cfg.skills,
    force,
    configPath: cfg.configPath,
  });

  if (result.stdout) outputChannel.append(result.stdout);
  if (result.stderr) outputChannel.append(result.stderr);

  if (!result.success && result.exitCode > 1) {
    // exitCode 2+ = CLI crashed (not just "issues found")
    vscode.window.showErrorMessage(
      `latex-claw failed: ${result.stderr.slice(0, 200) || "unknown error"}. ` +
      `Check the latex-claw Output panel for details.`
    );
    setStatusBar(null);
    return;
  }

  // Read the freshly-written sidecar and apply
  const sidecar = readSidecar(texFile);
  if (!sidecar) {
    setStatusBar(null);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.fileName === texFile) {
    applyDecorationsFromSidecar(editor, sidecar);
  }

  treeProvider.update(texFile, sidecar);
  setStatusBar(sidecar);
}

// ---------------------------------------------------------------------------
// Decoration application
// ---------------------------------------------------------------------------

function applyExistingSidecar(editor: vscode.TextEditor): void {
  const sidecar = readSidecar(editor.document.fileName);
  if (!sidecar) {
    setStatusBar(null);
    return;
  }
  applyDecorationsFromSidecar(editor, sidecar);
  treeProvider.update(editor.document.fileName, sidecar);
  setStatusBar(sidecar);
}

function applyDecorationsFromSidecar(
  editor: vscode.TextEditor,
  sidecar: ReturnType<typeof readSidecar>
): void {
  if (!sidecar) return;
  const issues = allIssues(sidecar);
  const lineMap = buildSectionLineMap(editor.document);
  decorationManager.apply(editor, issues, lineMap);
}

function refreshActiveEditor(): void {
  const editor = vscode.window.activeTextEditor;
  if (editor && isTexFile(editor.document)) {
    applyExistingSidecar(editor);
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function navigateToSection(texFile: string, sectionKey: string): void {
  vscode.workspace.openTextDocument(texFile).then((doc) => {
    vscode.window.showTextDocument(doc).then((editor) => {
      const lineMap = buildSectionLineMap(editor.document);
      const lineNum = lineMap.get(baseSectionKeyForLineMap(sectionKey));
      if (lineNum === undefined) return;

      const pos = new vscode.Position(lineNum, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function setStatusBar(
  sidecarOrRunning: ReturnType<typeof readSidecar> | "running" | null
): void {
  if (sidecarOrRunning === "running") {
    statusBarItem.text = "$(sync~spin) latex-claw…";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  if (!sidecarOrRunning) {
    statusBarItem.text = "🦞 latex-claw";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  const { errors, warnings, infos } = countBySeverity(sidecarOrRunning);

  if (errors > 0) {
    statusBarItem.text = `$(error) ${errors}  $(warning) ${warnings}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  } else if (warnings > 0) {
    statusBarItem.text = `$(warning) ${warnings}  $(info) ${infos}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.text = `$(check) latex-claw`;
    statusBarItem.backgroundColor = undefined;
  }

  statusBarItem.show();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTexFile(doc: vscode.TextDocument): boolean {
  return doc.languageId === "latex" || doc.fileName.endsWith(".tex");
}

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

interface Config {
  cliPath: string;
  venue: string;
  paperType: string;
  skills: string;
  debounceMs: number;
  enableOnSave: boolean;
  /** Passed as --config (empty = search for latex-claw.yaml from the .tex file). */
  configPath: string;
}

function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration("latex-claw");
  return {
    cliPath:      cfg.get<string>("cliPath", "latex-claw"),
    venue:        cfg.get<string>("venue", ""),
    paperType:    cfg.get<string>("paperType", "full"),
    skills:       cfg.get<string>("skills", "all"),
    debounceMs:   cfg.get<number>("debounceMs", 2000),
    enableOnSave: cfg.get<boolean>("enableOnSave", true),
    configPath:   cfg.get<string>("configPath", ""),
  };
}
