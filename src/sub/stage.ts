/**
 * Path 1 → Path 3 transfer, step 1: a completed subscription run
 * becomes a scenario **candidate**.
 *
 * ## What this is, and what it deliberately is not
 *
 * A subscription-mode run (`reports/sub/<stamp>--<alert>/`) is a real
 * investigation against the real cluster, and it is the only source of new
 * incident material this project has that a human did not hand-write. Path 3
 * (the graded suite) needs incident material. The gap between them is
 * **ground truth**: a run's report is the frontier's *hypothesis*, and a
 * hypothesis promoted to an answer key by nothing but its own confidence is
 * how a benchmark quietly starts measuring agreement-with-itself.
 *
 * So staging is two steps with a human in the middle:
 *
 *   1. `tools/sub-stage-scenario <run-dir>` copies the run into
 *      `scenarios/candidates/<class>-<date>/` with
 *      `answerKey: "frontier-provisional"` and the report's ranked causes
 *      recorded VERBATIM under `provisionalCauses`. The rubric it writes is a
 *      **placeholder**: structure, ordering and safety only. It contains no
 *      cause-specific check, because at this point nobody knows the cause.
 *   2. `tools/sub-confirm-candidate <dir> --fix <sha|forgejo-url>` rewrites
 *      `answerKey: "human-confirmed"` once the operator links the change that actually
 *      fixed the incident. **That link is the ground truth, never the
 *      frontier's hypothesis.**
 *
 * Nothing under `scenarios/candidates/` is ever enumerated by
 * `listScenarioIds()`, so a candidate cannot leak into the graded suite by
 * existing. It loads only when a caller names its directory explicitly.
 *
 * This module is pure file-shuffling: it spawns nothing, spends nothing and
 * touches no cluster.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { alertName, parseWebhookPayload, type WebhookPayload } from "../alert.js";
import {
  CANDIDATES_DIR_NAME,
  DERIVED_REPLAY_MARKER,
  FIX_LINK_HELP,
  FIX_SHA_RE,
  FIX_URL_HOST,
  FIX_URL_PATH_RE,
  candidatesRoot,
  describeFixLink,
  isCandidatePath,
  scenarioSchema,
  type FixLinkKind,
} from "../scenario.js";
import { readCalls, type LoggedCall } from "./calllog.js";
import { groupSubject } from "./poll.js";
import { publicationVerdict } from "../publication.js";

// One definition, in `src/scenario.ts` beside `candidatesRoot()`; re-exported
// so callers of this module do not need two imports to name the same thing.
export { CANDIDATES_DIR_NAME } from "../scenario.js";

export type StagedProvenance = {
  runDir: string;
  sha: string;
  model: string;
  engine: "subscription";
  stagedAt: string;
};

export type RunArtefacts = {
  runDir: string;
  /** `triage-2026-09-02` — the report stem, without directory or extension. */
  stem: string;
  reportPath: string;
  toolsPath: string;
  queriesPath: string;
  retrievalPath: string;
  report: string;
  /** The AlertManager payload, pretty-printed exactly as it reached the model. */
  alertJson: string;
  payload: WebhookPayload;
  calls: LoggedCall[];
  model: string;
  sha: string;
  /** `triage` or `postmortem`, from the report filename. */
  mode: "triage" | "postmortem";
};

export class StageError extends Error {}

/**
 * Lift the AlertManager payload back out of a completed run.
 *
 * **This is a reconstruction, and the reason is worth stating.** `run.ts`
 * writes `invocation.json` with the user prompt REDACTED to
 * `"<user prompt, N chars>"` — deliberately, so the file stays a small record
 * of how `claude` was invoked. The payload therefore survives in exactly one
 * place: the first fenced ```json block of `prompt.user.txt`, which
 * `buildUserTurn` emits verbatim under "Triage the following AlertManager
 * webhook payload." Nothing is re-derived or re-formatted here — the bytes
 * inside the fence are parsed to prove they are an AlertManager envelope, and
 * then written to `alert.json` unchanged.
 */
