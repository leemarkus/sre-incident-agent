/**
 * Subscription-mode runner: one alert → one `claude -p` run → one report.
 *
 * The API-mode pipeline (`src/triage.ts`) is: prompt + tools → SDK tool loop →
 * report + metering footer + transcripts. This file keeps every stage but
 * replaces the SDK loop with a Claude Code headless run whose ONLY tools are
 * this project's read-only tools served by `src/sub/mcp-server.ts`.
 *
 * `--dry-run` performs stages 1 and 3 with no sweep and no spawn, prints the
 * exact argv (system prompt elided), and exits 0. It costs nothing and touches
 * nothing but the run directory; the offline check suite relies on it.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import { EXIT_PUBLICATION_REJECTED, publicationVerdict, rejectionNotification, rejectionSummary, type RejectionSummary, writePublicationRejection } from "../publication.js";
import { alertName, parseWebhookPayload, type WebhookPayload } from "../alert.js";
import type { Config } from "../config.js";
import { describeEgress } from "../egress.js";
import { alertSafetyContext, describeMutations, recommendedMutations } from "../mutations.js";
import { POSTMORTEM_SYSTEM_PROMPT } from "../postmortem.js";
import { SUB_CITATION_CONTRACT } from "./citations.js";
import { TRIAGE_SYSTEM_PROMPT, toolAvailabilityNote } from "../prompt.js";
import {
  describeSweepMode,
  executeSweep,
  planSweep,
  SWEEP_DISABLED,
  sweepEnabled,
  sweepFooterLines,
  sweepPreamble,
  type SweepOutcome,
} from "../sweep.js";
import { buildUserTurn, reportPathFor, type ReportMode } from "../triage.js";
import {
  acquireRunLock,
  appendLedger,
  budgetVerdict,
  describeBudget,
  ledgerPath,
  LOCK_STALE_GRACE_MS,
  monthOf,
  monthSpend,
  readLedger,
  runLockPath,
  type BudgetVerdict,
  type LedgerEntry,
} from "./budget.js";
import {
  appendCall,
  readCalls,
  summarizeCalls,
  toQueryTranscript,
  toRetrievalTranscript,
  toToolTranscript,
} from "./calllog.js";
import { describeSubConfig, loadSubscriptionConfig, type SubConfig } from "./config.js";
import { SECRET_NAME } from "./redact.js";
import { buildReadOnlyTools, DENIED_BUILTIN_TOOLS, MCP_SERVER_NAME, mcpToolId, toolAvailability } from "./toolset.js";

export { EXIT_PUBLICATION_REJECTED } from "../publication.js";
export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
export const EXIT_BUDGET = 3;
export const EXIT_AUTH = 4;
export const EXIT_RUN_FAILED = 5;
/** The subscription's 5-hour or weekly window is exhausted; retrying only burns it further. */
export const EXIT_USAGE_LIMIT = 6;

const HERE = fileURLToPath(import.meta.url);
const RUNNING_FROM_SOURCE = HERE.endsWith(".ts");
export const PROJECT_ROOT = path.resolve(path.dirname(HERE), "..", "..");

/** The structured answer Claude Code is asked for; `report` is the Markdown body. */
export const REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    report: {
      type: "string",
      description:
        "The complete report body in Markdown, starting at its first `## ` section heading. " +
        "The harness writes the title line and the metering footer.",
    },
  },
  required: ["report"],
  additionalProperties: false,
} as const;

export const SUB_MODE_NOTE = [
  "Harness note (subscription mode). You are running inside Claude Code in non-interactive mode.",
  `Your tools are the ones on the \`${MCP_SERVER_NAME}\` MCP server and no others: there is no shell,`,
  "no file system, no web access, and no way to write anything anywhere. In your report refer to",
  "the tools by their short names (`kubectl_read`, `promql_query`, …), not their `mcp__` prefix.",
  "Your final answer is the report itself, returned in the `report` field of the requested JSON:",
  "the full Markdown body, beginning at its first `## ` section heading. Do not add a title line",
  "or a metering section — the harness writes both.",
].join(" ");

