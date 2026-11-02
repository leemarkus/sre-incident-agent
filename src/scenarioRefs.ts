import type { Config } from "./config.js";
import type { Scenario } from "./scenario.js";
import type { RecordedScript } from "./transport.js";
import { kubectlReadTool } from "./tools/kubectl.js";
import { declaredToolStatus } from "./tools/status.js";

/**
 * Dynamic references in a recorded scenario script.
 *
 * ## The problem this exists for
 *
 * A recorded turn names the objects it read: `kubectl logs <pod> -n monitoring`.
 * That is the whole point of the recorded transport — the tool calls are real,
 * they run against the real cluster, and the run proves the loop works end to
 * end. But a pod name is not a stable identifier. `watchdog-heartbeat-backoff`
 * reads the log of a pod created by a two-minute CronJob that keeps one or
 * two completed Jobs in history: **every** hard-coded pod name in that scenario
 * is stale within four minutes of being recorded. `prometheus-wal-eio` has the
 * milder version of the same problem — a StatefulSet pod that survives until it
 * is rescheduled.
 *
 * ## What this does instead
 *
 * The scenario declares, in `scenario.json`, that a name is to be resolved
 * against the cluster at replay time:
 *
 * ```json
 * "dynamicRefs": [
 *   { "id": "watchdog-pod", "kind": "newest-pod",
 *     "namespace": "monitoring",
 *     "selector": "app.kubernetes.io/name=watchdog-heartbeat",
 *     "why": "..." }
 * ]
 * ```
 *
 * and `replay.json` writes `{{ref:watchdog-pod}}` where the name would go. The
 * token is substituted before the recorded transport is built.
 *
 * ## Three constraints this deliberately keeps
 *
 *  1. **Read-only, through the agent's own tool.** Resolution runs
 *     `kubectlReadTool` — the same allowlisted, namespaced-only, no-raw-flags
 *     boundary the agent is held to. There is no second kubectl path in this
 *     repo and this does not add one.
 *  2. **It resolves names, not evidence.** A dynamic ref may only produce an
 *     object *name*. Nothing here can change what a tool returns, what the
 *     recorded report says, or what the grader checks — so it cannot make a
 *     failing scenario pass by softening anything.
 *  3. **An unresolved token is a hard failure.** Never a fallback, never the
 *     literal token passed through to kubectl. A scenario that cannot be
 *     grounded in current cluster state must stop and say so, because the
 *     alternative is a replay quietly reading the wrong object.
 */

const REF_TOKEN = /\{\{ref:([a-z][a-z0-9-]*)\}\}/g;

export class DynamicRefError extends Error {}

