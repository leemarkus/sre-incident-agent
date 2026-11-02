import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import * as z from "zod/v4";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

import { binaryIdentity, type Config } from "../config.js";
import { isLocalEngine } from "../egress.js";
import { assertKubectlServerLocality, kubectlChildEnv } from "../kubeEndpoint.js";
import { declare, declareFailed } from "./status.js";

// Re-exported from its home beside the endpoint guard: both decide what this process hands the kubectl child, so the one
// definition lives next to the other. Kept exported here because the check suite
// and this file's callers import it from this module.
export { kubectlChildEnv } from "../kubeEndpoint.js";

/**
 * Read-only `kubectl` tool.
 *
 * ## Why this file looks the way it does
 *
 *  - **Critical** — `-o go-template-file=/path/to/.env` made `kubectl` read a
 *    local file and render it into the model's context. Nothing in the denylist
 *    covered `-o`, because `-o` looked like a formatting concern.
 *  - **High** — the resource check inspected only the *first non-dash token*,
 *    so `["-o","yaml","secrets"]` and `["--selector","app=x","nodes"]` put the
 *    denied type in a later position and sailed through.
 *  - **High** — `--profile-output=/tmp/x` and `--log-file=/tmp/x` are global
 *    `kubectl` flags that **write arbitrary files**, on a tool whose entire
 *    premise is that it cannot write anything.
 *  - **Medium** — `-shttps://alternate.example` (attached shorthand) evaded the
 *    exact-match `-s` entry and redirected the API server.
 *
 * ## The inversion
 *
 * **The model does not supply flags. It supplies typed fields, and this file
 * renders argv.** Every element of the final argv is either a literal written
 * here or a value that passed a field-specific pattern/enum. Nothing
 * model-supplied is passed through verbatim.
 *
 * That makes the four escapes above *unrepresentable* rather than rejected:
 *
 * The pre-existing defences are kept, as depth rather than as the frontline:
 * `spawn` with `shell: false` (no metacharacter surface), stdin ignored, a
 * fixed `KUBECONFIG`/context from config, an output size cap and a timeout.
 * RBAC remains the independent second layer: `KUBECONFIG` points at the
 * `view`-scoped ServiceAccount `kube-system:sre-agent-ro`, which cannot
 * write even if everything here failed.
 */

const SUBCOMMANDS = ["get", "describe", "logs", "events"] as const;

/**
 * **Allowlist** of namespaced resource kinds the agent may read, long and short
 * forms. This is the whole universe of `resource` — it is a zod enum, so a value
 * outside it never reaches this module's logic at all.
 *
 * Adding a kind here is a deliberate, reviewable act. Nothing is inferred.
 */
export const ALLOWED_RESOURCES = [
  // core workloads
  "pods",
  "po",
  "deployments",
  "deploy",
  "replicasets",
  "rs",
  "statefulsets",
  "sts",
  "daemonsets",
  "ds",
  "jobs",
  "cronjobs",
  "cj",
  "replicationcontrollers",
  "rc",
  // networking
  "services",
  "svc",
  "endpoints",
  "ep",
  "endpointslices",
  "ingresses",
  "ing",
  "networkpolicies",
  "netpol",
  // config & storage (namespaced only; no Secrets)
  "configmaps",
  "cm",
  "persistentvolumeclaims",
  "pvc",
  // scheduling / policy (namespaced)
  "poddisruptionbudgets",
  "pdb",
  "horizontalpodautoscalers",
  "hpa",
  "resourcequotas",
  "quota",
  "limitranges",
  "limits",
  // identity (namespaced; tokens live in Secrets, which are absent above)
  "serviceaccounts",
  "sa",
  "roles",
  "rolebindings",
  // events
  "events",
  "ev",
  // operators the platform actually runs
  "applications",
  "appprojects",
  "servicemonitors",
  "podmonitors",
  "prometheusrules",
  "prometheuses",
  "alertmanagers",
  "certificates",
  "certificaterequests",
  "issuers",
  "backups",
  "restores",
  "schedules",
  "volumesnapshots",
] as const;