export const SUB_ALERT_OBJECT_RULE = [
  "Rule for every step you recommend (subscription mode): the Suggested runbook, any remediation,",
  "and any post-mortem action item. Never recommend deleting, evicting or",
  "otherwise removing the object the alert is about, any of its pods, or its sibling Jobs, and never",
  "do it to make the alert clear. A finished or failed Job and its Error pod are the incident's",
  "evidence: deleting them hides the failure and leaves the cause in place, and \"it only removes a",
  "finished Job record\" is not an exception. Read the failed pod's logs and events with",
  "`kubectl_read`, name the cause, and give the fix for that cause. If the alert should clear by",
  "itself once a later run succeeds or the Job history limit rotates the record out, say that",
  "instead. A report that recommends deleting the alert's own object is refused before anyone sees",
  "it, so the run is wasted.",
].join(" ");

// ---------------------------------------------------------------------------
// Claude Code invocation

export type ClaudeInvocation = {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcpConfig: unknown;
};

/** Environment variable names that must never be written into a run artefact. */
export { SECRET_NAME };

/**
 * The Claude Code versions this belt has actually been reviewed against.
 *
 * the built-in tool inventory, the meaning of `--tools ""`,
 * and the existence of `--restricted` are all properties of one
 * CLI build. A silent upgrade can add a code-running built-in this project has
 * never denied, so an unlisted version refuses to run rather than running on an
 * unreviewed belt.
 */
export const SUPPORTED_CLAUDE_VERSIONS = ["2.1.258", "2.1.280", "2.1.302"] as const;

export function supportedClaudeVersions(env: NodeJS.ProcessEnv): string[] {
  const extra = (env["SRE_SUB_EXTRA_CLAUDE_VERSIONS"] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return [...SUPPORTED_CLAUDE_VERSIONS, ...extra];
}

/** `2.1.258 (Claude Code)` → `2.1.258`; anything else → "". */
export function parseClaudeVersion(output: string): string {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(output.trim())?.[1] ?? "";
}

export function claudeVersionRefusal(version: string, allowed: readonly string[]): string {
  return (
    `refused: \`claude --version\` reported ${version === "" ? "no parseable version" : version}, ` +
    `which is not one of the reviewed versions (${allowed.join(", ")}). The read-only belt — the ` +
    "built-in tool inventory denied by name, `--tools \"\"`, `--restricted` — is a " +
    "property of one CLI build, so an unreviewed build gets no run. Re-run the belt review " +
    "against this CLI, then add the version to SUPPORTED_CLAUDE_VERSIONS in src/sub/run.ts (or set " +
    "SRE_SUB_EXTRA_CLAUDE_VERSIONS for a one-off, knowing the review has not been done)."
  );
}

/** Run `<bin> --version`. Spawns the CLI but makes no model call: $0. */
export async function readClaudeVersion(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve) => {
    // Same positive allowlist as the inference spawn: the version probe must not
    // be the one child that still inherits the whole environment.
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: claudeChildEnv(env) });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseClaudeVersion(out));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

/**
 * The environment the `claude` child is allowed to see — a POSITIVE allowlist. Spreading `{ ...env }` and deleting three names left every
 * provider selector, gateway URL and cloud credential in the shell reachable by
 * the CLI, which would reroute inference off the subscription and could hand the
 * subscription credential to an arbitrary base URL. What is left here is what a
 * process needs to run on macOS, plus the subscription credential itself.
 *
 * Nothing `SRE_SUB_*` is forwarded: audited 2026-09-02, the CLI reads none of
 * them, and the MCP child gets its tool configuration from `mcpServerCommand`
 * rather than by inheritance.
 */
export const CLAUDE_CHILD_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  // The subscription credential, when the run is driven by a token rather than
  // by the host's own `claude login` keychain entry.
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const CLAUDE_CHILD_ENV_ALLOW_PREFIXES = [/^LC_/] as const;

export function claudeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of CLAUDE_CHILD_ENV_ALLOW) {
    const value = env[name];
    if (typeof value === "string" && value !== "") child[name] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value === "") continue;
    if (CLAUDE_CHILD_ENV_ALLOW_PREFIXES.some((re) => re.test(key))) child[key] = value;
  }
  child["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  return child;
}

