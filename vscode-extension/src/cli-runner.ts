import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";

export interface RunOptions {
  texFile: string;
  cliPath: string;
  venue: string;
  paperType: string;
  skills: string;
  force: boolean;
  /** When set, passed as --config (otherwise CLI searches for latex-claw.yaml). */
  configPath: string;
}

export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Spawns `latex-claw check <file>` and resolves when it exits.
// ---------------------------------------------------------------------------

export function runCli(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = [
      "check",
      opts.texFile,
      "--skill",    opts.skills,
      "--paper-type", opts.paperType,
    ];
    if (opts.venue) args.push("--venue", opts.venue);
    if (opts.configPath?.trim()) args.push("--config", opts.configPath.trim());
    if (opts.force) args.push("--force");

    // Try to use the configured CLI path; fall back to npx latex-claw
    const [cmd, ...cmdArgs] = resolveCommand(opts.cliPath, args);

    let stdout = "";
    let stderr = "";

    const child = spawn(cmd, cmdArgs, {
      cwd: path.dirname(opts.texFile),
      shell: process.platform === "win32",
      env: { ...process.env },
    });

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      resolve({
        success: (code ?? 1) < 2, // exit 0 = clean, exit 1 = issues found (still success)
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      resolve({
        success: false,
        stdout,
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Resolve the CLI command to run.
// Priority: configured cliPath → npx latex-claw → node ./dist/cli.js
// ---------------------------------------------------------------------------

function resolveCommand(cliPath: string, args: string[]): [string, ...string[]] {
  if (cliPath !== "latex-claw") {
    return [cliPath, ...args];
  }
  // Default: let the shell resolve it from PATH
  return ["latex-claw", ...args];
}
