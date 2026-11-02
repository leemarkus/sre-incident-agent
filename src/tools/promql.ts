import * as z from "zod/v4";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

import type { Config } from "../config.js";
import { egressFetch } from "../egress.js";
import { EMPTY_RESULT_LINE } from "../queries.js";
import { knownSecrets, scrubSecrets } from "../sub/redact.js";
import { declareFailed, declareOk } from "./status.js";

/**
 * PromQL over the Grafana datasource proxy.
 *
 * The single most dangerous wrong answer this agent can give is calling a total
 * monitoring outage a quiet cluster. On 2026-07-30 the Grafana MCP returned an
 * empty result for `up` and volunteered the hints "the metric may not exist"
 * and "the scrape target may be down", while the truth was that Prometheus had
 * not written a sample in ~13 h (WAL `input/output error`). An agent that took
 * those hints at face value would have converted a sev-1 into an all-clear.
 *
 * So liveness is **not** left to the model's judgement, and **not** left to a
 * prompt instruction it might skip. Every single result this tool returns —
 * empty or not — is prefixed with a measured ingestion-freshness verdict:
 *
 *  - `time() - max(timestamp(up))` gives seconds since the freshest `up` sample.
 *  - If even that is empty, ingestion has been dead longer than the lookback
 *    window, so we widen to a 24 h range query on `count(up)` and report the
 *    **ingestion gap** rather than "no data".
 *  - If the range query is empty too, the verdict is INGESTION APPEARS DEAD.
 *
 * Metadata endpoints (health, label values, metric names) kept answering
 * happily throughout that outage, so they are explicitly **not** used as a
 * liveness proxy here. Only written samples count.
 */

const FRESH_SECONDS = 300;
const PROBE_CACHE_MS = 60_000;
/**
 * Largest `promql_query` result handed back to the model, in characters.
 * Exported for `src/contextWindow.ts`; see kubectl.ts for why.
 */
export const PROMQL_MAX_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = PROMQL_MAX_OUTPUT_CHARS;
const TIMEOUT_MS = 30_000;

export type Liveness = {
  verdict: "live" | "stale" | "dead" | "unknown";
  banner: string;
};

export type PromResponse = {
  status?: string;
  error?: string;
  errorType?: string;
  data?: {
    resultType?: string;
    result?: Array<{
      metric?: Record<string, string>;
      value?: [number, string];
      values?: Array<[number, string]>;
    }>;
  };
};

class PromqlError extends Error {}

/**
 * Grafana's bearer token goes out in every request, and a
 * misconfigured or compromised endpoint can echo it back in a diagnostic body.
 * That body used to be interpolated verbatim into the thrown error, which the
 * model reads and the call log stores. Every string this module builds from a
 * response body or a caught error goes through here first — the same discipline
 * `src/docs/forgejo.ts` applies to the Forgejo token.
 */
export function scrubGrafana(config: Config, text: string): string {
  return scrubSecrets(text, knownSecrets(config as unknown as Record<string, unknown>));
}

