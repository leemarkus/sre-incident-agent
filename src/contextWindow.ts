/**
 * The run's own context window: measure it, require enough of it, record it.
 *
 * ## Why this file exists
 *
 * Measured 2026-08-06 against the Studio's Ollama on the `/v1`
 * OpenAI-compatible route — the route `localTransport` uses:
 *
 * | prompt | `prompt_tokens` reported | needle at the START recalled |
 * |---|---|---|
 * | ~8.4k tokens | 8 4xx | yes |
 * | ~27k tokens (`qwen3:32b`) | **8194** | **no** |
 * | ~27k tokens (`qwen3:32b-ctx32k`) | **27049** | **yes** |
 *
 * Two facts follow, and both are load-bearing:
 *
 * ## The rule
 *
 * A run must know its own served window before it starts, and must refuse if
 * that window cannot hold what the run is about to put in it. Three outcomes,
 * kept distinct on purpose:
 *
 *  - **served, and large enough** — proceed, and record the number.
 *  - **served, and too small** — refuse, with the arithmetic in the message.
 *  - **undeterminable** — refuse. This is *not* folded into either of the
 *    above. This project has been bitten by exactly that polarity twice, and an unknown
 *    window folded into "probably fine" is the same mistake a third time.
 *
 * ## The bound is AGGREGATE, not per-result
 *
 * Nothing here re-states a number that lives somewhere else. The per-step caps
 * come from the tool modules, the evidence bound comes from `planSweep`, the
 * prompt and schemas are measured off the objects the runner is about to be
 * given, and the generation allowance is passed in from the one place that sets
 * it. Two copies of a constant is how the mismatch this task fixes was created.
 */

import { KUBECTL_MAX_OUTPUT_CHARS } from "./tools/kubectl.js";
import { PROMQL_MAX_OUTPUT_CHARS } from "./tools/promql.js";
import { ARGOCD_MAX_OUTPUT_CHARS } from "./tools/argocd.js";
import { DOCS_MAX_OUTPUT_CHARS } from "./tools/docs.js";
import { SWEEP_EVIDENCE_BUDGET_CHARS, type SweepPlan } from "./sweep.js";

export class ContextWindowError extends Error {}

/**
 * Characters per token, for converting a byte cap into a token requirement.
 *
 * Consequence to keep honest: the requirement below is a **floor**, not a
 * guarantee. A window that clears it can still be overflowed by unusually dense
 * output. What it does rule out is the case this task was raised for — a window
 * that cannot fit the run's evidence even on optimistic arithmetic.
 */
export const CHARS_PER_TOKEN = 4;

export function tokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Each registered tool's output cap, keyed by the tool name the model sees.
 *
 * Read from the tool modules, never re-typed. `docs_read` is listed under
 * `docs_search`'s cap: it is the larger of the two docs ceilings, so using it
 * for both rounds the requirement up rather than down.
 */
export const TOOL_OUTPUT_CAP_CHARS: Readonly<Record<string, number>> = Object.freeze({
  kubectl_read: KUBECTL_MAX_OUTPUT_CHARS,
  promql_query: PROMQL_MAX_OUTPUT_CHARS,
  argocd_status: ARGOCD_MAX_OUTPUT_CHARS,
  docs_search: DOCS_MAX_OUTPUT_CHARS,
  docs_read: DOCS_MAX_OUTPUT_CHARS,
});

/**
 * The cap for one tool.
 *
 * An unknown name is NOT defaulted to zero or to some average. A tool this
 * module has never heard of is a tool whose cap it cannot bound, and silently
 * costing it nothing would understate the requirement — the exact direction of
 * error that lets an overflowing run pass a sufficiency check. It is charged
 * the largest known cap instead, and the caller can see that in the breakdown.
 */
export function toolOutputCapChars(toolName: string): number {
  const known = TOOL_OUTPUT_CAP_CHARS[toolName];
  return known ?? largestToolOutputCapChars();
}

/** The largest single tool output cap, across every registered tool. */
export function largestToolOutputCapChars(): number {
  return Math.max(...Object.values(TOOL_OUTPUT_CAP_CHARS));
}

/**
 * How much tool output an UN-SCAFFOLDED run may accumulate across the whole
 * conversation, in characters.
 *
 * Deliberately the sweep's own standing aggregate ceiling rather than a second
 * number: the two paths fill the same context window with the same kind of
 * evidence, and charging them different aggregates would make their required
 * totals incomparable — the exact drift `SWEEP_EVIDENCE_BUDGET_CHARS` was
 * centralised to prevent. Re-exported under its own name because the reason it
 * applies here is different (nobody plans an autonomous run's reads; the
 * allowance is enforced turn by turn instead).
 */
