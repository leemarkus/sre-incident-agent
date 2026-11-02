/**
 * Known-secret redaction — the last boundary before a string reaches the model,
 * a log line, or a run artefact.
 *
 * `promql_query` and `argocd_status` copied a non-2xx
 * response body verbatim into the error they hand back, so a Grafana or ArgoCD
 * endpoint that echoed the `Authorization` header would have put the bearer
 * token into the model's context, `calls.jsonl`, `.tools.json` and the report.
 * `src/docs/forgejo.ts` already did the right thing for its own token; this
 * module generalises that helper so the other two tool paths — and the MCP
 * server's own reply/log boundary — share one implementation.
 *
 * The redaction is by VALUE, not by name: the caller passes the actual secret
 * strings (labelled with the variable they came from) and every encoded form of
 * them is replaced with `[redacted:<VAR>]`. Nothing here ever logs, prints or
 * returns the secret list.
 */

/** Environment variable names whose VALUE must never appear in an artefact. */
export const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export type KnownSecret = { label: string; value: string };

/**
 * Below this length a "secret" is more likely to be a placeholder or a common
 * word, and blanket-replacing it would corrupt legitimate output.
 */
export const MIN_REDACTABLE_LENGTH = 6;

/**
 * Every form one secret can reach a response body, a URL or a header dump in.
 * Same set `src/docs/forgejo.ts` covers: raw, percent-encoded, base64, and
 * JSON-string-escaped.
 */
export function secretForms(value: string): string[] {
  if (value.length < MIN_REDACTABLE_LENGTH) return [];
  const forms = new Set<string>([value]);
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    /* an unencodable secret is still redacted in its raw form */
  }
  forms.add(Buffer.from(value, "utf8").toString("base64"));
  forms.add(JSON.stringify(value).slice(1, -1));
  return [...forms].filter((f) => f !== "");
}

/** Replace every form of every known secret with `[redacted:<LABEL>]`. */
export function redactSecrets(text: string, secrets: readonly KnownSecret[]): string {
  let out = text;
  for (const secret of secrets) {
    for (const form of secretForms(secret.value)) {
      if (!out.includes(form)) continue;
      out = out.split(form).join(`[redacted:${secret.label}]`);
    }
  }
  return out;
}

/**
 * Redact anything SHAPED like a credential in a header echo, even when its
 * value is not one we know: an endpoint may reflect a token this process never
 * held (a proxy's own, a rotated one), and it is still not something to put in
 * front of the model.
 */
export function redactAuthorization(text: string): string {
  return text
    .replace(/\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{6,})/gi, "$1 [redacted:auth-header]")
    .replace(
      /("?\bauthorization"?\s*[:=]\s*"?)([^"'\s,;}]{6,})/gi,
      (_match, prefix: string) => `${prefix}[redacted:auth-header]`,
    );
}

/** The full boundary: known values first, then credential-shaped header echoes. */
export function scrubSecrets(text: string, secrets: readonly KnownSecret[]): string {
  return redactAuthorization(redactSecrets(text, secrets));
}

/**
 * Lift the known secrets out of a loaded config: every field whose NAME says it
 * is a credential and whose value is long enough to be one. Deriving the list
 * from the config rather than from a hand-written field list means a credential
 * added to `src/config.ts` later is covered without another edit here.
 */
export function knownSecrets(source: Record<string, unknown>): KnownSecret[] {
  const secrets: KnownSecret[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!SECRET_NAME.test(key)) continue;
    if (typeof value !== "string" || value.length < MIN_REDACTABLE_LENGTH) continue;
    secrets.push({ label: key, value });
  }
  return secrets;
}
