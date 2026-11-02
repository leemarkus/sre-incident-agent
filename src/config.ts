import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  EGRESS_URL_VARS,
  type EgressConfigView,
  assertLocalModelUrl,
  checkEgressUrl,
  isLocalEngine,
} from "./egress.js";
import { assertKubectlServerLocality } from "./kubeEndpoint.js";

export { assertLocalModelUrl, isLocalEngine } from "./egress.js";

/**
 * `.env.example` ships the optional URL vars as blank entries (`PROMETHEUS_URL=`),
 * and Node's `--env-file` loader turns those into empty strings rather than
 * leaving them unset. Treat "" as "not configured" so the documented file
 * validates. Anything non-empty still has to be a real URL.
 */
const optionalUrl = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().url().optional(),
);

const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v === "" ? undefined : v),
  z.string().optional(),
);

/**
 * A credential that is interpolated into an HTTP `Authorization` header.
 *
 * **Validated here, at config load, and rejected otherwise.** Every one of these ends up in `Authorization: token <value>`.
 * A value containing CR, LF, NUL or a non-ASCII byte is not a token anybody
 * minted — it is a header-injection attempt or a mangled `.env` — and `fetch`
 * reports it by throwing an exception that quotes the offending header value,
 * which is how a review recovered a full sentinel token out of a `DocsError`.
 * `src/docs/forgejo.ts` now redacts every error string on its way out; this is
 * the other half, and it is the half that means the process never starts with
 * a credential that can produce such an error in the first place.
 *
 * The grammar is visible ASCII, no spaces: what every one of these providers
 * actually mints, and a strict subset of RFC 9110's header-field-value.
 */
const HEADER_SAFE_TOKEN_RE = /^[\x21-\x7e]+$/;

const optionalHeaderToken = z.preprocess(
  (v) => (typeof v === "string" && v === "" ? undefined : v),
  z
    .string()
    .min(8, "an API token under 8 characters is not a token; check the .env entry")
    .max(512)
    .regex(
      HEADER_SAFE_TOKEN_RE,
      "must be visible ASCII with no whitespace (^[\\x21-\\x7e]+$) — this value is sent " +
        "in an Authorization header, and CR/LF/NUL or a non-ASCII byte makes the request " +
        "unconstructable and leaks the value into the resulting exception",
    )
    .optional(),
);

// ##, findings 1 and 2 (both HIGH)
//
// Everything that used to live here — the IPv4 range table, the IPv6 cases, and
// the `NAMED_LOCAL_SUFFIXES` allowlist — has moved to `src/egress.ts`, and the
// suffix allowlist is gone rather than moved.
//
// So: one predicate, in one file, applied to all five URLs, and mode-aware —
// enforced under local mode and explicitly recorded as unenforced under
// API mode, where these endpoints are legitimately remote.

/**
 * The one place an operator-typed on/off word is turned into a boolean.
 *
 * Returns the input UNCHANGED when it recognises nothing — including for the
 * empty string — so the caller's `z.boolean()` refuses it by name rather than
 * folding an unreadable value into a default. Every mode toggle in this file
 * shares this list, because two lists of accepted spellings is how one toggle
 * quietly comes to mean something the other does not.
 */
function booleanish(raw: unknown): unknown {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return raw;
  const value = raw.trim().toLowerCase();
  if (value === "") return raw;
  if (["on", "true", "1", "yes", "enabled"].includes(value)) return true;
  if (["off", "false", "0", "no", "disabled"].includes(value)) return false;
  return raw;
}

/** Everything except the Anthropic API key, which is only needed for real runs. */
/**
 * Default transport abort for local models. Must cover prefill plus a full
 * generation at the measured throughput — see LOCAL_MODEL_TIMEOUT_MS below.
 * Exported so the suite can assert it against the generation allowance.
 */
export const LOCAL_MODEL_TIMEOUT_DEFAULT_MS = 3_600_000;

