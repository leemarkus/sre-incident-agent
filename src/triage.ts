import { existsSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BetaMessage,
  BetaTextBlockParam,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { alertName, namespacesInPayload, type WebhookPayload } from "./alert.js";
import { publicationVerdict, writePublicationRejection, PublicationRejectedError } from "./publication.js";
import { retrievalCallsFromMessages } from "./citations.js";
import { promqlCallsFromMessages } from "./queries.js";
import { toolCallsFromMessages } from "./toolCalls.js";
import { type Config } from "./config.js";
import { describeEgress, isLocalEngine } from "./egress.js";
import { assertTransportPairing, liveTransport, type Transport } from "./transport.js";
import {
  assertAccumulatedEvidenceFits,
  assertContextWindowSufficient,
  contextRequirement,
  contextWindowFooterLines,
  type ContextWindowProbe,
} from "./contextWindow.js";
import type { UsageCounterName } from "./localWire.js";
import { POSTMORTEM_SYSTEM_PROMPT } from "./postmortem.js";
import { TRIAGE_SYSTEM_PROMPT, toolAvailabilityNote } from "./prompt.js";
import {
  describeSweepMode,
  executeSweep,
  planSweep,
  sweepEnabled,
  sweepFooterLines,
  SWEEP_DISABLED,
  type SweepOutcome,
} from "./sweep.js";
import { argocdAvailable, argocdStatusTool } from "./tools/argocd.js";
import { docsAvailable, docsReadTool, docsSearchTool } from "./tools/docs.js";
import { kubectlReadTool } from "./tools/kubectl.js";
import { promqlAvailable, promqlQueryTool } from "./tools/promql.js";

/**
 * The per-turn generation allowance.
 *
 * This is NOT a free parameter: it is subtracted from the served context window
 * before every request, because the transport refuses to send when
 * `prompt + MAX_TOKENS > num_ctx` (Ollama truncates from the front, which would
 * silently drop the system prompt and tool schemas). So the allowance sets the
 * usable PROMPT budget:
 *
 *     usable prompt = num_ctx - MAX_TOKENS
 *
 * The 16_000 was also unspendable on its own terms: at the local rate measured
 * on the Studio (14.2 tok/s, 2026-08-30) it needs ~1127s against a 600_000 ms
 * transport abort, so no turn could ever have used it.
 *
 * 16_000 became binding at ctx128k: minio r2 ended turn 5 with
 * stop_reason="max_tokens" and the loop correctly refused to build a report on a
 * truncated turn. A deeper window buys deeper investigation, which buys longer
 * reasoning — so this constant has to move with the window rather than being set
 * once. 24_000 at the slowest measured rate (10.2 tok/s) needs 2353s, which the
 * 3_600_000ms abort covers, and leaves a 111_072-token prompt ceiling.
 *
 * A FOURTH bound caps this constant, and it is not ours. The SDK refuses a
 * NON-STREAMING request whose generation it estimates at over ten minutes:
 * `client.js:calculateNonstreamingTimeout` throws unless
 *     3_600_000 * max_tokens / 128_000 <= 600_000   i.e.  max_tokens <= 21_333
 * and it only skips that check when the CLIENT was built with an explicit
 * `timeout` option. Ours is not: LOCAL_MODEL_TIMEOUT_MS is enforced one layer
 * lower, as a fetch AbortSignal in transport.ts, so the guard always applies.
 * 24_000 tripped it and every triage run died before reaching the model with
 * "Streaming is required for operations that may take longer than 10 minutes".
 * 20_000 sits under the ceiling with margin, is 25% above the 16_000 that was
 * observed to truncate, and needs 1961s at 10.2 tok/s.
 *
 * The ceiling problem is therefore NOT solved here. It is solved by serving a
 * larger context window (a `-ctx64k` tag gives 64_000 - 16_000 = 48_000 tokens
 * of prompt budget, clearing the deepest investigation recorded at 34_922),
 * which is a per-deployment property this constant cannot set.
 *
 * Changing this changes what every arm can produce, so it is a whole-matrix
 * re-run, never a per-model adjustment.
 */
const MAX_TOKENS = 20_000;

/** Exported so the suite can assert the two relations above. */
export const GENERATION_ALLOWANCE = MAX_TOKENS;

/**
 * Which product this run makes.
 *
 * `postmortem` swaps the system prompt (for the house nine-section format
 * derived in `src/postmortem.ts`) and the report filename. It swaps nothing
 * else: same tools, same cached-prefix discipline, same SDK tool loop, same
 * metering footer written by code. Adding a second *loop* for post-mortems
 * would have reintroduced exactly the mode-flag problem `src/transport.ts`
 * exists to prevent.
 */
export type ReportMode = "triage" | "postmortem";

export type UsageRecord = {
  turn: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /**
   * Counters the server did not report on this turn; their numbers above are
   * placeholders, not measurements. Empty on the Anthropic path, which reports
   * all four. See `mapUsage` in `src/localWire.ts`.
   */
  unreported: UsageCounterName[];
};

const USAGE_COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const satisfies readonly UsageCounterName[];

/**
 * Re-exported from `src/egress.ts`.
 *
 * The predicate had two homes once the egress policy needed it too, and two
 * homes is one too many for the flag that decides whether the locality rule is
 * enforced. `src/egress.ts` owns it; this keeps the existing import site.
 */
export { isLocalEngine } from "./egress.js";

/**
 * How the report describes the engine that produced it.
 */

export function describeEngine(config: Config, model: string = config.ANTHROPIC_TRIAGE_MODEL): string {
  return isLocalEngine(config)
    ? `\`${model}\` on a local OpenAI-compatible endpoint — no adaptive thinking and no ` +
        "effort control: both are Anthropic-only request fields and are dropped in translation"
    : `\`${model}\`, adaptive thinking, effort \`${config.ANTHROPIC_TRIAGE_EFFORT}\``;
}

export type ModelIdentity = {
  /** What the harness asked for. */
  configured: string;
  /** Distinct non-empty model ids the server actually stamped on its replies. */
  reported: string[];
  /** What the report attributes the run to — the server's answer when it differs. */
  authoritative: string;
  mismatch: boolean;
  /**
   * Did the server identify itself at all?
   *
   * . `false` means every reply arrived with
   * no `model` field, so the run is attributed to the requested name **as a
   * request, not as a confirmation** — and the report says so. Before this, the
   * translator substituted the requested name into the message, so this state
   * was unreachable and an unidentified server was indistinguishable from an
   * agreeing one.
   */
  identityAvailable: boolean;
};

/**
 * Reconcile the model the harness asked for with the model the server says
 * answered.
 *
 * `toBetaMessage` faithfully records `payload.model` — the server's own claim
 * about which weights ran — but the report header and the metering footer both
 * read `config.ANTHROPIC_TRIAGE_MODEL`, the *request*. Configure `candidate-A`,
 * let the server fall back to `candidate-B` (Ollama serves whatever tag is
 * loaded; LM Studio serves whatever model is selected in the UI, ignoring the
 * request field entirely), and the artefact says A while B did the work.
 */
export function reconcileModelIdentity(
  configured: string,
  reported: readonly (string | undefined)[],
): ModelIdentity {
  const distinct: string[] = [];
  for (const value of reported) {
    if (typeof value === "string" && value !== "" && !distinct.includes(value)) {
      distinct.push(value);
    }
  }
  if (distinct.length === 0) {
    // The server stamped no identity at all. Nothing to reconcile against, and
    // inventing a disagreement would be as wrong as inventing agreement — but
    // silence is not agreement either, so it is reported as its own state. This branch is reachable now: `toBetaMessage` no longer
    // back-fills the requested name over the server's silence.
    return {
      configured,
      reported: [],
      authoritative: configured,
      mismatch: false,
      identityAvailable: false,
    };
  }
  const only = distinct[0] as string;

  const anthropicName = /^claude-/.test(configured);
  const datedAlias = new RegExp(`^${configured.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}$`);
  const isAliasOf = (id: string): boolean =>
    id === configured || (anthropicName && datedAlias.test(id));
  if (distinct.length === 1 && isAliasOf(only)) {
    return {
      configured,
      reported: distinct,
      authoritative: only,
      mismatch: false,
      identityAvailable: true,
    };
  }
  return {
    configured,
    reported: distinct,
    authoritative: distinct.join(", "),
    mismatch: true,
    identityAvailable: true,
  };
}

export type TriageResult = {
  reportPath: string;
  turns: number;
  usage: UsageRecord[];
  totals: Omit<UsageRecord, "turn" | "unreported">;
  stopReason: string | null;
  /** Which model the harness asked for vs which one the server says answered. */
  model: ModelIdentity;
  /**
   * The conversation the tool loop actually built, verbatim: every assistant
   * message and every `tool_result` message, in order.
   *
   * , findings 1 and 2 (HIGH). This — not the transport's
   * recorded HTTP exchanges — is the ground truth the graders lift from. The
   * transport is a mock-only artefact (`liveTransport` records nothing) and,
   * because the pinned SDK ships a turn's `tool_result` in the *next* request,
   * a request-derived transcript also loses every call made on the final
   * permitted iteration. Tools execute in-process on both transports and the
   * SDK appends their results here before the iteration cap is re-checked, so
   * this source is complete on both paths.
   */
  messages: readonly unknown[];
  /**
   * Which investigation mode produced this run, and what the harness gathered
   * if it was the scaffolded one. Always present: `enabled: false` is the
   * autonomous path, and it is a recorded fact rather than an absence.
   */
  sweep: SweepOutcome;
  /**
   * The served context window this run was measured against, or null
   * on a path that has no server-chosen window (Anthropic API, recorded
   * fixture). Never `undeterminable` here: that outcome refuses the run.
   */
  contextWindow: Extract<ContextWindowProbe, { outcome: "served" }> | null;
};

/**
 * What a REFUSED run leaves behind.
 *
 * Every refusal in `runTriage` is a statement that no report may be written
 * from this run. Until 2026-08-11 it was also, silently, a statement that
 * NOTHING may be kept from it: the refusals threw a bare `Error`, and
 * `src/replay.ts` writes every artefact — transcript, tools, retrieval,
 * queries — strictly downstream of a returned `TriageResult`, so a throw took
 * the whole record with it.
 *
 * So the refusal now carries the run's own record out with it. The refusal
 * itself is unchanged in every respect that matters: it is still a throw, still
 * aborts before `reportPathFor` is reached, and still means no report, no
 * grade, and no gradeable artefact — see `refusedArtefactBase` for why the
 * files this produces cannot be mistaken for a completed run's, and
 * `loadToolEvidenceFrom` for the refusal that stops one being graded anyway.
 */
export type RefusedRunRecord = {
  /** A stable machine key for WHICH refusal fired. */
  refusal:
    | "abnormal-turn"
    | "self-contradictory-turn"
    | "iteration-cap"
    | "self-contradictory-final-turn"
    | "final-turn-not-end-turn"
    | "no-text";
  /** The refusal's own message, verbatim — the same text the throw carries. */
  reason: string;
  /** How many model turns the loop had accepted when the refusal fired. */
  turns: number;
  /** The cap this run was configured with, whether or not it was reached. */
  maxIterations: number;
  /** The final message's stop reason, where the refusal had one to read. */
  stopReason: string | null;
  /** Per-turn `(stop_reason, tool_use count)`, in order. */
  turnShapes: readonly { stop: string | null; toolUses: number }[];
  usage: readonly UsageRecord[];
  /**
   * A COPY, taken at the moment of refusal, and it ends with the turn the
   * refusal is about. For the post-loop refusals (`iteration-cap` and the rest)
   * the runner has already appended that turn and its tool results; for the
   * two in-loop refusals it had not, and `refuse` re-attaches it — see
   * `turnUnderExamination` in `runTriage`. Tool calls in a re-attached turn are
   * unanswered because they never ran, so they appear in the transcript and
   * NOT in the `tools.json` derived from it.
   */
  messages: readonly unknown[];
  sweep: SweepOutcome;
};

/**
 * The error every `runTriage` refusal throws once a conversation exists.
 *
 * Callers that only want the refusal need do nothing: it is an `Error`, its
 * message is the refusal's own text, and rethrowing it is the default. Callers
 * that persist artefacts (`src/replay.ts`) read `.record` and write the
 * transcript out under a REFUSED name before rethrowing.
 */
export class RefusedRunError extends Error {
  readonly record: RefusedRunRecord;

  constructor(record: RefusedRunRecord) {
    super(record.reason);
    this.name = "RefusedRunError";
    this.record = record;
  }
}

/**
 * The base path for a refused run's artefacts: `REFUSED-<date>` in the same
 * directory a report would have gone.
 *
 * Shouted, and NOT `triage-`/`postmortem-`, for one reason: every consumer in
 * this repo — `scripts/grade.ts`, `tools/arm-compare`, `tools/failure-census`,
 * `tools/scenario-drift` — finds a run's sidecars by taking a report path and
 * swapping its extension. A refused run has no report, so a sidecar named as
 * one would be an orphan that reads exactly like a completed run's file. The
 * name says what it is before anything opens it, and the `refused` block inside
 * each file says it again to anything that does.
 */
export function refusedArtefactBase(dir: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const plain = path.join(dir, `REFUSED-${day}`);
  if (!existsSync(`${plain}.transcript.json`)) return plain;
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return path.join(dir, `REFUSED-${day}T${time}`);
}

function recordUsage(turn: number, usage: BetaUsage): UsageRecord {
  // `unreported_counters` is set by `mapUsage` on the local path and rides along
  // on the usage object (extra fields survive the SDK's parse). Absent on the
  // Anthropic path, which reports all four counters.
  const marker = (usage as unknown as Record<string, unknown>)["unreported_counters"];
  const unreported = Array.isArray(marker)
    ? marker.filter((n): n is UsageCounterName =>
        (USAGE_COUNTERS as readonly string[]).includes(n as string),
      )
    : [];
  return {
    turn,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    unreported,
  };
}

function usageCell(record: UsageRecord, counter: UsageCounterName): string {
  return record.unreported.includes(counter) ? "—" : String(record[counter]);
}

function totalCell(
  records: readonly UsageRecord[],
  totals: Omit<UsageRecord, "turn" | "unreported">,
  counter: UsageCounterName,
): string {
  const missing = records.filter((r) => r.unreported.includes(counter)).length;
  if (records.length > 0 && missing === records.length) return "**—**";
  return missing === 0 ? `**${totals[counter]}**` : `**${totals[counter]}**\\*`;
}

function finalText(message: BetaMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** `<kind>-<date>.md`, with a time suffix only if that name is already taken. */
export function reportPathFor(dir: string, now: Date, kind: ReportMode = "triage"): string {
  const day = now.toISOString().slice(0, 10);
  const plain = path.join(dir, `${kind}-${day}.md`);
  if (!existsSync(plain)) return plain;
  const stamp = now.toISOString().replace(/[:.]/g, "").replace(/-/g, "").slice(0, 15);
  return path.join(dir, `${kind}-${stamp}Z.md`);
}

/** Exclusively reserve before writing; the advisory filename may race. */
async function writeReservedReport(preferredPath: string, report: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? preferredPath : preferredPath.replace(/\.md$/, `-${attempt + 1}.md`);
    let file;
    try {
      file = await open(candidate, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await file.writeFile(report, "utf8");
    } finally {
      await file.close();
    }
    return candidate;
  }
}

/**
 * ## This is NOT a system-prompt change — deliberately
 *
 * It is mechanism-free on purpose: it says evidence has been supplied and that
 * more investigation is expected. It names no query, no scenario, no expected
 * finding, and no rubric dimension.
 */
const SWEEP_USER_NOTE = [
  "Before you answer, the harness ran a fixed read-only evidence sweep for this alert's class.",
  "Its calls and their verbatim results are the tool calls and results that follow this message:",
  "they were issued by code, not chosen by you, and they are yours to read and cite exactly like",
  "any call you make yourself.",
  "",
  "They are a floor, not a ceiling. All of your tools remain available, and where the supplied",
  "evidence leaves a question open you are expected to investigate further yourself.",
].join("\n");

export function buildUserTurn(
  payload: WebhookPayload,
  mode: ReportMode,
  sweepInjected: boolean,
): string {
  const namespaces = namespacesInPayload(payload);
  const hint =
    namespaces.length > 0
      ? `Namespaces named by this alert: ${namespaces.join(", ")}.`
      : "This alert names no namespace. You are namespaced-only, so you will have to infer which namespace to look in from the alert's labels, annotations and generatorURL — and say so if you cannot.";

  return [
    mode === "postmortem"
      ? "Draft a post-mortem for the incident this AlertManager webhook payload belongs to. Investigate first; the payload is the entry point, not the whole story."
      : "Triage the following AlertManager webhook payload.",
    "",
    hint,
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    ...(sweepInjected ? ["", SWEEP_USER_NOTE] : []),
  ].join("\n");
}

/**
 * The ordered tool set API mode gives the model. Exported so
 * The offline check suite can assert that subscription mode's
 * `buildReadOnlyTools` builds the same list — the parity `src/sub/toolset.ts`
 * claims but nothing checked.
 */
export function apiModeTools(config: Config) {
  return [
    kubectlReadTool(config),
    ...(promqlAvailable(config) ? [promqlQueryTool(config)] : []),
    ...(argocdAvailable(config) ? [argocdStatusTool(config)] : []),
    ...(docsAvailable(config) ? [docsSearchTool(config), docsReadTool(config)] : []),
  ];
}

export async function runTriage(options: {
  payload: WebhookPayload;
  /**
   * The engine for the run: the client and its config as ONE bound unit.
   *
   * So the pair is now the unit: the only way to hand runTriage a client is
   * inside a `Transport`, and `assertTransportPairing` below refuses any whose
   * client is unbound or was factory-bound to a different config object. There
   * is no signature left through which an unfrozen or mismatched config
   * reaches tool construction. Omitted, a live transport is built here — the
   * strict config load and the binding both happen inside the factory.
   */
  transport?: Transport;
  outputDir?: string;
  now?: Date;
  mode?: ReportMode;
  onTurn?: (record: UsageRecord) => void;
  /**
   * Called once, after the evidence sweep has run and **before** the first request
   * leaves this process.
   *
   * It exists for one caller and one fact: `src/replay.ts` has to tell the
   * recorded transport how many assistant turns the HARNESS authored, so that a
   * scenario's `expectedToolFailures` turn numbers keep meaning *model* turns
   * (scripted turn 4 is still scripted turn 4 with a sweep in front of it).
   * Synchronous, and invoked before the tool loop starts, so the value is in
   * place by the time the transport sees a request.
   */
  onSweep?: (outcome: SweepOutcome) => void;
}): Promise<TriageResult> {

  if ("config" in options || "client" in options) {
    throw new Error(
      "runTriage no longer accepts `config` and `client` as independent options " +
        "a client next to a config it did not come " +
        "from can keep inference local while the tools egress unrestricted. Pass " +
        "`transport` — the factory-built unit that binds the two — or omit it for a " +
        "live API run.",
    );
  }
  const transport = options.transport ?? liveTransport();
  // The pairing check, every run: the config beside this client must be the
  // frozen snapshot a factory bound to it. Mismatched halves refuse here,
  // before a single tool is constructed.
  assertTransportPairing(transport);
  const { config, client } = transport;
  const now = options.now ?? new Date();
  const outputDir = options.outputDir ?? process.cwd();
  const mode: ReportMode = options.mode ?? "triage";

  const hasPromql = promqlAvailable(config);
  const hasArgocd = argocdAvailable(config);
  const hasDocs = docsAvailable(config);

  const tools = apiModeTools(config);

  // Stable prefix: tools render first, then these system blocks. The breakpoint
  // sits on the LAST system block so it caches tools + system together.
  const system: BetaTextBlockParam[] = [
    { type: "text", text: mode === "postmortem" ? POSTMORTEM_SYSTEM_PROMPT : TRIAGE_SYSTEM_PROMPT },
    {
      type: "text",
      text: toolAvailabilityNote({ promql: hasPromql, argocd: hasArgocd, docs: hasDocs }),
      cache_control: { type: "ephemeral" },
    },
  ];

  // Ordered deliberately: the plan is PURE (`planSweep` does no I/O), so the
  // requirement can be computed and the gate can refuse *before* `executeSweep`
  // reads a single byte from the cluster. Refusing after the sweep ran would
  // still be correct, and would still have cost the reads.
  const allowanceRaw = config.SRE_AGENT_LOCAL_GENERATION_ALLOWANCE ?? "";
  let allowance = MAX_TOKENS;
  if (allowanceRaw !== "") {
    const parsed = Number(allowanceRaw);
    if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
      throw new Error(
        `SRE_AGENT_LOCAL_GENERATION_ALLOWANCE must be an integer in 1_000..120_000, got ` +
          `${JSON.stringify(allowanceRaw)}. Empty means the built-in allowance of ${MAX_TOKENS}.`,
      );
    }
    if (transport.kind !== "local") {
      throw new Error(
        `SRE_AGENT_LOCAL_GENERATION_ALLOWANCE is set to ${parsed} but this is a ` +
          `${transport.kind} run. Above ${21_333} the SDK refuses a non-streaming request from a ` +
          `client that declares no timeout, and the live client declares none deliberately — that ` +
          `guard is correct about the real API. Unset it, or run with --local.`,
      );
    }
    allowance = parsed;
  }

  const plan = sweepEnabled(config) ? planSweep(options.payload) : null;
  const requirement = contextRequirement({
    plan,
    systemTexts: system.map((block) => block.text),
    tools: tools as unknown as readonly {
      name: string;
      description?: string;
      input_schema?: unknown;
    }[],
    userTurnText: buildUserTurn(options.payload, mode, plan !== null),
    maxOutputTokens: allowance,
  });
  // Absent probe = a path with no server-chosen window (Anthropic API, recorded
  // fixture). Present probe = a locally served model, and then BOTH non-passing
  // outcomes throw.
  const contextWindow = transport.probeContextWindow
    ? assertContextWindowSufficient(await transport.probeContextWindow(), requirement)
    : null;

  const sweep: SweepOutcome = plan
    ? await executeSweep({
        plan,
        tools,
        because: "SRE_AGENT_EVIDENCE_SWEEP is on (the default)",
      })
    : SWEEP_DISABLED;
  options.onSweep?.(sweep);

  // ## The two probe arms, and why they live here
  //
  // Both are OFF by default, both are recorded in the artefact, and a run with
  // either on is its own arm — never pooled with a scaffolded or autonomous
  // number (docs/safety-model.md). Nothing else about the run changes: same
  // prompt, same tools, same scenario, same rubric, same grader.
  const forceFirstToolCall = config.SRE_AGENT_FORCE_FIRST_TOOL_CALL;
  const continuationNudge = config.SRE_AGENT_CONTINUATION_NUDGE;
  let forcedTurns = 0;
  let releasedAfterTurn: number | null = null;
  let nudgedAtTurn: number | null = null;

  const temperatureRaw = config.SRE_AGENT_LOCAL_TEMPERATURE ?? "";
  let temperatureArm: number | null = null;
  if (temperatureRaw !== "") {
    const parsed = Number(temperatureRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
      throw new Error(
        `SRE_AGENT_LOCAL_TEMPERATURE must be a number in 0..2, got ${JSON.stringify(temperatureRaw)}. ` +
          "It is empty by default, which sends no temperature and lets the served model's own " +
          "default govern.",
      );
    }
    temperatureArm = parsed;
  }
  if (temperatureArm !== null && transport.kind !== "local") {
    throw new Error(
      `SRE_AGENT_LOCAL_TEMPERATURE is set to ${String(temperatureArm)} but this is a ` +
        `${transport.kind} run. The Anthropic API refuses a temperature other than 1 when ` +
        `thinking is enabled, and this request always sends thinking, so the value could only ` +
        `be dropped — leaving an arm that reports a temperature it never ran at. Unset it, or ` +
        `run with --local.`,
    );
  }

  const runner = client.beta.messages.toolRunner({
    model: config.ANTHROPIC_TRIAGE_MODEL,
    max_tokens: allowance,
    ...(temperatureArm === null ? {} : { temperature: temperatureArm }),
    thinking: { type: "adaptive" },
    output_config: { effort: config.ANTHROPIC_TRIAGE_EFFORT },
    max_iterations: config.SRE_AGENT_MAX_ITERATIONS,
    system,
    tools,
    ...(forceFirstToolCall ? { tool_choice: { type: "any" as const } } : {}),
    messages: [
      {
        role: "user",
        content: buildUserTurn(options.payload, mode, sweep.injectedAssistantTurns > 0),
      },
      ...(sweep.messages as never[]),
    ],
  });

  const usage: UsageRecord[] = [];
  const reportedModels: (string | undefined)[] = [];
  const turnShapes: { stop: string | null; toolUses: number }[] = [];
  let modelToolUses = 0;
  let turn = 0;

  /**
   * The turn currently under examination, or `undefined` between turns.
   *
   * Snapshotting the params alone therefore produced a record with a hole in
   * exactly the place the refusal is about: a transcript that stops one turn
   * short of the turn that caused it, leaving the operator a refusal message
   * naming a shape and no bytes to read it in. `refuse` puts the turn back.
   */
  let turnUnderExamination: BetaMessage | undefined;

  /**
   * Refuse the run, and carry its record out with the refusal.
   *
   * This changes nothing about WHEN a run is refused or WHAT is refused. Every
   * caller of this helper below threw a bare `Error` before; each one still
   * throws, at the same line, on the same condition, with the same message.
   * The only difference is that the thrown value now also holds the
   * conversation, so a caller that wants the record can keep it instead of
   * watching it go up with the stack. See `RefusedRunRecord`.
   *
   * The conversation is COPIED, not aliased. `runner.params.messages` is the
   * SDK's own live array; handing it out means the record a refusal carries is
   * whatever that array says whenever somebody gets round to reading it, which
   * is not a record. The copy is also where the refused turn is re-attached
   * (see `turnUnderExamination`).
   */
  const refuse = (
    refusal: RefusedRunRecord["refusal"],
    reason: string,
    stopReason: string | null,
  ): RefusedRunError => {
    const messages: unknown[] = [...(runner.params.messages as readonly unknown[])];
    if (turnUnderExamination !== undefined) {
      // Shaped exactly as the SDK would have pushed it, so a reader cannot tell
      // a re-attached turn from one the runner appended itself. Its `tool_use`
      // blocks stay UNANSWERED, which is the truth: an in-loop refusal fires
      // before the runner resumes, so those calls never executed. That is also
      // why this cannot inflate `tools.json` — `toolCallsFromMessages` emits a
      // call only when a matching `tool_result` comes back.
      messages.push({
        role: turnUnderExamination.role,
        content: turnUnderExamination.content,
      });
    }
    return new RefusedRunError({
      refusal,
      reason,
      turns: turn,
      maxIterations: config.SRE_AGENT_MAX_ITERATIONS,
      stopReason,
      turnShapes: [...turnShapes],
      usage: [...usage],
      messages,
      sweep,
    });
  };
  let last: BetaMessage | undefined;

  for await (const message of runner) {
    turn += 1;
    last = message;
    turnUnderExamination = message;
    // Stated exactly: this closes the window between turns, not the window
    // inside one. Bytes already written to a socket cannot be recalled, so a
    // disarm during an in-flight HTTP request stops the run at the next turn and
    // no earlier. That residual is inherent to any check outside the transport's
    // own fetch, and a hand-built client's fetch is not ours to hook — which is
    // why the shape refusals (local-engine config, non-Anthropic origin) are
    // unconditional rather than gate-dependent.
    assertTransportPairing(transport);
    // Re-checked here, per turn, against the same arithmetic and the measured
    // accumulation. Skipped (returning the count, throwing nothing) when no
    // server-served window was probed.
    //
    // The bound that actually holds is at the WIRE:
    // `assertRequestFitsServedWindow` runs inside `localTransport`'s own fetch,
    // on the finished payload, before a socket is opened. It also measures more than this
    // check can — the whole payload rather than tool results alone.
    //
    // This assertion is kept as the between-turns early warning it really is: it
    // names the turn and prints the arithmetic in the loop's own terms, and it
    // is the only one of the two that exists on paths whose transport is not
    // ours. It is NOT the runtime bound, and nothing in this file should be read
    // as saying it is.
    assertAccumulatedEvidenceFits({
      messages: runner.params.messages as readonly unknown[],
      requirement,
      probe: contextWindow,
      turn,
    });
    const toolUseCount = message.content.filter((b) => b.type === "tool_use").length;
    turnShapes.push({ stop: message.stop_reason ?? null, toolUses: toolUseCount });
    // The deliberate allowlist, mid-loop: `tool_use` (the model asked for
    // tools; the runner will execute them and continue) and `end_turn` (the
    // model finished; the runner stops, and the post-loop checks own whether
    // that final turn may become a report). Everything else refuses here:
    // `max_tokens` is a truncation, `refusal` is a declined turn,
    // `stop_sequence` never occurs without configured stop strings (none are
    // configured here), `pause_turn` belongs to server tools (none are
    // registered here — tolerate it BY NAME with an assertion if server tools
    // are ever added), and an absent or unknown value is an outcome this
    // harness does not understand. The local adapter refuses truncated
    // tool-calling turns at the wire as well; this check is the belt to that
    // brace and the ONLY guard on the API path.
    if (message.stop_reason !== "tool_use" && message.stop_reason !== "end_turn") {
      throw refuse(
        "abnormal-turn",
        `turn ${turn} ended with stop_reason=${JSON.stringify(message.stop_reason ?? null)} — ` +
          "not a complete turn. An investigation may only contain complete turns " +
          "(tool_use mid-loop, end_turn to finish); a truncated or abnormal turn " +
          "anywhere in the run poisons everything built on it, so this run is " +
          "refused at the turn where it broke, before that turn's tool calls " +
          "(if any) execute. No report will be written.",
        message.stop_reason ?? null,
      );
    }

    if (toolUseCount > 0 && message.stop_reason !== "tool_use") {
      throw refuse(
        "self-contradictory-turn",
        `turn ${turn} carries ${toolUseCount} tool_use block(s) but ended with ` +
          `stop_reason=${JSON.stringify(message.stop_reason ?? null)} — a turn that ` +
          "requests tools must stop with tool_use. A message claiming to be finished " +
          "while still asking for tool calls is self-contradictory; refusing before " +
          "any of those calls executes. No report will be written.",
        message.stop_reason ?? null,
      );
    }
    // The server's own claim about which weights answered. Collected per turn, not once: a server can swap the loaded
    // model mid-run, and a run half-answered by another model is exactly the
    // thing a comparison table must not silently absorb.
    reportedModels.push(message.model);
    const record = recordUsage(turn, message.usage);
    usage.push(record);
    options.onTurn?.(record);
    modelToolUses += toolUseCount;

    // ---- The probe arms act here, at the end of a turn the loop has already
    // accepted as complete.
    //
    // Both work by mutating the runner's params during the yield, and that has
    // one consequence which must not be discovered later: the pinned SDK pushes
    // the assistant message into the conversation only when the params were NOT
    // mutated during the yield (`lib/tools/BetaToolRunner.js`: the push sits
    // under `if (!this.#mutated)`). So whenever this block mutates, it must push
    // the model's own turn itself — otherwise that turn vanishes from the
    // conversation and from the transcript the run is graded on, and the tool
    // results of the turn would be generated against the wrong last message.
    if (forceFirstToolCall && turn === 1) {
      forcedTurns = 1;
      if (toolUseCount > 0) {
        // The constraint has done its job. Release it before the results come
        // back, so every later call in this run is the model's own choice —
        // which is the only reason the arm is worth running.
        runner.pushMessages({ role: "assistant", content: message.content });
        runner.setMessagesParams((params) => ({ ...params, tool_choice: { type: "auto" } }));
        releasedAfterTurn = turn;
      }
      // A forced turn that made no call means the server did not honour the
      // constraint. Nothing is done about it here: re-asking would repeat the
      // same non-effect, and mutating would restart a loop the model has already
      // ended. It is recorded in the footer as what it is.
    }
    if (
      continuationNudge !== "" &&
      nudgedAtTurn === null &&
      modelToolUses === 0 &&
      toolUseCount === 0 &&
      message.stop_reason === "end_turn"
    ) {
      // Fires at most once, and only on a run in which the model has called
      // nothing at all. A nudge after a real call would be pressure on an
      // investigation in progress; this is only ever the question of whether a
      // model that stopped without starting will start.
      runner.pushMessages(
        { role: "assistant", content: message.content },
        { role: "user", content: continuationNudge },
      );
      nudgedAtTurn = turn;
    }
    // Last statement of the body, deliberately. Past this point the loop yields
    // control back to the runner, which appends this turn to its own params —
    // so from here on the snapshot in `refuse` already contains it and
    // re-attaching would duplicate the turn. Every refusal below this line is a
    // post-loop one reading a conversation the runner has finished writing.
    turnUnderExamination = undefined;
  }

  if (!last) {
    throw new Error("the tool runner produced no messages");
  }

  // Belt to the two in-loop refusals above:
  // unreachable while those throw at the abnormal turn, but the rule "no
  // report from a run containing any incomplete or self-contradictory turn"
  // is re-stated at the acceptance end so it survives a future change to the
  // loop's yield order or an early `break`.
  const abnormalTurn = turnShapes.findIndex(
    (t) =>
      (t.stop !== "tool_use" && t.stop !== "end_turn") ||
      (t.toolUses > 0 && t.stop !== "tool_use"),
  );
  if (abnormalTurn !== -1) {
    const shape = turnShapes[abnormalTurn] as { stop: string | null; toolUses: number };
    throw refuse(
      "abnormal-turn",
      `turn ${abnormalTurn + 1} of ${turnShapes.length} ended with ` +
        `stop_reason=${JSON.stringify(shape.stop)} carrying ${shape.toolUses} tool_use ` +
        "block(s); a run containing a truncated, abnormal or self-contradictory turn " +
        "has no report, whatever the final turn said.",
      last.stop_reason ?? null,
    );
  }

  // Totals sum only what was measured. Adding a placeholder zero would be
  // harmless arithmetically and dishonest presentationally: it would make an
  // unreported counter indistinguishable from a measured one in the bottom row.
  const add = (acc: number, u: UsageRecord, counter: UsageCounterName): number =>
    u.unreported.includes(counter) ? acc : acc + u[counter];
  const totals = usage.reduce(
    (acc, u) => ({
      input_tokens: add(acc.input_tokens, u, "input_tokens"),
      output_tokens: add(acc.output_tokens, u, "output_tokens"),
      cache_creation_input_tokens: add(
        acc.cache_creation_input_tokens,
        u,
        "cache_creation_input_tokens",
      ),
      cache_read_input_tokens: add(acc.cache_read_input_tokens, u, "cache_read_input_tokens"),
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  );

  // , second half. `stop_reason: "tool_use"`
  // on the *last* message the loop produced means the model was still working:
  // it asked for tools that the runner executed but whose results it was never
  // shown, because the iteration cap cut the conversation off. Any prose in
  // that turn is a mid-investigation aside, not a report — it was written
  // before the evidence it asked for came back.
  //
  // Writing it out anyway produced a gradeable artefact from a truncated run,
  // which is the same class of mistake as reading an empty vector as health:
  // an incomplete measurement presented as a finding. A truncated run must fail
  // loudly, and the operator's fix is to raise SRE_AGENT_MAX_ITERATIONS.
  if (last.stop_reason === "tool_use") {

    const lastToolUses = turnShapes[turnShapes.length - 1]?.toolUses ?? 0;
    if (lastToolUses === 0) {
      throw refuse(
        "self-contradictory-final-turn",
        `the tool loop stopped with stop_reason=tool_use after ${turn} turn(s), but the ` +
          "final turn carries NO tool_use blocks: the model declared it was calling tools " +
          "while requesting none. That is a self-contradictory final turn — not a finished " +
          "report and not an iteration-cap truncation — so no report is written. If this " +
          "shape recurs, record it against the model/adapter rather than raising " +
          "SRE_AGENT_MAX_ITERATIONS.",
        last.stop_reason ?? null,
      );
    }
    throw refuse(
      "iteration-cap",
      `the tool loop stopped with stop_reason=tool_use after ${turn} turn(s) ` +
        `(max_iterations ${config.SRE_AGENT_MAX_ITERATIONS}). The model was still ` +
        "calling tools when the iteration cap cut it off, so this run has no final " +
        "report — only a turn written before its own evidence arrived. Refusing to " +
        "write a truncated investigation as a report; raise SRE_AGENT_MAX_ITERATIONS " +
        "and re-run. The conversation this run DID produce is persisted beside it " +
        "under a REFUSED- name and is not gradeable.",
      last.stop_reason ?? null,
    );
  }

  if (last.stop_reason !== "end_turn") {
    throw refuse(
      "final-turn-not-end-turn",
      `the final turn ended with stop_reason=${JSON.stringify(last.stop_reason)} after ` +
        `${turn} turn(s); a report is only written from a turn the model finished itself ` +
        "(end_turn). max_tokens means the generation was truncated mid-report; refusal " +
        "means there is no report; anything else is an outcome this harness does not " +
        "recognise. Refusing to write a partial or declined investigation as a report.",
      last.stop_reason ?? null,
    );
  }

  const body = finalText(last);
  if (body === "") {
    throw refuse(
      "no-text",
      `the model returned no text (stop_reason=${last.stop_reason ?? "unknown"}). No report written.`,
      last.stop_reason ?? null,
    );
  }

  const identity = reconcileModelIdentity(config.ANTHROPIC_TRIAGE_MODEL, reportedModels);

  const probeArmLines: string[] = [];
  if (forceFirstToolCall) {
    probeArmLines.push(
      "- **Probe arm: FORCED FIRST TOOL CALL.** The opening request carried " +
        '`tool_choice: {"type":"any"}`, sent to the OpenAI-compatible endpoint as ' +
        '`tool_choice: "required"`. ' +
        (releasedAfterTurn !== null
          ? `Turn ${releasedAfterTurn} carried tool calls, and the constraint was released to ` +
            "`auto` immediately afterwards — so every later call in this run was the model's " +
            "own choice."
          : `The forced turn (${forcedTurns} of 1) made **no tool call**, so the server did not ` +
            "honour the constraint and nothing in this run was forced in effect. Read this run " +
            "as an un-forced one that carried an ignored flag."),
    );
  }
  if (continuationNudge !== "") {
    probeArmLines.push(
      nudgedAtTurn !== null
        ? "- **Probe arm: CONTINUATION NUDGE.** After turn " +
          `${nudgedAtTurn}, which finished with no tool call, this exact text was appended as a ` +
          `single user turn: ${JSON.stringify(continuationNudge)}`
        : "- **Probe arm: continuation nudge CONFIGURED BUT NEVER ISSUED** — no turn finished " +
          "without a tool call while the run had none. Unused text: " +
          JSON.stringify(continuationNudge),
    );
  }

  const preferredPath = reportPathFor(outputDir, now, mode);
  const header = [
    `# ${mode === "postmortem" ? "Post-mortem (draft)" : "Triage"} — ${alertName(options.payload)}`,
    "",
    `*Generated ${now.toISOString()} by sre-agent (${describeEngine(config, identity.authoritative)}). Read-only investigation; it proposes, a human disposes.*`,
    "",

    `*Investigation mode: ${describeSweepMode(sweep)}*`,
    ...(probeArmLines.length > 0 ? ["", ...probeArmLines] : []),
    ...(identity.mismatch
      ? [
          "",
          `> **Model identity mismatch.** The harness requested \`${identity.configured}\`; the ` +
            `server reported \`${identity.reported.join("`, `")}\`. This report is attributed to ` +
            "the **server-reported** identity, because that is what produced the text. Do not " +
            "record this run against the requested model.",
        ]
      : identity.identityAvailable
        ? []
        : [
            // . The model named above is what
            // was ASKED FOR. The server never said what answered, and this run
            // must not enter a comparison table as though it had.
            "",
            "> **Model identity unavailable.** The server returned no `model` field on any " +
              `reply, so \`${identity.configured}\` above is the model this harness ` +
              "*requested*, not a confirmation of what ran. Treat the attribution as " +
              "unverified when ranking this run.",
          ]),
    "",
    "---",
    "",
  ].join("\n");

  const footer = [
    "",
    "---",
    "",
    "## Run metering",
    "",
    `- Engine: ${describeEngine(config, identity.authoritative)}`,
    ...(identity.mismatch
      ? [
          `- **Model identity mismatch:** requested \`${identity.configured}\`, server reported ` +
            `\`${identity.reported.join("`, `")}\`. Attributed above to the server-reported identity.`,
        ]
      : identity.identityAvailable
        ? [`- Model identity: requested \`${identity.configured}\`, confirmed by the server.`]
        : [
            "- **Model identity: unavailable.** The server reported no `model` field; " +
              `\`${identity.configured}\` is the requested name, unconfirmed.`,
          ]),
    // recorded BESIDE model identity, deliberately. "Which model" and
    // "how much of it we were served" are one fact about a run, and the two
    // eval rounds that were graded without the second half are why this line
    // exists. A run whose window is unknown never reaches this footer — the
    // gate above refuses it.
    ...contextWindowFooterLines(contextWindow, requirement),
    `- Investigation mode: ${describeSweepMode(sweep)}`,
    ...probeArmLines,
    `- Tool-loop turns: ${turn} (max_iterations ${config.SRE_AGENT_MAX_ITERATIONS})`,
    `- Stop reason: \`${last.stop_reason ?? "unknown"}\``,
    `- Tools registered: ${tools.map((t) => `\`${t.name}\``).join(", ")}`,

    `- Egress: ${describeEgress(config)}`,
    "",
    "| turn | input | output | cache write | cache read |",
    "|---:|---:|---:|---:|---:|",
    ...usage.map(
      (u) =>
        `| ${u.turn} | ${usageCell(u, "input_tokens")} | ${usageCell(u, "output_tokens")} | ` +
        `${usageCell(u, "cache_creation_input_tokens")} | ${usageCell(u, "cache_read_input_tokens")} |`,
    ),
    `| **total** | ${totalCell(usage, totals, "input_tokens")} | ` +
      `${totalCell(usage, totals, "output_tokens")} | ` +
      `${totalCell(usage, totals, "cache_creation_input_tokens")} | ` +
      `${totalCell(usage, totals, "cache_read_input_tokens")} |`,
    "",
    // : the old wording claimed every number was read
    // verbatim while the code was synthesising zeroes for counters the server
    // never sent. Both halves are now true.
    "*Token counts are read verbatim from `response.usage` — never estimated. `—` means the " +
      "server reported no count for that counter; it is not a zero. A total marked `*` sums " +
      "only the turns that reported one.*",
    // The per-step sweep record. Written whether or not the steps succeeded: a
    // sweep call that read nothing is a fact about this run's evidence base, and
    // burying it would make two scaffolded runs look alike when they were not.
    ...sweepFooterLines(sweep),
    "",
  ].join("\n");

  const report = `${header}${body}\n${footer}`;
  const reportPath = await writeReservedReport(preferredPath, report);
  const verdict = publicationVerdict(report, JSON.stringify(options.payload));
  if (!verdict.publish) {
    const rejectionPath = reportPath.replace(/\.md$/, "") + ".rejected.json";
    const failures: string[] = [];
    // Persist here: CLI callers have no transcript writer, and replay only
    // writes its normal sidecars after runTriage returns successfully.
    const messages = runner.params.messages as readonly unknown[];
    const stem = reportPath.replace(/\.md$/, "");
    const artefacts = {
      transcript: () => ({ messages, exchanges: transport.exchanges, usage, turns: turn, sweep }),
      tools: () => ({ calls: toolCallsFromMessages(messages) }),
      queries: () => ({ calls: promqlCallsFromMessages(messages) }),
      retrieval: () => ({ calls: retrievalCallsFromMessages(messages) }),
    };
    for (const [suffix, value] of Object.entries(artefacts)) {
      try {
        await writeFile(`${stem}.${suffix}.json`, JSON.stringify(value(), null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      } catch (error) {
        failures.push(`${suffix} preservation failed: ${String(error)}`);
      }
    }
    try {
      writePublicationRejection(reportPath, options.payload, verdict, now);
    } catch (error) {
      failures.push(`rejection record write failed: ${String(error)}`);
    }
    throw new PublicationRejectedError(reportPath, rejectionPath, [verdict.reason, ...failures].join("\n"));
  }

  return {
    reportPath,
    turns: turn,
    usage,
    totals,
    stopReason: last.stop_reason ?? null,
    model: identity,
    // Read *after* the loop has fully drained: the SDK pushes each assistant
    // message and then the tool-result message for that turn, and only then
    // re-checks the iteration cap. So the final iteration's results are here
    // even though no request ever carried them.
    messages: runner.params.messages as readonly unknown[],
    sweep,
    contextWindow,
  };
}
