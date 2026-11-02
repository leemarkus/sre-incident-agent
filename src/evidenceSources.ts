/**
 * Where a grade run's evidence transcripts come from.
 *
 * ## The rule
 *
 * An explicit `--retrieval` / `--queries` always wins: that is a human naming a
 * transcript on purpose, which is a different act from the tool guessing.
 *
 * Resolution is a pure function over an injected `exists` so the suite can
 * assert the substitution refusal without a filesystem.
 */

import path from "node:path";

import { queryFixtureFor, retrievalFixtureFor } from "./scenario.js";

/** Which report is being graded — this decides whether a fixture is its own. */
export type GradeMode =
  /** `--known-good` / `--known-bad`: the committed fixture is this report's own transcript. */
  | "committed-fixture"
  /** An arbitrary `--report`: only a transcript beside that report is admissible. */
  | "arbitrary-report";

export type EvidenceKind = "retrieval" | "queries" | "tools";

export interface ResolvedSource {
  /** The transcript to load, or `undefined` when the evidence is absent. */
  readonly file: string | undefined;
  /** Human-readable provenance, printed by the grader above its verdict. */
  readonly label: string;
  /**
   * How `file` was chosen. `absent` is the honest-refusal state: a fixture
   * existed but belonged to a different run, or none existed at all.
   */
  readonly origin:
    | "explicit-flag"
    | "beside-report"
    | "beside-report-transcript"
    | "committed-fixture"
    | "absent";
}

export interface ResolveOptions {
  readonly reportPath: string;
  readonly scenarioId: string;
  readonly mode: GradeMode;
  readonly retrievalArg?: string | undefined;
  readonly queriesArg?: string | undefined;
  readonly toolsArg?: string | undefined;
  /** Injected for testability; defaults to a real `existsSync` at the call site. */
  readonly exists: (file: string) => boolean;
}

/** `reports/run-7/triage.md` + `queries` -> `reports/run-7/triage.queries.json`. */
export function adjacentTranscriptPath(reportPath: string, kind: EvidenceKind): string {
  return `${reportPath.replace(/\.md$/, "")}.${kind}.json`;
}

/** `reports/run-7/triage.md` -> `reports/run-7/triage.transcript.json`. */
export function fullTranscriptPath(reportPath: string): string {
  return `${reportPath.replace(/\.md$/, "")}.transcript.json`;
}

function resolveOne(
  kind: EvidenceKind,
  explicit: string | undefined,
  options: ResolveOptions,
): ResolvedSource {
  if (explicit !== undefined) {
    return { file: explicit, label: explicit, origin: "explicit-flag" };
  }

  if (options.mode === "committed-fixture") {
    // There is deliberately no committed per-scenario TOOL fixture: a
    // known-good report describes incident-time evidence no present-day
    // transcript can support, and manufacturing one would fabricate the very
    // evidence the attribution check exists to demand. See
    // `toolTranscriptSchema` in `src/scenario.ts`.
    const fixture =
      kind === "retrieval"
        ? retrievalFixtureFor(options.scenarioId)
        : kind === "queries"
          ? queryFixtureFor(options.scenarioId)
          : undefined;
    if (fixture !== undefined) {
      return { file: fixture, label: fixture, origin: "committed-fixture" };
    }
    return { file: undefined, origin: "absent", label: absentLabel(kind, "") };
  }

  // An arbitrary report: beside itself, or nowhere. Deliberately does NOT fall
  // through to the scenario fixture — that fallthrough was the bug.
  const beside = adjacentTranscriptPath(options.reportPath, kind);
  if (options.exists(beside)) {
    return { file: beside, label: beside, origin: "beside-report" };
  }

  if (kind === "tools") {
    const full = fullTranscriptPath(options.reportPath);
    if (options.exists(full)) {
      return { file: full, label: full, origin: "beside-report-transcript" };
    }
  }

  return {
    file: undefined,
    origin: "absent",
    label: absentLabel(
      kind,
      `no ${path.basename(beside)}${
        kind === "tools" ? ` or ${path.basename(fullTranscriptPath(options.reportPath))}` : ""
      } beside the report; refusing to substitute the scenario fixture, which belongs to a ` +
        "different run",
    ),
  };
}

function absentLabel(kind: EvidenceKind, why: string): string {
  const consequence =
    kind === "retrieval"
      ? "citations unverifiable"
      : kind === "queries"
        ? "F3 primary check unarmed"
        : "evidence attribution unarmed — unknown; no verified evidence credit";
  return why === "" ? `(none — ${consequence})` : `(none — ${why}; ${consequence})`;
}

export interface ResolvedEvidenceSources {
  readonly retrieval: ResolvedSource;
  readonly queries: ResolvedSource;
  readonly tools: ResolvedSource;
}

export function resolveEvidenceSources(options: ResolveOptions): ResolvedEvidenceSources {
  return {
    retrieval: resolveOne("retrieval", options.retrievalArg, options),
    queries: resolveOne("queries", options.queriesArg, options),
    tools: resolveOne("tools", options.toolsArg, options),
  };
}
