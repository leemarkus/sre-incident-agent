/**
 * The call log — how a subscription-mode run stays gradeable.
 *
 * In API mode the SDK's tool loop leaves every `tool_use`/`tool_result` pair in
 * the transcript, and `src/toolCalls.ts` lifts them into the tool/query/
 * retrieval transcripts the grader arms attribution with. In subscription mode
 * the loop runs inside Claude Code, which reports only its own cost summary — so
 * the MCP server writes every call it serves to a JSONL file as it happens,
 * and the runner converts that file into the same three artefacts
 * (`<report>.tools.json`, `.queries.json`, `.retrieval.json`) with the same
 * schemas `scripts/grade.ts` already loads. Nothing in the grader changes.
 *
 * `toolUseId`s are `sub_<n>` because MCP carries no tool-use id; `turn` is the
 * call's 1-based position in the run (harness sweep calls first), because the
 * harness cannot see Claude Code's assistant turns. Both facts are written into
 * the transcript's `turnSemantics` field rather than left to be inferred.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { declaredToolStatus } from "../tools/status.js";
import { OBSERVATION_TOOLS, RETRIEVAL_TOOLS, type ToolCall } from "../toolCalls.js";

export type CallOrigin = "harness" | "model";

export type LoggedCall = ToolCall & {
  at: string;
  origin: CallOrigin;

  step?: string;
};

export const TURN_SEMANTICS =
  "subscription mode: `turn` is the call's 1-based position in the run (harness sweep calls " +
  "first), not a Messages-API assistant turn; `toolUseId` is harness-assigned (`sub_<n>` for " +
  "model calls, the evidence-sweep id for harness calls) because MCP carries no tool_use id.";

export function appendCall(file: string, call: LoggedCall): void {
  appendFileSync(file, `${JSON.stringify(call)}\n`, "utf8");
}

export function readCalls(file: string): LoggedCall[] {
  if (!existsSync(file)) return [];
  const calls: LoggedCall[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    calls.push(JSON.parse(line) as LoggedCall);
  }
  return calls;
}

/** `ok` exactly as the API-mode transcript would record it: the tool's own declaration. */
export function callOk(result: string): boolean {
  return declaredToolStatus(result) === "ok";
}

export function toToolTranscript(calls: readonly LoggedCall[], scenario?: string) {
  return {
    ...(scenario === undefined ? {} : { scenario }),
    turnSemantics: TURN_SEMANTICS,
    calls: calls.map((c) => ({
      turn: c.turn,
      tool: c.tool,
      toolUseId: c.toolUseId,
      input: c.input,
      result: c.result,
      ok: c.ok,
    })),
  };
}

export function toQueryTranscript(calls: readonly LoggedCall[], scenario?: string) {
  return {
    ...(scenario === undefined ? {} : { scenario }),
    turnSemantics: TURN_SEMANTICS,
    calls: calls
      .filter((c) => c.tool === "promql_query")
      .map((c) => ({
        turn: c.turn,
        toolUseId: c.toolUseId,
        query: typeof c.input["query"] === "string" ? (c.input["query"] as string) : "",
        range: c.input["range"] !== undefined && c.input["range"] !== null,
        result: c.result,
      })),
  };
}

export function toRetrievalTranscript(calls: readonly LoggedCall[], scenario?: string) {
  return {
    ...(scenario === undefined ? {} : { scenario }),
    turnSemantics: TURN_SEMANTICS,
    calls: calls
      .filter((c) => RETRIEVAL_TOOLS.has(c.tool))
      .map((c) => ({
        turn: c.turn,
        tool: c.tool,
        toolUseId: c.toolUseId,
        input: c.input,
        result: c.result,
      })),
  };
}

export type CallSummary = {
  total: number;
  harness: number;
  model: number;
  ok: number;
  observation: number;
  retrieval: number;
};

export function summarizeCalls(calls: readonly LoggedCall[]): CallSummary {
  return {
    total: calls.length,
    harness: calls.filter((c) => c.origin === "harness").length,
    model: calls.filter((c) => c.origin === "model").length,
    ok: calls.filter((c) => c.ok).length,
    observation: calls.filter((c) => OBSERVATION_TOOLS.has(c.tool)).length,
    retrieval: calls.filter((c) => RETRIEVAL_TOOLS.has(c.tool)).length,
  };
}