/** How Claude Code should launch the MCP server: same runtime as this process. */
export function mcpServerCommand(callLog: string, turnBase: number, env: NodeJS.ProcessEnv) {
  const script = RUNNING_FROM_SOURCE
    ? path.join(PROJECT_ROOT, "src", "sub", "mcp-server.ts")
    : path.join(PROJECT_ROOT, "dist", "sub", "mcp-server.js");
  const envFile = path.join(PROJECT_ROOT, ".env");
  const args = [`--env-file-if-exists=${envFile}`, ...(RUNNING_FROM_SOURCE ? ["--import", "tsx"] : []), script];
  // Pass the NON-SECRET tool-layer configuration through explicitly rather than
  // trusting Claude Code to forward its own environment to MCP children. The
  // mcp-config is written into the run directory as provenance, so nothing that
  // matches a credential name goes in it: tokens reach the server through the
  // project's `.env` (loaded by the child via --env-file-if-exists) and through
  // the environment Claude Code inherits from this process. Belt and braces for
  // the settings; neither belt for the secrets.
  const passthrough: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(key)) continue;
    const needed =
      /^(PATH|HOME)$/.test(key) ||
      // NOT `NODE_*`: NODE_OPTIONS is interpreted by
      // node before main() can drop anything, so `--require`/`--import` code would run
      // in the MCP child with its merged environment.
      /^(KUBE|KUBECTL_|GRAFANA_|ARGOCD_|FORGEJO_|SRE_AGENT_|SRE_SUB_|DOCS_|RUNBOOKS?_)/.test(key);
    if (needed) passthrough[key] = value;
  }
  // TOOL-ONLY environment: PATH and HOME so `kubectl` runs
  // and `~` resolves, the non-secret tool settings, and the call-log wiring —
  // and deliberately NOT the subscription credential. Claude Code merges its own
  // environment into the servers it launches, so the server ALSO drops
  // `CLAUDE_CODE_OAUTH_TOKEN` at startup (see `src/sub/mcp-server.ts`); this is
  // the half of that belt the harness controls.
  return {
    command: process.execPath,
    args,
    env: { ...passthrough, SRE_SUB_CALL_LOG: callLog, SRE_SUB_TURN_BASE: String(turnBase) },
  };
}

export function claudeArgs(options: {
  sub: SubConfig;
  tools: readonly BetaRunnableTool[];
  systemPrompt: string;
  userPrompt: string;
  /** Path of the mcp-config file written into the run directory. */
  mcpConfigPath: string;
}): string[] {
  const allowed = options.tools.map((t) => mcpToolId(t.name));
  return [
    "-p",
    options.userPrompt,
    "--model",
    options.sub.SRE_SUB_MODEL,
    "--effort",
    options.sub.SRE_SUB_EFFORT,
    "--system-prompt",
    options.systemPrompt,
    // The three built-in restrictions feed ONE deny path (EndConversation is
    // undeniable). --tools "" supplies toolsNarrowing denies for every base
    // tool and builtInToolsDisabled also refuses plugin tool registration.
    "--restricted", // 0. the CLI's own removal of command/code-running built-ins and WebFetch

    "--tools",
    "", // 1. disable base tools and plugin registration (shared exemption above)
    "--disallowedTools",
    DENIED_BUILTIN_TOOLS.join(","), // 2. explicit names on the same deny path
    "--allowedTools",
    allowed.join(","), // 3. only our MCP tools are pre-approved
    "--mcp-config",
    options.mcpConfigPath,
    "--strict-mcp-config", // no .mcp.json / user-scope servers leak in
    "--permission-mode",
    "dontAsk", // anything not pre-approved is refused, never prompted
    "--setting-sources",
    "", // no user/project/local settings; built-in hooks/managed policy remain
    "--disable-slash-commands",
    "--no-session-persistence",
    // --- money and shape
    "--max-budget-usd",
    options.sub.SRE_SUB_RUN_BUDGET_USD.toFixed(2),
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(REPORT_JSON_SCHEMA),
  ];
}

/** The subset of Claude Code's JSON result this runner reads. */
export type ClaudeResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  errors?: unknown[];
};

export function parseClaudeOutput(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();
  if (trimmed === "") return { is_error: true, result: "claude produced no output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // stream-json or a trailing warning line: take the last parseable line that is a result.
    const lines = trimmed.split("\n").reverse();
    for (const line of lines) {
      try {
        const candidate = JSON.parse(line) as ClaudeResult;
        if (candidate.type === "result" || candidate.total_cost_usd !== undefined) return candidate;
      } catch {
        /* keep looking */
      }
    }
    return { is_error: true, result: `claude output was not JSON: ${trimmed.slice(0, 400)}` };
  }
  if (Array.isArray(parsed)) {
    const result = parsed.find((m) => m !== null && typeof m === "object" && (m as ClaudeResult).type === "result");
    return (result ?? { is_error: true, result: "no result message in claude output" }) as ClaudeResult;
  }
  return parsed as ClaudeResult;
}