export function autonomousEvidenceBudgetChars(): number {
  return SWEEP_EVIDENCE_BUDGET_CHARS;
}

// ---------------------------------------------------------------------------
// What the run needs

export type ContextRequirement = {
  /**
   * Aggregate evidence the run may place in context before the model's first
   * useful turn, in characters.
   *
   * Scaffolded: the sweep plan's **declared** aggregate budget
   * (`SweepPlan.evidenceBudgetChars`), read straight off the plan. It is a
   * promise `executeSweep` keeps by trimming and dropping steps, so this is
   * what the run will actually place in context — not what it is allowed to.
   */
  evidenceChars: number;
  evidenceTokens: number;
  /** How `evidenceChars` was arrived at, in one readable line. */
  evidenceBasis: string;
  /** System prompt + tool schemas + the alert turn, measured, in characters. */
  overheadChars: number;
  overheadTokens: number;
  /** `max_tokens` — Ollama's `num_ctx` covers prompt AND completion. */
  outputTokens: number;
  /** The sum. A served window below this refuses the run. */
  requiredTokens: number;
};

export function contextRequirement(options: {
  /** The sweep plan, or null when the scaffold is off. */
  plan: SweepPlan | null;
  /** Every system block's text, as it will be sent. */
  systemTexts: readonly string[];
  /** The tools as registered: name, description and JSON input schema. */
  tools: readonly { name: string; description?: string; input_schema?: unknown }[];
  /** The user turn carrying the alert. */
  userTurnText: string;
  /** The generation allowance the runner will request. */
  maxOutputTokens: number;
}): ContextRequirement {
  const { plan, systemTexts, tools, userTurnText, maxOutputTokens } = options;

  let evidenceChars: number;
  let evidenceBasis: string;
  if (plan) {

    evidenceChars = plan.evidenceBudgetChars;
    evidenceBasis =
      `scaffolded: ${plan.steps.length} sweep step(s) for alert class ` +
      `"${plan.classification.alertClass}" across ${plan.namespaces.length} namespace(s), ` +
      `collected to the sweep's DECLARED aggregate budget of ${plan.evidenceBudgetChars} chars ` +
      "(steps beyond it are trimmed or dropped, each recorded in the report footer)";
  } else {
    // The bound charged is the ACCUMULATION allowance, not one result: the same
    // standing aggregate ceiling the scaffolded path is held to, so both modes are
    // charged the same evidence aggregate and their arithmetic stays comparable.
    // `Math.max` keeps the old per-result floor as a floor — this bound can never
    // become smaller than the largest single result the model may be handed.
    //
    // Unlike the sweep's budget, nothing plans this number in advance: the model
    // chooses when to call and when to stop. So it is enforced where the choosing
    // happens — `assertAccumulatedEvidenceFits` is called once per turn, before
    // the next request goes out, and refuses with the same arithmetic rather than
    // letting the server truncate. A declared allowance nobody enforces is exactly
    // the gap this task closes; declaring it here and checking it there is what
    // makes it a bound rather than an intention.
    evidenceChars = Math.max(largestToolOutputCapChars(), autonomousEvidenceBudgetChars());
    evidenceBasis =
      "un-scaffolded (evidence sweep off): no harness-injected sweep, so the bound is the ACCUMULATION " +
      `allowance for the whole conversation (${evidenceChars} chars — the standing aggregate ` +
      `evidence ceiling, never below the largest single tool output cap of ` +
      `${largestToolOutputCapChars()} chars). Every prior tool result is re-sent on every ` +
      "turn, so one result is not the bound; the running total is re-checked each turn " +
      "against the served window";
  }

  const schemaChars = tools.reduce(
    (sum, tool) =>
      sum +
      tool.name.length +
      (tool.description?.length ?? 0) +
      JSON.stringify(tool.input_schema ?? {}).length,
    0,
  );
  const overheadChars =
    systemTexts.reduce((sum, text) => sum + text.length, 0) + schemaChars + userTurnText.length;

  const evidenceTokens = tokensFromChars(evidenceChars);
  const overheadTokens = tokensFromChars(overheadChars);

  return {
    evidenceChars,
    evidenceTokens,
    evidenceBasis,
    overheadChars,
    overheadTokens,
    outputTokens: maxOutputTokens,
    requiredTokens: evidenceTokens + overheadTokens + maxOutputTokens,
  };
}

