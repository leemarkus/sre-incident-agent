import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseWebhookPayload } from "./alert.js";
import {
  evidenceFromCalls,
  retrievalCallsFromMessages,
  type RetrievalCall,
  type RetrievalEvidence,
} from "./citations.js";
import { gradeReport, type Grade } from "./grade.js";
import {
  promqlCallsFromMessages,
  queryEvidenceFromCalls,
  type QueryCall,
  type QueryEvidence,
} from "./queries.js";
import {
  toolCallsFromMessages,
  toolEvidenceFromCalls,
  type ToolCall,
  type ToolEvidence,
} from "./toolCalls.js";
import { loadDiagnosticConfig, type Config } from "./config.js";
import { loadScenario, type LoadedScenario } from "./scenario.js";
import {
  assertDynamicRefEvidence,
  resolveDynamicRefs,
  substituteRefs,
} from "./scenarioRefs.js";
import { describeSweepMode } from "./sweep.js";
import {
  RefusedRunError,
  refusedArtefactBase,
  runTriage,
  type RefusedRunRecord,
  type TriageResult,
} from "./triage.js";
import {
  liveTransport,
  localTransport,
  recordedTransport,
  type Transport,
  type TransportKind,
} from "./transport.js";

/**
 * Replay harness.
 *
 * One function drives a scenario end to end. The `transport` argument is the
 * *only* thing that differs between a dry run and a real run — see
 * `src/transport.ts` for why that constraint is load-bearing. Below this line
 * there is no mode flag, no branch on `transport.kind`, and no alternative path
 * through prompt assembly, the tool loop, tool execution or report writing.
 */

export type ReplayOptions = {
  scenarioId: string;
  /** `undefined` builds the transport from the scenario's recorded script. */
  transport?: Transport;
  /**
   * Which transport to construct when one is not supplied.
   *
   * **This is the mode switch, and it is the only one.** It selects a
   * `Transport` and nothing else: no code below this line branches on it, and
   * `runReplay` itself never reads it again after the three-way choice below.
   * `live` is kept as the older boolean spelling of `kind: "live"`.
   */
  transportKind?: TransportKind;
  live?: boolean;
  outputDir?: string;
  now?: Date;
  onTurn?: (line: string) => void;
};

export type ReplayResult = {
  loaded: LoadedScenario;
  transport: Transport;
  triage: TriageResult;
  grade: Grade;
  transcriptPath: string;
  /** The documentation actually retrieved during this run, as the grader saw it. */
  retrieval: RetrievalEvidence;
  retrievalPath: string;

  queries: QueryEvidence;
  queriesPath: string;
  /** Every tool call the run made — evidence attribution's ground truth. */
  tools: ToolEvidence;
  toolsPath: string;
};

/**
 * The banner every refused-run artefact carries, in its own top-level key.
 *
 * Deliberately the FIRST key in each file, and deliberately not a comment or a
 * filename convention alone: a reader opening the JSON sees it before the data,
 * a `jq '.refused'` finds it without knowing the shape, and the loaders in
 * `src/scenario.ts` refuse any transcript carrying it. The wording states the
 * one thing a future reader must not get wrong — this is the record of a run
 * that produced NO report and is not gradeable.
 */
function refusedBanner(record: RefusedRunRecord): Record<string, unknown> {
  return {
    warning:
      "THIS RUN WAS REFUSED. It produced no report, no grade, and no usable " +
      "investigation. The conversation below is kept ONLY so the calls it made " +
      "are recoverable; it is a truncated or abnormal run and must never be " +
      "read, quoted, pooled or graded as a completed one.",
    refusal: record.refusal,
    reason: record.reason,
    turns: record.turns,
    maxIterations: record.maxIterations,
    stopReason: record.stopReason,
    turnShapes: record.turnShapes,
    gradeable: false,
    reportWritten: false,
  };
}

