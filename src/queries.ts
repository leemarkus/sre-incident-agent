import { declaredToolStatus, withoutStatus } from "./tools/status.js";

/**
 * PromQL query evidence.
 *
 * ## Why this file exists
 *
 * After 5a landed, five further phrasings still PASSed with zero failed checks:
 * "the series came back void", "no samples surfaced for that selector", "the
 * scrape yielded an unpopulated set", "we saw naught in the response", "result
 * set had zero rows". The lesson is structural, not lexical: the old detector
 * tried to recognise an unbounded natural-language claim by enumerating
 * vocabulary in **two** open-ended dimensions at once (empty-result words ×
 * health words). Enumeration cannot finish that.
 *
 * ## The re-founding
 *
 * The obvious weaker formulation — "whenever an empty result appears in the
 * report, require a verdict" — is still the lexical problem wearing a hat,
 * because deciding that "the series came back void" *is* an empty-result
 * mention is the enumeration that keeps failing. Nothing here reads the report.
 *
 * ## What counts as an empty vector, and why that is not spoofable
 *
 * The tool's own output contract, on two independent axes:
 *
 *  - the result must **declare success** (`src/tools/status.js`) — a query that
 *    failed read nothing, which is a different fact from a query that ran and
 *    matched nothing, and must not arm the check; and
 *  - a line equal to `EMPTY_RESULT_LINE` must appear in the payload. That line
 *    is emitted by `formatResult` only on the zero-series path. Series lines
 *    are `{labels} => value @ timestamp`, so a label value containing this text
 *    can never be a whole line equal to it.
 *
 * Both constants live here rather than in `src/tools/promql.ts` so that the
 * grader can depend on the contract without pulling the SDK, the config loader
 * and a `fetch` client into a pure, offline module; `promql.ts` imports them
 * from here, which keeps one definition and one direction of dependency.
 */

export const PROMQL_TOOL_NAME = "promql_query";

export const EMPTY_RESULT_LINE = "(empty result — zero series returned)";

/** A measured liveness verdict, as `promql_query` emits it in every banner. */
export const LIVENESS_VERDICT_RE =
  /INGESTION (LIVE|STALE|GAP|APPEARS DEAD|LIVENESS UNKNOWN)/;

/** Global flavour, for finding every verdict in a passage. */
const LIVENESS_VERDICT_GLOBAL_RE = new RegExp(LIVENESS_VERDICT_RE.source, "g");

/** Every verdict token in a passage, in order, e.g. `["INGESTION GAP"]`. */
export function verdictTokens(text: string): string[] {
  return [...text.matchAll(LIVENESS_VERDICT_GLOBAL_RE)].map((m) => m[0]);
}

/** One `promql_query` call and what it returned, verbatim. */
export type QueryCall = {
  turn: number;
  toolUseId: string;
  /** The PromQL expression, taken from the recorded tool input. */
  query: string;
  /** Was it a range query? Recorded for the audit trail, not used for grading. */
  range: boolean;
  /** Verbatim tool result, status marker included. */
  result: string;

  ok: boolean;
  /** Did the tool report zero series for this query? */
  empty: boolean;
  /** The verdict this call emitted, e.g. `INGESTION GAP`. */
  verdict: string | undefined;
};

export type QueryEvidence = {

  present: boolean;
  calls: QueryCall[];

  emptyCalls: QueryCall[];
};

export const NO_QUERY_EVIDENCE: QueryEvidence = {
  present: false,
  calls: [],
  emptyCalls: [],
};

/** Did this result declare success and report zero series? */
export function resultIsEmptyVector(result: string): boolean {
  if (declaredToolStatus(result) !== "ok") return false;
  return withoutStatus(result)
    .split("\n")
    .some((line) => line.trim() === EMPTY_RESULT_LINE);
}

export function queryEvidenceFromCalls(calls: readonly QueryCall[]): QueryEvidence {
  return {
    present: true,
    calls: [...calls],
    emptyCalls: calls.filter((c) => c.ok && c.empty),
  };
}

// ---------------------------------------------------------------------------
// Pulling the query calls out of a run transcript

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