/** The requirement as footer/error lines, so one derivation is printed everywhere. */
export function requirementLines(requirement: ContextRequirement): string[] {
  return [
    `evidence ${requirement.evidenceTokens} tokens (~${requirement.evidenceChars} chars) — ` +
      requirement.evidenceBasis,
    `system prompt + tool schemas + alert ${requirement.overheadTokens} tokens ` +
      `(~${requirement.overheadChars} chars, measured)`,
    `generation allowance ${requirement.outputTokens} tokens (max_tokens; a local server's ` +
      "context covers prompt AND completion)",
    `required total ${requirement.requiredTokens} tokens ` +
      `(at ~${CHARS_PER_TOKEN} chars/token — an estimate, so this is a floor)`,
  ];
}

// ---------------------------------------------------------------------------
// What the server actually serves

export type ContextWindowProbe =
  | {
      outcome: "served";
      /** The window the server reports for the loaded model, in tokens. */
      tokens: number;
      /** Which endpoint said so, for the record. */
      source: string;
      /** The model name the server attached the window to. */
      model: string;
    }
  | {
      outcome: "undeterminable";
      /** Why. Printed verbatim in the refusal; never summarised away. */
      reason: string;
      source: string;
    };

/** Ollama tags `foo` and `foo:latest` as the same model. */
function sameModel(a: string, b: string): boolean {
  const norm = (s: string): string => (s.includes(":") ? s : `${s}:latest`);
  return norm(a) === norm(b);
}

/**
 * Read the served window from Ollama's `/api/ps`.
 *
 * ## Why `/api/ps` and not `/api/show`
 *
 * `/api/show` reports `qwen3.context_length = 40960` — the window the *weights*
 * were trained for — and the Modelfile parameters, which say nothing about what
 * the running server did with them. `OLLAMA_CONTEXT_LENGTH` in the service
 * environment overrides the Modelfile, and a model already resident is serving
 * whatever window it was loaded with, not whatever a fresh load would pick. Only
 * `/api/ps` reports the loaded runner's actual `context_length`, so it is the
 * only endpoint whose answer is a measurement rather than an intention.
 *
 * ## Why it may need a warm-up
 *
 * `/api/ps` lists *loaded* models. Before the first turn nothing is loaded, so
 * the model must be resident before it can be asked about. `warm` is called at
 * most once, and only when the model is absent from a first read.
 *
 * ## Why every failure lands on `undeterminable` rather than throwing
 *
 * A non-Ollama server (LM Studio, vLLM, llama.cpp) has no `/api/ps` and will
 * 404. That is a legitimate, expected state, and it must be reportable as "this
 * run does not know its window" — which the caller then refuses on — rather
 * than as a transport crash that looks like the server being down. The
 * distinction is the whole of acceptance 4.
 */
