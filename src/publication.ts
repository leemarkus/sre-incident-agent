
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { alertName, type WebhookPayload } from "./alert.js";
import { alertSafetyContext, recommendedMutations, type RecommendedMutation } from "./mutations.js";

export const EXIT_PUBLICATION_REJECTED = 7;
export type PublicationVerdict =
  | { publish: true }
  | { publish: false; forbidden: RecommendedMutation[]; reason: string };

// TODO: call this same gate before filing a Forgejo issue.
export function publicationVerdict(
  report: string,
  alertJson: string,
  dependencies = { alertSafetyContext, recommendedMutations },
): PublicationVerdict {
  try {
    let payload: unknown;
    try { payload = JSON.parse(alertJson); } catch { /* Unusable alert input. */ }
    const usablePayload = payload !== null && typeof payload === "object" && !Array.isArray(payload);
    const context = dependencies.alertSafetyContext(alertJson);
    const mutations = dependencies.recommendedMutations(report, context);
    if (!usablePayload && mutations.length > 0) {
      return { publish: false, forbidden: mutations, reason: "Publication rejected: alert payload unusable; mutations cannot be evaluated" };
    }
    const forbidden = mutations.filter((mutation) => mutation.forbidden !== undefined);
    return forbidden.length === 0 ? { publish: true } : {
      publish: false,
      forbidden,
      reason: `Publication rejected: forbidden recommended mutation(s): ${[...new Set(forbidden.map((m) => m.quote))].join(" | ")}`,
    };
  } catch {
    // Error details can themselves contain report text or credentials.
    return { publish: false, forbidden: [], reason: "Publication rejected: safety gate failed" };
  }
}

export const REJECTION_NOTIFICATION_CAP = 200;
// Keep these grammars in sync with tools/sub-poll-rejection.mjs.
const RUN_ID = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3])-[0-5]\d-[0-5]\d-\d{3}z$(?![\s\S])/;
const ALERT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$(?![\s\S])/;
export type RejectionSummary = { count: number; runId: string | null; alertName: string | null };

/** Only the harness timestamp survives; the alert slug/path never crosses this boundary. */
export function rejectionSummary(
  verdict: Extract<PublicationVerdict, { publish: false }>,
  runDir: string,
  name: string,
): RejectionSummary {
  const timestamp = path.basename(runDir).split("--", 1)[0] ?? "";
  return {
    count: verdict.forbidden.length,
    runId: RUN_ID.test(timestamp) ? timestamp : null,
    alertName: ALERT_NAME.test(name) ? name : null,
  };
}

/** Fixed wording, integer count and harness timestamp only; no detector strings. */
export function rejectionNotification(
  verdict: Extract<PublicationVerdict, { publish: false }>,
  runDir: string,
): string {
  const { count, runId } = rejectionSummary(verdict, runDir, "");
  return `Publication refused: ${count} forbidden recommended mutation(s). Evidence retained locally: ${runId ?? "see the local sub-poll log"}`;
}

/** A sidecar marks retained evidence; reportPath is NOT a successful output. */
export function writePublicationRejection(
  reportPath: string,
  payload: WebhookPayload,
  verdict: Extract<PublicationVerdict, { publish: false }>,
  now: Date,
): string {
  const context = alertSafetyContext(JSON.stringify(payload));
  const alertKey = payload.groupKey ?? [alertName(payload), context?.namespace ?? "", ...(context?.objects ?? [])].join("|");
  const rejectionPath = reportPath.replace(/\.md$/, "") + ".rejected.json";
  const record = JSON.stringify({ ...verdict, alertKey, at: now.toISOString(), reportPath }, null, 2) + "\n";
  const tempPath = `${rejectionPath}.${randomUUID()}.tmp`;
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, record, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Atomic visibility of a complete record, without replacing existing evidence.
    linkSync(tempPath, rejectionPath);
  } finally {
    unlinkSync(tempPath);
  }
  return rejectionPath;
}

/** API/local callers must not receive a successful TriageResult on rejection. */
export class PublicationRejectedError extends Error {
  readonly exitCode = EXIT_PUBLICATION_REJECTED;
  constructor(readonly reportPath: string, readonly rejectionPath: string, reason: string) {
    super(`${reason}\nEvidence retained at ${reportPath}; rejection record: ${rejectionPath}`);
    this.name = "PublicationRejectedError";
  }
}
