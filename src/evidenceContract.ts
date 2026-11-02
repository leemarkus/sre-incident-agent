import { blocksOf } from "./attribution.js";
import { redactAuthorization } from "./sub/redact.js";
import { OBSERVATION_TOOLS, type ToolCall, type ToolEvidence } from "./toolCalls.js";

export type EvidenceStatus = "verified" | "unverifiable" | "unknown";
export type EvidenceClaim = {
  id: number;
  section: string;
  kind: "invocation" | "observation" | "unbound";
  status: EvidenceStatus;
  /** Visible, credential-header-scrubbed report text; never the entire result. */
  text: string;
  anchors: { call: number; turn: number; tool: string; toolUseId: string; ok: boolean }[];
  detail: string;
};

function invocationForms(call: ToolCall): string[] {
  const forms = [JSON.stringify({ name: call.tool, input: call.input })];
  const prefix = call.tool === "kubectl_read" ? "$ kubectl "
    : call.tool === "promql_query" ? "$ promql: " : undefined;
  if (prefix !== undefined) {
    const echo = call.result.split(/\r?\n/).find((line) => line.startsWith(prefix));
    if (echo !== undefined) forms.push(echo.trim(), echo.slice(2).trim());
  }
  return forms;
}

/** Structural reporting units, not inferred natural-language propositions.
 * Exact quoted bytes bind only to an explicitly identified call. No case folding,
 * whitespace folding, short-fragment tolerance, or prose vocabulary grants credit.
 * The frozen legacy matcher remains a separate contradiction check in grade.ts.
 */
export function classifyEvidence(body: string, section: string, tools: ToolEvidence): EvidenceClaim[] {
  const claims: EvidenceClaim[] = [];
  let candidates: number[] = [];
  const add = (text: string, kind: EvidenceClaim["kind"], anchors: number[], detail: string): void => {
    if (text.trim() === "") return;
    claims.push({
      id: claims.length + 1, section, kind,
      status: !tools.present ? "unknown" : anchors.length > 0 ? "verified" : "unverifiable",
      text: redactAuthorization(text),
      anchors: tools.present ? anchors.map((i) => {
        const call = tools.calls[i]!;
        return { call: i + 1, turn: call.turn, tool: call.tool, toolUseId: call.toolUseId, ok: call.ok };
      }) : [],
      detail: !tools.present ? "no tool transcript supplied; no verified credit" : detail,
    });
  };
  const sources = tools.present ? tools.calls.map((call) => ({
    forms: invocationForms(call), result: call.result.replace(/\r\n/g, "\n"),
  })) : [];
  for (const block of blocksOf(body)) {
    if (block.kind === "heading") { candidates = []; continue; }
    const raw = block.lines.join("\n").trim();
    if (!raw) continue;
    if (block.kind === "prose" || block.kind === "table") {
      add(raw, "unbound", [], "prose/table has no exact call/result binding; retained without verified credit");
      continue;
    }
    const literal = block.kind === "quoted"
      ? block.lines.map((line) => line.replace(/^[ \t]{0,3}> ?/, "").replace(/^(?: {4}|\t)/, "")).join("\n").trim()
      : raw;
    // An invocation can occupy the first line of an output fence or its own fence.
    const first = literal.split("\n")[0]!;
    const bound = sources.flatMap((source, i) => source.forms.includes(first) ? [i] : []);
    let output = literal;
    if (block.kind === "fence" && bound.length > 0) {
      candidates = bound;
      add(first, "invocation", bound, "literal invocation rendered by this run's call");
      output = literal.slice(first.length).trim();
    }
    if (!output) continue;
    const supported = candidates.filter((i) => sources[i]!.result.includes(output));
    add(output, "observation", supported,
      supported.length > 0 ? "exact quotation of the bound call's result (not verification of its interpretation)"
        : "no exact result quotation bound to a real call; retained without verified credit");
    // An unbound fence must not lend the previous invocation to the next quote.
    if (block.kind === "fence" && bound.length === 0 && supported.length === 0) candidates = [];
  }
  return claims;
}

/** Only successful observation tools earn cluster-evidence rubric credit. */
export function creditedEvidence(claims: readonly EvidenceClaim[]): string {
  return claims.filter((claim) => claim.status === "verified" &&
    claim.anchors.some((anchor) => anchor.ok && OBSERVATION_TOOLS.has(anchor.tool)))
    .map((claim) => claim.text).join("\n");
}