/**
 * Map a singular resource noun onto the plural this tool accepts.
 *
 * `kubectl` itself takes `job`, `service`, `deployment`; this enum took only the
 * plural and the short alias, so the tool was stricter than the CLI it fronts
 * and the models have plainly learned the CLI. Five of `qwen3-coder:30b`'s seven
 * Zod-rejected calls across 39 were singular nouns — a rejected call costs a
 * turn and reads to the model as "that kind does not exist".
 *
 * ## Why this normalises instead of widening the allowlist
 *
 * The enum stays the sole authority on what may be read. This can only ever map
 * onto a spelling that is ALREADY allowed — it cannot admit a new kind, so the
 * denied surface is unchanged by construction: `secret` normalises to `secrets`,
 * which is not in the list and is refused exactly as before, and the same holds
 * for every cluster-scoped kind. Adding 60 singular entries to `ALLOWED_RESOURCES`
 * would have put that guarantee in a list a future edit could get wrong.
 *
 * Unknown input is returned untouched so the enum produces the error, rather
 * than this quietly inventing a spelling nobody asked for.
 */
export function canonicalResource(raw: string): string {
  const allowed = new Set<string>(ALLOWED_RESOURCES);
  if (allowed.has(raw)) return raw;
  const candidates = [`${raw}s`, `${raw}es`, raw.replace(/y$/, "ies")];
  return candidates.find((c) => allowed.has(c)) ?? raw;
}

/** RFC 1123 label — also excludes anything that could read as a flag. */
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** RFC 1123 subdomain: object names may contain dots (`foo.bar`), never a leading `-`. */
const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
/** Container names are plain RFC 1123 labels. */
const CONTAINER_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Equality-only label selectors: `k=v` or `k=v,k2=v2`. No `!`, no set notation, no spaces. */
const SELECTOR_RE =
  /^[A-Za-z0-9][-A-Za-z0-9_./]*=[-A-Za-z0-9_.]*(,[A-Za-z0-9][-A-Za-z0-9_./]*=[-A-Za-z0-9_.]*)*$/;
/** Prometheus/kubectl-style duration, bounded by the pattern itself. */
const SINCE_RE = /^[1-9][0-9]{0,4}[smh]$/;

const OUTPUTS = ["wide", "json", "yaml"] as const;

/**
 * Largest `kubectl_read` result handed back to the model, in characters.
 */
export const KUBECTL_MAX_OUTPUT_CHARS = 40_000;
const MAX_OUTPUT_CHARS = KUBECTL_MAX_OUTPUT_CHARS;
const MAX_TAIL_LINES = 5_000;
const TIMEOUT_MS = 30_000;

/**
 * Default `--tail` for `logs`.
 *
 * `kubectl logs` with no `--tail` streams the container's **entire** log. On a
 * chatty pod that is tens of megabytes, and the tool would previously buffer all
 * of it in memory and only truncate after the process closed — so the cap
 * protected the model's context but not this process's heap. A model that
 * simply omits `tailLines` should not be able to do that, so omission now means
 * "the last ${DEFAULT_TAIL_LINES} lines", not "everything since the container
 * started". A model that wants more asks for more, up to MAX_TAIL_LINES.
 */
const DEFAULT_TAIL_LINES = 500;