export function looksLikeAuthFailure(result: ClaudeResult, stderr: string): boolean {
  const text = `${typeof result.result === "string" ? result.result : ""}\n${stderr}`;
  return /authenticat|oauth|not logged in|please run .?claude login|login required|setup-token/i.test(text);
}

/**
 * The plan-limit refusal. On a subscription `claude -p` shares the operator's 5-hour and
 * weekly window (the Agent SDK credit is paused as of 2026-09-02), so this is
 * the failure that means "stop polling until the window resets", not "retry".
 */
export function looksLikeUsageLimit(result: ClaudeResult, stderr: string): boolean {
  const text = `${typeof result.result === "string" ? result.result : ""}\n${stderr}`;
  return /hit your (session|weekly|opus|sonnet|fable|usage) limit|usage limit|rate[_ ]limit|out of (usage|credits)|limit (will )?reset/i.test(text);
}

/**
 * The shape a SUCCESSFUL run must have. Exit 0 plus "no
 * literal `is_error: true`" used to be enough, so a system/warning object or an
 * empty structured report was written out as a completed triage. A report the
 * grader can read starts at a Markdown heading — the harness supplies the title
 * line and the metering footer, and the prompt asks the model for a body
 * beginning at its first `## ` heading, so a leading `#`/`##` heading is the
 * check. (`# Triage`/`# Post-mortem` are accepted too: a model that includes the
 * title it was told to omit is untidy, not failed.)
 */
export const REPORT_BODY_OPENING = /^#{1,3} \S/;

export function resultRejection(result: ClaudeResult, body: string): string | undefined {
  if (result.type !== "result") return `claude returned a ${JSON.stringify(result.type ?? "(missing)")} message, not a result`;
  if (result.subtype !== undefined && result.subtype !== "success") return `claude reported subtype ${JSON.stringify(result.subtype)}`;
  if (result.is_error === true) return "claude reported is_error";
  if (body === "") return "the report body was empty";
  if (!REPORT_BODY_OPENING.test(body)) return `the report body does not begin with a Markdown heading: ${JSON.stringify(body.slice(0, 80))}`;
  return undefined;
}

export function reportBody(result: ClaudeResult): string {
  const structured = result.structured_output;
  if (structured !== null && typeof structured === "object" && typeof (structured as { report?: unknown }).report === "string") {
    return (structured as { report: string }).report.trim();
  }
  if (typeof result.result === "string") return result.result.trim();
  return "";
}

async function runClaude(invocation: ClaudeInvocation, wallClockMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(invocation.bin, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, wallClockMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`, code: null, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Prompt composition

export function renderSweepEvidence(outcome: SweepOutcome): string {
  if (!outcome.enabled || outcome.plan === undefined || outcome.calls.length === 0) return "";
  const parts = ["## Harness evidence sweep", "", sweepPreamble(outcome.plan), ""];
  for (const call of outcome.calls) {
    const substituted = call.substituted === undefined ? "" : ` (substituted for \`${call.substituted.step}\`: ${call.substituted.because})`;
    parts.push(
      `### ${call.step} — \`${call.tool}\`${substituted}`,
      "",
      "Input:",
      "```json",
      JSON.stringify(call.input),
      "```",
      "Result:",
      "```text",
      call.result,
      "```",
      "",
    );
  }
  return parts.join("\n");
}

export function composePrompts(options: {
  config: Config;
  payload: WebhookPayload;
  mode: ReportMode;
  sweep: SweepOutcome;
}): { systemPrompt: string; userPrompt: string } {
  const availability = toolAvailability(options.config);
  const systemPrompt = [
    options.mode === "postmortem" ? POSTMORTEM_SYSTEM_PROMPT : TRIAGE_SYSTEM_PROMPT,
    toolAvailabilityNote(availability),
    SUB_MODE_NOTE,
    SUB_ALERT_OBJECT_RULE,
    SUB_CITATION_CONTRACT,
  ].join("\n\n");
  const injected = options.sweep.enabled && options.sweep.calls.length > 0;
  const userPrompt = [buildUserTurn(options.payload, options.mode, injected), injected ? "" : undefined, renderSweepEvidence(options.sweep)]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// The run

export type RunOptions = {
  payload: WebhookPayload;
  mode?: ReportMode;
  scenario?: string;
  dryRun?: boolean;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Override the loaded config (tests). */
  loaded?: { config: Config; sub: SubConfig };
};

export type RunOutcome = {
  exitCode: number;
  runDir: string;
  reportPath?: string;
  /** Retained evidence only; deliberately not reportPath (successful publication). */
  rejectionPath?: string;
  rejection?: RejectionSummary;
  budget: BudgetVerdict;
  costUsd: number;
  numTurns: number;
  calls: ReturnType<typeof summarizeCalls>;
  mutations: string[];
  message: string;
  invocation?: { bin: string; args: string[]; cwd: string };
};

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "alert";
}

function isoStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "z");
}