/**
 * Extract the `promql_query` calls and their results from a **conversation** —
 * the ordered `messages` array the tool loop actually built.
 *
 * ##: why not the transport's exchanges
 *
 * It also missed the last turn's calls entirely. The pinned SDK (0.115.0) runs
 * a turn's tools *after* yielding the assistant message and ships the results in
 * the *next* request; at `max_iterations` there is no next request, so a
 * `promql_query` that really executed left no trace in any request body.
 *
 * The runner's own conversation has neither problem. The tools execute
 * in-process on both transports, and the SDK appends their results to
 * `runner.params.messages` before the iteration cap is re-checked. Same
 * verbatim tool output, no re-query, and armed on both paths.
 *
 * `turn` is the 1-based index of the **assistant turn that issued the call**.
 *
 * ##: pairing consumes, it does not dedupe
 *
 * The pairing is now a *queue* rather than a *set*: a `tool_use` registers a
 * pending call, and the matching `tool_result` consumes it. Cross-turn reuse
 * therefore pairs each call with its own result, in order, and nothing is
 * dropped. `src/transport.ts` separately guarantees run-unique ids on the local
 * path; this is the second half, because the recorded transport replays
 * committed fixtures that this function must not silently mis-read either.
 *
 * Genuine ambiguity — two *unanswered* calls sharing an id, or a second result
 * for an id with nothing outstanding — cannot be resolved by any rule, so it
 * throws. A grader that quietly returns less evidence than the run produced is
 * the failure being fixed; failing loudly is the only honest alternative.
 */
export class QueryTranscriptError extends Error {}

export function promqlCallsFromMessages(messages: readonly unknown[]): QueryCall[] {
  /** Issued but not yet answered, in issue order, per id. */
  const pending = new Map<string, Array<{ input: Record<string, unknown>; turn: number }>>();
  /** Every id this conversation has used for a promql call, answered or not. */
  const known = new Set<string>();
  const calls: QueryCall[] = [];
  let assistantTurn = 0;

  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message["role"] === "assistant") assistantTurn += 1;
    const content = message["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] === "tool_use") {
        const id = block["id"];
        if (block["name"] === PROMQL_TOOL_NAME && typeof id === "string") {
          const queue = pending.get(id);
          if (queue !== undefined && queue.length > 0) {
            throw new QueryTranscriptError(
              `two unanswered ${PROMQL_TOOL_NAME} calls share tool_use_id ${JSON.stringify(id)} ` +
                `(turns ${queue[0]?.turn} and ${assistantTurn}). Their results cannot be told ` +
                "apart, so the evidence this grader reports would be attributed to the wrong " +
                "query. Refusing to guess.",
            );
          }
          known.add(id);
          pending.set(id, [{ input: isRecord(block["input"]) ? block["input"] : {}, turn: assistantTurn }]);
        }
      } else if (block["type"] === "tool_result") {
        const id = block["tool_use_id"];
        if (typeof id !== "string") continue;
        const queue = pending.get(id);
        const issued = queue?.shift();
        if (issued === undefined) {
          if (known.has(id)) {
            throw new QueryTranscriptError(
              `a second tool_result arrived for ${PROMQL_TOOL_NAME} call ` +
                `${JSON.stringify(id)} with no outstanding call to match it. The transcript ` +
                "is malformed; refusing to attribute the result to an arbitrary call.",
            );
          }
          continue; // Not a promql call — another tool's result.
        }
        const result = blockText(block);
        const query = typeof issued.input["query"] === "string" ? issued.input["query"] : "";
        calls.push({
          turn: issued.turn,
          toolUseId: id,
          query,
          range: isRecord(issued.input["range"]),
          result,
          ok: declaredToolStatus(result) === "ok",
          empty: resultIsEmptyVector(result),
          verdict: verdictTokens(result)[0],
        });
      }
    }
  }
  return [...calls].sort((a, b) => a.turn - b.turn);
}

export function queryEvidenceFromMessages(messages: readonly unknown[]): QueryEvidence {
  return queryEvidenceFromCalls(promqlCallsFromMessages(messages));
}

/** The persisted shape written next to a run's report and committed as a fixture. */
export type QueryTranscript = {
  scenario?: string;
  calls: QueryCall[];
};

export function evidenceFromQueryTranscript(transcript: QueryTranscript): QueryEvidence {
  return queryEvidenceFromCalls(transcript.calls);
}
