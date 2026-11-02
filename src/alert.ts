import * as z from "zod/v4";

/**
 * AlertManager webhook envelope, version "4".
 *
 * Deliberately permissive: unknown keys pass through untouched, because the
 * agent's job is to reason about a real payload, not to police AlertManager's
 * schema. What we *do* enforce is the shape the triage flow depends on —
 * `alerts[]` with labels — so a malformed stdin fails fast with a useful
 * message instead of producing a confidently wrong report about nothing.
 *
 * **`.loose()` is load-bearing.** The comment
 * above always claimed unknown keys passed through; zod's default `strip` mode
 * meant they were silently *deleted*, so the model never saw them. A review caught
 * it. The concrete casualty is `notification_reason`, added to the webhook
 * envelope in AlertManager 0.32 — exactly the kind of field a triage report
 * should be reasoning about, discarded before it reached the prompt. Passing
 * unknown fields through also means a future AlertManager can add context
 * without a code change here, which is the behaviour the comment promised.
 */
const labelMap = z.record(z.string(), z.string());

export const alertSchema = z.object({
  status: z.string().optional(),
  labels: labelMap.default({}),
  annotations: labelMap.default({}),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().optional(),
}).loose();

export const webhookPayloadSchema = z.object({
  version: z.string().optional(),
  groupKey: z.string().optional(),
  truncatedAlerts: z.number().optional(),
  status: z.string().optional(),
  receiver: z.string().optional(),
  groupLabels: labelMap.default({}),
  commonLabels: labelMap.default({}),
  commonAnnotations: labelMap.default({}),
  externalURL: z.string().optional(),
  alerts: z.array(alertSchema).min(1, "payload contains no alerts"),
}).loose();

export type Alert = z.infer<typeof alertSchema>;
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export function parseWebhookPayload(raw: string): WebhookPayload {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = webhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`stdin is not an AlertManager webhook payload:\n${issues}`);
  }
  return parsed.data;
}

/** Namespaces the alert mentions, in label-precedence order, de-duplicated. */
export function namespacesInPayload(payload: WebhookPayload): string[] {
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    if (value && value.trim() !== "") seen.add(value);
  };
  push(payload.groupLabels["namespace"]);
  push(payload.commonLabels["namespace"]);
  for (const alert of payload.alerts) {
    push(alert.labels["namespace"]);
    push(alert.labels["exported_namespace"]);
  }
  return [...seen];
}

/** A stable, human-readable name for the incident (used in the report title). */
export function alertName(payload: WebhookPayload): string {
  return (
    payload.groupLabels["alertname"] ??
    payload.commonLabels["alertname"] ??
    payload.alerts[0]?.labels["alertname"] ??
    "unknown-alert"
  );
}