export async function probeOllamaContextWindow(options: {
  /** The `/v1` base URL the transport dials. Only its origin is used. */
  baseUrl: URL;
  /** The configured model name. */
  model: string;
  /**
   * Same-origin-validated fetch — `localFetch` in production.
   *
   * Every field is always supplied (never optional-and-omitted) so the
   * signature matches `localFetch`'s init shape exactly under
   * `exactOptionalPropertyTypes`, and the transport can hand it straight
   * through rather than rebuilding the object and risking dropping the signal.
   */
  fetchImpl: (
    url: URL,
    init: { method: string; headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<Response>;
  /** Force the model resident. Called at most once. */
  warm?: () => Promise<void>;
  timeoutMs?: number;
}): Promise<ContextWindowProbe> {
  const { baseUrl, model, fetchImpl, warm, timeoutMs = 600_000 } = options;
  // Origin only. `/api/ps` sits at the server root, beside `/v1`, and building
  // it from the origin cannot inherit a path the operator wrote into
  // LOCAL_MODEL_BASE_URL.
  const psUrl = new URL("/api/ps", baseUrl.origin);
  const source = psUrl.href;

  const read = async (): Promise<
    { ok: true; models: unknown[] } | { ok: false; reason: string }
  > => {
    let response: Response;
    try {
      response = await fetchImpl(psUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        reason:
          `${psUrl.href} could not be reached ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason:
          `${psUrl.href} answered ${response.status} ${response.statusText}. This server is ` +
          "probably not Ollama (LM Studio, vLLM and llama.cpp have no /api/ps), so the " +
          "served context window cannot be read from it",
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch (error) {
      return {
        ok: false,
        reason: `${psUrl.href} did not return JSON (${
          error instanceof Error ? error.message : String(error)
        })`,
      };
    }
    const models =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["models"]
        : undefined;
    if (!Array.isArray(models)) {
      return { ok: false, reason: `${psUrl.href} returned no \`models\` array` };
    }
    return { ok: true, models };
  };

  const findWindow = (models: unknown[]): number | undefined => {
    for (const entry of models) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const name = typeof record["name"] === "string" ? record["name"] : "";
      const alt = typeof record["model"] === "string" ? record["model"] : "";
      if (!sameModel(name, model) && !sameModel(alt, model)) continue;
      const window = record["context_length"];
      // A present-but-unusable value is NOT a miss that falls through to the
      // next entry and then to "not loaded": it is a different failure, and
      // reporting it as "not loaded" would send the caller to warm a model that
      // is already resident. Return 0, which the caller renders as its own
      // reason.
      if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return 0;
      return Math.trunc(window);
    }
    return undefined;
  };

  let first = await read();
  if (!first.ok) return { outcome: "undeterminable", reason: first.reason, source };

  let window = findWindow(first.models);
  if (window === undefined && warm) {
    try {
      await warm();
    } catch (error) {
      return {
        outcome: "undeterminable",
        reason:
          `${model} was not loaded and could not be warmed ` +
          `(${error instanceof Error ? error.message : String(error)})`,
        source,
      };
    }
    first = await read();
    if (!first.ok) return { outcome: "undeterminable", reason: first.reason, source };
    window = findWindow(first.models);
  }

  if (window === undefined) {
    return {
      outcome: "undeterminable",
      reason:
        `${psUrl.href} lists no loaded model matching ${JSON.stringify(model)}, so the window ` +
        "it is served with is unknown",
      source,
    };
  }
  if (window === 0) {
    return {
      outcome: "undeterminable",
      reason:
        `${psUrl.href} lists ${JSON.stringify(model)} but reports no usable ` +
        "`context_length` for it",
      source,
    };
  }
  return { outcome: "served", tokens: window, source, model };
}

// ---------------------------------------------------------------------------
// The gate

/**
 * Refuse the run unless the served window provably holds what it will contain.
 *
 * Throws on both non-passing outcomes, with different messages, because the two
 * call for different actions: a small window is raised at the server, an
 * unknown one is diagnosed. Returns the probe on success so the caller can
 * record it.
 */
export function assertContextWindowSufficient(
  probe: ContextWindowProbe,
  requirement: ContextRequirement,
): Extract<ContextWindowProbe, { outcome: "served" }> {
  if (probe.outcome === "undeterminable") {
    throw new ContextWindowError(
      "refusing to start: this run cannot determine the context window it is being served " +
        `with. ${probe.reason}. An unknown window is NOT a large enough one — a local ` +
        "server that silently truncates drops the system prompt and the tool schemas FIRST " +
        "(Ollama truncates from the front), so a run that overflowed would look exactly " +
        "like a model that ignored its instructions, and would be graded as one. Serve the " +
        "model through an endpoint whose window can be read, or raise the window and " +
        "re-run.\n  Required: " +
        requirementLines(requirement).join("\n  Required: "),
    );
  }
  if (probe.tokens < requirement.requiredTokens) {
    throw new ContextWindowError(
      `refusing to start: the server serves ${JSON.stringify(probe.model)} with a ` +
        `${probe.tokens}-token context window, but this run needs ` +
        `${requirement.requiredTokens}. Ollama truncates from the FRONT, so the overflow ` +
        "would silently discard the system prompt, the tool schemas and the sweep's " +
        "targeted evidence before anything else.\n  " +
        requirementLines(requirement).join("\n  ") +
        `\n  Served: ${probe.tokens} tokens (per ${probe.source})\n` +
        "  Fix: raise the window at the SERVER — the /v1 OpenAI-compatible route accepts no " +
        "per-request `num_ctx`. Either create a derived model with a larger window " +
        '(`POST /api/create` with `{"from":"<model>","parameters":{"num_ctx":<n>}}`) and ' +
        "point LOCAL_MODEL_NAME at it, or set OLLAMA_CONTEXT_LENGTH on the Ollama service " +
        "and restart it. Reducing the sweep's aggregate evidence budget is the other lever; " +
        "see docs/safety-model.md.",
    );
  }
  return probe;
}

// ---------------------------------------------------------------------------
// the gate again, mid-run, against what the conversation really holds

/**
 * Characters of tool RESULT currently sitting in the conversation.
 *
 * Counted off the runner's own message array — the exact objects the next
 * request will serialise — rather than off a tally the harness keeps as results
 * go by, because a tally can drift from the array (a retried turn, a result the
 * SDK rewrites) and the array cannot: it *is* what gets sent.
 *
 * So this is not the bound any more. It is the loop's diagnostic, kept in
 * `contextRequirement`'s own terms (evidence, prompt, schemas, generation
 * allowance) so the two arithmetics stay comparable. The bound that must hold is
 * `assertRequestFitsServedWindow`, which counts the ENTIRE outgoing payload —
 * prose, thinking, tool arguments, schemas and `max_tokens` included — at the
 * wire, where nothing reachable can be left out by construction.
 */
export function accumulatedToolResultChars(messages: readonly unknown[]): number {
  let chars = 0;
  const measure = (content: unknown): number =>
    typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record["type"] !== "tool_result") continue;
      chars += measure(record["content"]);
    }
  }
  return chars;
}