/** Every `{{ref:…}}` id appearing anywhere in a recorded script. */
export function refsUsedBy(script: RecordedScript): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(REF_TOKEN)) {
        if (match[1] !== undefined) found.add(match[1]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(script.turns);
  return [...found];
}

/**
 * Resolve every declared ref against the live cluster.
 *
 * `kind: "newest-pod"` picks the pod matching `selector` with the latest
 * `metadata.creationTimestamp`. Newest rather than oldest because the recorded
 * read is always "what did the most recent run of this workload say"; oldest
 * would drift toward whichever pod is about to be garbage-collected.
 *
 * `kind: "newest-failed-pod"` applies the same rule over failed pods
 * only. A failure scenario reads the run that failed, and "newest" coincides
 * with that only while the workload is still broken.
 */
export async function resolveDynamicRefs(
  scenario: Scenario,
  config: Config,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (scenario.dynamicRefs.length === 0) return resolved;

  const tool = kubectlReadTool(config);
  for (const ref of scenario.dynamicRefs) {
    const result = await tool.run(
      {
        subcommand: "get",
        namespace: ref.namespace,
        resource: "pods",
        selector: ref.selector,
        output: "json",
      },
      // The SDK's tool signature takes a second argument it does not use here.
      undefined as never,
    );
    const text = typeof result === "string" ? result : JSON.stringify(result);
    if (declaredToolStatus(text) !== "ok") {
      throw new DynamicRefError(
        `dynamicRefs[${ref.id}]: the cluster read failed, so the scenario cannot be ` +
          `grounded in current state.\n${text.slice(0, 800)}`,
      );
    }
    const failedOnly = ref.kind === "newest-failed-pod";
    const name = newestPodName(text, failedOnly);
    if (name === undefined) {
      throw new DynamicRefError(
        `dynamicRefs[${ref.id}]: no ${failedOnly ? "FAILED " : ""}pod in namespace ` +
          `${ref.namespace} matches selector ${ref.selector}. The scenario reads that ` +
          "workload's output, and there is nothing to read right now. This is a fact about " +
          "the cluster, not a harness defect — but the replay stops rather than reading some " +
          "other object." +
          (failedOnly
            ? " For a failure scenario this most often means the workload has recovered and " +
              "its failed pods have been garbage-collected; the scenario is then no longer " +
              "groundable live and belongs on preserved evidence."
            : ""),
      );
    }
    resolved.set(ref.id, name);
  }
  return resolved;
}

/**
 * Can this pod's log plausibly be read right now?
 *
 * A pod with no `status` at all is treated as ineligible rather than assumed
 * fine: this parses the cluster's own answer, and an answer that omits status
 * is not one to draw conclusions from.
 */
export function podIsReadable(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const metadata = (item as { metadata?: unknown }).metadata;
  if (typeof metadata === "object" && metadata !== null) {
    if (typeof (metadata as { deletionTimestamp?: unknown }).deletionTimestamp === "string") {
      return false;
    }
  }
  const status = (item as { status?: unknown }).status;
  if (typeof status !== "object" || status === null) return false;
  const phase = (status as { phase?: unknown }).phase;

  if (phase !== "Running" && phase !== "Succeeded" && phase !== "Failed") return false;
  const containers = (status as { containerStatuses?: unknown }).containerStatuses;
  if (!Array.isArray(containers) || containers.length === 0) return false;
  return containers.some((c) => {
    if (typeof c !== "object" || c === null) return false;
    const state = (c as { state?: unknown }).state;
    if (typeof state !== "object" || state === null) return false;
    return "running" in state || "terminated" in state;
  });
}

/**
 * Did this pod fail?
 *
 * `Completed` with exit code 0 is not a failure and never matches. A pod whose
 * status cannot be read returns false rather than being assumed either way —
 * the same rule `podIsReadable` follows, for the same reason.
 */
export function podFailed(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const status = (item as { status?: unknown }).status;
  if (typeof status !== "object" || status === null) return false;
  if ((status as { phase?: unknown }).phase === "Failed") return true;
  const containers = (status as { containerStatuses?: unknown }).containerStatuses;
  if (!Array.isArray(containers)) return false;
  return containers.some((c) => {
    if (typeof c !== "object" || c === null) return false;
    const state = (c as { state?: unknown }).state;
    if (typeof state !== "object" || state === null) return false;
    const terminated = (state as { terminated?: unknown }).terminated;
    if (typeof terminated !== "object" || terminated === null) return false;
    const code = (terminated as { exitCode?: unknown }).exitCode;
    return typeof code === "number" && code !== 0;
  });
}

/**
 * Pull the newest *readable* pod name out of a `kubectl get pods -o json`
 * payload.
 *
 * Tolerant of the tool's framing (`$ kubectl …` banner, status marker) because
 * it is parsing the tool's own declared output rather than raw kubectl.
 *
 * With `failedOnly` the search is narrowed to pods that failed. It
 * narrows the candidates and nothing else: the readability rule, the recency
 * rule and the deterministic tie-break are identical, and an empty result is
 * still `undefined` — which the caller turns into a hard stop, never a fallback
 * to some other pod.
 */
export function newestPodName(toolText: string, failedOnly = false): string | undefined {
  const start = toolText.indexOf("{");
  if (start === -1) return undefined;
  const end = toolText.lastIndexOf("}");
  if (end <= start) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(toolText.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;

  let best: { name: string; created: number } | undefined;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const metadata = (item as { metadata?: unknown }).metadata;
    if (typeof metadata !== "object" || metadata === null) continue;
    const name = (metadata as { name?: unknown }).name;
    const created = (metadata as { creationTimestamp?: unknown }).creationTimestamp;
    if (typeof name !== "string" || name === "") continue;
    // The old rule was "newest match wins", full stop. For the CronJob this
    // exists to serve that is actively wrong: the newest pod is very often the
    // one that started ten seconds ago and has not written its log line yet, or
    // is `Pending` on an image pull, or is already `Terminating`. Resolving to
    // it produces a read that *succeeds* and returns nothing — and a tool call
    // that succeeds is exactly what the replay gate used to accept. So the
    // scenario would stay green over evidence that no longer supports its
    // conclusion, which is the failure mode dynamic refs were introduced to
    // avoid rather than to relocate.
    if (!podIsReadable(item)) continue;
    if (failedOnly && !podFailed(item)) continue;
    const at = typeof created === "string" ? Date.parse(created) : Number.NaN;
    const rank = Number.isNaN(at) ? 0 : at;
    // Ties are broken by name so the choice is deterministic: a CronJob's
    // job-index suffix increases monotonically, and two pods created in the
    // same second must not resolve differently between runs.
    if (best === undefined || rank > best.created || (rank === best.created && name > best.name)) {
      best = { name, created: rank };
    }
  }
  return best?.name;
}

/**
 * Every `tool_result` body in a conversation, as text.
 *
 * Reads `triage.messages` — the same source the graders lift from — rather than the transport's exchanges, which are a recorded-only
 * artefact and miss the final turn.
 */
export function toolResultTexts(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  /** A `tool_result.content` is a string, or an array of typed parts. */
  const textOf = (content: unknown): void => {
    if (typeof content === "string") {
      out.push(content);
      return;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") {
          out.push(part);
          continue;
        }
        if (typeof part !== "object" || part === null) continue;
        const text = (part as Record<string, unknown>)["text"];
        if (typeof text === "string") out.push(text);
      }
      return;
    }
    if (typeof content === "object" && content !== null) {
      const text = (content as Record<string, unknown>)["text"];
      if (typeof text === "string") out.push(text);
    }
  };
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record["type"] !== "tool_result") continue;
      textOf(record["content"]);
    }
  }
  return out;
}