const baseSchema = z.object({
  ANTHROPIC_TRIAGE_MODEL: z.string().default("claude-sonnet-5"),
  /**
   * Where the Anthropic client actually points.
   *
   * The SDK reads `ANTHROPIC_BASE_URL` itself when the option is omitted, so
   * this variable was already in force — silently, outside the config, and
   * outside what `describe()` claimed the run was doing. Declaring it here does
   * not add a capability; it makes an existing one visible: the value is read
   * at the sanctioned moment (config load), frozen into the snapshot, passed
   * explicitly to the client, and reported by `liveTransport().describe()`.
   *
   * A gateway or proxy in front of the API is a legitimate deployment, so this
   * is not refused — it is stated. A run pointed somewhere else runs, and says
   * where.
   */
  ANTHROPIC_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().default("https://api.anthropic.com"),
  ),
  ANTHROPIC_DIGEST_MODEL: z.string().default("claude-haiku-4-5"),

  ANTHROPIC_TRIAGE_EFFORT: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .default("high"),
  /** Tool-loop ceiling on the Tool Runner. */

  SRE_AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(25),

  SRE_AGENT_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(10),
  /**
   * On: before the model's first turn, the harness runs the fixed read-only
   * evidence sweep for the alert's class (`src/sweep.ts`) and injects the
   * verbatim results into the conversation as genuine tool calls.
   *
   * Spelled as a word, not a number, and accepted in the spellings an operator
   * will actually type. An unrecognised value is REFUSED at config load rather
   * than folded into a default: "which mode is this run in" is the one fact
   * every artefact of this harness is compared on, and a typo silently meaning
   * `on` is the 7b/7d comparability failure with an extra step.
   */
  SRE_AGENT_EVIDENCE_SWEEP: z.preprocess((raw) => {

    if (raw === undefined) return true;
    return booleanish(raw);
  }, z.boolean({
    error:
      "SRE_AGENT_EVIDENCE_SWEEP must be on/true/1/yes/enabled or off/false/0/no/disabled. " +
      "It decides whether the evidence sweep scaffolds this run, which is recorded in " +
      "every report and is what makes two runs comparable; an unrecognised value is refused " +
      "rather than defaulted, so nobody discovers the mode from a typo. An EMPTY value is " +
      "refused for the same reason and is usually an unset shell variable that expanded to " +
      "nothing: unset the variable entirely to get the default (on), or write the mode out.",
  }).default(true)),
  /**
   * **PROBE ARM (diagnostics). Defaults OFF.**
   *
   * On: the FIRST request of the run carries `tool_choice: {type: "any"}` —
   * translated by `src/localWire.ts` to the OpenAI-compatible
   * `tool_choice: "required"` — so the model's opening turn is constrained to
   * emit a tool call. If that turn does carry tool calls, the choice is flipped
   * back to `auto` immediately afterwards and the rest of the run is free; the
   * model decides every later call for itself.
   *
   * It forces a call; it does not choose one. No tool, resource or namespace is
   * named by the harness — the model still picks what to look at.
   */
  SRE_AGENT_FORCE_FIRST_TOOL_CALL: z.preprocess(
    (raw) => booleanish(raw),
    z.boolean({
      error:
        "SRE_AGENT_FORCE_FIRST_TOOL_CALL must be on/true/1/yes/enabled or " +
        "off/false/0/no/disabled. It puts the run in a separate probe arm whose grade is " +
        "not comparable to a free run's, so an unrecognised or empty value is refused " +
        "rather than defaulted.",
    }).default(false),
  ),
  /**
   * **PROBE ARM (diagnostics). Defaults to the empty string,
   * meaning no nudge.**
   *
   * When non-empty: if the model finishes a turn with `end_turn` having made no
   * tool call at all, this exact text is appended as a single user turn and the
   * loop continues. It fires AT MOST ONCE per run, only while the run has zero
   * model-initiated tool calls, and never after a turn that called a tool.
   *
   * The text is operator-supplied and goes across verbatim so that it can be
   * recorded verbatim: a nudge that names a tool, a resource or a namespace
   * measures the operator's prompt rather than the model, and the only defence
   * against that is that the exact bytes are printed in the artefact.
   */
  SRE_AGENT_CONTINUATION_NUDGE: z.string().default(""),
  /**
   * The value is chosen on PRINCIPLE and declared before the run: Qwen's own
   * thinking-mode guidance is ~0.6, and a precision task argues no higher. It
   * is NOT swept. Picking the value that scored best would be tuning to pass
   * evals; picking one because a triage agent must be reproducible is a
   * deployment decision. A run with this set is its own arm and is never pooled
   * with a run without it (docs/safety-model.md).
   *
   * Declared as a STRING, empty meaning unset, for the same reason
   * SRE_AGENT_CONTINUATION_NUDGE is: every field in this schema must be a flat
   * primitive or `frozenConfigSnapshot`'s shallow freeze stops being a complete
   * freeze.
   * The numeric parse and the 0..2 range live at the single use site.
   */
  SRE_AGENT_LOCAL_TEMPERATURE: z.string().default(""),
  /**
   * MAX_TOKENS must stay under 21_333 because the SDK refuses a non-streaming
   * request above that when the client declares no timeout — and the
   * LIVE client deliberately declares none, because that guard is correct about
   * the real API. The LOCAL client now declares one, so the guard does not
   * apply to it. Its upstream always streams; the allowance is capped at
   * 120_000 and checked against measured completion tokens before acceptance.
   * Missing completion usage refuses the gate.
   *
   * It exists because a postmortem legitimately needs more: minio r2 truncated
   * at 16_000 and again at 20_000 on a 13_043-character 9-section draft that
   * was not repetitive. Without this the mode axis cannot be measured.
   *
   * A string for the same flatness reason as SRE_AGENT_LOCAL_TEMPERATURE; the
   * parse and range live at the single use site, which also REFUSES the value
   * outside local mode rather than silently ignoring it.
   */
  SRE_AGENT_LOCAL_GENERATION_ALLOWANCE: z.string().default(""),
  /** Read-only kubeconfig + the context the agent is pinned to. */
  KUBECONFIG: z.string().default(""),
  KUBE_CONTEXT: z.string().default("homelab"),
  /**
   * The Kubernetes API endpoint, **declared** — not derived from the kubeconfig.
   */
  KUBE_SERVER: z.string().default(""),
  /**
   * The kubectl binary, as an ABSOLUTE path, and the HOME the child sees.
   *
   * Both are therefore config fields, resolved at **load** — the sanctioned
   * moment, the one every snapshot is taken from — and frozen with the rest of
   * the snapshot at pairing:
   *
   *  - `KUBECTL_BIN` is an operator override; left empty it is resolved once,
   *    here, by scanning the load-time `PATH` for an executable `kubectl`. The
   *    resolved absolute path is what `spawn` is given, so a later `PATH`
   *    mutation selects nothing. **:** what is
   *    frozen here is the PATH, and a path is not a binary — `spawn()` resolves
   *    it at execution time, so a package upgrade after load swapped the
   *    executable. The path is now canonicalised (symlinks resolved) and the
   *    file's identity is recorded in `KUBECTL_BIN_IDENTITY`, which
   *    `runKubectl` re-checks before spawning. Only with all three does the
   *    sentence "the binary a run executes is decided at config load" hold.
   *  - `HOME` is read straight from the environment at load and passed
   *    explicitly to the child, so kubectl's own default kubeconfig chain
   *    (`$HOME/.kube/config`) resolves against the value the run was configured
   *    with rather than whatever `HOME` says at execution time.
   *
   * Everything else the child might have inherited is DROPPED — see
   * `kubectlChildEnv` in `src/tools/kubectl.ts` for the per-variable reasons.
   */
  /**
   * ##: the schema enforces the contract
   *
   * An operator override must now BE what the docs say it is: absolute, or
   * refused loudly at config load naming the value. The auto-resolution path
   * (`resolveKubectlBinary`, below) only ever produces absolute paths — it
   * joins an absolute PATH entry with a filename and skips relative entries —
   * so the field is absolute-or-empty by construction on both routes.
   */
  KUBECTL_BIN: z
    .string()
    .default("")
    .refine(
      (value) => !value.split(path.sep).includes(".."),
      "KUBECTL_BIN must not contain a `..` component. A path that walks upward is a path whose " +
        "meaning depends on what the intervening directories are at execution time, which is " +
        "the ambient dependence this field exists to remove. Give the canonical absolute path.",
    )
    .refine(
      (value) => value === "" || path.isAbsolute(value),
      "KUBECTL_BIN must be an ABSOLUTE path to the kubectl binary (e.g. " +
        "/opt/homebrew/bin/kubectl). A bare name is resolved by the child process through " +
        "its own environment and a relative path against the working directory — both are " +
        "the execution-time ambient dependence this field exists to remove, and both would " +
        "make the frozen snapshot's claim about which binary a run executes untrue. Leave " +
        "it unset to have an absolute path resolved once, at config load, from PATH.",
    ),
  /**
   * The identity of the file `KUBECTL_BIN` named at config load — device,
   * inode, size and mtime, as one flat string.
   *
   * Derived at load (like `KUBECTL_BIN`'s PATH resolution) rather than read from
   * the environment; a value supplied in the environment is overwritten. It is a
   * string so the config schema stays flat — `frozenConfigSnapshot`'s shallow
   * freeze is a complete freeze only while every field is a primitive, and the
   * schema-shape walk in the check suite pins that.
   */
  KUBECTL_BIN_IDENTITY: z.string().default(""),
  HOME: z.string().default(""),
  /** Read-only observability endpoints (no write paths, ever). */
  PROMETHEUS_URL: optionalUrl,
  GRAFANA_URL: optionalUrl,
  /**
   * In-cluster Prometheus is ClusterIP-only, so PromQL goes through Grafana's
   * datasource proxy. Viewer-scoped service-account token, minted by the operator.
   */
  GRAFANA_SERVICE_ACCOUNT_TOKEN: optionalHeaderToken,
  /**
   * Optional: skip the `/api/datasources` lookup by pinning the UID.
   *
   * **Validated here, at config load, and rejected otherwise.**
   * The UID is interpolated into the datasource-proxy path
   * (`/api/datasources/proxy/uid/<uid>/api/v1/query`). A review showed that a UID
   * of `../../../../api/search?x=` escapes the proxy prefix and points the
   * Viewer token at arbitrary Grafana GET endpoints. Grafana's own UID grammar
   * is alphanumerics, `-` and `_`, so anything else is a misconfiguration or an
   * attack and must not start the process. `src/tools/promql.ts` also
   * percent-encodes it and asserts the constructed pathname.
   */
  GRAFANA_PROM_DATASOURCE_UID: z.preprocess(
    (v) => (typeof v === "string" && v === "" ? undefined : v),
    z
      .string()
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        "must match ^[a-zA-Z0-9_-]+$ (Grafana datasource UID grammar) — a UID " +
          "containing path characters can escape the datasource proxy",
      )
      .optional(),
  ),
  /** ArgoCD. Both must be set or the argocd tool is skipped gracefully. */
  ARGOCD_URL: optionalUrl,
  ARGOCD_TOKEN: optionalHeaderToken,

  FORGEJO_URL: optionalUrl,
  FORGEJO_TOKEN: optionalHeaderToken,
  /**
   * Constrained by the shared egress predicate (`src/egress.ts`): an address
   * literal must be in the local set, and a name is admitted here only because
   * it is re-checked against the address the socket actually reaches. See
   * there for why that split is the honest one.
   */
  LOCAL_MODEL_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .superRefine((value, ctx) => {
        try {
          assertLocalModelUrl(value);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .optional(),
  ),
  /** The model to ask the local server for, e.g. `qwen3:32b`. Server-defined. */
  LOCAL_MODEL_NAME: optionalString,
  /**
   * Wall-clock ceiling per local request, ms. A cold model load plus a long
   * generation on a quantised 30–70B is minutes, not seconds, so this is
   * generous — but unbounded would mean a wedged server hangs the replay
   * forever with no diagnosis.
   */
  LOCAL_MODEL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(LOCAL_MODEL_TIMEOUT_DEFAULT_MS),
});