function runDirFor(sub: SubConfig, now: Date, name: string): string {
  const outputRoot = path.isAbsolute(sub.SRE_SUB_OUTPUT_DIR) ? sub.SRE_SUB_OUTPUT_DIR : path.join(PROJECT_ROOT, sub.SRE_SUB_OUTPUT_DIR);
  return path.join(outputRoot, `${isoStamp(now)}--${slug(name)}`);
}

export const CONCURRENT_RUN_NOTE = "concurrent run holds the ledger lock";

/**
 * One run, serialised.
 */
export async function runSubscriptionTriage(options: RunOptions): Promise<RunOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const loaded = options.loaded ?? loadSubscriptionConfig(env);
  const { sub } = loaded;
  const lock = acquireRunLock(sub.SRE_SUB_STATE_DIR, sub.SRE_SUB_WALL_CLOCK_MS + LOCK_STALE_GRACE_MS, now);
  if (lock === undefined) {
    const runDir = runDirFor(sub, now, alertName(options.payload));
    mkdirSync(runDir, { recursive: true });
    return {
      exitCode: EXIT_BUDGET,
      runDir,
      budget: budgetVerdict(monthSpend(readLedger(ledgerPath(sub.SRE_SUB_STATE_DIR)), monthOf(now)), sub.SRE_SUB_MONTHLY_BUDGET_USD),
      costUsd: 0,
      numTurns: 0,
      calls: summarizeCalls([]),
      mutations: [],
      message: `refused: ${CONCURRENT_RUN_NOTE} (${runLockPath(sub.SRE_SUB_STATE_DIR)}). Rationing is per-run; two runs sharing one pre-run balance is how the ceiling gets overshot.`,
    };
  }
  try {
    return await runOnce({ ...options, env, now, loaded });
  } finally {
    lock.release();
  }
}