/**
 * Refuse the next turn when the conversation has outgrown the served window.
 *
 * The startup gate proves the window can hold the run's *declared* evidence
 * allowance. Nothing at startup can prove what an autonomous model will actually
 * ask for, so the same arithmetic is re-run here, once per turn, with the
 * measured accumulation in place of the allowance.
 *
 * What this one is for: a loud, turn-numbered diagnosis in the loop's own terms,
 * on every path — including transports this project does not own, where there is
 * no wire of ours to check. Keep both; do not read either as the other.
 *
 * `null` probe = a path with no server-chosen window (the Anthropic API, the
 * recorded transport). There is no served number to check against, so there is
 * nothing to enforce; that is a skip, not a pass, and it is why the caller keeps
 * the probe rather than a boolean.
 */
export function assertAccumulatedEvidenceFits(options: {
  messages: readonly unknown[];
  requirement: ContextRequirement;
  probe: Extract<ContextWindowProbe, { outcome: "served" }> | null;
  /** 1-based turn about to be sent, named in the refusal. */
  turn: number;
}): number {
  const { messages, requirement, probe, turn } = options;
  const accumulatedChars = accumulatedToolResultChars(messages);
  if (!probe) return accumulatedChars;
  const accumulatedTokens = tokensFromChars(accumulatedChars);
  const needed = requirement.overheadTokens + accumulatedTokens + requirement.outputTokens;
  if (needed <= probe.tokens) return accumulatedChars;
  throw new ContextWindowError(
    `refusing turn ${turn}: the tool results this conversation has accumulated no longer fit ` +
      `the context window ${JSON.stringify(probe.model)} is served with. Every prior result is ` +
      "re-sent on every turn, so results that each passed their own cap can jointly overflow a " +
      "window that cleared the startup gate. Ollama truncates from the FRONT, so sending this " +
      "turn would silently discard the system prompt, the tool schemas and the earliest " +
      "evidence — and the run would read as a model that ignored its instructions.\n" +
      `  accumulated tool results ${accumulatedTokens} tokens (~${accumulatedChars} chars, ` +
      `measured across ${messages.length} message(s); the startup gate charged ` +
      `${requirement.evidenceTokens} tokens for evidence)\n` +
      `  system prompt + tool schemas + alert ${requirement.overheadTokens} tokens\n` +
      `  generation allowance ${requirement.outputTokens} tokens\n` +
      `  required now ${needed} tokens (at ~${CHARS_PER_TOKEN} chars/token — an estimate, so ` +
      "this is a floor)\n" +
      `  Served: ${probe.tokens} tokens (per ${probe.source})\n` +
      "  Fix: raise the window at the SERVER (see the startup refusal for the two routes), or " +
      "run this alert through the scaffolded path, whose evidence aggregate is planned and " +
      "bounded before the run starts.",
  );
}

// ---------------------------------------------------------------------------
// the gate AT THE WIRE, where the ground truth is

/**
 * Every character of prompt this request will put in front of the model.
 *
 * Walks the outgoing Messages payload and sums its string leaves — the system
 * blocks, every message's text, thinking and `tool_use` arguments, every
 * `tool_result`, and the tool schemas. Numbers and booleans are counted as their
 * printed form, because that is how they reach the model.
 *
 * ## What it still is not
 *
 * A character count divided by `CHARS_PER_TOKEN` (§ the constant's own note), so
 * it remains a floor rather than a token-exact measurement, and JSON structure
 * (keys, punctuation, chat-template furniture the server adds) is not counted.
 * Both directions are stated rather than papered over: unusually dense output
 * can still exceed the estimate, and the estimate does not pretend to be the
 * server's tokeniser.
 */
