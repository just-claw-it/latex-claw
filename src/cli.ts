#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import type { Stats } from "node:fs";
import { watch as chokidarWatch } from "chokidar";

import { extractDocument } from "./engine/extractor.js";
import { dispatch } from "./engine/dispatcher.js";
import {
  loadSidecar,
  writeSidecar,
  upsertSection,
  summarizeSidecar,
} from "./engine/sidecar.js";
import type { SkillName } from "./engine/dispatcher.js";
import {
  sidecarStorageKey,
  isSkillName,
  SKILL_NAME_VALUES,
} from "./engine/dispatcher.js";
import { loadProjectConfig } from "./config/project-config.js";

const VERSION = "0.1.0";

function parseSkillOption(raw: unknown): SkillName {
  const s = String(raw ?? "").trim();
  if (isSkillName(s)) return s;
  console.error(chalk.red(`Unknown --skill "${s}".`));
  console.error(chalk.dim(`Valid values: ${SKILL_NAME_VALUES.join(", ")}`));
  process.exit(2);
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("latex-claw")
  .description("Live academic paper analysis while you write 🦞")
  .version(VERSION);

// ------------------------------------------------------------------
// latex-claw check <file>
// ------------------------------------------------------------------
program
  .command("check <file>")
  .description("Run all skills (or one skill) on a .tex file")
  .option(
    "--skill <name>",
    "Run a specific skill: all | structure-check | citation-check | language-check | stats-check | figure-check | cross-section-check",
    "all"
  )
  .option("--venue <name>", "Target venue (e.g. ICSE, TOSEM)")
  .option(
    "--paper-type <type>",
    "Paper type: full | short | workshop | tool-demo",
    "full"
  )
  .option("--force", "Ignore cached results and re-run everything")
  .option("--json", "Print raw JSON output instead of formatted report")
  .option(
    "--config <path>",
    "Path to latex-claw.yaml (default: search upward from the .tex file)"
  )
  .action(async (file: string, options) => {
    await runCheck(file, {
      skill: parseSkillOption(options.skill),
      venue: options.venue ?? null,
      paperType: options.paperType,
      force: !!options.force,
      json: !!options.json,
      configPath: options.config ?? null,
    });
  });

// ------------------------------------------------------------------
// latex-claw watch <dir>
// ------------------------------------------------------------------
program
  .command("watch [dir]")
  .description("Watch a directory for .tex changes and run checks on save")
  .option(
    "--skill <name>",
    "Skill to run (same values as check --skill)",
    "all"
  )
  .option("--venue <name>", "Target venue")
  .option("--paper-type <type>", "Paper type", "full")
  .option(
    "--config <path>",
    "Path to latex-claw.yaml (default: discover from changed .tex)"
  )
  .action(async (dir: string = ".", options) => {
    const watchDir = path.resolve(dir);
    console.log(chalk.cyan(`🦞 latex-claw watching ${watchDir} …`));

    let debounce: ReturnType<typeof setTimeout> | null = null;

    // chokidar v4+ does not support glob strings — watch the tree and filter .tex files.
    const watcher = chokidarWatch(watchDir, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string, stats?: Stats) => {
        if (
          p.includes(`${path.sep}node_modules${path.sep}`) ||
          p.includes(`${path.sep}.git${path.sep}`)
        ) {
          return true;
        }
        if (stats?.isDirectory()) return false;
        return !p.toLowerCase().endsWith(".tex");
      },
    });

    watcher.on("change", (changedFile: string) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        console.log(chalk.dim(`\n[${new Date().toLocaleTimeString()}] ${path.basename(changedFile)} changed — checking…`));
        await runCheck(changedFile, {
          skill: parseSkillOption(options.skill),
          venue: options.venue ?? null,
          paperType: options.paperType,
          force: false,
          json: false,
          configPath: options.config ?? null,
        });
      }, 2000); // 2s debounce
    });
  });

// ------------------------------------------------------------------
// latex-claw clean <file>
// ------------------------------------------------------------------
program
  .command("clean <file>")
  .description("Remove all \\todo[latex-claw*]{} comments injected in inline mode")
  .action(async (file: string) => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(file, "utf8");
    const cleaned = source.replace(
      /\\todo\[latex-claw[^\]]*\]\{[^}]*\}\s*/g,
      ""
    );
    await fs.writeFile(file, cleaned, "utf8");
    console.log(chalk.green(`✓ Cleaned latex-claw todos from ${file}`));
  });

