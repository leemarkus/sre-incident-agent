import { declaredToolStatus } from "./tools/status.js";

/**
 * The run's whole tool transcript.
 *
 * ## Count blocks, never string-match the transcript
 *
 * Recorded exchanges resend the whole conversation on every turn and the tool
 * schema is echoed in every request, so a naive `grep kubectl_read` over a run's
 * transcript reports hits for a run that never called it. That false signal is
 * what let this bug survive casual inspection. Everything here counts structured
 * `tool_use` blocks.
 */

/** The tools this agent can actually hold. Used to recognise invented ones. */
export const AGENT_TOOL_NAMES = [
  "kubectl_read",
  "promql_query",
  "argocd_status",
  "docs_search",
  "docs_read",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/**
 * Tools that OBSERVE the cluster, as opposed to retrieving text about it.
 *
 * An ALLOWLIST rather than "everything that is not docs": an unrecognised tool
 * is not an observation. The offline check suite asserts every name in
 * {@link AGENT_TOOL_NAMES} is classified here or in {@link RETRIEVAL_TOOLS}, so
 * adding a sixth tool fails the suite until someone decides which it is,
 * instead of defaulting it into the trusted half.
 */
export const OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "kubectl_read",
  "promql_query",
  "argocd_status",
]);

/** Tools that return text ABOUT the cluster, from a world-writable corpus. */
export const RETRIEVAL_TOOLS: ReadonlySet<string> = new Set(["docs_search", "docs_read"]);

/**
 * The input keys each tool's own Zod schema declares.
 *
 * `src/attribution.ts` uses these to recognise a **bare argument object** — a
 * fenced JSON blob a model writes instead of making a call, with no `"name"`
 * field to give it away. The bound on that claim form has to be the tools' own
 * declared surface rather than a vocabulary the grader invents, or it becomes
 * the open-ended enumeration abandoned.
 *
 * Duplicated here, in the pure module, for the same reason `EMPTY_RESULT_LINE`
 * lives in `src/queries.ts`: the grader must be able to depend on the tool
 * contract without pulling the SDK, the config loader and a `fetch` client into
 * an offline module. The offline check suite asserts these key sets against the real
 * schemas, so the copy cannot drift silently.
 */
export const AGENT_TOOL_INPUT_KEYS: Readonly<Record<AgentToolName, readonly string[]>> = {
  kubectl_read: [
    "subcommand",
    "namespace",
    "resource",
    "name",
    "selector",
    "container",
    "tailLines",
    "since",
    "output",
  ],
  promql_query: ["query", "range"],
  argocd_status: ["application"],
  docs_search: ["query", "repo", "path_prefix", "max_results"],
  docs_read: ["repo", "path"],
};

export function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

/** One tool call of any kind, and what it returned, verbatim. */
export type ToolCall = {
  /** 1-based index of the assistant turn that issued the call. */
  turn: number;
  /**
   * The tool name as the model wrote it — deliberately not narrowed to
   * `AgentToolName`. A call to a tool that does not exist is a fact about the
   * run and must stay visible, not be filtered out of the evidence.
   */
  tool: string;
  toolUseId: string;
  input: Record<string, unknown>;
  /** Verbatim tool result, status marker included. */
  result: string;
  /**
   * Did the tool declare success? A call that failed — or whose arguments the
   * schema rejected, which leaves the result undeclared — read nothing, and a
   * report may not attribute an observation to it.
   */
  ok: boolean;
};

export type ToolEvidence = {
  /**
   * Was a tool transcript available at all? `false` means "we do not know what
   * the run called", which is NOT "the run called nothing". The grader must not
   * treat the two alike: absent leaves attribution unarmed and says so, and
   * never borrows another run's transcript.
   */
  present: boolean;
  calls: ToolCall[];
  /** Calls that ran and declared success. Only these can support an observation. */
  okCalls: ToolCall[];
};

export const NO_TOOL_EVIDENCE: ToolEvidence = {
  present: false,
  calls: [],
  okCalls: [],
};