/**
 * Assert that each declared dynamic ref actually delivered the evidence it
 * exists to deliver.
 *
 * The replay gate checked that the tool calls *succeeded*. A `kubectl logs`
 * against a pod that started eight seconds ago succeeds and returns an empty
 * body, so a resolved-but-useless name passed the gate and the scenario stayed
 * green over evidence that was no longer there. `podIsReadable` narrows which
 * pods can be chosen; this checks the thing that actually matters, which is
 * whether the words the scenario is built on came back.
 *
 * Recorded path only, and that is not a loophole: on a live or local run the
 * model picks its own arguments and the script is never consulted, so there is
 * no ref to have resolved and nothing here to assert.
 */
export function assertDynamicRefEvidence(
  scenario: Scenario,
  messages: readonly unknown[],
): void {
  if (scenario.dynamicRefs.length === 0) return;
  const texts = toolResultTexts(messages);
  const haystack = texts.join("\n");
  for (const ref of scenario.dynamicRefs) {
    const re = new RegExp(ref.evidence.pattern, ref.evidence.flags);
    if (re.test(haystack)) continue;
    throw new DynamicRefError(
      `dynamicRefs[${ref.id}]: the read succeeded but the evidence it exists for is not in ` +
        `the result. Expected /${ref.evidence.pattern}/${ref.evidence.flags} somewhere in the ` +
        `run's tool output — ${ref.evidence.why}\n\n` +
        "A tool call that returns nothing is still a tool call that returned, so the " +
        "success gate cannot see this. The replay stops rather than grading a report against " +
        "evidence the run did not actually obtain. Either the workload is no longer producing " +
        "this output (a fact about the cluster, and the scenario needs revisiting) or the " +
        `resolved object was the wrong one. ${texts.length} tool result(s) inspected.`,
    );
  }
}

/**
 * The one *position* a `{{ref:…}}` token may appear in.
 *
 *  (low): anchored to the FULL path from the script root, not a
 * `.input.name` suffix. The suffix form still matched any nested object that
 * happened to contain its own `input.name` pair (e.g.
 * `…input.template.input.name`), which is the same shape of hole one level
 * down. The only substitutable position is the direct
 * `turns[n].tool_uses[n].input.name`.
 */
const SUBSTITUTABLE_PATH = /^turns\[\d+\]\.tool_uses\[\d+\]\.input\.name$/;

/**
 * Substitute `{{ref:…}}` tokens in a recorded script — under the restriction,
 * enforced here.
 *
 *  1. A token is honoured **only** as the entire value of a `name` field.
 *  2. A token anywhere else — a different key, or embedded in surrounding text
 *     — is a hard error naming the key and the value. Not ignored, not passed
 *     through: a fixture that tries it is a fixture someone must look at.
 *  3. An undeclared id is a hard error, as before.
 */
export function substituteRefs(
  script: RecordedScript,
  resolved: ReadonlyMap<string, string>,
): RecordedScript {
  const resolveId = (id: string, where: string): string => {
    const name = resolved.get(id);
    if (name === undefined) {
      throw new DynamicRefError(
        `${where} uses {{ref:${id}}}, which no dynamicRefs entry declares. Refusing to send ` +
          "an unresolved token to the cluster.",
      );
    }
    return name;
  };

  const containsToken = (value: string): boolean => {
    REF_TOKEN.lastIndex = 0;
    return REF_TOKEN.test(value);
  };

  /** `where` is the dotted path this string was found at, e.g. `turns[0].tool_uses[0].input.name`. */
  const walk = (value: unknown, where: string): unknown => {
    if (typeof value === "string") {
      if (!containsToken(value)) return value;
      const whole = /^\{\{ref:([a-z][a-z0-9-]*)\}\}$/.exec(value);
      const inPosition = SUBSTITUTABLE_PATH.test(where);
      if (inPosition && whole?.[1] !== undefined) {
        return resolveId(whole[1], where);
      }
      throw new DynamicRefError(
        `refusing to substitute a dynamic ref at ${where}: a {{ref:…}} token may appear ONLY ` +
          "as the entire value of a tool call's `input.name`, and this one is " +
          `${inPosition ? "embedded in surrounding text" : "somewhere else"}. Dynamic refs ` +
          "resolve object NAMES against the live cluster; allowing one into a query, a " +
          "namespace, a selector, a TOOL name or report text would let a cluster read change " +
          "what the scenario asks, which tool it asks, or what it concludes — exactly the " +
          "softening the mechanism promises it cannot do. Value: " +
          `${JSON.stringify(value.slice(0, 200))}`,
      );
    }
    if (Array.isArray(value)) return value.map((item, i) => walk(item, `${where}[${i}]`));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v, `${where}.${k}`),
        ]),
      );
    }
    return value;
  };

  return {
    ...script,
    turns: walk(script.turns, "turns") as RecordedScript["turns"],
  };
}