async function runOnce(options: RunOptions & { env: NodeJS.ProcessEnv; now: Date; loaded: { config: Config; sub: SubConfig } }): Promise<RunOutcome> {
  const env = options.env;
  const now = options.now;
  const mode: ReportMode = options.mode ?? "triage";
  const { config, sub } = options.loaded;
  const payload = options.payload;
  const name = alertName(payload);

  // 1. Ledger gate.
  const ledgerFile = ledgerPath(sub.SRE_SUB_STATE_DIR);
  const month = monthOf(now);
  const budget = budgetVerdict(monthSpend(readLedger(ledgerFile), month), sub.SRE_SUB_MONTHLY_BUDGET_USD);

  const runDir = runDirFor(sub, now, name);
  mkdirSync(runDir, { recursive: true });
  const callLog = path.join(runDir, "calls.jsonl");
  const workDir = path.join(runDir, "workdir");
  mkdirSync(workDir, { recursive: true });

  const ledgerBase = (outcome: LedgerEntry["outcome"], extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
    at: now.toISOString(),
    month,
    kind: mode,
    alert: name,
    outcome,
    costUsd: 0,
    model: sub.SRE_SUB_MODEL,
    numTurns: 0,
    durationMs: 0,
    ...extra,
  });

  const empty = summarizeCalls([]);

  // 1b. CLI version gate. Costs nothing (`--version` makes no model call) and
  // runs before the sweep, so an unreviewed CLI does not even read the cluster.
  const allowedVersions = supportedClaudeVersions(env);
  const version = await readClaudeVersion(sub.claudeBin, env);
  if (!allowedVersions.includes(version)) {
    const note = claudeVersionRefusal(version, allowedVersions);
    if (!options.dryRun) appendLedger(ledgerFile, ledgerBase("failed", { note: note.slice(0, 300) }));
    return {
      exitCode: EXIT_CONFIG,
      runDir,
      budget,
      costUsd: 0,
      numTurns: 0,
      calls: empty,
      mutations: [],
      message: note,
    };
  }

  if (budget.state === "exhausted" && !options.dryRun) {
    appendLedger(ledgerFile, ledgerBase("refused-budget", { note: describeBudget(budget) }));
    return {
      exitCode: EXIT_BUDGET,
      runDir,
      budget,
      costUsd: 0,
      numTurns: 0,
      calls: empty,
      mutations: [],
      message: `refused: monthly ceiling reached — ${describeBudget(budget)}`,
    };
  }

  // 2. Tools + sweep (skipped on dry run: the sweep is live cluster reads).
  const tools = buildReadOnlyTools(config);
  let sweep: SweepOutcome = SWEEP_DISABLED;
  if (!options.dryRun && sweepEnabled(config)) {
    const plan = planSweep(payload);
    sweep = await executeSweep({ plan, tools, because: "SRE_AGENT_EVIDENCE_SWEEP is on (the default)" });
    sweep.calls.forEach((call, index) => {
      appendCall(callLog, {
        at: new Date().toISOString(),
        turn: index + 1,
        origin: "harness",
        step: call.step,
        tool: call.tool,
        toolUseId: call.toolUseId,
        input: call.input,
        result: call.result,
        ok: call.ok,
      });
    });
  } else if (options.dryRun && sweepEnabled(config)) {
    sweep = { ...SWEEP_DISABLED, because: "dry run: the sweep is live cluster reads and was not executed" };
  }
  const harnessCalls = sweep.calls.length;

  // 3. Prompts.
  const { systemPrompt, userPrompt } = composePrompts({ config, payload, mode, sweep });
  writeFileSync(path.join(runDir, "prompt.system.txt"), systemPrompt, "utf8");
  writeFileSync(path.join(runDir, "prompt.user.txt"), userPrompt, "utf8");

  // 4. Invocation.
  const server = mcpServerCommand(callLog, harnessCalls, env);
  const mcpConfig = { mcpServers: { [MCP_SERVER_NAME]: server } };
  const mcpConfigPath = path.join(runDir, "mcp-config.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");
  const args = claudeArgs({ sub, tools, systemPrompt, userPrompt, mcpConfigPath });
  // The child sees an ALLOWLISTED environment, not this process's minus three
  // names: nothing that can re-route inference, re-bill the run, or hand the
  // subscription credential to another host reaches it.
  const childEnv = claudeChildEnv(env);
  const invocation: ClaudeInvocation = { bin: sub.claudeBin, args, cwd: workDir, env: childEnv, mcpConfig };
  const redactedArgs = args.map((a, i) => (args[i - 1] === "--system-prompt" ? `<system prompt, ${a.length} chars>` : args[i - 1] === "-p" ? `<user prompt, ${a.length} chars>` : a));
  writeFileSync(
    path.join(runDir, "invocation.json"),
    JSON.stringify({ bin: sub.claudeBin, cwd: workDir, args: redactedArgs, sub: describeSubConfig(sub), budgetAtStart: budget }, null, 2),
    "utf8",
  );

  if (options.dryRun) {
    return {
      exitCode: EXIT_OK,
      runDir,
      budget,
      costUsd: 0,
      numTurns: 0,
      calls: empty,
      mutations: [],
      message: "dry run: prompts and invocation written, claude not spawned",
      invocation: { bin: sub.claudeBin, args: redactedArgs, cwd: workDir },
    };
  }

  // 5. Run.
  //
  // From here the model may have SPENT the subscription window, so the ledger
  // entry is owed no matter what happens next. `settle` writes
  // exactly one entry; every exit path below goes through it, and the catch
  // clause settles a `failed` entry if transcript writing or call-log parsing
  // throws after the child exited.
  let settled = false;
  let costUsd = 0;
  let numTurns = 0;
  let durationMs = 0;
  let sessionId: string | undefined;
  const settle = (outcome: LedgerEntry["outcome"], extra: Partial<LedgerEntry> = {}): void => {
    if (settled) return;
    settled = true;
    appendLedger(
      ledgerFile,
      ledgerBase(outcome, { costUsd, numTurns, durationMs, ...(sessionId === undefined ? {} : { sessionId }), ...extra }),
    );
  };

  const started = Date.now();
  try {
    const { stdout, stderr, code, timedOut } = await runClaude(invocation, sub.SRE_SUB_WALL_CLOCK_MS);
    durationMs = Date.now() - started;
    writeFileSync(path.join(runDir, "claude.stdout.json"), stdout, "utf8");
    writeFileSync(path.join(runDir, "claude.stderr.txt"), stderr, "utf8");
    const result = parseClaudeOutput(stdout);
    costUsd = typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : 0;
    numTurns = typeof result.num_turns === "number" ? result.num_turns : 0;
    sessionId = typeof result.session_id === "string" ? result.session_id : undefined;
    const calls = readCalls(callLog);
    const callSummary = summarizeCalls(calls);

    const failed = timedOut || code !== 0 || result.is_error === true;
    if (failed) {
      const auth = looksLikeAuthFailure(result, stderr);
      const limited = !auth && looksLikeUsageLimit(result, stderr);
      const note = timedOut
        ? `killed after ${sub.SRE_SUB_WALL_CLOCK_MS} ms wall clock`
        : `claude exited ${code}: ${typeof result.result === "string" ? result.result.slice(0, 300) : stderr.slice(0, 300)}`;
      settle(auth ? "refused-auth" : limited ? "refused-limit" : "failed", { note });
      return {
        exitCode: auth ? EXIT_AUTH : limited ? EXIT_USAGE_LIMIT : EXIT_RUN_FAILED,
        runDir,
        budget,
        costUsd,
        numTurns,
        calls: callSummary,
        mutations: [],
        message: auth
          ? `${note}\nThe host's Claude Code login is missing or expired. Operator action: run \`claude login\` (or \`claude setup-token\` and export CLAUDE_CODE_OAUTH_TOKEN in the job's environment).`
          : limited
            ? `${note}\nThe subscription's usage window is exhausted (claude -p shares the plan's 5-hour/weekly limits). Not an error to retry: the poller stops until the window resets.`
            : note,
      };
    }

    // 5b. Shape gate: exit 0 is not a report. A system message,
    // a non-success subtype, or an empty/headless body is a FAILED run with its
    // raw output preserved — never a blank report recorded as `completed`.
    const body = reportBody(result);
    const rejection = resultRejection(result, body);
    if (rejection !== undefined) {
      const note = `claude exited 0 but returned no usable report: ${rejection}`;
      settle("failed", { note: note.slice(0, 300) });
      return {
        exitCode: EXIT_RUN_FAILED,
        runDir,
        budget,
        costUsd,
        numTurns,
        calls: callSummary,
        mutations: [],
        message: `${note}\nRaw output preserved at ${path.join(runDir, "claude.stdout.json")}; no report was written.`,
      };
    }

    // 6. Report.
    const mutations = recommendedMutations(body, alertSafetyContext(JSON.stringify(payload)));
    const mutationLines = mutations.length === 0 ? ["- Recommended mutations: none detected."] : ["- **Recommended mutations detected** (the agent never runs these; review before acting):", ...describeMutations(mutations).split("\n").map((l) => `  ${l}`)];
    const spentAfter = budgetVerdict(budget.spentUsd + costUsd, budget.budgetUsd);
    const modelsUsed = result.modelUsage ? Object.keys(result.modelUsage).join(", ") : sub.SRE_SUB_MODEL;
    const title = mode === "postmortem" ? `# Post-mortem — ${name}` : `# Triage — ${name}`;
    const report = [
      title,
      "",
      `*Generated ${now.toISOString()} by sre-agent (subscription mode: \`claude -p\`, model ${modelsUsed})*`,
      `*Investigation mode: ${describeSweepMode(sweep)}*`,
      "",
      body,
      "",
      "---",
      "",
      "## Run metering",
      "",
      "- Engine: Claude Code headless (`claude -p`) on a Claude subscription — drawing from the plan's own 5-hour/weekly usage window; no API key was present.",
      `- Model requested: \`${sub.SRE_SUB_MODEL}\` (effort ${sub.SRE_SUB_EFFORT}); reported: ${modelsUsed}.`,
      `- Claude Code: ${version} (a reviewed version; the belt is pinned to ${allowedVersions.join(", ")}).`,
      `- Turns: ${numTurns}. Duration: ${(durationMs / 1000).toFixed(1)} s. Session: ${result.session_id ?? "n/a"}.`,
      `- Cost (client-side estimate, \`total_cost_usd\`): $${costUsd.toFixed(4)} against a per-run ceiling of $${sub.SRE_SUB_RUN_BUDGET_USD.toFixed(2)}.`,
      `- Month to date after this run: ${describeBudget(spentAfter)}`,
      `- Tool calls: ${callSummary.total} (${callSummary.harness} harness sweep, ${callSummary.model} model; ${callSummary.ok} declared ok).`,
      `- Tools served: ${tools.map((t) => `\`${t.name}\``).join(", ")}; built-in Claude Code tools disabled and denied.`,
      `- Egress: ${describeEgress(config)}`,
      ...mutationLines,
      ...sweepFooterLines(sweep),
      "",
    ].join("\n");

    const reportPath = reportPathFor(runDir, now, mode);
    writeFileSync(reportPath, report, { encoding: "utf8", flag: "wx" });
    const stem = reportPath.replace(/\.md$/, "");
    const verdict = publicationVerdict(report, JSON.stringify(payload));
    const failures: string[] = [];
    const artefacts = {
      tools: () => toToolTranscript(calls, options.scenario),
      queries: () => toQueryTranscript(calls, options.scenario),
      retrieval: () => toRetrievalTranscript(calls, options.scenario),
      claude: () => result,
    };
    for (const [suffix, value] of Object.entries(artefacts)) {
      try {
        writeFileSync(`${stem}.${suffix}.json`, JSON.stringify(value(), null, 2), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        failures.push(`${suffix} preservation failed: ${String(error)}`);
      }
    }
    if (!verdict.publish) {
      const rejectionPath = `${stem}.rejected.json`;
      try {
        writePublicationRejection(reportPath, payload, verdict, now);
      } catch (error) {
        failures.push(`rejection record write failed: ${String(error)}`);
      }
      settle("rejected-safety", { reportPath, note: [verdict.reason, ...failures].join("\n") });
      return {
        exitCode: EXIT_PUBLICATION_REJECTED, runDir, rejectionPath,
        budget: spentAfter, costUsd, numTurns, calls: callSummary,
        mutations: mutations.map((m) => m.quote),
        rejection: rejectionSummary(verdict, runDir, alertName(payload)),
        message: rejectionNotification(verdict, runDir),
      };
    }
    if (failures.length > 0) throw new Error(failures.join("\n"));
    settle("completed", { reportPath });

    return {
      exitCode: EXIT_OK,
      runDir,
      reportPath,
      budget: spentAfter,
      costUsd,
      numTurns,
      calls: callSummary,
      mutations: mutations.map((m) => m.quote),
      message: `report written: ${reportPath}`,
    };
  } catch (error) {
    // The child may already have spent the window. Record what it cost before
    // letting the failure out.
    if (durationMs === 0) durationMs = Date.now() - started;
    settle("failed", {
      note: `settled after a harness error following the model call: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI

