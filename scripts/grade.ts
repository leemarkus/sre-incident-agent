#!/usr/bin/env node
/**
 * Grade a triage report against a scenario rubric.
 *
 *   npm run grade -- --scenario prometheus-wal-eio --report reports/…/triage-2026-07-30.md
 *   npm run grade -- --scenario prometheus-wal-eio --known-good
 *
 * Deterministic and offline: no model, no network, no credentials. Exit code 0
 * on PASS, 1 on FAIL, so it can gate CI later without further wiring.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { NO_RETRIEVAL_EVIDENCE } from "../src/citations.js";
import { resolveEvidenceSources } from "../src/evidenceSources.js";
import { formatGrade, gradeReport } from "../src/grade.js";
import { NO_QUERY_EVIDENCE } from "../src/queries.js";
import { NO_TOOL_EVIDENCE } from "../src/toolCalls.js";
import {
  listScenarioIds,
  loadScenario,
  loadQueryEvidenceFrom,
  loadRetrievalEvidenceFrom,
  loadToolEvidenceFrom,
  loadToolEvidenceFromTranscript,
} from "../src/scenario.js";

const USAGE = `sre-agent grade — score a triage report or post-mortem draft against a rubric

Usage:
  npm run grade -- --scenario <id> --report <path> [--retrieval <path>] [--queries <path>] [--tools <path>] [--live-state] [--json]
  npm run grade -- --scenario <id> --known-good [--json]
  npm run grade -- --scenario <id> --known-bad  [--json]

Citations are checked against the run's retrieval transcript, F3 is armed by its
query transcript, and evidence attribution is armed by its TOOL transcript — the
verbatim docs_search / docs_read, promql_query and whole-tool output that
\`npm run replay\` writes next to every report as \`<report>.retrieval.json\`,
\`<report>.queries.json\` and \`<report>.tools.json\`. For a report produced before
\`.tools.json\` existed, the run's own \`<report>.transcript.json\` is lifted
instead — the same conversation, never another run's.

Without a tool transcript matching evidence text is UNKNOWN and earns no verified
credit. Unbound evidence is UNVERIFIABLE; exact transcript bindings and retained
sanitized observations appear in evidenceClaims.
Qualified passes exit 2; only a clean PASS exits 0.

With --report, a transcript is taken ONLY from beside that report (or from an
explicit --retrieval / --queries). If there is none, the evidence is treated as
ABSENT — unverifiable citations grade as failures and F3's primary check goes
n/a. The scenario's committed fixture is NEVER substituted: it belongs to a
different run, and grading a report against another run's facts is the mistake
F3 itself exists to catch.

With --known-good / --known-bad the committed fixtures under fixtures/retrieval/
and fixtures/queries/ are the right default, because those reports came out of
the run those fixtures were captured from.

Scenarios: ${listScenarioIds().join(", ")}
`;

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function main(argv: readonly string[]): number {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 64 : 0;
  }

  const scenarioId = argValue(argv, "--scenario") ?? argValue(argv, "-s");
  if (scenarioId === undefined) {
    process.stderr.write(`--scenario is required.\n\n${USAGE}`);
    return 64;
  }

  const loaded = loadScenario(scenarioId);

  let reportPath = argValue(argv, "--report");
  if (argv.includes("--known-good")) {
    reportPath = path.join(loaded.dir, loaded.scenario.files.knownGoodReport);
  }
  if (argv.includes("--known-bad")) {
    const bad = loaded.scenario.files.knownBadReport;
    if (bad === undefined) {
      process.stderr.write(`${scenarioId} has no known-bad report fixture.\n`);
      return 64;
    }
    reportPath = path.join(loaded.dir, bad);
  }
  if (reportPath === undefined) {
    process.stderr.write(
      `one of --report / --known-good / --known-bad is required.\n\n${USAGE}`,
    );
    return 64;
  }

  // Where a transcript comes from when the flag is omitted: see
  // `src/evidenceSources.ts`. The short version is that a committed fixture is
  // only ever used for the report it was captured alongside; an arbitrary
  // `--report` looks beside itself or grades the evidence as absent.
  const sources = resolveEvidenceSources({
    reportPath,
    scenarioId: loaded.scenario.id,
    mode:
      argv.includes("--known-good") || argv.includes("--known-bad")
        ? "committed-fixture"
        : "arbitrary-report",
    retrievalArg: argValue(argv, "--retrieval"),
    queriesArg: argValue(argv, "--queries"),
    toolsArg: argValue(argv, "--tools"),
    exists: existsSync,
  });

  const evidence =
    sources.retrieval.file === undefined
      ? NO_RETRIEVAL_EVIDENCE
      : loadRetrievalEvidenceFrom(sources.retrieval.file);
  const queries =
    sources.queries.file === undefined
      ? NO_QUERY_EVIDENCE
      : loadQueryEvidenceFrom(sources.queries.file);
  const tools =
    sources.tools.file === undefined
      ? NO_TOOL_EVIDENCE
      : sources.tools.origin === "beside-report-transcript"
        ? loadToolEvidenceFromTranscript(sources.tools.file)
        : loadToolEvidenceFrom(sources.tools.file);

  // `--live-state` grades as if the report came from a run against CURRENT
  // cluster state, which engages the scenario's `incidentTimeOnly` class. Off by default and off for the committed fixtures: a recorded
  // transcript preserves incident-time evidence, so relabelling there would
  // hide genuine fixture regressions rather than separate drift from weakness.
  const grade = gradeReport(
    readFileSync(reportPath, "utf8"),
    loaded.scenario,
    evidence,
    queries,
    tools,
    { liveState: argv.includes("--live-state") },
  );

  // Echo arm identity from the tool sidecar into the grade artifact. Additive
  // only: nothing here participates in scoring. Absent for older sidecars
  // written before arm identity was recorded, which is why it is optional
  // rather than defaulted to a guess about which arm produced them.
  if (sources.tools.file !== undefined) {
    try {
      const sidecar = JSON.parse(readFileSync(sources.tools.file, "utf8")) as {
        arm?: string;
        replay?: unknown;
      };
      if (sidecar.arm !== undefined || sidecar.replay != null) {
        grade.provenance = {
          ...(sidecar.arm === undefined ? {} : { arm: sidecar.arm }),
          ...(sidecar.replay == null ? {} : { replay: sidecar.replay }),
        };
      }
    } catch {
      // A sidecar that does not parse is already fatal upstream; provenance is
      // never the thing that fails a grade.
    }
  }

  // Persist the grade beside the report it graded.
  //
  // Grades were printed and thrown away for three months. The failure-mode
  // census (tools/failure-census, 2026-08-08) could only reconstruct that
  // history because grading happens to be deterministic and offline — luck,
  // not design, and it would have been lost the moment a rubric changed.
  // Writing it here costs nothing and makes the record queryable at the time
  // it was true. Never written for --known-good/--known-bad: those grade a
  // committed fixture, not a run.
  const explicitReport = argValue(argv, "--report");
  if (explicitReport !== undefined && !argv.includes("--no-write-grade")) {
    try {
      writeFileSync(
        explicitReport.replace(/\.md$/, ".grade.json"),
        `${JSON.stringify(grade, null, 2)}\n`,
      );
    } catch (error) {
      // A read-only or missing directory must not turn a valid grade into a
      // failed command: the grade is the product, the sidecar is bookkeeping.
      process.stderr.write(
        `warning: could not write grade sidecar: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(grade, null, 2)}\n`);
  } else {
    process.stdout.write(
      `report:    ${reportPath}\nretrieval: ${sources.retrieval.label}\nqueries:   ${sources.queries.label}\ntools:     ${sources.tools.label}\n${formatGrade(grade)}\n`,
    );
  }
  // Exit codes: 0 is reserved for a CLEAN
  // pass. qualified passes exit 2 — not a failure, but a caller checking
  // `$? == 0` must not mistake a grade that excused checks for one that
  // excused nothing.
  return grade.verdict === "PASS" ? 0 : grade.verdict === "FAIL" ? 1 : 2;
}

process.exitCode = main(process.argv.slice(2));
