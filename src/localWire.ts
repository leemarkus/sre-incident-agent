import type {
  BetaContentBlock,
  BetaMessage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * ## What this file is and is not
 *
 * This is **pure translation**: Anthropic Messages wire shape in one direction,
 * OpenAI chat-completions wire shape in the other. No network, no config, no
 * SDK client, no I/O. `src/transport.ts` supplies the `fetch` that carries the
 * bytes; everything about *what the bytes say* is decided here, so every branch
 * of it is assertable offline by the offline check suite with no server running.
 */

// ---------------------------------------------------------------------------
// Limits
//
// A local server is not a hostile party, but it is an *unvalidated* one: it is
// whatever binary the operator started, at whatever quantisation, possibly mid-crash.
// The recorded transport gets its bytes from a committed fixture and needs no
// such guard; this one takes them from a process that can and does emit
// degenerate output (repetition loops are the characteristic failure mode of a
// small quantised model), so the ceilings below exist to make that failure
// loud and bounded instead of an OOM fifteen minutes into a replay.

/** Legacy bounded-body ceiling; streamed completions use MAX_STREAM_BYTES. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Most `tool_calls` accepted in one assistant turn.
 *
 * The tool loop executes every one of them, against the real cluster. A model
 * stuck in a repetition loop can emit hundreds; the SDK would dutifully run
 * them all. Read-only RBAC bounds the *damage*, and this bounds the *waste*.
 */
export const MAX_TOOL_CALLS_PER_TURN = 32;

/** What this translator cannot carry, in each direction. Kept as data so the
 * check suite and the notes cannot drift from the code. */
export const LOSSY = {
  /** Anthropic → OpenAI: sent by the harness, dropped on the way out. */
  droppedFromRequest: [
    "thinking (adaptive) — no OpenAI-compatible equivalent; local reasoning models expose their own, differently",
    "output_config.effort — Anthropic-only",
    "cache_control breakpoints — prompt caching is server-side and provider-specific",
    "assistant thinking/redacted_thinking blocks in conversation history",
  ],
  /** OpenAI → Anthropic: absent upstream, so synthesised or zeroed. */
  absentFromResponse: [
    "cache_creation_input_tokens — always UNREPORTED (rendered `—`, not 0); no OpenAI-compatible server has a wire field for it",
    "thinking blocks — a local reasoning model's <think> output is not separable from content here",
    "stop_sequence — not reported by chat-completions",
    "server-side request ids — synthesised locally when the server omits one",
  ],
} as const;

export class LocalWireError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Request: Anthropic Messages -> OpenAI chat completions

export type OpenAIToolSpec = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIChatRequest = {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAIToolSpec[];
  tool_choice?: unknown;
  temperature?: number;
  stop?: string[];
};

/** Flatten Anthropic's `system` (string, or an array of text blocks with cache
 * breakpoints on them) into the single system string OpenAI accepts. */
export function systemText(system: unknown): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) {
    throw new LocalWireError(
      `system must be a string or an array of text blocks, got ${typeof system}`,
    );
  }
  const parts: string[] = [];
  for (const [i, block] of system.entries()) {
    if (!isRecord(block)) throw new LocalWireError(`system[${i}] is not a content block`);
    if (block["type"] !== "text") {
      throw new LocalWireError(
        `system[${i}] has type ${JSON.stringify(block["type"])}; only text blocks are translatable`,
      );
    }
    const text = block["text"];
    if (typeof text !== "string") throw new LocalWireError(`system[${i}].text is not a string`);
    parts.push(text);
  }
  return parts.join("\n\n");
}

/** The text of a `tool_result` block, which may be a string or a block array. */
function toolResultContent(block: Record<string, unknown>): string {
  const content = block["content"];
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) =>
        isRecord(part) && typeof part["text"] === "string" ? part["text"] : JSON.stringify(part),
      )
      .join("\n");
  } else {
    text = JSON.stringify(content ?? "");
  }
  // OpenAI's `tool` role has no `is_error` field, so an errored result would
  // otherwise arrive looking exactly like a successful one. The tools declare
  // their own outcome in-band (src/tools/status.ts) and that declaration is
  // what the model is trained on here, but a transport-level error — a tool
  // that threw rather than returned — has no such marker, so it gets one.
  //
  // This prefix is added on the OUTBOUND translation only. Evidence lifting
  // reads `triage.messages`, the Anthropic-side conversation, which is
  // untouched — so nothing the grader or the citation verifier sees is altered
  // by this line.
  return block["is_error"] === true ? `[tool error] ${text}` : text;
}