// ------------------------------------------------------------------
// latex-claw report
// ------------------------------------------------------------------
program
  .command("report <file>")
  .description("Print the last sidecar report for a .tex file")
  .option("--format <fmt>", "Output format: md | json", "md")
  .action(async (file: string, options) => {
    const { loadSidecar: load, summarizeSidecar: summarize } = await import(
      "./engine/sidecar.js"
    );
    const sidecar = await load(file);
    if (options.format === "json") {
      console.log(JSON.stringify(sidecar, null, 2));
    } else {
      const { errors, warnings, infos } = summarize(sidecar);
      console.log(chalk.bold("\n📋 latex-claw report"));
      console.log(
        `Generated: ${sidecar.generatedAt}\n` +
          `Errors: ${chalk.red(errors)}  Warnings: ${chalk.yellow(warnings)}  Info: ${chalk.blue(infos)}\n`
      );
      for (const [sectionId, section] of Object.entries(sidecar.sections)) {
        if (section.issues.length === 0) continue;
        console.log(chalk.bold(`\n§ ${sectionId}`));
        for (const issue of section.issues) {
          const icon =
            issue.severity === "error"
              ? chalk.red("✗")
              : issue.severity === "warning"
              ? chalk.yellow("⚠")
              : chalk.blue("ℹ");
          const rule =
            issue.ruleId != null
              ? chalk.dim(`  (${issue.packId ?? "—"} · ${issue.ruleId})`)
              : "";
          console.log(`  ${icon} [${issue.id}] ${issue.message}${rule}`);
          console.log(chalk.dim(`     → ${issue.suggestion}`));
        }
      }
    }
  });

program.parse();

// ---------------------------------------------------------------------------
// Core check runner
// ---------------------------------------------------------------------------

async function runCheck(
  file: string,
  opts: {
    skill: SkillName;
    venue: string | null;
    paperType: string;
    force: boolean;
    json: boolean;
    configPath?: string | null;
  }
): Promise<void> {
  const absFile = path.resolve(file);
  const texDir = path.dirname(absFile);

  let project: ReturnType<typeof loadProjectConfig>;
  try {
    project = loadProjectConfig(texDir, opts.configPath ?? null);
  } catch (e) {
    console.error(chalk.red(`✗ ${String(e)}`));
    process.exit(2);
    throw new Error("unreachable");
  }

  const venue = opts.venue ?? project.config.venue ?? null;

  console.log(chalk.cyan(`\n🦞 latex-claw check — ${path.basename(absFile)}`));
  if (project.config.label) {
    console.log(chalk.dim(`   paper: ${project.config.label}`));
  }
  if (project.config.configPath) {
    console.log(chalk.dim(`   config: ${project.config.configPath}`));
  }
  console.log(
    chalk.dim(
      `   venue pack: ${project.resolvedVenuePack.label} (${project.resolvedVenuePack.id})`
    )
  );
  if (venue) console.log(chalk.dim(`   venue: ${venue}`));
  if (opts.paperType) console.log(chalk.dim(`   type:  ${opts.paperType}`));
  console.log();

  let doc: Awaited<ReturnType<typeof extractDocument>>;
  try {
    doc = await extractDocument(absFile);
  } catch (err) {
    console.error(chalk.red(`✗ Failed to parse ${file}: ${String(err)}`));
    process.exit(1);
    throw new Error("unreachable");
  }

  if (doc.sections.length === 0) {
    console.warn(chalk.yellow("⚠ No sections found. Check that the .tex file has \\section{} commands."));
  } else {
    console.log(chalk.dim(`  Extracted ${doc.sections.length} section(s), ${doc.bibliography.length} bib entries.`));
  }

  // Load sidecar to get cached hashes
  const sidecar = await loadSidecar(absFile);
  const cachedHashes = new Map(
    Object.entries(sidecar.sections).map(([id, s]) => [id, s.hash])
  );

  // Run dispatcher
  const results = await dispatch(
    doc.sections,
    doc.bibliography,
    doc.allCiteKeys,
    cachedHashes,
    {
      skills: opts.skill,
      paperType: opts.paperType as "full" | "short" | "workshop" | "tool-demo",
      venue,
      structureCheck: {
        venuePack: project.resolvedVenuePack,
        disabledRuleIds: project.config.disableRules,
        fingerprint: project.fingerprint,
      },
      forceFull: opts.force,
    }
  );

  const docContentHash = doc.sections.map((s) => s.contentHash).join(":");
  const structureSidecarHash = `${docContentHash}:${project.fingerprint}`;

  // Write sidecar — keys must match dispatcher cache keys (see engine/dispatcher.ts)
  for (const r of results) {
    if (r.skipped) continue;
    const storageKey = sidecarStorageKey(r.skill, r.sectionId);
    const section = doc.sections.find((s) => s.id === r.sectionId);
    const hash =
      storageKey === "__document__"
        ? structureSidecarHash
        : storageKey === "__figures__" || storageKey === "__cross__"
        ? docContentHash
        : section?.contentHash ?? "";

    const output = r.output;
    const verificationResults =
      "verificationResults" in output ? output.verificationResults : undefined;

    upsertSection(sidecar, storageKey, hash, output.issues, verificationResults);
  }
  await writeSidecar(absFile, sidecar);

  // Render
  if (opts.json) {
    console.log(JSON.stringify(sidecar, null, 2));
    return;
  }

  renderReport(results, opts.force);
}

