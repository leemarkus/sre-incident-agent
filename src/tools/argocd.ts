import * as z from "zod/v4";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

import type { Config } from "../config.js";
import { egressFetch } from "../egress.js";
import { knownSecrets, scrubSecrets } from "../sub/redact.js";
import { declareFailed, declareOk } from "./status.js";

/**
 * ArgoCD application status (read-only).
 *
 * Only `GET /api/v1/applications[...]` is reachable from here — there is no
 * sync, refresh, rollback or delete path in this file, so "did a deploy cause
 * this?" is answerable while "make it stop" is not.
 *
 * Skipped gracefully when `ARGOCD_URL` (or the token) is unset: the tool is
 * simply not registered, and the system prompt tells the model that ArgoCD
 * evidence is unavailable so it reports the gap instead of inventing it.
 */

const TIMEOUT_MS = 20_000;

/**
 * the ArgoCD bearer token used to reach the model through
 * an echoed non-2xx body (`text.slice(0, 500)`) or a caught error. Every string
 * built from a response or an exception passes through here first.
 */
export function scrubArgocd(config: Config, text: string): string {
  return scrubSecrets(text, knownSecrets(config as unknown as Record<string, unknown>));
}
/**
 * Largest `argocd_status` result handed back to the model, in characters.
 * Exported for `src/contextWindow.ts`; see kubectl.ts for why.
 */
export const ARGOCD_MAX_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = ARGOCD_MAX_OUTPUT_CHARS;

export function argocdAvailable(config: Config): boolean {
  return Boolean(config.ARGOCD_URL && config.ARGOCD_TOKEN);
}

type ArgoApp = {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    project?: string;
    destination?: { namespace?: string };
    source?: { repoURL?: string; path?: string; targetRevision?: string };
  };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: {
      phase?: string;
      message?: string;
      finishedAt?: string;
      startedAt?: string;
    };
    conditions?: Array<{ type?: string; message?: string }>;
  };
};

function summarize(app: ArgoApp): string {
  const name = app.metadata?.name ?? "(unnamed)";
  const sync = app.status?.sync?.status ?? "Unknown";
  const health = app.status?.health?.status ?? "Unknown";
  const op = app.status?.operationState;
  const parts = [
    `- ${name}: sync=${sync} health=${health}`,
    `  destNamespace=${app.spec?.destination?.namespace ?? "?"} revision=${app.status?.sync?.revision?.slice(0, 12) ?? "?"}`,
  ];
  if (op?.phase) {
    parts.push(
      `  lastOperation=${op.phase} finishedAt=${op.finishedAt ?? "?"}${op.message ? ` msg=${op.message}` : ""}`,
    );
  }
  if (app.status?.health?.message) {
    parts.push(`  healthMessage=${app.status.health.message}`);
  }
  for (const condition of app.status?.conditions ?? []) {
    parts.push(`  condition=${condition.type ?? "?"}: ${condition.message ?? ""}`);
  }
  return parts.join("\n");
}

/**
 * Exported so the offline check suite can assert `AGENT_TOOL_INPUT_KEYS` against the
 * real schema: `src/attribution.ts` recognises a bare argument object by whether
 * its keys belong to exactly one tool's declared input surface, and a stale copy
 * of that surface would silently change which claims the grader can see.
 */
export const argocdInputSchema = z.object({
  application: z
    .string()
    .optional()
    .describe(
      "Application name. Omit to list every application with its sync and " +
        "health status — useful for spotting a recent deploy near the alert.",
    ),
});

export function argocdStatusTool(config: Config) {
  return betaZodTool({
    name: "argocd_status",
    description:
      "Read ArgoCD application sync/health status (read-only; there is no sync " +
      "or rollback verb here). Use it to answer 'did a deploy land near the " +
      "alert window?' and 'is desired state actually reconciled?'. Note that " +
      "ArgoCD's own view can be stale if its controller is not being scraped — " +
      "cross-check against kubectl rather than trusting it alone.",
    inputSchema: argocdInputSchema,
    run: async ({ application }) => {
      const base = config.ARGOCD_URL?.replace(/\/+$/, "");
      const token = config.ARGOCD_TOKEN;
      if (!base || !token) {
        return declareFailed(
          "ArgoCD is not configured (ARGOCD_URL / ARGOCD_TOKEN unset). Report ArgoCD evidence as unavailable; do not guess.",
        );
      }

      const path = application
        ? `/api/v1/applications/${encodeURIComponent(application)}`
        : "/api/v1/applications";

      try {
        // : local mode routes this through
        // `localFetch`, so the connection cannot leave the LAN.
        const response = await egressFetch(config)(`${base}${path}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await response.text();
        if (!response.ok) {
          return declareFailed(scrubArgocd(config, `ArgoCD returned ${response.status}: ${text.slice(0, 500)}`));
        }
        const body = JSON.parse(text) as ArgoApp | { items?: ArgoApp[] };
        const apps =
          "items" in body && Array.isArray(body.items)
            ? body.items
            : [body as ArgoApp];
        const out = apps.map(summarize).join("\n");
        return declareOk(
          out.length > MAX_OUTPUT_CHARS
            ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated — query one application by name]`
            : out || "(no applications returned)",
        );
      } catch (error) {
        return declareFailed(
          scrubArgocd(config, `ArgoCD query failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    },
  });
}
