/**
 * Tool-result status declaration.
 *
 * ## What was wrong
 *
 * `src/transport.ts` gated a dry run on `FAILED_RESULT_RE`: a hand-maintained
 * list of text shapes meaning "this tool ran and did not work". That list was
 * written when `kubectl_read` and `promql_query` were the only tools. The later `docs_search` / `docs_read` tools report failure as an ordinary
 * result string (`DOCUMENTATION RETRIEVAL FAILED`) with no `is_error` — a shape
 * the list did not contain. A dry run could therefore lose the entire
 * documentation corpus and still advance to a scripted PASS.
 *
 * The specific miss was cheap to fix. The *mechanism* was the defect: the gate
 * defaulted to "usable" and only rejected what someone had remembered to
 * enumerate, so every tool added later reintroduces the hole for free.
 *
 * ## The inversion
 *
 * A tool result must now **declare success**. The last non-empty line of every
 * tool result is either
 *
 *     [[tool-status: ok]]
 *     [[tool-status: failed]]
 *
 * and anything else — including a result from a tool nobody taught this file
 * about — is `undeclared`, which the transport treats as unusable. Adding a
 * tool without declaring its status now fails loudly on the first dry run
 * instead of silently widening the gap.
 *
 * ## Why the *last* line, and why that is not spoofable
 *
 * Retrieved documents reach the model inside a tool result, and a document can
 * contain any text at all — including these markers. Position is what makes the
 * declaration trustworthy: the marker is appended after everything else, so
 * document content is structurally never last. A document containing
 * `[[tool-status: failed]]` in its body is just a line in the body.
 */

export const TOOL_STATUS_OK = "[[tool-status: ok]]";
export const TOOL_STATUS_FAILED = "[[tool-status: failed]]";

export type ToolStatus = "ok" | "failed" | "undeclared";

/** Append the success declaration. Use on every path where the tool did its job. */
export function declareOk(text: string): string {
  return `${text.replace(/\s+$/, "")}\n\n${TOOL_STATUS_OK}`;
}

/**
 * Append the failure declaration. Use on every path where the tool did not do
 * its job — including the ones that return a readable explanation to the model
 * rather than throwing.
 */
export function declareFailed(text: string): string {
  return `${text.replace(/\s+$/, "")}\n\n${TOOL_STATUS_FAILED}`;
}

export function declare(text: string, ok: boolean): string {
  return ok ? declareOk(text) : declareFailed(text);
}

/**
 * Read a tool result's declaration. Only the last non-empty line counts, and it
 * must be the marker exactly — no prefix, no suffix, no surrounding prose.
 */
export function declaredToolStatus(text: string): ToolStatus {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (line === TOOL_STATUS_OK) return "ok";
    if (line === TOOL_STATUS_FAILED) return "failed";
    return "undeclared";
  }
  return "undeclared";
}

/** Strip the declaration, for callers that want the payload alone. */
export function withoutStatus(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (line === TOOL_STATUS_OK || line === TOOL_STATUS_FAILED) {
      return lines.slice(0, i).join("\n").replace(/\s+$/, "");
    }
    break;
  }
  return text;
}