/**
 * Translate one Anthropic request body into an OpenAI chat-completions body.
 *
 * ## Message-order contract
 *
 * OpenAI requires each `tool` message to follow the assistant message carrying
 * the matching `tool_call`. Anthropic's shape guarantees that ordering already
 * — an assistant turn with `tool_use` blocks is always followed by a user turn
 * whose content leads with the matching `tool_result` blocks — so a single
 * in-order pass preserves it. Nothing here reorders anything; if the input
 * violates the contract the output will too, deliberately, because inventing a
 * repair would hide a harness bug.
 */
export function toChatCompletionsRequest(body: unknown): OpenAIChatRequest {
  if (!isRecord(body)) throw new LocalWireError("request body is not a JSON object");

  const model = body["model"];
  if (typeof model !== "string" || model === "") {
    throw new LocalWireError("request has no `model`");
  }
  const maxTokens = body["max_tokens"];
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_STREAM_OUTPUT_TOKENS) {
    throw new LocalWireError("request has no positive integer `max_tokens`");
  }
  // The upstream leg streams; the SDK-facing leg still returns Messages JSON.
  if (body["stream"] === true) {
    throw new LocalWireError(
      "the local transport returns assembled Messages JSON to the SDK. Its toolRunner " +
        "uses the non-streaming SDK path; a `stream: true` request means that changed, and " +
        "a half-translated stream would be worse than stopping here.",
    );
  }

  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LocalWireError("request has no `messages`");
  }

  const out: OpenAIMessage[] = [];

  const system = systemText(body["system"]);
  if (system !== "") out.push({ role: "system", content: system });

  for (const [i, raw] of messages.entries()) {
    if (!isRecord(raw)) throw new LocalWireError(`messages[${i}] is not an object`);
    const role = raw["role"];
    const content = raw["content"];

    if (role !== "user" && role !== "assistant") {
      throw new LocalWireError(`messages[${i}].role is ${JSON.stringify(role)}`);
    }

    if (typeof content === "string") {
      out.push(role === "user" ? { role: "user", content } : { role: "assistant", content });
      continue;
    }
    if (!Array.isArray(content)) {
      throw new LocalWireError(
        `messages[${i}].content is neither a string nor an array of blocks`,
      );
    }

    if (role === "user") {
      // Tool results first, then any prose, matching both the order Anthropic
      // puts them in and the order OpenAI requires.
      const prose: string[] = [];
      for (const [j, block] of content.entries()) {
        if (!isRecord(block)) throw new LocalWireError(`messages[${i}].content[${j}] is not a block`);
        const type = block["type"];
        if (type === "tool_result") {
          const id = block["tool_use_id"];
          if (typeof id !== "string" || id === "") {
            throw new LocalWireError(`messages[${i}].content[${j}] has no tool_use_id`);
          }
          out.push({ role: "tool", tool_call_id: id, content: toolResultContent(block) });
        } else if (type === "text") {
          const text = block["text"];
          if (typeof text === "string" && text !== "") prose.push(text);
        } else {
          throw new LocalWireError(
            `messages[${i}].content[${j}] has type ${JSON.stringify(type)}, which this ` +
              "translator cannot carry to an OpenAI-compatible server. The harness sends " +
              "only text and tool_result blocks in user turns; a new block type is a " +
              "change above the seam that this transport must be taught about, not one " +
              "it may quietly discard.",
          );
        }
      }
      if (prose.length > 0) out.push({ role: "user", content: prose.join("\n\n") });
      continue;
    }

    // assistant
    const prose: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    for (const [j, block] of content.entries()) {
      if (!isRecord(block)) throw new LocalWireError(`messages[${i}].content[${j}] is not a block`);
      const type = block["type"];
      if (type === "text") {
        const text = block["text"];
        if (typeof text === "string" && text !== "") prose.push(text);
      } else if (type === "tool_use") {
        const id = block["id"];
        const name = block["name"];
        if (typeof id !== "string" || id === "") {
          throw new LocalWireError(`messages[${i}].content[${j}] tool_use has no id`);
        }
        if (typeof name !== "string" || name === "") {
          throw new LocalWireError(`messages[${i}].content[${j}] tool_use has no name`);
        }
        toolCalls.push({
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(block["input"] ?? {}) },
        });
      } else if (type === "thinking" || type === "redacted_thinking") {
        // Dropped deliberately (LOSSY.droppedFromRequest). Anthropic thinking
        // blocks in history have no OpenAI counterpart, and a local reasoning
        // model keeps its own scratchpad conventions. Nothing the model is
        // *asked* changes by their absence.
        continue;
      } else {
        throw new LocalWireError(
          `messages[${i}].content[${j}] has assistant block type ${JSON.stringify(type)}, ` +
            "which this translator cannot carry.",
        );
      }
    }
    const assistant: Extract<OpenAIMessage, { role: "assistant" }> = {
      role: "assistant",
      content: prose.length > 0 ? prose.join("\n\n") : null,
    };
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    out.push(assistant);
  }

  const request: OpenAIChatRequest = {
    model,
    messages: out,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  const tools = body["tools"];
  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = tools.map((tool, i) => {
      if (!isRecord(tool)) throw new LocalWireError(`tools[${i}] is not an object`);
      const name = tool["name"];
      if (typeof name !== "string" || name === "") {
        throw new LocalWireError(`tools[${i}].name is missing`);
      }
      const schema = tool["input_schema"];
      if (!isRecord(schema)) throw new LocalWireError(`tools[${i}].input_schema is missing`);
      const description = tool["description"];
      const spec: OpenAIToolSpec = {
        type: "function",
        function: {
          name,

          parameters: schema,
        },
      };
      if (typeof description === "string" && description !== "") {
        spec.function.description = description;
      }
      return spec;
    });
  }

  const temperature = body["temperature"];
  if (typeof temperature === "number") request.temperature = temperature;

  const stopSequences = body["stop_sequences"];
  if (Array.isArray(stopSequences) && stopSequences.length > 0) {
    request.stop = stopSequences.filter((s): s is string => typeof s === "string");
  }

  const toolChoice = body["tool_choice"];
  if (isRecord(toolChoice)) {
    const kind = toolChoice["type"];
    if (kind === "auto") request.tool_choice = "auto";
    else if (kind === "any") request.tool_choice = "required";
    else if (kind === "none") request.tool_choice = "none";
    else if (kind === "tool" && typeof toolChoice["name"] === "string") {
      request.tool_choice = { type: "function", function: { name: toolChoice["name"] } };
    }
  }

  return request;
}