export function promptCharsOfRequestPayload(payload: unknown): number {
  let chars = 0;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      chars += value.length;
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      chars += String(value).length;
      return;
    }
    if (Array.isArray(value)) {
      for (const element of value) walk(element);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const element of Object.values(value)) walk(element);
    }
  };
  walk(payload);
  return chars;
}

/**
 * Refuse an outgoing request that does not fit the window the server serves.
 *
 * ## Why this lives at the transport and not in the loop
 *
 * `probe === null` — no window was ever read from this server — is a SKIP,
 * stated as one. Enforcing against a window nobody measured would be inventing a
 * number, which is the failure `assertContextWindowSufficient` refuses at
 * startup; the run does not reach here with an unread window on the normal path,
 * because `runTriage` probes before the first turn and refuses an undeterminable
 * answer outright.
 */
export function assertRequestFitsServedWindow(options: {
  /** The parsed Messages payload the SDK built, exactly as it will be sent. */
  payload: unknown;
  probe: Extract<ContextWindowProbe, { outcome: "served" }> | null;
  /** 1-based index of the request about to be sent, named in the refusal. */
  turn: number;
}): number {
  const { payload, probe, turn } = options;
  const promptChars = promptCharsOfRequestPayload(payload);
  if (!probe) return promptChars;
  const promptTokens = tokensFromChars(promptChars);
  const record = typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
  // The generation allowance this very request asks for. Read off the payload
  // rather than from a constant: `max_tokens` is what the server will reserve,
  // and a local context covers prompt AND completion.
  const maxOutput = typeof record["max_tokens"] === "number" ? record["max_tokens"] : 0;
  const needed = promptTokens + maxOutput;
  if (needed <= probe.tokens) return promptChars;
  throw new ContextWindowError(
    `refusing to send request ${turn}: it does not fit the context window ` +
      `${JSON.stringify(probe.model)} is served with, so it is NOT being sent. Ollama truncates ` +
      "from the FRONT, so this request would have silently lost the system prompt, the tool " +
      "schemas and the earliest evidence — and the run would read as a model that ignored its " +
      "instructions.\n" +
      `  prompt ${promptTokens} tokens (~${promptChars} chars, measured across the whole ` +
      "payload: system prompt, tool schemas, every message, thinking, tool arguments and " +
      "tool results)\n" +
      `  generation allowance ${maxOutput} tokens (max_tokens, as requested)\n` +
      `  required ${needed} tokens (at ~${CHARS_PER_TOKEN} chars/token — an estimate, so this ` +
      "is a floor)\n" +
      `  Served: ${probe.tokens} tokens (per ${probe.source})\n` +
      "  Fix: raise the window at the SERVER (the /v1 route accepts no per-request `num_ctx`; " +
      "see the startup refusal for the two routes), or run this alert through the scaffolded " +
      "path, whose evidence aggregate is planned and bounded before the run starts.",
  );
}

/**
 * The metering lines, written beside model identity.
 *
 * `null` means the path has no server-served window to report — the Anthropic
 * API and the recorded transport both have fixed, known windows that no local
 * server chose. That is stated rather than left blank, so a reader can tell
 * "not applicable here" from "nobody checked".
 */
export function contextWindowFooterLines(
  probe: ContextWindowProbe | null,
  requirement: ContextRequirement,
): string[] {
  if (!probe) {
    return [
      "- Served context window: not applicable (this run's engine is not a locally served " +
        `model). Requirement computed anyway: ${requirement.requiredTokens} tokens — ` +
        requirementLines(requirement).join("; "),
    ];
  }
  if (probe.outcome === "undeterminable") {
    // Unreachable from a completed run — the gate throws first — but written
    // rather than assumed away, because "the footer can't print it" is a worse
    // reason for a gap than "the footer printed the truth".
    return [
      `- **Served context window: UNDETERMINABLE.** ${probe.reason} (asked ${probe.source}).`,
    ];
  }
  return [
    `- Served context window: **${probe.tokens} tokens** for \`${probe.model}\`, read from ` +
      `${probe.source}. Required ${requirement.requiredTokens}; headroom ` +
      `${probe.tokens - requirement.requiredTokens}.`,
    `  - ${requirementLines(requirement).join("\n  - ")}`,
  ];
}