function usage(): never {
  process.stderr.write(
    [
      "usage: sub-triage [--alert <payload.json>] [--mode triage|postmortem] [--scenario <id>] [--dry-run]",
      "  reads an AlertManager webhook payload from --alert or stdin and runs one subscription-mode triage.",
    ].join("\n") + "\n",
  );
  process.exit(EXIT_CONFIG);
}

export function parseArgs(argv: readonly string[]): { alertFile?: string; mode: ReportMode; scenario?: string; dryRun: boolean } {
  let alertFile: string | undefined;
  let mode: ReportMode = "triage";
  let scenario: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) usage();
      i += 1;
      return value;
    };
    if (arg === "--alert") alertFile = next();
    else if (arg === "--mode") {
      const value = next();
      if (value !== "triage" && value !== "postmortem") usage();
      mode = value;
    } else if (arg === "--scenario") scenario = next();
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "-h" || arg === "--help") usage();
    else usage();
  }
  return { ...(alertFile === undefined ? {} : { alertFile }), mode, ...(scenario === undefined ? {} : { scenario }), dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let raw: string;
  if (args.alertFile !== undefined) {
    if (!existsSync(args.alertFile)) {
      process.stderr.write(`no such file: ${args.alertFile}\n`);
      process.exit(EXIT_CONFIG);
    }
    raw = readFileSync(args.alertFile, "utf8");
  } else {
    raw = readFileSync(0, "utf8");
  }
  let payload: WebhookPayload;
  try {
    payload = parseWebhookPayload(raw);
  } catch (error) {
    process.stderr.write(`payload rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_CONFIG);
  }
  let outcome: RunOutcome;
  try {
    outcome = await runSubscriptionTriage({
      payload,
      mode: args.mode,
      dryRun: args.dryRun,
      ...(args.scenario === undefined ? {} : { scenario: args.scenario }),
    });
  } catch (error) {
    process.stderr.write(`sub-triage: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_CONFIG);
  }
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exitCode = outcome.exitCode;
}

const invokedDirectly = typeof process.argv[1] === "string" && /[/\\]run\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) void main();