export function toolEvidenceFromCalls(calls: readonly ToolCall[]): ToolEvidence {
  return {
    present: true,
    calls: [...calls],
    okCalls: calls.filter((c) => c.ok),
  };
}

// ---------------------------------------------------------------------------
// Pulling the calls out of a run transcript

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockText(block: Record<string, unknown>): string {
  const content = block["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part["text"] === "string"
          ? part["text"]
          : JSON.stringify(part),
      )
      .join("\n");
  }
  return typeof content === "undefined" ? "" : JSON.stringify(content);
}

export class ToolTranscriptError extends Error {}

/**
 * Extract every tool call and its result from a **conversation** — the ordered
 * `messages` array the tool loop actually built.
 *
 * Not from `transport.exchanges`, for the two reasons recorded:
 * a live transport records no exchanges at all (so every check founded on them
 * is disarmed exactly when a real model is in the loop), and the pinned SDK
 * ships a turn's tool results in the *next* request, so calls made on the final
 * permitted iteration leave no trace in any request body. The conversation has
 * neither problem and is still the run's own verbatim tool output.
 *
 * Pairing **consumes** rather than dedupes, for the reason
 * recorded: local models reuse `tool_use_id` across turns, and a dropped
 * pairing is a call missing from the evidence — which here would mean a real
 * invocation graded as fabricated, an evidence-integrity failure pointing the
 * wrong way. Ambiguity no rule can resolve throws rather than returning quietly
 * incomplete evidence.
 */
export function toolCallsFromMessages(messages: readonly unknown[]): ToolCall[] {
  const pending = new Map<
    string,
    Array<{ tool: string; input: Record<string, unknown>; turn: number }>
  >();
  const known = new Set<string>();
  const calls: ToolCall[] = [];
  let assistantTurn = 0;

  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message["role"] === "assistant") assistantTurn += 1;
    const content = message["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] === "tool_use") {
        const name = block["name"];
        const id = block["id"];
        if (typeof name !== "string" || typeof id !== "string") continue;
        const queue = pending.get(id);
        if (queue !== undefined && queue.length > 0) {
          throw new ToolTranscriptError(
            `two unanswered tool calls share tool_use_id ${JSON.stringify(id)} ` +
              `(turns ${queue[0]?.turn} and ${assistantTurn}). Their results cannot be told ` +
              "apart, so an observation would be attributed to the wrong call. Refusing to guess.",
          );
        }
        known.add(id);
        pending.set(id, [
          {
            tool: name,
            input: isRecord(block["input"]) ? block["input"] : {},
            turn: assistantTurn,
          },
        ]);
      } else if (block["type"] === "tool_result") {
        const id = block["tool_use_id"];
        if (typeof id !== "string") continue;
        const queue = pending.get(id);
        const issued = queue?.shift();
        if (issued === undefined) {
          if (known.has(id)) {
            throw new ToolTranscriptError(
              `a second tool_result arrived for tool call ${JSON.stringify(id)} with no ` +
                "outstanding call to match it. The transcript is malformed; refusing to " +
                "attribute the result to an arbitrary call.",
            );
          }
          continue; // A result for a block this walk never saw issued.
        }
        const result = blockText(block);
        calls.push({
          turn: issued.turn,
          tool: issued.tool,
          toolUseId: id,
          input: issued.input,
          result,
          ok: declaredToolStatus(result) === "ok",
        });
      }
    }
  }
  return [...calls].sort((a, b) => a.turn - b.turn);
}

export function toolEvidenceFromMessages(messages: readonly unknown[]): ToolEvidence {
  return toolEvidenceFromCalls(toolCallsFromMessages(messages));
}

/** The persisted shape written next to a run's report and committed as a fixture. */
export type ToolTranscript = {
  scenario?: string;
  calls: ToolCall[];
};

export function evidenceFromToolTranscript(transcript: ToolTranscript): ToolEvidence {
  return toolEvidenceFromCalls(transcript.calls);
}