export const kubectlInputSchema = z.object({
  subcommand: z
    .enum(SUBCOMMANDS)
    .describe(
      "kubectl read verb. `get` (list/read resources), `describe` (read a " +
        "resource plus its events), `logs` (container logs), `events` " +
        "(namespace event stream). Nothing else exists.",
    ),
  namespace: z
    .string()
    .regex(NAMESPACE_RE, "must be a valid RFC 1123 namespace name")
    .describe(
      "Namespace to operate in. REQUIRED — this agent is namespaced-only. " +
        "There is no all-namespaces option and no cluster scope.",
    ),
  resource: z
    .preprocess(
      (v) => (typeof v === "string" ? canonicalResource(v) : v),
      z.enum(ALLOWED_RESOURCES),
    )
    .optional()
    .describe(
      "Resource kind. Plural or the short alias; the singular is accepted and " +
        "normalised (`job` → `jobs`). " +
        "Required for `get` and `describe`; optional for `logs` " +
        "(to name a workload rather than a pod) and `events` (to scope --for). " +
        "Only namespaced kinds exist here: Secrets, SealedSecrets and every " +
        "cluster-scoped kind (nodes, PVs, CRDs, ClusterRoles, namespaces, " +
        "StorageClasses) are absent by construction and cannot be requested.",
    ),
  name: z
    .string()
    .regex(NAME_RE, "must be a valid RFC 1123 resource name")
    .optional()
    .describe(
      "Object name. Required for `logs`; optional for `get`/`describe` " +
        "(omit to list the whole kind in the namespace).",
    ),
  selector: z
    .string()
    .regex(SELECTOR_RE, "must be an equality label selector, e.g. app=foo,tier=web")
    .optional()
    .describe(
      "Equality label selector, e.g. `app.kubernetes.io/name=loki`. " +
        "Comma-separated for multiple. Set-based selectors are not supported.",
    ),
  container: z
    .string()
    .regex(CONTAINER_RE, "must be a valid container name")
    .optional()
    .describe("Container name — `logs` only, for multi-container pods."),
  tailLines: z
    // `"20"` is accepted as 20. Models emit tool arguments as JSON text
    // and a numeric field arriving quoted is a serialisation artefact, not a
    // different request — rejecting it spent a turn to teach the model nothing.
    // Only a string that is EXACTLY an integer converts; `"20 lines"`, `"1e3"`
    // and `""` stay rejections, and the bounds below still apply either way, so
    // this widens the accepted spelling and not the accepted range.
    .preprocess(
      (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
      z.number().int().min(1).max(MAX_TAIL_LINES),
    )
    .optional()
    .describe(
      `Log lines from the end — \`logs\` only, 1..${MAX_TAIL_LINES}. ` +
        `Omitting this does NOT fetch the whole log: it defaults to ${DEFAULT_TAIL_LINES} lines.`,
    ),
  since: z
    .string()
    .regex(SINCE_RE, "must be a duration like 15m, 2h or 300s")
    .optional()
    .describe("Only logs newer than this relative duration — `logs` only, e.g. `15m`."),
  output: z
    .enum(OUTPUTS)
    .optional()
    .describe(
      "Output format for `get`/`events`: `wide`, `json` or `yaml`. These three " +
        "are the only formats that exist — template and file-backed formats " +
        "are not available.",
    ),
  })
  // Strict: an unknown key is a hard rejection, not a silent strip. A model
  // reaching for `args`, `flags` or `extra_args` should be told plainly that
  // no such surface exists rather than have the attempt quietly deleted.
  .strict();

export type KubectlInput = z.infer<typeof kubectlInputSchema>;

class RejectedError extends Error {}

/**
 * Render argv from validated fields. Every array element below is either a
 * string literal written in this file or a field that passed its enum/pattern.
 * Long `--flag=value` form throughout, so a value can never be mistaken for the
 * next flag, and attached-shorthand parsing (`-shttps://…`) has no analogue.
 */
export function buildKubectlArgv(input: KubectlInput): string[] {
  const { subcommand, namespace, resource, name, selector, container, tailLines, since, output } =
    input;

  const ns = `--namespace=${namespace}`;

  switch (subcommand) {
    case "get":
    case "describe": {
      if (resource === undefined) {
        throw new RejectedError(
          `rejected: \`${subcommand}\` needs a \`resource\` (e.g. "pods"). ` +
            "Set the `resource` field; there is no other way to name a kind.",
        );
      }
      if (name !== undefined && selector !== undefined) {
        throw new RejectedError(
          "rejected: give either `name` or `selector`, not both — kubectl " +
            "ignores a selector when a name is given.",
        );
      }
      const argv: string[] = [subcommand, resource];
      if (name !== undefined) argv.push(name);
      argv.push(ns);
      if (selector !== undefined) argv.push(`--selector=${selector}`);
      // `describe` has no -o; only `get` takes one.
      if (subcommand === "get" && output !== undefined) argv.push(`--output=${output}`);
      return argv;
    }

    case "logs": {
      if (name === undefined) {
        throw new RejectedError(
          "rejected: `logs` needs a `name` (a pod name, or a workload name " +
            "together with `resource`).",
        );
      }
      const target = resource === undefined ? name : `${resource}/${name}`;
      const argv = ["logs", target, ns];
      if (container !== undefined) argv.push(`--container=${container}`);
      // Always rendered: an absent `tailLines` must not mean "the whole log".
      argv.push(`--tail=${tailLines ?? DEFAULT_TAIL_LINES}`);
      if (since !== undefined) argv.push(`--since=${since}`);
      return argv;
    }

    case "events": {
      const argv = ["events", ns];
      if (resource !== undefined && name !== undefined) {
        argv.push(`--for=${resource}/${name}`);
      } else if (resource !== undefined || name !== undefined) {
        throw new RejectedError(
          "rejected: `events --for` needs both `resource` and `name`. Omit " +
            "both to read the whole namespace event stream.",
        );
      }
      if (output !== undefined) argv.push(`--output=${output}`);
      return argv;
    }
  }
}

/**
 * The streaming output cap, extracted so it can be asserted directly.
 *
 * . The cap was inline in the `spawn`
 * callback, and the branch that fired when the buffer was *already* at the cap
 * marked overflow without killing the child — so a stream that landed on
 * exactly `MAX_OUTPUT_CHARS` left `kubectl` running and reading bytes that were
 * being discarded. Two changes: every path that reaches the cap stops the
 * child, and `overflowed` is set only when bytes were genuinely dropped, so
 * output that lands exactly on the cap is not mislabelled as truncated.
 *
 * `stop` is called at most once; the caller makes it idempotent-safe by
 * flagging the kill it performs.
 */
export function createOutputBound(max: number, stop: () => void) {
  let overflowed = false;
  let stopped = false;
  const stopOnce = (): void => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  return {
    append(current: string, chunk: string): string {
      if (current.length >= max) {
        // Bytes are still arriving and are being discarded.
        overflowed = true;
        stopOnce();
        return current;
      }
      const next = current + chunk;
      if (next.length < max) return next;
      stopOnce();
      if (next.length > max) overflowed = true;
      return next.slice(0, max);
    },
    get overflowed(): boolean {
      return overflowed;
    },
    get stopped(): boolean {
      return stopped;
    },
  };
}

type KubectlOutcome = { text: string; ok: boolean };

async function runKubectl(argv: string[], config: Config): Promise<KubectlOutcome> {

  const env = kubectlChildEnv(config);

  if (config.KUBECTL_BIN === "") {
    return {
      text:
        "kubectl could not be executed: no kubectl binary was resolved at config load. " +
        "Set KUBECTL_BIN to an absolute path, or make sure kubectl is on PATH in the " +
        "environment this process starts in. The binary is resolved once, at load, so a " +
        "PATH change after startup deliberately has no effect.",
      ok: false,
    };
  }

  if (!isAbsolute(config.KUBECTL_BIN)) {
    return {
      text:
        `kubectl could not be executed: KUBECTL_BIN is ${JSON.stringify(config.KUBECTL_BIN)}, ` +
        "which is not an absolute path. A bare name would be resolved by the child through " +
        "its own environment and a relative path against the working directory; the binary a " +
        "run executes must be decided once, at config load, and frozen into the snapshot. " +
        "Set KUBECTL_BIN to an absolute path, or leave it unset to have one resolved.",
      ok: false,
    };
  }

  if (config.KUBECTL_BIN_IDENTITY === undefined || config.KUBECTL_BIN_IDENTITY === "") {
    return {
      text:
        `kubectl was NOT executed: the binary at ${config.KUBECTL_BIN} has no recorded identity ` +
        "in this run's snapshot. The schema records device/inode/size/mtime at config load so a " +
        "swapped binary is caught before spawn; an empty identity means this Config was built " +
        "outside the schema (a hand-built object), and 6i skipped the pin in exactly that case — " +
        "which let a hand-built config reach spawn with the check disabled. Build the Config " +
        "through loadConfig()/loadDiagnosticConfig(), which record the identity.",
      ok: false,
    };
  }
  {
    const now = binaryIdentity(config.KUBECTL_BIN);
    if (now !== config.KUBECTL_BIN_IDENTITY) {
      return {
        text:
          `kubectl was NOT executed: the binary at ${config.KUBECTL_BIN} is not the file that ` +
          `was there at config load (recorded ${JSON.stringify(config.KUBECTL_BIN_IDENTITY)}, ` +
          `found ${JSON.stringify(now === "" ? "(missing)" : now)}). A path is not a binary: ` +
          "spawn() resolves it at execution time, so a package upgrade — or a replaced file — " +
          "between load and this call would otherwise have run an executable this run's frozen " +
          "snapshot never saw. Restart the agent to re-resolve and re-record the binary.",
        ok: false,
      };
    }
  }

  let validatedServer = "";
  const localMode = isLocalEngine(config);
  if (localMode) {
    try {
      validatedServer = assertKubectlServerLocality(config);
    } catch (error) {
      return {
        text:
          "kubectl was NOT executed: " +
          (error instanceof Error ? error.message : String(error)),
        ok: false,
      };
    }
  }

  // Global flags rendered by the harness, never the model: `--context` pins the
  // context (unchanged), and `--server=<validated literal>` — UNCONDITIONALLY in
  // local mode — makes the endpoint kubectl is ASKED FOR a value this process
  // declared and validated, overriding the kubeconfig's `cluster.server` field at
  // spawn time. Both are global flags, not verbs — no write-capable surface is
  // added.
  const globalFlags: string[] = [];
  if (config.KUBE_CONTEXT !== "") globalFlags.push(`--context=${config.KUBE_CONTEXT}`);
  if (localMode) globalFlags.push(`--server=${validatedServer}`);
  const finalArgv = globalFlags.length === 0 ? argv : [...globalFlags, ...argv];

  return await new Promise<KubectlOutcome>((resolve) => {
    const child = spawn(config.KUBECTL_BIN, finalArgv, {
      env,
      shell: false,
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Bounded as the stream arrives, not after it closes. The previous version accumulated the whole stream in
    // memory and truncated at the end, so `kubectl logs` on a chatty container
    // could buffer tens of megabytes before anything capped it — the model's
    // context was protected, this process's heap was not. Now the cap is
    // enforced per chunk and the child is killed the moment it is reached: a
    // read-only tool has no reason to keep pulling bytes it has already
    // decided to discard.
    let stdout = "";
    let stderr = "";
    let killedForSize = false;
    const bound = createOutputBound(MAX_OUTPUT_CHARS, () => {
      killedForSize = true;
      child.kill("SIGTERM");
    });
    const append = (current: string, chunk: Buffer): string =>
      bound.append(current, chunk.toString());

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      resolve({ text: `kubectl could not be executed: ${error.message}`, ok: false });
    });
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" && !killedForSize) {
        resolve({ text: `kubectl timed out after ${TIMEOUT_MS / 1000}s.`, ok: false });
        return;
      }
      const body = stdout.trim() === "" ? stderr.trim() : stdout.trim();
      const truncated = bound.overflowed
        ? `${body}\n… [truncated at ${MAX_OUTPUT_CHARS} chars — narrow the query]`
        : body;
      const succeeded = code === 0 || killedForSize;
      resolve({
        text: succeeded
          ? truncated || "(no output — the query matched nothing)"
          : `kubectl exited ${code ?? "?"}:\n${truncated}`,
        ok: succeeded,
      });
    });
  });
}