export function extractAlertPayload(promptUser: string): { raw: string; payload: WebhookPayload } {
  // Fixed harness prompt envelope, not report Markdown: require its literal JSON wrapper.
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(promptUser);
  if (fence === null || fence[1] === undefined) {
    throw new StageError(
      "prompt.user.txt contains no fenced ```json block, so the alert payload cannot be " +
        "recovered from this run. invocation.json redacts the prompt by design; without the " +
        "fence there is no verbatim copy of the payload in the run directory.",
    );
  }
  const raw = fence[1];
  let payload: WebhookPayload;
  try {
    payload = parseWebhookPayload(raw);
  } catch (error) {
    throw new StageError(
      "the first fenced json block in prompt.user.txt is not an AlertManager webhook payload: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return { raw, payload };
}

/**
 * `captured` for a live poll payload, `reconstructed` for a fixture replay.
 *
 * The discriminator is the `groupKey`. `src/sub/poll.ts` synthesises its own
 * envelope from a live Prometheus read and keys it `<alertname>|<ns>|<subject>`;
 * a real AlertManager envelope — which is what every committed fixture under
 * `fixtures/alertmanager/` is a hand-written copy of — keys it `{}:{…}`. The
 * fixtures' own README is explicit that those envelopes were RECONSTRUCTED and
 * never captured from a webhook POST, so a run fed one of them inherits
 * `reconstructed`, not `captured`.
 */
export function alertProvenanceOf(payload: WebhookPayload): "captured" | "reconstructed" {
  const key = payload.groupKey ?? "";
  return key.startsWith("{") ? "reconstructed" : "captured";
}

/** Kebab-case a label value into something safe as a path component. */
export function kebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `<alertname>[-<subject>]-<YYYY-MM-DD>`, lower-cased and kebabbed.
 *
 * The subject is the poll grouper's own notion of what the alert is ABOUT
 * (the captured group key, or `groupSubject` for AlertManager labels) so two
 * KubeJobFailed candidates on the same day for different jobs do not collide
 * into a `-2` suffix that says nothing about which is which.
 */
export function candidateName(payload: WebhookPayload, day: string): string {
  const name = kebab(alertName(payload));
  // Different pods in one workload disappear from commonLabels; the captured
  // key retains the subject already chosen by the poller.
  const subject = kebab(alertProvenanceOf(payload) === "captured"
    ? (payload.groupKey ?? "").split("|").slice(2).join("|")
    : groupSubject({ ...payload.commonLabels, ...payload.groupLabels }));
  const stem = subject === "" || name.includes(subject) ? name : `${name}-${subject}`;
  return `${stem}-${day}`;
}

/**
 * The ranked causes, verbatim, from the report's own "Probable cause (ranked)"
 * section.
 *
 * Recorded rather than interpreted. These are what the human confirms or
 * rejects, so paraphrasing them here would put the staging tool's reading of
 * the report between the frontier and the person judging it.
 */
export function rankedCauses(report: string): string[] {
  const section = /\n##\s+Probable cause \(ranked\)\s*\n([\s\S]*?)(?=\n##\s|\n---\s*\n|$)/.exec(report);
  if (section === null || section[1] === undefined) return [];
  const causes: string[] = [];
  const item = /^\s*\d+\.\s+(.+?)\s*$/gm;
  for (let m = item.exec(section[1]); m !== null; m = item.exec(section[1])) {
    const line = (m[1] ?? "").trim();
    // The report writes each ranked cause as `N. **<claim>** <detail>` — take
    // the bold claim when there is one, verbatim, and the whole line when there
    // is not. Nothing is paraphrased: what lands in `provisionalCauses` is the
    // model's own words, so the human confirming it judges the report and not
    // this parser's summary of it.
    const bold = /^\*\*([\s\S]+?)\*\*/.exec(line);
    causes.push((bold?.[1] ?? line).trim());
  }
  return causes;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new StageError(
      `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read a completed run directory, refusing anything that is not one. */
export function readRun(runDir: string): RunArtefacts {
  const dir = path.resolve(runDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new StageError(`${dir} is not a directory`);
  }
  const promptFile = path.join(dir, "prompt.user.txt");
  if (!existsSync(promptFile)) {
    throw new StageError(`${dir} has no prompt.user.txt — it is not a subscription run directory`);
  }
  const reports = readdirSync(dir)
    .filter((n) => /^(triage|postmortem)-.+\.md$/.test(n))
    .sort();
  const reportName = reports[0];
  if (reportName === undefined) {
    throw new StageError(
      `${dir} holds no triage-*.md / postmortem-*.md report. Only a COMPLETED run can be ` +
        "staged: a refused or failed run produced no report, and a candidate whose answer key " +
        "is an unfinished investigation is worse than no candidate.",
    );
  }
  if (reports.length > 1) {
    throw new StageError(
      `${dir} holds ${reports.length} reports (${reports.join(", ")}); refusing to guess which ` +
        "one is the run's product",
    );
  }
  const stem = reportName.replace(/\.md$/, "");
  const reportPath = path.join(dir, reportName);
  const rejectionPath = path.join(dir, `${stem}.rejected.json`);
  if (existsSync(rejectionPath)) throw new StageError(`refusing rejected run: ${rejectionPath}`);
  const toolsPath = path.join(dir, `${stem}.tools.json`);
  const queriesPath = path.join(dir, `${stem}.queries.json`);
  const retrievalPath = path.join(dir, `${stem}.retrieval.json`);
  for (const file of [toolsPath, queriesPath, retrievalPath]) {
    if (!existsSync(file)) {
      throw new StageError(
        `${dir} is missing ${path.basename(file)} — a candidate without its transcripts cannot ` +
          "be graded on evidence, citations or F3, which is most of what the grader is for",
      );
    }
  }

  const { raw, payload } = extractAlertPayload(readFileSync(promptFile, "utf8"));
  const report = readFileSync(reportPath, "utf8");
  const verdict = publicationVerdict(report, raw);
  if (!verdict.publish) throw new StageError(`${reportPath}: ${verdict.reason}`);

  const invocationFile = path.join(dir, "invocation.json");
  const invocation = existsSync(invocationFile)
    ? (readJsonFile(invocationFile) as { sha?: unknown; sub?: { model?: unknown } })
    : {};
  const sha = typeof invocation.sha === "string" && invocation.sha !== "" ? invocation.sha : "unknown";
  const model = typeof invocation.sub?.model === "string" ? invocation.sub.model : "unknown";

  const callsFile = path.join(dir, "calls.jsonl");
  const calls = existsSync(callsFile) ? readCalls(callsFile) : [];

  return {
    runDir: dir,
    stem,
    reportPath,
    toolsPath,
    queriesPath,
    retrievalPath,
    report,
    alertJson: raw.endsWith("\n") ? raw : `${raw}\n`,
    payload,
    calls,
    model,
    sha,
    mode: stem.startsWith("postmortem") ? "postmortem" : "triage",
  };
}

/**
 * A replay script DERIVED from the run's own model-issued tool calls.
 *
 * `scenario.json` requires `files.replay`, and a candidate has no hand-written
 * evidence chain — so this records the calls the model actually made, in the
 * order it made them, and ends with the report it actually wrote. It is
 * honest about being derived (see `_comment`): it has not been replayed, and a
 * candidate is not a replay fixture until a human confirms it and curates one.
 */
export function replayScriptFrom(run: RunArtefacts): unknown {
  const model = run.calls.filter((c) => c.origin === "model");
  const turns: unknown[] = [];
  for (const call of model) {
    turns.push({ tool_uses: [{ name: call.tool, input: call.input }] });
  }
  turns.push({ text_file: "./answer-key.md" });
  return {
    // Machine-readable, because the prose below is a claim and this is the
    // enforcement: `loadScenario` reads this field and `runReplay` refuses to
    // run a script that carries it (review M5).
    [DERIVED_REPLAY_MARKER]: true,
    _comment: [
      "DERIVED, not authored. These turns were reconstructed from the model-issued",
      "calls in the staged run's calls.jsonl, in the order they were made, followed by the",
      "report the run produced. The harness sweep's own calls are NOT here: they are issued by",
      "code on every run and are not part of an assistant transcript.",
      "This script has never been replayed. It exists so a candidate satisfies the scenario",
      "shape and can be loaded and graded; curating a real evidence chain is part of promoting",
      "a candidate, not of staging one.",
    ],
    turns,
  };
}

/**
 * The PLACEHOLDER rubric a candidate is staged with.
 *
 * Structure, ordering and safety only — every check here would be true of a
 * correct report for ANY incident. There is deliberately no cause-specific
 * pattern: the cause is unconfirmed, and a rubric written from the frontier's
 * own hypothesis would score the next model on how well it agrees with this
 * one. `provisionalCauses` carries the hypothesis instead, as text for a human
 * to accept or throw away.
 */
export function placeholderRubric(): unknown {
  return {
    _comment:
      "PLACEHOLDER. Structural and safety checks only; no cause-specific pattern " +
      "exists until a human confirms the cause with a fix link. Do not grade a model on this " +
      "rubric and report the number as a result.",
    rootCause: {
      patterns: [
        {
          id: "ranks-something",
          pattern: "\\S",
          why: "placeholder: the report must rank a cause at all. The check that the cause is the RIGHT one is written when a human confirms it (tools/sub-confirm-candidate).",
        },
      ],
      topRanked: [],
    },
    evidence: [],
    forbidden: [
      {
        id: "claims-to-have-acted",
        pattern: "\\bI (have )?(restarted|deleted|patched|scaled|applied|rolled back)\\b",
        why: "the agent is read-only by construction and must never claim to have changed the cluster. This is an invariant of every scenario, confirmed or not, so it is not a placeholder.",
      },
    ],
    emptyVectorRule: true,
    incidentTimeOnly: [],
  };
}

export type StageOptions = {
  runDir: string;
  /** Where candidates go. Defaults to `scenarios/candidates` under the repo root. */
  outDir: string;
  force?: boolean;
  now?: Date;
};

export type StageResult = {
  dir: string;
  id: string;
  files: string[];
  causes: string[];
  alertProvenance: "captured" | "reconstructed";
};

/** The answer-key state of an existing candidate, as WRITTEN (never defaulted). */
function candidateAnswerKey(dir: string): string | undefined {
  const file = path.join(dir, "scenario.json");
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const key = raw["answerKey"];
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

function candidateProvenanceRunDir(dir: string): string | undefined {
  const file = path.join(dir, "scenario.json");
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { provenance?: { runDir?: unknown } };
    const runDir = raw.provenance?.runDir;
    return typeof runDir === "string" ? runDir : undefined;
  } catch {
    return undefined;
  }
}

/** Stage one completed run as a scenario candidate. */
export function stageCandidate(options: StageOptions): StageResult {
  const run = readRun(options.runDir);
  const outDir = path.resolve(options.outDir);
  const now = options.now ?? new Date();
  // The candidate is dated by the INCIDENT (the report's own day), not by the
  // day it happened to be staged: re-staging an old run months later must not
  // mint a candidate that claims to be a fresh incident.
  const day = /^(?:triage|postmortem)-(\d{4}-\d{2}-\d{2})/.exec(run.stem)?.[1] ?? now.toISOString().slice(0, 10);
  const base = candidateName(run.payload, day);

  // Idempotence first, collision second. A run that is already staged is a
  // no-op refusal, never a `-2` twin: the second copy would be silently
  // identical evidence counted twice by anything that later reads the tree.
  let replacing: string | undefined;
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const existing = path.join(outDir, entry.name);
      if (candidateProvenanceRunDir(existing) !== run.runDir) continue;
      if (options.force !== true) {
        throw new StageError(
          `${run.runDir} is already staged as ${existing} — refusing to ` +
            "stage it twice. Pass --force to overwrite that candidate in place.",
        );
      }
      // --force overwrites a PROVISIONAL candidate. It must never overwrite a
      // confirmed one (review H3): re-staging would throw away a human's fix
      // link and their judgement of which cause was right, and silently return
      // the candidate to frontier-provisional — a confirmed answer key
      // demoted back to a hypothesis by a command that reads like a refresh.
      const state = candidateAnswerKey(existing);
      if (state === "human-confirmed") {
        throw new StageError(
          `${existing} is HUMAN-CONFIRMED — refusing to overwrite it, --force or not. ` +
            "Re-staging would discard the fix link and the confirmed cause, and demote a " +
            "settled answer key back to a hypothesis. Delete it deliberately if that is " +
            "really what you want.",
        );
      }
      replacing = existing;
    }
  }

  let id = base;
  for (let n = 2; existsSync(path.join(outDir, id)); n += 1) {
    if (replacing !== undefined && path.join(outDir, id) === replacing) break;
    id = `${base}-${n}`;
    if (n > 99) throw new StageError(`could not find a free candidate name for ${base}`);
  }
  const target = replacing ?? path.join(outDir, id);
  id = path.basename(target);

  // Build in a sibling temp directory and move it into place once every file
  // is written (review H3). The old code deleted the existing candidate first
  // and wrote into the hole, so a failure part-way — a short read, a full disk
  // — left a half-populated candidate where a complete one had been.
  mkdirSync(outDir, { recursive: true });
  const dir = mkdtempSync(path.join(outDir, `.staging-${id}-`));

  const causes = rankedCauses(run.report);
  const provenance: StagedProvenance = {
    runDir: run.runDir,
    sha: run.sha,
    model: run.model,
    engine: "subscription",
    stagedAt: now.toISOString(),
  };

  const scenario = {
    id,
    title: `CANDIDATE — ${alertName(run.payload)} (staged from subscription run ${path.basename(run.runDir)})`,
    mode: run.mode,
    // Deliberately not a failure class: naming one would be a claim about the
    // cause, which is the thing this candidate does not yet know.
    failureClass: "unconfirmed — staged from a subscription run, awaiting a human-linked fix",
    expectedRootCause:
      causes.length === 0
        ? "PROVISIONAL: the staged report ranked no cause the staging tool could parse. Read answer-key.md."
        : `PROVISIONAL (the frontier's own top-ranked hypothesis, NOT confirmed): ${causes[0]}`,
    alertProvenance: alertProvenanceOf(run.payload),
    answerKey: "frontier-provisional" as const,
    provisionalCauses: causes,
    provenance,
    files: {
      alert: "./alert.json",
      replay: "./replay.json",
      knownGoodReport: "./answer-key.md",
    },
    expectedToolFailures: [],
    rubric: placeholderRubric(),
  };

  const files: string[] = [];
  const write = (name: string, body: string): void => {
    writeFileSync(path.join(dir, name), body, "utf8");
    files.push(name);
  };
  const copy = (from: string, name: string): void => {
    copyFileSync(from, path.join(dir, name));
    files.push(name);
  };

  write("alert.json", run.alertJson);
  write("answer-key.md", run.report);
  copy(run.toolsPath, "triage.tools.json");
  copy(run.queriesPath, "triage.queries.json");
  copy(run.retrievalPath, "triage.retrieval.json");
  write("replay.json", `${JSON.stringify(replayScriptFrom(run), null, 2)}\n`);
  write("scenario.json", `${JSON.stringify(scenario, null, 2)}\n`);
  write("README.md", candidateReadme({ id, run, causes, provenance, alertProvenance: scenario.alertProvenance }));

  const backup = replacing === undefined ? undefined : `${replacing}.replaced-${process.pid}`;
  try {
    if (replacing !== undefined && backup !== undefined) renameSync(replacing, backup);
    try {
      renameSync(dir, target);
    } catch (error) {
      if (backup !== undefined && existsSync(backup)) renameSync(backup, target);
      throw error;
    }
    if (backup !== undefined) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new StageError(
      `could not move the staged candidate into place at ${target}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  return { dir: target, id, files, causes, alertProvenance: scenario.alertProvenance };
}

function candidateReadme(input: {
  id: string;
  run: RunArtefacts;
  causes: string[];
  provenance: StagedProvenance;
  alertProvenance: "captured" | "reconstructed";
}): string {
  const { id, run, causes, provenance } = input;
  const lines = [
    `# Candidate — ${alertName(run.payload)} (${id})`,
    "",
    "**This is a CANDIDATE, not a scenario.** It is not in the graded suite and cannot get",
    "there by existing: `listScenarioIds()` skips `scenarios/candidates/` entirely, so nothing",
    "that walks the suite will ever see it. It loads only when a caller names this directory.",
    "",
    "## Provenance",
    "",
    `- Run: \`${provenance.runDir}\``,
    `- Engine: ${provenance.engine} (\`claude -p\`), model \`${provenance.model}\``,
    `- Source commit: \`${provenance.sha}\`${provenance.sha === "unknown" ? " — the run did not record one; it was not guessed from the working tree" : ""}`,
    `- Staged: ${provenance.stagedAt} by \`tools/sub-stage-scenario\``,
    `- Alert provenance: \`${input.alertProvenance}\` — \`alert.json\` is the payload the run was given, lifted verbatim from the fenced JSON block in the run's \`prompt.user.txt\` (\`invocation.json\` redacts the prompt by design).`,
    `- Tool calls in the run: ${run.calls.length} (${run.calls.filter((c) => c.origin === "harness").length} harness sweep, ${run.calls.filter((c) => c.origin === "model").length} model)`,
    "",
    "## What the run concluded (ranked, verbatim)",
    "",
    ...(causes.length === 0
      ? ["_The staging tool parsed no ranked causes out of the report; read `answer-key.md`._"]
      : causes.map((c, i) => `${i + 1}. ${c}`)),
    "",
    "None of the above is ground truth. They are one model's hypotheses on one day, recorded",
    "so a human can confirm or reject them — not so a later model can be scored on agreeing",
    "with them.",
    "",
    "## The rubric is a placeholder",
    "",
    "`scenario.json`'s rubric asserts only what is true of a correct report for *any* incident:",
    "the five required sections present and ordered, an investigation that actually happened,",
    "and no claim to have mutated the cluster. It contains **no cause-specific check**, because",
    "the cause is unconfirmed. Grading a model against this rubric produces a number that is",
    "not a result. It stays a placeholder until confirmation, at which point the confirmed cause",
    "is written into it by hand.",
    "",
    "`replay.json` is likewise derived from the run's own calls and has never been replayed.",
    "",
    "## Confirming this candidate",
    "",
    "When the incident is actually fixed, link the change that fixed it:",
    "",
    "```sh",
    `tools/sub-confirm-candidate scenarios/${CANDIDATES_DIR_NAME}/${id} \\`,
    "  --fix <gitops commit SHA | https://git.example.com/... issue URL> \\",
    "  --cause <n>   # which of the ranked causes above was right (omit if none were)",
    "```",
    "",
    "That link is the ground truth. The frontier's hypothesis is not, however well argued it",
    "reads — a candidate confirmed against its own report would make the suite measure",
    "self-agreement. Confirmation sets `answerKey: human-confirmed`; only then is it worth",
    "writing a real rubric.",
    "",
  ];
  return `${lines.join("\n")}`;
}

/* ------------------------------------------------------------------ confirm */

// The fix-link validator lives in `src/scenario.ts`: the
// SCHEMA has to apply the same rule, or a hand-edited `human-confirmed`
// scenario could carry a link this command would have refused. Re-exported
// here so the tools keep one import.
export { FIX_SHA_RE, FIX_URL_HOST, FIX_URL_PATH_RE, FIX_LINK_HELP, describeFixLink };

export type ConfirmOptions = {
  dir: string;
  fix: string;
  /** 1-based index into `provisionalCauses`. Omit if none of them was right. */
  cause?: number;
  now?: Date;
};

export type ConfirmResult = {
  dir: string;
  fixLink: string;
  fixLinkKind: FixLinkKind;
  confirmedAt: string;
  confirmedCause?: string;
};

/**
 * Promote a candidate to `answerKey: human-confirmed`.
 *
 * ## What this refuses, and why each refusal is load-bearing
 *
 * The first version of this function checked only that `answerKey` was not the
 * string `"human-authored"` — and the four committed scenarios OMIT the field,
 * so their raw value is `undefined` and the check did not protect them. A review
 * reproduced it: pointing this command at a copy of `prometheus-wal-eio`
 * rewrote a hand-authored scenario as `human-confirmed` with a fix link that
 * had nothing to do with it (review H2). That is the worst available bug in
 * this feature — it forges ground truth in the suite that judges every model.
 *
 * So the target must clear four gates before a byte is written:
 *
 *  1. a valid fix link (the same validator the schema applies);
 *  2. **canonical containment** under `scenarios/candidates/` — resolved
 *     through symlinks, so an alias cannot smuggle a target in from elsewhere;
 *  3. it parses as a scenario at all;
 *  4. its state is **exactly** `frontier-provisional`. Not "not
 *     human-authored": `undefined` is not a candidate, and an
 *     already-`human-confirmed` candidate is not re-confirmable — replacing an
 *     existing confirmation silently would overwrite the one human judgement
 *     this whole design exists to preserve.
 */
export function confirmCandidate(options: ConfirmOptions): ConfirmResult {
  const kind = describeFixLink(options.fix);
  if (kind === undefined) {
    throw new StageError(
      `--fix "${options.fix}" is not a usable fix link — ${FIX_LINK_HELP}. The fix link is ` +
        "the GROUND TRUTH for a confirmed candidate, so it has to point at something specific " +
        "that can be read back later; the frontier's own hypothesis is never it.",
    );
  }
  const dir = path.resolve(options.dir);
  const file = path.join(dir, "scenario.json");
  if (!existsSync(file)) throw new StageError(`${dir} has no scenario.json`);
  if (!isCandidatePath(dir)) {
    throw new StageError(
      `${dir} is not under ${candidatesRoot()} — refusing to confirm it. This command promotes ` +
        "STAGED CANDIDATES only. A committed scenario's answer key was written by a human from " +
        "what actually happened; rewriting one here would forge ground truth in the suite that " +
        "judges every model.",
    );
  }
  const parsed = scenarioSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new StageError(
      `${file} is not a valid scenario, so its state cannot be established:\n` +
        parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  // The RAW value, not the parsed one: the schema defaults a missing key to
  // `human-authored`, and "the field was absent" is precisely the case that
  // slipped through before.
  if (raw["answerKey"] !== "frontier-provisional") {
    throw new StageError(
      `${file} has answerKey ${JSON.stringify(raw["answerKey"] ?? null)}; only a ` +
        "frontier-provisional candidate can be confirmed. " +
        (raw["answerKey"] === "human-confirmed"
          ? "This candidate is ALREADY confirmed — re-confirming would overwrite an existing " +
            "human judgement and its fix link. Edit the file deliberately if the link was wrong."
          : "A scenario with no explicit answerKey is human-authored: its answer key was " +
            "written by a person from what actually happened, and is not this tool's to rewrite."),
    );
  }
  const scenario = raw as Record<string, unknown> & { provisionalCauses?: unknown };
  const causes = Array.isArray(scenario.provisionalCauses)
    ? (scenario.provisionalCauses as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  let confirmedCause: string | undefined;
  if (options.cause !== undefined) {
    const picked = causes[options.cause - 1];
    if (picked === undefined) {
      throw new StageError(
        `--cause ${options.cause} is out of range: this candidate records ${causes.length} ` +
          "provisional cause(s)",
      );
    }
    confirmedCause = picked;
  }
  const answerPath = path.resolve(dir, parsed.data.files.knownGoodReport);
  const alertPath = path.resolve(dir, parsed.data.files.alert);
  let verdict;
  try {
    verdict = publicationVerdict(readFileSync(answerPath, "utf8"), readFileSync(alertPath, "utf8"));
  } catch (error) {
    throw new StageError(`cannot evaluate candidate publication safety: ${String(error)}`);
  }
  if (!verdict.publish) throw new StageError(`${answerPath}: ${verdict.reason}`);
  const confirmedAt = (options.now ?? new Date()).toISOString();

  scenario.answerKey = "human-confirmed";
  scenario.fixLink = options.fix;
  scenario.confirmedAt = confirmedAt;
  // Recorded either way. "None of the frontier's causes was right" is a
  // finding, and dropping the field would make it indistinguishable from
  // "nobody looked".
  scenario.confirmedCause = confirmedCause ?? null;
  writeFileSync(file, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");

  return {
    dir,
    fixLink: options.fix,
    fixLinkKind: kind,
    confirmedAt,
    ...(confirmedCause === undefined ? {} : { confirmedCause }),
  };
}