// ---------------------------------------------------------------------------
// Console renderer
// ---------------------------------------------------------------------------

function renderReport(
  results: Awaited<ReturnType<typeof dispatch>>,
  wasForced: boolean
): void {
  let totalErrors = 0, totalWarnings = 0, totalInfos = 0;
  let skippedCount = 0;

  for (const r of results) {
    if (r.skipped) { skippedCount++; continue; }

    const issues = r.output.issues;
    if (issues.length === 0) {
      console.log(chalk.green(`  ✓ ${r.skill} [${r.sectionId}] — no issues`));
      continue;
    }

    console.log(chalk.bold(`\n  ${r.skill} › ${r.sectionId}`));
    for (const issue of issues) {
      const icon =
        issue.severity === "error"
          ? chalk.red("✗")
          : issue.severity === "warning"
          ? chalk.yellow("⚠")
          : chalk.blue("ℹ");
      const label = issue.citeKey ? chalk.dim(`[${issue.citeKey}] `) : "";
      const rule =
        issue.ruleId != null
          ? chalk.dim(`  (${issue.packId ?? "—"} · ${issue.ruleId})`)
          : "";
      console.log(`    ${icon} ${label}${issue.message}${rule}`);
      console.log(chalk.dim(`       → ${issue.suggestion}`));

      if (issue.severity === "error") totalErrors++;
      else if (issue.severity === "warning") totalWarnings++;
      else totalInfos++;
    }

    // Show verification summary if citation-check
    if ("verificationResults" in r.output && r.output.verificationResults.length > 0) {
      const vrs = r.output.verificationResults as Array<{status: string}>;
      const verified = vrs.filter((v: {status:string}) => v.status === "verified").length;
      const suspect = vrs.filter(
        (v: {status:string}) => v.status === "mismatch" || v.status === "doi-invalid"
      ).length;
      const notFound = vrs.filter((v: {status:string}) => v.status === "not-found").length;
      console.log(
        chalk.dim(
          `\n    Hallucination check: ${verified} verified, ${suspect} suspect, ${notFound} not-indexed, ${(vrs as Array<{status:string}>).filter((v: {status:string}) => v.status === "skipped").length} skipped`
        )
      );
    }
  }

  if (skippedCount > 0 && !wasForced) {
    console.log(chalk.dim(`\n  (${skippedCount} section(s) unchanged — skipped. Use --force to re-run all.)`));
  }

  console.log(
    `\n  ${chalk.bold("Total:")} ${chalk.red(`${totalErrors} error(s)`)}  ${chalk.yellow(`${totalWarnings} warning(s)`)}  ${chalk.blue(`${totalInfos} info(s)`)}\n`
  );

  if (totalErrors > 0) process.exitCode = 1;
}