/**
 * Apply the locality rule to **every** egress URL when local mode is intended.
 *
 * `LOCAL_MODEL_BASE_URL` was the only constrained endpoint, so the four other
 * hosts this process dials were unconstrained egress. That matters because the
 * injection vector is not hypothetical: `docs_search` reads a **public** gitops
 * repo, and a model that has read attacker-controlled text can encode findings
 * into a syntactically valid PromQL query — a legitimate-looking tool call to
 * whatever `GRAFANA_URL` names. The transport meanwhile claimed nothing left
 * the LAN.
 *
 * ## Why the trigger is "both LOCAL_MODEL_* set" rather than `isLocalEngine`
 *
 * `isLocalEngine` additionally requires `ANTHROPIC_TRIAGE_MODEL ===
 * LOCAL_MODEL_NAME`, and that equality is produced by `localConfig()` *after*
 * this schema has run — so testing it here would never fire on the path it
 * exists for. An operator who has set both `LOCAL_MODEL_*` has declared a local
 * endpoint, and erring toward enforcing is the safe direction: the only run it
 * can newly refuse is one whose observability endpoints are at public IP
 * literals, which is a configuration worth refusing loudly under any reading.
 *
 * Names are *not* refused here. They are undecidable at config load, and are
 * settled at connect time by `localOnlyLookup` instead — see `src/egress.ts`.
 *
 * **Kept, deliberately, and not unified.** Unifying means relaxing this trigger
 * to `isLocalEngine`, which cannot even be asked here (the equality arrives
 * after the schema runs — see above) and which would REMOVE enforcement from the
 * five HTTP endpoints in exactly the configuration where it currently applies.
 * The disagreement errs toward refusing; the alternative errs toward permitting
 * a public IP literal for an endpoint a locally-benched operator declared. A
 * refused run costs one edit — unset the `LOCAL_MODEL_*` pair, or address the
 * endpoint by name — and says why. Pinned by the offline check suite
 * so that changing it is a decision someone makes rather than a regression.
 */