/**
 * What this tool cannot reach, as one sentence.
 *
 * The description is asserted byte-for-byte in the offline check suite: this is a
 * refactor of a string that is part of the cached prompt prefix, and a single
 * character of drift would make every score measured before it incomparable.
 */
export const KUBECTL_ACCESS_LIMIT =
  "NAMESPACED ONLY: `namespace` is required, and " +
  "cluster-scoped kinds (nodes, PVs, CRDs, ClusterRoles, namespaces …) " +
  "plus Secrets are not in the resource list at all. If you need " +
  "node-level evidence, you cannot have it";

export function kubectlReadTool(config: Config) {
  return betaZodTool({
    name: "kubectl_read",
    description:
      "Run a READ-ONLY kubectl query against the homelab cluster as the " +
      "view-scoped ServiceAccount kube-system:sre-agent-ro. You do not write a " +
      "command line: you fill structured fields and the tool builds the " +
      "command. There is no way to pass raw flags, and only get / describe / " +
      `logs / events exist. ${KUBECTL_ACCESS_LIMIT} — say so in the report rather ` +
      "than guessing.",
    inputSchema: kubectlInputSchema,
    run: async (input) => {
      let argv: string[];
      try {
        argv = buildKubectlArgv(input);
      } catch (error) {
        // A refused input is a tool failure: the model asked for something the
        // boundary does not allow, and nothing was read.
        if (error instanceof RejectedError) return declareFailed(error.message);
        throw error;
      }
      const outcome = await runKubectl(argv, config);
      return declare(`$ kubectl ${argv.join(" ")}\n\n${outcome.text}`, outcome.ok);
    },
  });
}