/**
 * Persist what a REFUSED run produced, and nothing more.
 *
 * Two files, both under a `REFUSED-` base name: the transcript and the tool
 * slice. No report, no grade, no `.md` — the refusal is unchanged and this
 * function is never on a path that could produce one. The retrieval and query
 * slices are deliberately NOT written: they exist to arm graders, and a refused
 * run is not graded.
 *
 * Failures here are swallowed and reported, never rethrown. The refusal is the
 * outcome the caller must see; a disk error while recording it must not replace
 * the reason a run was refused with the reason a file could not be written.
 */
async function persistRefusedRun(
  outputDir: string,
  now: Date,
  scenarioId: string,
  transport: Transport,
  error: RefusedRunError,
  onTurn?: (line: string) => void,
): Promise<void> {
  const record = error.record;
  const base = refusedArtefactBase(outputDir, now);
  const banner = refusedBanner(record);
  try {
    await writeFile(
      `${base}.transcript.json`,
      `${JSON.stringify(
        {
          refused: banner,
          scenario: scenarioId,
          transport: transport.describe(),
          transportKind: transport.kind,
          reportPath: null,
          investigationMode: record.sweep.enabled ? "scaffolded" : "autonomous",
          sweep: {
            enabled: record.sweep.enabled,
            because: record.sweep.because,
            injectedAssistantTurns: record.sweep.injectedAssistantTurns,
          },
          turns: record.turns,
          stopReason: record.stopReason,
          usage: record.usage,
          messages: record.messages,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const calls = toolCallsFromMessages(record.messages);
    await writeFile(
      `${base}.tools.json`,
      `${JSON.stringify({ refused: banner, scenario: scenarioId, calls }, null, 2)}\n`,
      "utf8",
    );
    onTurn?.(
      `[refused] no report was written. ${calls.length} tool call(s) preserved in ` +
        `${base}.tools.json and ${base}.transcript.json — marked REFUSED and not gradeable.`,
    );
  } catch (writeError) {
    onTurn?.(
      "[refused] the run was refused AND its record could not be written: " +
        `${writeError instanceof Error ? writeError.message : String(writeError)}`,
    );
  }
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const loaded = loadScenario(options.scenarioId);

  // Both conditions are checked because they fail independently: the answer-key
  // state says the scenario is unconfirmed, and the replay marker says the
  // script was transcribed from a run rather than recorded through the
  // transport. Grading by explicit path is unaffected — `scripts/grade.ts`
  // never comes through here, which is the seam that keeps a candidate
  // inspectable without being runnable.
  if (loaded.scenario.answerKey !== "human-authored" || loaded.replayIsDerived) {
    throw new Error(
      `${loaded.dir} is a scenario CANDIDATE (answerKey: ${loaded.scenario.answerKey}` +
        `${loaded.replayIsDerived ? ", replay.json is derived" : ""}) and cannot be replayed ` +
        ". Candidate scripts are derived from the run's own calls and are not a " +
        "recording: replaying one exercises no transport that ever produced it, and grading " +
        "the result against the candidate's placeholder rubric yields a number that is not a " +
        "result. Grade a candidate by explicit path instead: " +
        "npm run grade -- --scenario <dir> --report <dir>/answer-key.md --tools … .",
    );
  }

  const kind: TransportKind =
    options.transportKind ?? (options.live === true ? "live" : "recorded");
  if (options.transport === undefined && kind === "custom") {
    // "custom" names a caller-supplied client, and this function will not
    // construct one: production paths offer no door for hand-built clients. The only maker
    // of custom transports lives in `scripts/testTransport.ts`, which is
    // outside the compiled build, and its pairing primitive refuses unless the
    // check-suite gate is open.
    throw new Error(
      'transportKind "custom" requires an explicit `transport`. There is no production ' +
        "constructor for one: hand-built clients pair only through the check-suite helper " +
        "in scripts/, which is not part of the shipped build and is gated at runtime.",
    );
  }

  // ground the recorded script's object names in current cluster state.
  // Only the recorded path needs this — on a live or local run the model picks
  // its own arguments and the script is not consulted at all. Resolution is
  // read-only and produces names, nothing else; see `src/scenarioRefs.ts`.
  let script = loaded.script;
  const recordedPath = options.transport === undefined && kind === "recorded";
  if (recordedPath) {
    const refs = await resolveDynamicRefs(
      loaded.scenario,
      { ...loadDiagnosticConfig(), ANTHROPIC_API_KEY: "" } as Config,
    );
    // This was guarded by a non-empty-map test, so a script containing
    // `{{ref:something-nobody-declared}}` in a scenario with an EMPTY
    // `dynamicRefs` array skipped substitution entirely and shipped the literal
    // token to the cluster — the exact "never a fallback, never passed through"
    // failure the mechanism promises it refuses. The refusal lives inside
    // `substituteRefs`, so the only way to keep it armed is to always call it.
    script = substituteRefs(loaded.script, refs);
    for (const [id, name] of refs) {
      options.onTurn?.(`[dynamic ref] ${id} -> ${name}`);
    }
  }

  let harnessAssistantTurns = 0;

  const transport =
    options.transport ??
    (kind === "live"
      ? liveTransport()
      : kind === "local"
        ? localTransport()
        : recordedTransport(script, {
            expectedToolFailures: loaded.scenario.expectedToolFailures,
            harnessAssistantTurns: () => harnessAssistantTurns,
          }));

  // `scenario.id` is a slug by schema (fix 3a/4), so it cannot traverse. This
  // resolve-and-assert is the second belt: a default report directory must
  // stay under `reports/`. An explicit `outputDir` is a caller's own choice
  // and is left alone.
  const reportsRoot = path.resolve(process.cwd(), "reports");
  const outputDir =
    options.outputDir === undefined
      ? path.resolve(reportsRoot, loaded.scenario.id)
      : path.resolve(options.outputDir);
  if (
    options.outputDir === undefined &&
    !outputDir.startsWith(`${reportsRoot}${path.sep}`)
  ) {
    throw new Error(
      `refusing to write reports to "${outputDir}": scenario "${loaded.scenario.id}" ` +
        `resolves outside "${reportsRoot}".`,
    );
  }
  await mkdir(outputDir, { recursive: true });

  const payload = parseWebhookPayload(loaded.alertJson);

  let triage: TriageResult;
  try {
    triage = await runTriage({
      payload,
      transport,
      outputDir,
      mode: loaded.scenario.mode,
      ...(options.now === undefined ? {} : { now: options.now }),
      onSweep: (outcome) => {
        harnessAssistantTurns = outcome.injectedAssistantTurns;
        options.onTurn?.(`[sweep] ${describeSweepMode(outcome)}`);
      },
      onTurn: (u) =>
        options.onTurn?.(
          `[turn ${u.turn}] in=${u.input_tokens} out=${u.output_tokens} ` +
            `cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens}`,
        ),
    });
  } catch (error) {
    if (error instanceof RefusedRunError) {
      await persistRefusedRun(
        outputDir,
        options.now ?? new Date(),
        loaded.scenario.id,
        transport,
        error,
        options.onTurn,
      );
    }
    throw error;
  }

  const report = await readFile(triage.reportPath, "utf8");

  // ## Where the graders' ground truth comes from
  //
  // Both transcripts below are lifted from `triage.messages` — the conversation
  // the SDK's tool loop actually built — and NOT from `transport.exchanges`.
  //
  // The exchanges also cannot see the last turn: the pinned SDK executes a
  // turn's tools after yielding the assistant message and ships the results in
  // the *next* request, so a call made on the final permitted iteration ran for
  // real and left no trace in any request body.
  //
  // The conversation has neither property. It is still the run's own verbatim
  // tool output, and it is still never a re-fetch or a re-query: re-fetching
  // would grade the report against a corpus or a cluster the model never saw,
  // and would put a network and a token in the path of a verdict.
  const conversation = triage.messages;

  if (recordedPath) {
    assertDynamicRefEvidence(loaded.scenario, conversation);
  }

  const retrievalCalls: RetrievalCall[] = retrievalCallsFromMessages(conversation);
  const retrieval = evidenceFromCalls(retrievalCalls);

  const queryCalls: QueryCall[] = promqlCallsFromMessages(conversation);
  const queries: QueryEvidence = queryEvidenceFromCalls(queryCalls);

  const toolCalls: ToolCall[] = toolCallsFromMessages(conversation);
  const tools: ToolEvidence = toolEvidenceFromCalls(toolCalls);

  // : the incident-time class engages only when the run faced
  // live cluster state. `transport.kind` is the honest signal — it is what the
  // run actually used, not what the caller asked for — and a recorded replay
  // therefore grades exactly as it did before this change.
  const grade = gradeReport(report, loaded.scenario, retrieval, queries, tools, {
    liveState: transport.kind !== "recorded",
  });

  // The transcript is the audit trail of what the loop actually did.
  //
  // `messages` is the conversation and is present on **both** transports — it
  // is what the graders were given. `exchanges` is the extra detail a recorded
  // transport can supply (the literal request bodies the SDK built, which is
  // the thing the HTTP-boundary seam exists to exercise); on a live run it is
  // empty by design, because we do not intercept real traffic. Writing both,
  // labelled, is what keeps "the graders ran on an empty list" from ever again
  // being invisible in the artefact.
  const transcriptPath = `${triage.reportPath.replace(/\.md$/, "")}.transcript.json`;
  await writeFile(
    transcriptPath,
    `${JSON.stringify(
      {
        scenario: loaded.scenario.id,
        transport: transport.describe(),
        transportKind: transport.kind,
        reportPath: triage.reportPath,

        investigationMode: triage.sweep.enabled ? "scaffolded" : "autonomous",
        sweep: {
          enabled: triage.sweep.enabled,
          because: triage.sweep.because,
          alertClass: triage.sweep.plan?.classification.alertClass ?? null,
          injectedAssistantTurns: triage.sweep.injectedAssistantTurns,
          calls: triage.sweep.calls.map((c) => ({
            step: c.step,
            tool: c.tool,
            toolUseId: c.toolUseId,
            input: c.input,
            ok: c.ok,
          })),
          skipped: triage.sweep.plan?.skipped ?? [],
        },
        turns: triage.turns,
        stopReason: triage.stopReason,
        usage: triage.usage,
        messages: conversation,
        exchanges: transport.exchanges,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  // The retrieval slice, written separately and deliberately: the full
  // transcript repeats the whole conversation on every turn and is unwieldy to
  // commit, while this file is small, verbatim, and is exactly what an offline
  // grade needs. Committed copies of it are what let
  // an offline grade verify citations with no network and no Forgejo token.
  const retrievalPath = `${triage.reportPath.replace(/\.md$/, "")}.retrieval.json`;
  await writeFile(
    retrievalPath,
    `${JSON.stringify({ scenario: loaded.scenario.id, calls: retrievalCalls }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const queriesPath = `${triage.reportPath.replace(/\.md$/, "")}.queries.json`;
  await writeFile(
    queriesPath,
    `${JSON.stringify({ scenario: loaded.scenario.id, calls: queryCalls }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  // The whole-tool slice. Same reasoning as the two slices above, and
  // one more: it is the only artefact that says what the run actually CALLED,
  // which is what separates an investigation from a description of one.
  const toolsPath = `${triage.reportPath.replace(/\.md$/, "")}.tools.json`;
  await writeFile(
    toolsPath,
    `${JSON.stringify({ scenario: loaded.scenario.id, calls: toolCalls }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  return {
    loaded,
    transport,
    triage,
    grade,
    transcriptPath,
    retrieval,
    retrievalPath,
    queries,
    queriesPath,
    tools,
    toolsPath,
  };
}