// ---------------------------------------------------------------------------
// Response: OpenAI chat completions -> Anthropic BetaMessage

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal";

/**
 * Map a chat-completions `finish_reason` to an Anthropic `stop_reason`.
 *
 * ## The one that matters: `hasToolCalls` overrides everything
 *
 * A large minority of OpenAI-compatible servers — Ollama and several llama.cpp
 * builds among them — return `finish_reason: "stop"` on a turn that *did* emit
 * `tool_calls`, because the generation genuinely ended at an EOS token and the
 * tool-call extraction happened afterwards in a grammar/parser layer that never
 * revisits the field.
 *
 * ##: the override is now scoped
 *
 * The override therefore applies only to the finish reasons that are genuinely
 * ambiguous on a tool-calling turn: `stop` and `tool_calls` itself. Everything
 * outside the named allowlist — absent values included — throws; see the body for why silence is not an option.
 */
export function mapStopReason(finishReason: unknown, hasToolCalls: boolean): StopReason {
  // Now: the reasons this adapter KNOWS map by name; anything else — including
  // absent — throws, carrying the raw value, so an unknown outcome is a loud
  // adapter/server question instead of a silent clean turn. If a real server
  // needs another reason tolerated (e.g. `eos` on some llama.cpp builds),
  // tolerate it BY NAME with a comment and an assertion, after seeing it on a
  // real server — never by default.
  if (hasToolCalls && (finishReason === "stop" || finishReason === "tool_calls")) {
    // The one genuine ambiguity: servers that finish generation at EOS and
    // extract tool calls afterwards report "stop" on a tool-calling turn.
    // "tool_calls" is the literal OpenAI mapping, not an override.
    return "tool_use";
  }
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "stop_sequence":
      if (hasToolCalls) {
        // A stop-string cut on a turn that ALSO carries tool calls is a
        // combination no server here has ever produced. end_turn would let the
        // loop accept a turn with unexecuted tool calls as final; tool_use
        // would extend the "stop" override to an unproven case. Refuse, and
        // tolerate by name if a real server ever emits it.
        throw new LocalWireError(
          'finish_reason "stop_sequence" arrived on a turn carrying tool calls — an ' +
            "unproven combination. Refusing rather than guessing whether the turn was " +
            "a clean tool-calling turn or a truncated one. If a real server emits this, " +
            "add the mapping by name with a comment and an assertion.",
        );
      }
      // Non-standard but unambiguous without tool calls: generation stopped at
      // a stop string. Tolerated by name; asserted in the offline check suite.
      return "end_turn";
    case "length":

      if (hasToolCalls) {
        throw new LocalWireError(
          'finish_reason "length" arrived on a turn carrying tool calls: the generation ' +
            "was truncated by the token budget while it was still emitting, so the calls " +
            "(and their arguments) may be cut off mid-emission. Refusing before any of " +
            "them executes. Raise the token budget or the server's context and re-run.",
        );
      }
      return "max_tokens";
    case "content_filter":
      // Same shape as "length" above: a filtered turn that
      // still carries tool calls is a contradiction — calls emitted alongside
      // content the server itself suppressed must not run against the cluster.
      if (hasToolCalls) {
        throw new LocalWireError(
          'finish_reason "content_filter" arrived on a turn carrying tool calls: the ' +
            "server suppressed the generation, so the calls that came with it cannot be " +
            "trusted to be what the model meant to emit. Refusing before any of them " +
            "executes.",
        );
      }
      return "refusal";
    case "tool_calls":

      throw new LocalWireError(
        'the server reported finish_reason "tool_calls" on a message carrying no tool ' +
          "calls. The server contradicted itself — the turn's text was generated around " +
          "tool calls this adapter never received — so the turn cannot be accepted as a " +
          "final report. This is a server/adapter fault, not a model fault; record it as " +
          "such.",
      );
    default:
      throw new LocalWireError(
        `unrecognised finish_reason ${JSON.stringify(finishReason) ?? String(finishReason)} ` +
          `(tool calls present: ${String(hasToolCalls)}). Known values: "stop", ` +
          '"stop_sequence", "length", "content_filter", "tool_calls". An unknown or absent ' +
          "finish_reason may mean an aborted, errored or truncated generation, and mapping " +
          "it to a clean end_turn would let a partial investigation be graded as a final " +
          "report. If a real server legitimately emits this value, add it to the allowlist " +
          "by name, with a comment and an assertion.",
      );
  }
}