function requireGrafana(config: Config): { url: string; token: string } {
  const url = config.GRAFANA_URL;
  const token = config.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  if (!url || !token) {
    throw new PromqlError(
      "GRAFANA_URL and GRAFANA_SERVICE_ACCOUNT_TOKEN must both be set; " +
        "PromQL is unavailable without them.",
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

async function grafanaFetch(
  config: Config,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const { url, token } = requireGrafana(config);
  const target = new URL(`${url}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    target.searchParams.set(key, value);
  }
  // : under local mode this is
  // `localFetch`, which cannot land a connection off-LAN. The query string in
  // `params` is model-chosen, and the model may have read attacker-controlled
  // text from the public gitops repo via `docs_search` — so this is an egress
  // path carrying investigation content, exactly like the model endpoint.
  const response = await egressFetch(config)(target, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new PromqlError(
      scrubGrafana(config, `Grafana returned ${response.status} for ${path}: ${body.slice(0, 500)}`),
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PromqlError(`Grafana returned non-JSON for ${path}.`);
  }
}

/**
 * Grafana's datasource-UID grammar. Enforced three times over, because the UID
 * is the only user/server-controlled segment of the proxy path:
 *
 *  1. at config load (`src/config.ts`) — a bad pinned UID refuses to start;
 *  2. here, on whatever `/api/datasources` hands back, since a server response
 *     is still untrusted input;
 *  3. `encodeURIComponent` at the call site, plus a post-construction assertion
 *     that the URL's pathname still begins with the proxy prefix.
 */
const DATASOURCE_UID_RE = /^[a-zA-Z0-9_-]+$/;

export function assertDatasourceUid(uid: string): string {
  if (!DATASOURCE_UID_RE.test(uid)) {
    throw new PromqlError(
      `Refusing datasource UID "${uid}": it must match ${DATASOURCE_UID_RE.source}. ` +
        "A UID containing path characters can escape the datasource proxy.",
    );
  }
  return uid;
}

let datasourceUid: string | undefined;

async function resolveDatasourceUid(config: Config): Promise<string> {
  if (config.GRAFANA_PROM_DATASOURCE_UID) {
    return assertDatasourceUid(config.GRAFANA_PROM_DATASOURCE_UID);
  }
  if (datasourceUid !== undefined) return datasourceUid;

  const listed = await grafanaFetch(config, "/api/datasources");
  if (!Array.isArray(listed)) {
    throw new PromqlError("Grafana /api/datasources did not return a list.");
  }
  const candidates = listed.filter(
    (ds): ds is { uid: string; isDefault?: boolean } =>
      typeof ds === "object" &&
      ds !== null &&
      (ds as { type?: unknown }).type === "prometheus" &&
      typeof (ds as { uid?: unknown }).uid === "string",
  );
  const chosen = candidates.find((ds) => ds.isDefault === true) ?? candidates[0];
  if (!chosen) {
    throw new PromqlError(
      "No Prometheus datasource found in Grafana. Pin one with " +
        "GRAFANA_PROM_DATASOURCE_UID.",
    );
  }
  datasourceUid = assertDatasourceUid(chosen.uid);
  return datasourceUid;
}

/**
 * Build the proxy path for a datasource UID, and prove it stayed inside the
 * proxy. Exported so the offline check suite can assert the traversal case
 * without a live Grafana.
 */
export function datasourceProxyPath(uid: string, endpoint: "query" | "query_range"): string {
  const prefix = `/api/datasources/proxy/uid/${encodeURIComponent(assertDatasourceUid(uid))}/`;
  const path = `${prefix}api/v1/${endpoint}`;
  // Belt and braces: resolve against a dummy origin and confirm the pathname
  // did not escape the prefix (traversal, encoded traversal, or a stray `?`).
  const resolved = new URL(path, "https://grafana.invalid");
  if (!resolved.pathname.startsWith(prefix) || resolved.search !== "") {
    throw new PromqlError(
      `Refusing constructed datasource-proxy URL "${resolved.pathname}${resolved.search}": ` +
        `it does not stay under "${prefix}".`,
    );
  }
  return path;
}

async function promQuery(
  config: Config,
  params: Record<string, string>,
  range: boolean,
): Promise<PromResponse> {
  const uid = await resolveDatasourceUid(config);
  const path = datasourceProxyPath(uid, range ? "query_range" : "query");
  const body = (await grafanaFetch(config, path, params)) as PromResponse;
  if (body.status === "error") {
    throw new PromqlError(
      `Prometheus rejected the query (${body.errorType ?? "error"}): ${body.error ?? "no detail"}`,
    );
  }
  return body;
}

/**
 * One instant query, returned as the parsed Prometheus response rather than the
 * model-facing text. Exported for the subscription-mode poller
 * (`src/sub/poll.ts`), which reads `ALERTS` to decide what to triage and must
 * not have to scrape numbers back out of the rendered tool result. Same egress
 * path, same datasource-UID belt, same PromqlError on a rejected query as the
 * tool itself — there is no second Prometheus access path.
 */
export async function promInstantQuery(config: Config, query: string): Promise<PromResponse> {
  return promQuery(config, { query }, false);
}

function resultCount(body: PromResponse): number {
  return body.data?.result?.length ?? 0;
}

let cachedLiveness: { at: number; value: Liveness } | undefined;

/**
 * Measure ingestion freshness. Exported so the report writer can state the
 * observability posture even when no query was run.
 */
export async function probeIngestionLiveness(config: Config): Promise<Liveness> {
  const now = Date.now();
  if (cachedLiveness && now - cachedLiveness.at < PROBE_CACHE_MS) {
    return cachedLiveness.value;
  }

  let value: Liveness;
  try {
    const instant = await promQuery(
      config,
      { query: "time() - max(timestamp(up))" },
      false,
    );
    const raw = instant.data?.result?.[0]?.value?.[1];
    const staleness = raw === undefined ? undefined : Number(raw);

    if (staleness !== undefined && Number.isFinite(staleness)) {
      value =
        staleness <= FRESH_SECONDS
          ? {
              verdict: "live",
              banner:
                `INGESTION LIVE — freshest \`up\` sample is ${Math.round(staleness)}s old. ` +
                "An empty result below therefore means the series genuinely does not " +
                "exist or matches nothing right now.",
            }
          : {
              verdict: "stale",
              banner:
                `INGESTION STALE — the freshest \`up\` sample is ${Math.round(staleness)}s old ` +
                `(threshold ${FRESH_SECONDS}s). Prometheus is behind. Treat every result ` +
                "below, empty or not, as describing the past, not the present.",
            };
    } else {
      // `up` itself is empty: ingestion stopped longer ago than the lookback
      // window. Widen the range and report the gap instead of "no data".
      const end = Math.floor(now / 1000);
      const start = end - 24 * 60 * 60;
      const range = await promQuery(
        config,
        {
          query: "count(up)",
          start: String(start),
          end: String(end),
          step: "300",
        },
        true,
      );
      const samples = range.data?.result?.[0]?.values ?? [];
      const last = samples[samples.length - 1];
      if (last) {
        const gap = Math.round(end - last[0]);
        value = {
          verdict: "dead",
          banner:
            `INGESTION GAP — Prometheus has written no \`up\` sample for ${gap}s ` +
            `(~${(gap / 3600).toFixed(1)} h). The last sample in the past 24 h was at ` +
            `${new Date(last[0] * 1000).toISOString()}. This is an INGESTION FAILURE, ` +
            "not a quiet cluster: every empty result below is meaningless, and the " +
            "observability stack itself is a candidate root cause.",
        };
      } else {
        value = {
          verdict: "dead",
          banner:
            "INGESTION APPEARS DEAD — no `up` samples exist anywhere in the past 24 h. " +
            "Prometheus is not ingesting. Do not conclude anything from empty results " +
            "below; report degraded observability as a finding in its own right.",
        };
      }
    }
  } catch (error) {
    value = {
      verdict: "unknown",
      banner:
        "INGESTION LIVENESS UNKNOWN — the freshness probe itself failed " +
        `(${scrubGrafana(config, error instanceof Error ? error.message : String(error))}). ` +
        "Do not treat any empty result below as evidence of health.",
    };
  }

  cachedLiveness = { at: now, value };
  return value;
}

function formatResult(body: PromResponse): string {
  const results = body.data?.result ?? [];

  if (results.length === 0) return EMPTY_RESULT_LINE;

  const lines = results.slice(0, 50).map((series) => {
    const labels = JSON.stringify(series.metric ?? {});
    if (series.value) return `${labels} => ${series.value[1]} @ ${series.value[0]}`;
    const values = series.values ?? [];
    const head = values.slice(0, 3);
    const tail = values.slice(-3);
    const shown = values.length <= 6 ? values : [...head, ["…", "…"], ...tail];
    return `${labels} => ${shown.map((v) => `${v[0]}:${v[1]}`).join(" ")}`;
  });
  if (results.length > 50) lines.push(`… ${results.length - 50} more series omitted`);
  const text = lines.join("\n");
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated — aggregate the query]`
    : text;
}

/**
 * Exported so the offline check suite can assert `AGENT_TOOL_INPUT_KEYS` against the
 * real schema: `src/attribution.ts` recognises a bare argument object by whether
 * its keys belong to exactly one tool's declared input surface, and a stale copy
 * of that surface would silently change which claims the grader can see.
 */
export const promqlInputSchema = z.object({
  query: z.string().describe("The PromQL expression to evaluate."),
  range: z
    .object({
      lookback_seconds: z
        .number()
        .int()
        .positive()
        .describe("How far back from now to evaluate, in seconds."),
      step_seconds: z
        .number()
        .int()
        .positive()
        .describe("Resolution of the range query, in seconds."),
    })
    .optional()
    .describe(
      "Omit for an instant query. Supply for a range query — the right tool " +
        "when an instant query came back empty and you need to find out when " +
        "the data stopped.",
    ),
});

export function promqlQueryTool(config: Config) {
  return betaZodTool({
    name: "promql_query",
    description:
      "Evaluate a PromQL expression against the cluster's Prometheus, via the " +
      "Grafana datasource proxy (read-only). EVERY result is prefixed with a " +
      "measured ingestion-freshness verdict — read it before interpreting the " +
      "result. An empty result is NOT evidence that a system is healthy: it is " +
      "only meaningful when the verdict says INGESTION LIVE. If the verdict " +
      "reports a gap or a dead TSDB, the observability stack itself is a " +
      "candidate root cause and must be reported as such.",
    inputSchema: promqlInputSchema,
    run: async ({ query, range }) => {
      const liveness = await probeIngestionLiveness(config);
      try {
        const body = range
          ? await promQuery(
              config,
              {
                query,
                end: String(Math.floor(Date.now() / 1000)),
                start: String(
                  Math.floor(Date.now() / 1000) - range.lookback_seconds,
                ),
                step: String(range.step_seconds),
              },
              true,
            )
          : await promQuery(config, { query }, false);

        const emptyNote =
          resultCount(body) === 0 && liveness.verdict !== "live"
            ? "\n\nNOTE: this result is empty AND ingestion is not verified live. " +
              "Do not read it as 'healthy' or 'metric does not exist'."
            : "";

        return declareOk(
          `[${liveness.banner}]\n\n$ promql: ${query}${range ? ` (range ${range.lookback_seconds}s / step ${range.step_seconds}s)` : " (instant)"}\n\n${formatResult(body)}${emptyNote}`,
        );
      } catch (error) {
        // A failed query read nothing. It declares failure — the liveness banner is still printed, because the
        // verdict was measured before the query and remains true.
        // Final known-secret boundary: whatever the message was built from
        // (response body, fetch cause chain), it leaves this tool scrubbed.
        const detail = scrubGrafana(config, error instanceof Error ? error.message : String(error));
        return declareFailed(`[${liveness.banner}]\n\nQuery failed: ${detail}`);
      }
    },
  });
}

export function promqlAvailable(config: Config): boolean {
  return Boolean(config.GRAFANA_URL && config.GRAFANA_SERVICE_ACCOUNT_TOKEN);
}