function enforceEgressLocality(
  data: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const base = data["LOCAL_MODEL_BASE_URL"];
  const name = data["LOCAL_MODEL_NAME"];
  const localIntended =
    typeof base === "string" && base !== "" && typeof name === "string" && name !== "";
  if (!localIntended) return;

  for (const variable of EGRESS_URL_VARS) {
    const raw = data[variable];
    if (typeof raw !== "string" || raw === "") continue;
    try {
      checkEgressUrl(raw, variable);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: [variable],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** The strict contract every real run must satisfy. */
const envSchema = baseSchema
  .extend({
    ANTHROPIC_API_KEY: z.string().min(1),
  })
  .superRefine(enforceEgressLocality);

/**
 * Diagnostic contract: identical, except the API key may be absent. Used only
 * by the `env` command so `anthropicApiKey: "<unset>"` is a reachable state on
 * a fresh checkout. Never use this to construct the Anthropic client.
 */
const diagnosticEnvSchema = baseSchema
  .extend({
    ANTHROPIC_API_KEY: optionalString,
  })
  .superRefine(enforceEgressLocality);

export type Config = z.infer<typeof envSchema>;
export type DiagnosticConfig = z.infer<typeof diagnosticEnvSchema>;

/**
 * The config schema's own field types, keyed by field name.
 */
export function configSchemaShape(): Record<string, unknown> {
  return { ...diagnosticEnvSchema.shape };
}

/**
 * Find an executable `kubectl` on a PATH value, as an absolute path.
 *
 * Called ONCE, at config load, so the *path*
 * a run executes is decided at the same moment as everything else the snapshot
 * freezes. Returns "" when nothing is found; the kubectl tool reports that as a
 * tool failure naming the cause, rather than the child process's opaque ENOENT.
 *
 * ##: a path is not a binary
 *
 * Two things make the sentence true rather than merely narrower:
 * {@link canonicalKubectlPath} resolves symlinks so the recorded path is the
 * real file rather than a mutable pointer to one, and {@link binaryIdentity}
 * records what that file WAS, which `runKubectl` re-checks before spawning.
 *
 * Relative PATH entries are skipped deliberately: a relative entry resolves
 * against the child's working directory, which is exactly the kind of ambient
 * dependence this fix removes.
 */
export function resolveKubectlBinary(pathValue: string): string {
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "kubectl");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return "";
}

/**
 * The canonical path of a binary: symlinks resolved, `.`/`..` gone.
 *
 * Best-effort by design. A path that cannot be resolved (it does not exist yet,
 * or is unreadable) is returned unchanged rather than refused: `KUBECTL_BIN`
 * pointing at a missing file is a configuration to report at the tool call —
 * where the failure text names the cause — not a reason to refuse to load a
 * config for the `env` command that exists to diagnose exactly that.
 */
export function canonicalKubectlPath(value: string): string {
  if (value === "") return "";
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * A file's identity as one flat string: device, inode, size, mtime.
 *
 * `""` when the file cannot be stat'ed. Inode and device are what actually
 * identify a file on the platforms this runs on (macOS and Linux); size and
 * mtime are carried because an inode can be reused after a delete, and because
 * a rewrite in place (the shape `install` and some package managers use) keeps
 * the inode and changes the rest.
 */
export function binaryIdentity(value: string): string {
  if (value === "") return "";
  try {
    const s = statSync(value);
    return `dev:${s.dev};ino:${s.ino};size:${s.size};mtime:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

function parseWith<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const data = parsed.data as Record<string, unknown>;
  // The one derivation that has to happen here rather than in the schema: it
  // reads a DIFFERENT variable (PATH) than the field it fills, and it must
  // happen at load so the resolved path is part of the frozen snapshot.
  if (data["KUBECTL_BIN"] === "") {
    data["KUBECTL_BIN"] = resolveKubectlBinary(env["PATH"] ?? "");
  }

  data["KUBECTL_BIN"] = canonicalKubectlPath(data["KUBECTL_BIN"] as string);
  data["KUBECTL_BIN_IDENTITY"] = binaryIdentity(data["KUBECTL_BIN"] as string);
  // Note what is NOT here any more: no child process, no file read, no document.
  // The guard cannot ingest a credential because it never opens anything.
  //
  // ##: ONE mode predicate, and it is `isLocalEngine`
  //
  // The fail-closed direction is unchanged: under local mode a missing or
  // non-local `KUBE_SERVER` still refuses, here and at both runtime sites.
  //
  // What this does NOT change, deliberately: `enforceEgressLocality` above keeps
  // its own "both `LOCAL_MODEL_*` set" trigger. That is not a mode claim — it is a
  // declared-local-INTENT belt, and its own docblock records why `isLocalEngine`
  // cannot be asked there (the `ANTHROPIC_TRIAGE_MODEL === LOCAL_MODEL_NAME`
  // equality is produced by `localConfig()` *after* the schema runs, so on the
  // `--local` path the predicate is false at load). Those five endpoints are
  // re-enforced inside the socket's own DNS lookup by `localFetch`; the kubectl
  // endpoint has no such second chance, which is why it is the one that has to be
  // decided by the mode predicate rather than by intent.
  assertKubeServerBelt(data);
  return data as z.infer<T>;
}

/**
 * The KUBE_SERVER load-time belt, as a function both entry points can call.
 *
 * `parseWith` asks `isLocalEngine`, which needs `ANTHROPIC_TRIAGE_MODEL ===
 * LOCAL_MODEL_NAME` — and on the real local path that equality is produced by
 * `localConfig()` (src/transport.ts) *after* this loader has returned. So on
 * every `--local` run the belt evaluated false and did nothing: a documented
 * defence-in-depth layer, absent from the only mode that has one.
 *
 * The same timing is recorded two functions up, for `enforceEgressLocality`,
 * and simply was not noticed to apply here too.
 *
 * **No leak, verified rather than assumed.** Two independent sites re-run this
 * exact guard downstream: `localTransport` (src/transport.ts:1575) refuses to
 * construct, and `runKubectl` (src/tools/kubectl.ts:524) refuses before spawn
 * and returns `ok: false` instead of an argv. Under local mode kubectl cannot
 * be spawned without a validated `--server`, belt or no belt. What was missing
 * was the EARLY refusal — the one that fails a misconfigured run at load,
 * where an operator reads it, rather than at the first tool call inside a
 * scored investigation.
 *
 * Exported so `localConfig()` can run it on the config it produces, which is
 * the first moment `isLocalEngine` is true on that path.
 */
export function assertKubeServerBelt(data: Record<string, unknown>): void {
  if (!isLocalEngine(data as EgressConfigView)) return;
  try {

    assertKubectlServerLocality({ KUBE_SERVER: data["KUBE_SERVER"] });
  } catch (error) {
    throw new Error(
      "Invalid environment:\n  KUBE_SERVER: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Strict load. Hard-fails without `ANTHROPIC_API_KEY`. Everything that talks to
 * the API — `triage`, and anything calling `createClient` — must use this.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parseWith(envSchema, env);
}

/**
 * Diagnostic load for the `env` command only: same contract, but a missing
 * API key is reported rather than fatal. Every other field stays strict.
 */
export function loadDiagnosticConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticConfig {
  return parseWith(diagnosticEnvSchema, env);
}