/**
 * Parse a `tool_calls[].function.arguments` payload into a tool input object.
 *
 * Three shapes are accepted because three shapes occur in the wild:
 *
 *  - a JSON string (the OpenAI specification, and what most servers emit);
 *  - an already-decoded object (Ollama's native shape leaks through some of its
 *    compatibility builds, and some LM Studio versions do the same);
 *  - absent or empty, meaning a no-argument call, which is legitimate.
 *
 * Everything else throws. The tempting alternative — fall back to `{}` on a
 * parse failure — is the single worst thing this file could do: it converts
 * "the model emitted malformed JSON" into "the model called this tool with no
 * arguments", so `kubectl_read` runs with defaults, returns something, and the
 * run continues on evidence the model never asked for. A malformed tool call
 * must be visible as a malformed tool call.
 */
export function parseToolArguments(raw: unknown, toolName: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") {
    throw new LocalWireError(
      `tool call to "${toolName}" has arguments of type ${typeof raw}; expected a JSON string or object`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new LocalWireError(
      `tool call to "${toolName}" has arguments that are not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)}). Refusing to ` +
        "substitute an empty object: that would run the tool with defaults and " +
        `present the result as what the model asked for. Raw: ${trimmed.slice(0, 200)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new LocalWireError(
      `tool call to "${toolName}" has arguments that parsed to ` +
        `${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object. Tool inputs ` +
        "are objects; anything else cannot be matched against the tool's schema.",
    );
  }
  return parsed;
}

export type UsageCounterName =
  | "input_tokens"
  | "output_tokens"
  | "cache_creation_input_tokens"
  | "cache_read_input_tokens";

export type LocalUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /**
   * Counters the server did **not** report, whose numeric value above is
   * therefore a placeholder rather than a measurement.
   */
  unreported_counters: UsageCounterName[];
};

/**
 * Map chat-completions usage onto the four counters the metering footer prints.
 *
 * What is real: `input_tokens` and `output_tokens`, verbatim from the server's
 * `prompt_tokens` / `completion_tokens`. What is *structurally* absent:
 *
 *  - `cache_creation_input_tokens` is **always 0** — no OpenAI-compatible
 *    server reports a cache-write count, because prompt caching there is an
 *    internal KV-cache detail with no wire representation. The footer's
 *    "cache write" column is therefore a column of zeroes on this path, and
 *    that is a fact about the protocol, not about the run.
 *  - `cache_read_input_tokens` is populated only when the server volunteers
 *    `prompt_tokens_details.cached_tokens` (vLLM and recent llama.cpp do;
 *    Ollama does not), and is 0 otherwise — which is indistinguishable from a
 *    genuine zero. Do not read it as a cache-hit rate.
 *
 * ##: unreported is not zero
 *
 * So every counter the server did not report is listed in `unreported_counters`
 * and printed as `—`. `cache_creation_input_tokens` is *always* listed: it has
 * no wire representation at all on this protocol, so its zero was never a
 * measurement on any local run. Nothing is estimated in either case.
 */
export function mapUsage(raw: unknown): LocalUsage {
  const usage = isRecord(raw) ? raw : {};
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? Math.trunc(v) : 0;

  const reported = (v: unknown): boolean =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const details = isRecord(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : {};

  const rawInput = usage["prompt_tokens"] ?? usage["input_tokens"];
  const rawOutput = usage["completion_tokens"] ?? usage["output_tokens"];
  const rawCacheRead = details["cached_tokens"];

  const unreported: UsageCounterName[] = [];
  if (!reported(rawInput)) unreported.push("input_tokens");
  if (!reported(rawOutput)) unreported.push("output_tokens");
  // Structural, not circumstantial: no OpenAI-compatible server has a field for
  // this, so it is unreported on every local run without exception.
  unreported.push("cache_creation_input_tokens");
  if (!reported(rawCacheRead)) unreported.push("cache_read_input_tokens");

  return {
    input_tokens: num(rawInput),
    output_tokens: num(rawOutput),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: num(rawCacheRead),
    unreported_counters: unreported,
  };
}

/** Join a chat-completions `content` field, which may be a string, null, or
 * (on a few servers) an array of typed parts. */
function responseText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
      .join("");
  }
  return "";
}

/**
 * Text of whichever reasoning channel this server uses, or `""`.
 *
 * Both fields are therefore tried in order and the first with non-whitespace
 * text wins. Returns the TRIMMED text, because every caller wants it trimmed and
 * an untrimmed length would misreport the character count in the diagnosis.
 */
function reasoningText(message: Record<string, unknown>): string {
  for (const key of ["reasoning", "reasoning_content"]) {
    const raw = message[key];
    let text = responseText(raw);
    if (text.trim() === "" && isRecord(raw)) {
      // Object-shaped channels: {text} and {content} are the shapes in the wild.
      text = responseText(raw["text"]) || responseText(raw["content"]);
    }
    if (text.trim() !== "") return text.trim();
  }
  return "";
}

export type ToBetaMessageOptions = {
  /** Falls back into `BetaMessage.model` when the server omits one. */
  model: string;
  /** 1-based turn number, used to synthesise ids the server did not supply. */
  turn: number;
  /**
   * Every `tool_use` id this **run** has already issued.
   *
   * ## — why this is per-run and not per-call
   *
   * That is the evidence-integrity class closed, reopened
   * through a different door. The caller (`localTransport`) owns one set for the
   * whole run and hands it in here; a collision is then repaired at the point it
   * is created, where the repair can still be correct, rather than being
   * discovered downstream where it can only be dropped.
   *
   * Omit it and the behaviour degrades to per-response, which is the old bug;
   * `localTransport` never omits it.
   */
  issuedToolCallIds?: Set<string>;
  /**
   * Called when the server hands back an id this run has already used.
   */
  onToolCallIdCollision?: (info: { turn: number; index: number; id: string; replacement: string }) => void;
};

/**
 * Translate a chat-completions response body into a `BetaMessage`.
 *
 * The SDK parses what this produces as if the real API had sent it, so the
 * shape has to be right in full, not merely right in the fields we happen to
 * read downstream.
 */
export function toBetaMessage(payload: unknown, options: ToBetaMessageOptions): BetaMessage {
  if (!isRecord(payload)) {
    throw new LocalWireError("the local server's response body is not a JSON object");
  }

  // Surface a server-side error as itself. An OpenAI-compatible error body is
  // `{ error: { message, type } }` and carries no `choices`; without this the
  // failure would present as "malformed response" and hide the real reason
  // (model not loaded, context overflow, out of memory).
  const error = payload["error"];
  if (isRecord(error) || typeof error === "string") {
    const message = isRecord(error) ? String(error["message"] ?? JSON.stringify(error)) : error;
    throw new LocalWireError(`the local inference server returned an error: ${message}`);
  }

  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LocalWireError(
      "the local server's response has no `choices`. This is not a chat-completions " +
        "response; check that LOCAL_MODEL_BASE_URL points at an OpenAI-compatible endpoint.",
    );
  }
  const choice = choices[0];
  if (!isRecord(choice)) throw new LocalWireError("choices[0] is not an object");
  const message = choice["message"];
  if (!isRecord(message)) {
    throw new LocalWireError(
      "choices[0].message is missing. A `delta` here means the server streamed a " +
        "response to a non-streaming request.",
    );
  }

  const blocks: BetaContentBlock[] = [];
  const text = responseText(message["content"]);
  if (text.trim() !== "") {
    blocks.push({ type: "text", text, citations: null } as BetaContentBlock);
  }

  const rawToolCalls = message["tool_calls"];
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : [];
  if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
    throw new LocalWireError(
      `the local model emitted ${toolCalls.length} tool calls in one turn ` +
        `(ceiling ${MAX_TOOL_CALLS_PER_TURN}). The loop would execute every one of them ` +
        "against the cluster. This is the signature of a model stuck in a repetition " +
        "loop, not of an investigation.",
    );
  }

  // Per-RUN when the caller supplies it; the local
  // fallback preserves the old per-response behaviour only for direct callers
  // in the check suite that are asserting a single translation.
  const seenIds = new Set(options.issuedToolCallIds);
  const collisions: Parameters<NonNullable<ToBetaMessageOptions["onToolCallIdCollision"]>>[0][] = [];
  for (const [i, call] of toolCalls.entries()) {
    if (!isRecord(call)) throw new LocalWireError(`tool_calls[${i}] is not an object`);
    const fn = call["function"];
    if (!isRecord(fn)) {
      throw new LocalWireError(`tool_calls[${i}].function is missing (only function calls exist here)`);
    }
    const name = fn["name"];
    if (typeof name !== "string" || name === "") {
      throw new LocalWireError(`tool_calls[${i}].function.name is missing or empty`);
    }

    const rawId = call["id"];
    // Prefer the server's own id so the `tool_call_id` we echo back on the next
    // request is the one it issued. Fall back when it is missing, empty, or a
    // duplicate — a duplicate would make two results indistinguishable and
    // silently mispair evidence with the call that produced it.
    const supplied = typeof rawId === "string" && rawId !== "" ? rawId : "";
    const collided = supplied !== "" && seenIds.has(supplied);
    let id = supplied !== "" && !collided ? supplied : `toolu_local_${options.turn}_${i}`;
    // The synthesised form embeds the turn and index, so it cannot collide with
    // another synthesised id — but a server could have *emitted* that exact
    // string earlier, so uniqueness is proven rather than assumed.
    let suffix = 0;
    while (seenIds.has(id)) {
      suffix += 1;
      id = `toolu_local_${options.turn}_${i}_${suffix}`;
    }
    if (collided) {

      collisions.push({
        turn: options.turn,
        index: i,
        id: supplied,
        replacement: id,
      });
    }
    seenIds.add(id);
    blocks.push({
      type: "tool_use",
      id,
      name,
      input: parseToolArguments(fn["arguments"], name),
    } as BetaContentBlock);
  }

  if (blocks.length === 0) {
    // The reasoning text is deliberately NOT promoted into a text block. It is
    // the model's scratchpad, not its answer: promoting it would smuggle
    // chain-of-thought into a report that gets graded and filed as an issue,
    // and would manufacture an answer the model never committed to.
    const reasoning = reasoningText(message);
    if (reasoning !== "") {

      const finish = choice["finish_reason"];
      const cause =
        finish === "length"
          ? "generation hit the token ceiling while the model was still in its reasoning " +
            "channel, so no answer was ever committed. Raise max_tokens — this is " +
            "truncation, not a parser fault."
          : finish === "content_filter"
            ? "the server refused mid-turn while the model was still reasoning. This is a " +
              "refusal, not a parser fault."
            : "the answer may have been generated and landed off the channel this adapter " +
              "reads — a serving-layer/runtime behaviour rather than a model failure. " +
              "Check the runtime's reasoning-parser settings before blaming the model.";
      throw new LocalWireError(
        "the local server returned an empty `content` while putting " +
          `${reasoning.length} characters in a separate reasoning field ` +
          `(finish_reason=${JSON.stringify(finish)}). ${cause} The reasoning text is ` +
          "not promoted into the answer: it is a scratchpad, and a report must quote " +
          "what the model committed to.",
      );
    }
    throw new LocalWireError(
      "the local model returned a turn with neither text nor tool calls " +
        `(finish_reason=${JSON.stringify(choice["finish_reason"])}). An empty assistant ` +
        "message cannot advance the loop and cannot be written as a report.",
    );
  }

  const id = payload["id"];
  const model = payload["model"];

  const stopReason = mapStopReason(choice["finish_reason"], toolCalls.length > 0);
  for (const info of collisions) options.onToolCallIdCollision?.(info);
  for (const issued of seenIds) options.issuedToolCallIds?.add(issued);

  return {
    id: typeof id === "string" && id !== "" ? id : `msg_local_${options.turn}`,
    type: "message",
    role: "assistant",

    model: typeof model === "string" && model !== "" ? model : "",
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsage(payload["usage"]),
  } as unknown as BetaMessage;
}

// limits apply to wire bytes (including framing), one SSE event, and
// measured completion tokens independently. No bytes-to-tokens estimate.
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;
export const MAX_STREAM_EVENT_BYTES = 1024 * 1024;
export const MAX_STREAM_OUTPUT_TOKENS = 120_000;

export function assertStreamingAllowance(allowance: number, usage?: LocalUsage): void {
  if (!Number.isSafeInteger(allowance) || allowance < 1 || allowance > MAX_STREAM_OUTPUT_TOKENS) {
    throw new LocalWireError(`streaming allowance must be in 1..${MAX_STREAM_OUTPUT_TOKENS}`);
  }
  if (usage === undefined || usage.unreported_counters.includes("output_tokens") ||
      !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) {
    throw new LocalWireError("streaming allowance gate refuses: completion token usage is unmeasured");
  }
  if (usage.output_tokens > allowance) {
    throw new LocalWireError(`measured completion ${usage.output_tokens} exceeds streaming allowance ${allowance}`);
  }
}

/** One reader for every local completion, including warm-up. SSE framing is
 * decoded independently of JSON and HTTP chunk boundaries. Nothing is published
 * (including issued tool ids) until finish_reason AND [DONE] have arrived.
 * Usage-free streams can be inspected, but cannot pass the allowance gate.
 */
type StreamOptions = ToBetaMessageOptions & { allowance?: number; maxBytes?: number; maxEventBytes?: number };
export function assembleLocalStream(response: Response, options: StreamOptions & { purpose: "warmup" }): Promise<void>;
export function assembleLocalStream(response: Response, options: StreamOptions): Promise<BetaMessage>;
export async function assembleLocalStream(
  response: Response,
  options: StreamOptions & { purpose?: "warmup" },
): Promise<BetaMessage | void> {
  const maxBytes = options.maxBytes ?? MAX_STREAM_BYTES;
  const maxEventBytes = options.maxEventBytes ?? MAX_STREAM_EVENT_BYTES;
  if (![maxBytes, maxEventBytes].every((n) => Number.isSafeInteger(n) && n > 0)) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalWireError("invalid streaming byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new LocalWireError("local stream has no body");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const message: Record<string, unknown> = { role: "assistant", content: "" };
  const payload: Record<string, unknown> = {};
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let finish: unknown = null;
  let terminal = false;
  let total = 0;
  let eventBytes = 0;
  let line = "";
  let afterCR = false;
  let firstCharacter = true;
  let data: string[] = [];
  let event = "";
  const fail = (detail: string): never => { throw new LocalWireError(detail); };
  const dispatch = (): void => {
    const raw = data.join("\n");
    data = [];
    const kind = event;
    event = "";
    eventBytes = 0;
    if (raw === "" && kind === "") return;
    if (terminal) fail("frame after terminal [DONE]");
    if (kind === "error") fail(`local stream error: ${raw.slice(0, 500)}`);
    if (raw === "[DONE]") { terminal = true; return; }
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { fail("local stream has invalid JSON event"); }
    if (!isRecord(frame)) return fail("local stream event is not an object");
    if (frame["error"] !== undefined) fail(`local stream error: ${JSON.stringify(frame["error"]).slice(0, 500)}`);
    for (const key of ["id", "model"]) {
      const value = frame[key];
      if (value === undefined || value === "") continue;
      if (typeof value !== "string" || (payload[key] !== undefined && payload[key] !== value)) {
        fail(`local stream changed ${key}`);
      }
      payload[key] = value;
    }
    if (frame["usage"] != null) {
      if (payload["usage"] !== undefined) fail("duplicate stream usage totals");
      payload["usage"] = frame["usage"];
    }
    const choices = frame["choices"];
    if (!Array.isArray(choices) || choices.length > 1) return fail("stream requires one choice at index 0");
    if (choices.length === 0) {
      if (frame["usage"] == null) fail("empty stream choices without usage");
      return;
    }
    const choice = choices[0];
    if (!isRecord(choice) || choice["index"] !== 0) return fail("stream choice index must be 0");
    if (finish !== null) fail("choice after finish_reason");
    const delta = choice["delta"];
    if (!isRecord(delta)) return fail("stream choice has no delta");
    if (delta["role"] !== undefined && delta["role"] !== "assistant") fail("invalid stream role");
    for (const key of ["content", "reasoning", "reasoning_content"]) {
      const value = delta[key];
      if (value == null) continue;
      if (typeof value !== "string") fail(`stream ${key} delta is not text`);
      message[key] = String(message[key] ?? "") + value;
    }
    if (delta["tool_calls"] !== undefined) {
      if (!Array.isArray(delta["tool_calls"])) return fail("tool_calls delta is not an array");
      for (const rawCall of delta["tool_calls"]) {
        if (!isRecord(rawCall)) return fail("tool delta is not an object");
        const index = rawCall["index"];
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_TOOL_CALLS_PER_TURN) {
          return fail("tool delta index exceeds turn limit");
        }
        let call = calls.get(index);
        if (!call) { call = { id: "", type: "function", function: { name: "", arguments: "" } }; calls.set(index, call); }
        if (rawCall["type"] !== undefined && rawCall["type"] !== "function") fail("unsupported tool delta type");
        if (rawCall["id"] !== undefined) {
          if (typeof rawCall["id"] !== "string") fail("invalid tool id delta");
          call.id += rawCall["id"];
        }
        const fn = rawCall["function"];
        if (fn !== undefined) {
          if (!isRecord(fn)) return fail("invalid tool function delta");
          for (const key of ["name", "arguments"] as const) {
            if (fn[key] === undefined) continue;
            if (typeof fn[key] !== "string") return fail(`invalid tool ${key} delta`);
            call.function[key] += fn[key];
          }
        }
      }
    }
    if (choice["finish_reason"] != null) finish = choice["finish_reason"];
  };
  const acceptLine = (): void => {
    if (line === "") dispatch();
    else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      if (field === "event") event = value;
    }
    line = "";
  };
  const consume = (text: string): void => {
    for (const char of text) {
      if (afterCR) {
        afterCR = false;
        if (char === "\n") {
          eventBytes += 1;
          if (eventBytes > maxEventBytes) fail("stream event exceeds byte ceiling");
          acceptLine();
          continue;
        }
        acceptLine();
      }
      eventBytes += Buffer.byteLength(char);
      if (eventBytes > maxEventBytes) fail("stream event exceeds byte ceiling");
      if (firstCharacter) {
        firstCharacter = false;
        if (char === "\uFEFF") continue;
      }
      if (char === "\r") afterCR = true;
      else if (char === "\n") acceptLine();
      else line += char;
    }
  };
  try {
    if (!response.ok) fail(`local inference server answered ${response.status} ${response.statusText}`);
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
      fail("local server did not return text/event-stream");
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) fail("declared stream exceeds byte ceiling");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) fail("stream exceeds byte ceiling mid-read");
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    if (afterCR) acceptLine();
    if (!terminal || finish === null || line !== "" || data.length > 0 || event !== "") {
      fail("incomplete local stream: finish_reason and terminal [DONE] frame required");
    }
    const sorted = [...calls.entries()].sort(([a], [b]) => a - b);
    if (sorted.some(([index], position) => index !== position)) fail("sparse tool delta indices");
    if (sorted.length) message["tool_calls"] = sorted.map(([, call]) => call);
    payload["choices"] = [{ index: 0, message, finish_reason: finish }];
    if (options.allowance !== undefined) assertStreamingAllowance(options.allowance, mapUsage(payload["usage"]));
    if (options.purpose === "warmup") {
      if (calls.size > 0) fail("warm-up unexpectedly emitted tool calls");
      mapStopReason(finish, false);
      return;
    }
    return toBetaMessage(payload, options);
  } finally {
    try { await reader.cancel(); } catch { /* preserve the original failure */ }
    reader.releaseLock();
  }
}
