import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { WebhookPayload } from "./alert.js";
import { resolveSweepNamespaces } from "./sweepNamespace.js";
import type { Config } from "./config.js";
import { buildKubectlArgv, kubectlInputSchema } from "./tools/kubectl.js";
import { promqlInputSchema } from "./tools/promql.js";
import { declaredToolStatus, withoutStatus } from "./tools/status.js";
import { isAgentToolName, type AgentToolName } from "./toolCalls.js";
// Type-only in the other direction (`contextWindow` imports `SweepPlan` as a
// type), so this is not a runtime cycle. The caps live in one place and the
// budget is derived from them rather than from a second copy.
import { toolOutputCapChars } from "./contextWindow.js";

/**
 * ## Read-only by the same construction as everything else
 *
 * The sweep holds no verb the model does not hold. `SWEEP_TOOLS` is a closed
 * two-element set, every kubectl step's `subcommand` comes from
 * {@link READ_SUBCOMMANDS}, and every step's input is validated against the
 * tool's own Zod schema before it is planned — so a step that could not be
 * expressed by the model cannot be expressed here either. A write verb is not
 * refused; it is unrepresentable.
 */

/** The only tools a sweep may use. Both are read-only by construction. */
export const SWEEP_TOOLS = ["promql_query", "kubectl_read"] as const;
export type SweepToolName = (typeof SWEEP_TOOLS)[number];

/**
 * The only kubectl verbs a sweep may use — a subset of the tool's own enum, so
 * this list can only ever narrow the surface, never widen it.
 */
export const READ_SUBCOMMANDS = ["get", "describe", "logs", "events"] as const;

/**
 * How far back the class-independent posture range query looks, and at what
 * resolution. Six hours is long enough to show the start of an ingestion gap
 * that fired an overnight alert and short enough to stay one series.
 */
const POSTURE_LOOKBACK_SECONDS = 6 * 60 * 60;
const POSTURE_STEP_SECONDS = 300;

/** Log lines a sweep pulls. Deliberately far below the tool's 5000 ceiling. */
const SWEEP_TAIL_LINES = 200;
/** How far back a sweep reads logs. */
const SWEEP_LOG_SINCE = "2h";

/**
 * At most this many namespaces are swept. An alert naming five namespaces is a
 * grouped alert, and sweeping all of them would spend the model's context on
 * breadth it did not ask for.
 */
export const MAX_SWEPT_NAMESPACES = 2;

// ---------------------------------------------------------------------------
// Alert classification

/**
 * The alert classes this platform's rules actually produce, plus the honest
 * fallback. Deliberately few: a class exists here only when a competent
 * responder would run a *different* first set of queries for it.
 */
export const ALERT_CLASSES = [
  "metric-absence",
  "pod-unhealthy",
  "job-failed",
  "unclassified",
] as const;
export type AlertClass = (typeof ALERT_CLASSES)[number];

/**
 * Every contiguous run of *whole words* in an alertname, lower-cased and joined.
 *
 * ## Why this exists
 *
 * The fix is to make a component name unable to capture a class named later: a
 * term matches only when it spans **complete words** of the alertname. The
 * alertname is split on camel-case and on any non-alphanumeric run, and every
 * contiguous sequence of the resulting words is joined. `TargetDown` yields
 * `target`, `targetdown`, `down` — so `down` matches. `ArtifactDownloadJobFailed`
 * yields `download` but never `down` — so it falls through to `jobfailed`, which
 * it really is.
 *
 * Exported so the check suite can assert the tokenisation directly rather than
 * only its consequences.
 */
export function alertnameWordSequences(alertname: string): Set<string> {
  const words = alertname
    // `fooBar` → `foo Bar`, and `HTTPServer` → `HTTP Server`: the two camel
    // seams, in the order that leaves an acronym whole.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
  const sequences = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    let joined = "";
    for (let end = start; end < words.length; end += 1) {
      joined += words[end];
      sequences.add(joined);
    }
  }
  return sequences;
}

/**
 * The inflections a term is allowed to carry and still be the same term.
 *
 * `CrashLooping` is `crashloop` + `ing`; `OOMKilled` is `oomkill` + `ed`. A
 * closed, tiny list rather than a stemmer: each entry is an ending a rule author
 * would otherwise have to enumerate by hand, and nothing here can turn `down`
 * into `download` — that is the whole property this list must not break.
 */
const TERM_INFLECTIONS = ["", "s", "es", "ed", "ing"] as const;

function alertnameHasTerm(sequences: ReadonlySet<string>, term: string): boolean {
  return TERM_INFLECTIONS.some((suffix) => sequences.has(term + suffix));
}

/**
 * The classifier, stated as data.
 */
const CLASSIFIERS: ReadonlyArray<{ alertClass: AlertClass; terms: readonly string[] }> = [
  {

    alertClass: "metric-absence",
    terms: ["down", "absent", "missing", "notscraped", "scrapefailed", "targetdown", "watchdog", "deadmans"],
  },
  {
    alertClass: "pod-unhealthy",
    terms: ["crashloop", "podnotready", "containerwaiting", "podrestart", "oomkill", "imagepull", "initcontainer"],
  },
  {
    alertClass: "job-failed",
    terms: ["jobfailed", "jobcompletion", "jobnotcompleted", "cronjob"],
  },
];

export type AlertClassification = {
  alertClass: AlertClass;
  /** The alertname the decision was made from, verbatim. */
  alertname: string;
  /** Which rule decided, so a reader never has to re-derive it. */
  decidedBy: string;
};

/** The alertname in label-precedence order — the same order `alertName` uses. */
function alertnameOf(payload: WebhookPayload): string {
  return (
    payload.groupLabels["alertname"] ??
    payload.commonLabels["alertname"] ??
    payload.alerts[0]?.labels["alertname"] ??
    ""
  );
}

export function classifyAlert(payload: WebhookPayload): AlertClassification {
  const alertname = alertnameOf(payload);
  const sequences = alertnameWordSequences(alertname);
  for (const rule of CLASSIFIERS) {
    const term = rule.terms.find((candidate) => alertnameHasTerm(sequences, candidate));
    if (term !== undefined) {
      return {
        alertClass: rule.alertClass,
        alertname,
        decidedBy: `alertname contains the whole word-sequence "${term}"`,
      };
    }
  }
  return {
    alertClass: "unclassified",
    alertname,
    decidedBy:
      alertname === ""
        ? "the payload carries no alertname"
        : "no class rule matches this alertname",
  };
}

/**
 * A label read straight off the alert, or `undefined`.
 *
 * Alert labels are AlertManager's, not the model's — but they are still input,
 * and every value read here goes on to be validated against a tool schema
 * before it is planned. A label that cannot pass the schema drops the step
 * (with the reason recorded) rather than being coerced into one that fits.
 */
function label(payload: WebhookPayload, key: string): string | undefined {
  const value =
    payload.groupLabels[key] ??
    payload.commonLabels[key] ??
    payload.alerts[0]?.labels[key];
  return value === undefined || value.trim() === "" ? undefined : value;
}

// ---------------------------------------------------------------------------
// The plan

/**
 * What a step is worth when the aggregate budget cannot hold everything.
 *
 * Three bands, and the order between them is the whole of the prioritisation
 * policy — there is no per-step score to tune:
 */
export type SweepPriority = "posture" | "targeted" | "context";

const PRIORITY_RANK: Readonly<Record<SweepPriority, number>> = Object.freeze({
  posture: 0,
  targeted: 1,
  context: 2,
});

/**
 * What this sweep has already established about its OTHER steps, at the moment a
 * fallback fires.
 *
 * A fallback's disclosure has to say what is actually gone, and for a SELECTOR
 * read that is not the object the alert names. `job.pods` asks
 * `get pods --selector=job-name=X`: an empty answer establishes only that no pod
 * carries that label, which is true both when the Job was collected together
 * with its pods AND when the Job is alive and only its pods were removed — the
 * shape an `activeDeadlineSeconds` (DeadlineExceeded) kill leaves behind. This
 * sweep can tell those apart, because `job.describe` reads the Job itself and is
 * charged before `job.pods`. What it must not do is guess.
 *
 * Hence {@link SweepReadOutcome}, a genuine three-state answer rather than a
 * boolean: a positive read, an established absence, and everything else. The
 * third answer is a real answer — "this sweep did not establish it" — and never
 * a licence to pick one of the first two.
 */
export type SweepObservations = {
  read: (step: string) => SweepReadOutcome;
};

/**
 * What one step's read ESTABLISHED about the object it named.
 *
 * The first cut of this recorded a boolean — `isNotFound(result)` — for every
 * step that ran, which made "the read succeeded" the DEFAULT rather than an
 * observation. A `job.describe` that came back `Forbidden`, timed out, failed to
 * parse, or threw was stored as `false` and read downstream as "job.describe
 * READ the Job successfully", so an empty `job.pods` listing then told the model
 * and the human footer that the `JOB ITSELF STILL EXISTS` and had been killed by
 * `activeDeadlineSeconds` — an existence claim built on a read that never
 * happened. Only a positive read may license a positive claim, so the three
 * outcomes are named and the third is the one every unhandled path falls into:
 *
 *  - `found` — the step ran, DECLARED success, and its object was there.
 *  - `not-found` — the step established absence: a named read that came back
 *    `NotFound`, or a selector listing that succeeded with zero rows.
 *  - `unestablished` — anything else at all. Rejected by RBAC, timed out, threw,
 *    returned an undeclared result, or never ran (dropped by the budget, its
 *    tool unregistered). The object's state is unknown and must be reported as
 *    unknown.
 */
export type SweepReadOutcome = "found" | "not-found" | "unestablished";

export type SweepStep = {
  /**
   * Stable, class-keyed step id. Two alerts of the same class always produce the
   * same ordered list of these — that is the property the offline check suite
   * asserts, and it is what "keyed off the alert class" means operationally.
   */
  step: string;
  tool: SweepToolName;
  /**
   * The parameterised form of the step, with alert-supplied values written as
   * `${name}`. Two alerts of the same class have identical templates even when
   * their namespaces differ, so the template is the class-keyed identity and the
   * input is the instance.
   */
  template: string;
  input: Record<string, unknown>;
  /** Why a competent responder always runs this for this class. */
  why: string;
  /** What this step is worth when the aggregate budget binds. */
  priority: SweepPriority;
  /**
   * What to read instead when this step's object no longer exists.
   *
   * A CronJob alert names one Job instance. Kubernetes garbage-collects Job
   * history, so by the time the alert is investigated the named Job is often
   * gone and the read returns `NotFound` — on `watchdog-heartbeat-backoff` that
   * cost the Job describe AND the pod log, which is the scenario's decisive
   * artefact. The census dated the damage precisely: the two evidence checks
   * that depend on it passed on 2026-08-04 and 2026-08-05 and stopped passing
   * afterwards, while the same writer model still passes them on a replayed
   * transcript captured before the collection.
   *
   * The evidence is not gone, only the name is: sibling Jobs from the same
   * CronJob survive, and their pods still hold the log. So a step whose object
   * has been collected degrades to the workload it belongs to rather than
   * spending a cluster read on `NotFound`.
   *
   * `derive` receives the text already collected by this sweep and returns a
   * replacement input, or null when it cannot honestly build one. It is a
   * FALLBACK, never a first choice: it runs only after the primary has actually
   * come back not-found, so a healthy cluster produces byte-identical sweeps to
   * the ones this project has been grading all along.
   */
  fallback?: {
    step: string;
    why: string;
    /**
     * What the failed primary read actually ESTABLISHED — the clause the
     * disclosure banner opens with, and the reason the report footer prints.
     *
     * A function of {@link SweepObservations} rather than a constant, because
     * the answer is not the same for every step. A NAMED read (`describe jobs
     * X`, `logs jobs/X`) that comes back `NotFound` is the API server saying
     * that Job is gone. A SELECTOR listing that comes back empty is not: it
     * says nothing carries the label, and whether the Job survives is a
     * separate fact this sweep either read or did not.
     */
    absence: (observed: SweepObservations) => string;
    derive: (collected: string) => Record<string, unknown> | null;
  };
};

/**
 * A read that found nothing because the object it named is gone.
 *
 *  - `kubectl describe jobs <gone>` FAILS with `NotFound`.
 *  - `kubectl get pods --selector=job-name=<gone>` SUCCEEDS with "No resources
 *    found". Status ok, zero rows.
 *
 * Only the first triggered the fallback, so the pods listing never degraded, no
 * pod names were ever collected, and the log step's fallback had nothing to
 * derive from — the chain broke one link before the evidence it exists to
 * reach. An empty selector result is the same condition as a not-found name and
 * has to be treated as one.
 *
 * Scoped to steps that declare a fallback, so an ordinarily-empty read
 * elsewhere is not reinterpreted as a failure.
 */
export function isNotFound(
  resultText: string,
  options: {
    /**
     * Is this result a LISTING (`kubectl get …`)?
     */
    listing?: boolean;
  } = {},
): boolean {

  if (
    declaredToolStatus(resultText) !== "ok" &&
    /Error from server \(NotFound\)|NotFound: |not found in namespace|" not found/i.test(resultText)
  ) {
    return true;
  }
  return options.listing === true && isEmptyListing(resultText);
}

/**
 * A `kubectl get` that succeeded and returned zero rows.
 */
export function isEmptyListing(resultText: string): boolean {
  return /No resources found/i.test(resultText);
}

/**
 * Does this step read a LISTING — i.e. is an empty result the object being gone?
 *
 * Read off the step's own validated input, never off the result text: the
 * subcommand is what the harness asked for, and it is the only thing that says
 * whether zero rows means "gone" or "the log said so".
 */
export function stepReadsListing(step: { tool: SweepToolName; input: Record<string, unknown> }): boolean {
  return step.tool === "kubectl_read" && step.input["subcommand"] === "get";
}

/**
 * The `STATUS` values in a `get pods` listing that mean "this pod did not
 * succeed".
 *
 * Every entry is a status kubectl itself prints (`printPod` in kube-printers,
 * plus the container-waiting/terminated reasons it surfaces there). Matching is
 * case-insensitive because these are read from a text column, and word-bounded
 * so a status is never matched inside a pod name. Deliberately absent:
 * `Completed`, `Running`, `Succeeded`, `Pending` — a pod still starting is not a
 * failure, and treating it as one would substitute a log that does not exist yet.
 */

export function podStatusCell(line: string): string | undefined {
  const fields = line.trim().split(/\s+/);
  const ready = fields.findIndex((f) => /^\d+\/\d+$/.test(f));

  if (ready < 1) return undefined;
  return fields[ready + 1];
}

const POD_FAILURE_STATUS_RE =
  /\b(Error|Failed|Evicted|Unknown|ContainerStatusUnknown|CrashLoopBackOff|OOMKilled|ImagePullBackOff|ErrImagePull|ErrImageNeverPull|InvalidImageName|CreateContainerError|CreateContainerConfigError|RunContainerError|ContainerCannotRun|StartError|DeadlineExceeded|NodeLost|NodeAffinity|NodeShutdown|OutOf[A-Za-z]+)\b/i;

/**
 * The newest pod of a CronJob's family, chosen from text the sweep already read.
 *
 * CronJob Job names end in the schedule time in whole minutes since the epoch
 * (`watchdog-heartbeat-29764894`), so the largest suffix is the most recent
 * occurrence — an ordering that is exact rather than a heuristic over `AGE`
 * strings. Returns null when nothing matches, which is the honest answer: a
 * fallback that guesses a pod name would fabricate the evidence this whole
 * dimension exists to verify.
 */
export function newestPodOfFamily(collected: string, jobName: string): string | null {
  const family = jobName.replace(/-\d+$/, "");
  if (family === jobName) return null;
  const re = new RegExp(`\\b${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)-[a-z0-9]{5}\\b`, "g");

  //  1. A Job and its pods are separate objects with separate lifetimes. The
  //     Job named by this alert is gone, but `watchdog-heartbeat-29764894-xvhjj`
  //     — that same Job's own pod — is still listed and still returns its log.
  //     Substituting a sibling while the actual pod is sitting in the listing
  //     labels the evidence as belonging to a different object for no reason.
  //  2. When the alert's own pod really is gone, the newest sibling is often a
  //     later, HEALTHY run: the first live probe read one logging "heartbeat
  //     pushed". Handing back the most recent success as a substitute for a
  //     failure is worse than returning nothing, because it reads as evidence
  //     that the workload is fine.
  //
  // Status comes from the pod's own row in the listing this sweep already
  // collected (`get pods -o wide`), never guessed. Falling all the way through
  // to the newest sibling is still a legitimate "the family is healthy" reading,
  // and the caller labels it a sibling either way.
  const own = new RegExp(`\\b${jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-z0-9]{5}\\b`);
  const exact = own.exec(collected)?.[0];
  if (exact !== undefined) return exact;

  let newest: { name: string; when: number } | null = null;
  let newestFailed: { name: string; when: number } | null = null;
  for (const line of collected.split("\n")) {

    const status = podStatusCell(line);
    const failed = status !== undefined && POD_FAILURE_STATUS_RE.test(status);
    for (const m of line.matchAll(re)) {
      const cand = { name: m[0], when: Number(m[1]) };
      if (newest === null || cand.when > newest.when) newest = cand;
      if (failed && (newestFailed === null || cand.when > newestFailed.when)) newestFailed = cand;
    }
  }
  return (newestFailed ?? newest)?.name ?? null;
}

export type SweepSkip = {
  step: string;
  tool: string;
  /** Why the step was planned at all, kept so a skip is never silent. */
  why: string;
  /** Why it was dropped: an unusable label, or a tool this deployment lacks. */
  reason: string;
};

/**
 * A step trimmed or dropped to stay inside the sweep's aggregate budget.
 */
export type SweepElision = {
  step: string;
  tool: SweepToolName;
  /** Why the step was planned at all, kept so an elision is never silent. */
  why: string;
  /** `trimmed`: part of the result reached the model. `dropped`: none of it did. */
  disposition: "trimmed" | "dropped";
  /** The declared aggregate budget this was measured against, in characters. */
  budgetChars: number;
  /** What the step produced, in characters. 0 when it was never run. */
  collectedChars: number;
  /** What reached the model's context, in characters. */
  keptChars: number;
  /** The whole of it, in one sentence, for the footer. */
  reason: string;
};

/**
 * The sweep's **declared** aggregate evidence ceiling, in characters.
 *
 * ## Why 60 000
 *
 * It is 15 000 tokens at `CHARS_PER_TOKEN`. Beside the measured overhead
 * (system prompt + tool schemas + alert ≈ 5.3k tokens) and the 16 000-token
 * generation allowance, a scaffolded run of any class at `MAX_SWEPT_NAMESPACES`
 * lands near 36.3k against a 40 960-token window — roughly 11% headroom, which
 * is deliberate rather than leftover: `CHARS_PER_TOKEN = 4` is optimistic for
 * kubectl JSON and log lines, so the requirement is a floor and a floor with no
 * margin is a guess. It also leaves the model room for a first call of its own,
 * which the gate does not otherwise account for (see docs/safety-model.md).
 *
 * It is a *ceiling*, not an allocation: {@link planSweep} declares the smaller of
 * this and what the planned steps could possibly produce, so a short plan is
 * charged what it can actually cost rather than what it is allowed to cost.
 */
export const SWEEP_EVIDENCE_BUDGET_CHARS = 60_000;

/**
 * Below this, a truncated result is not worth its own place in the transcript.
 *
 * A 500-character fragment of a `describe` is not weak evidence, it is
 * *misleading* evidence: it reads as complete, and the model has no way to know
 * what the rest said. So a step that cannot be given at least this much is
 * dropped whole and recorded, rather than being handed a stub.
 */
export const MIN_USEFUL_EVIDENCE_CHARS = 2_000;

export type SweepPlan = {
  classification: AlertClassification;
  steps: SweepStep[];
  skipped: SweepSkip[];
  namespaces: string[];
  /** Namespace provenance or an explicit unresolved declaration. */
  namespaceNote?: string;
  /**
   * The aggregate character ceiling `executeSweep` will hold this plan to.
   */
  evidenceBudgetChars: number;
};

function validate(
  tool: SweepToolName,
  input: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const schema = tool === "kubectl_read" ? kubectlInputSchema : promqlInputSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `the tool's own schema rejects this input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  if (tool === "kubectl_read") {
    // Second belt, and the one that is a *property* rather than a check: argv is
    // rendered by the tool's own builder, so a sweep step's command line is the
    // same literal-only argv a model-issued call would produce. A builder
    // rejection (an argument combination the boundary refuses) drops the step
    // here rather than becoming a failed call at run time.
    try {
      buildKubectlArgv(parsed.data as never);
    } catch (error) {
      return {
        ok: false,
        reason: `the kubectl argv builder refuses this input: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  return { ok: true };
}

/**
 * Build the sweep for an alert. Pure: no I/O, no clock, no cluster. Given the
 * same payload it returns the same plan, which is what makes the class-keying
 * assertable offline.
 */
export function planSweep(payload: WebhookPayload): SweepPlan {
  const classification = classifyAlert(payload);
  const resolved = resolveSweepNamespaces(payload, classification.alertClass === "metric-absence");
  const namespaces = resolved.namespaces.slice(0, MAX_SWEPT_NAMESPACES);
  const steps: SweepStep[] = [];
  const skipped: SweepSkip[] = [];

  const add = (step: SweepStep): void => {
    const verdict = validate(step.tool, step.input);
    if (verdict.ok) steps.push(step);
    else skipped.push({ step: step.step, tool: step.tool, why: step.why, reason: verdict.reason });
  };

  // ---- 1. Observability posture, every class, always first.
  add({
    step: "posture.ingestion-now",
    tool: "promql_query",
    template: "count(up)",
    input: { query: "count(up)" },
    why: "establish observability posture before anything else: every promql_query result carries a measured ingestion-freshness verdict, and an empty vector is only readable as health when that verdict says INGESTION LIVE (F3)",
    priority: "posture",
  });
  add({
    step: "posture.ingestion-history",
    tool: "promql_query",
    template: `count(up) over ${POSTURE_LOOKBACK_SECONDS}s / ${POSTURE_STEP_SECONDS}s`,
    input: {
      query: "count(up)",
      range: {
        lookback_seconds: POSTURE_LOOKBACK_SECONDS,
        step_seconds: POSTURE_STEP_SECONDS,
      },
    },
    why: "when scrape coverage changed, if it did — the range query is what tells an ingestion gap apart from a quiet cluster, and it is the query the WAL-EIO incident was missed for want of",
    priority: "posture",
  });

  // ---- 2. Namespace context, every class that named a namespace.
  //
  // So the order is now least-valuable-first, which under front truncation means
  // most-valuable-survives: the broad namespace reads sit at the front where a
  // truncation would eat them, and the class-specific evidence sits behind them.
  // The posture queries stay ahead of both: they are the frame every later result
  // is read through, they are the smallest section by a wide margin, and the
  // aggregate budget below now makes an overflow the exception rather than the
  // expected case — this ordering is the second line of defence, not the first.
  for (const namespace of namespaces) {
    add({
      step: "workload.pods",
      tool: "kubectl_read",
      template: "get pods --namespace=${namespace} --output=wide",
      input: { subcommand: "get", namespace, resource: "pods", output: "wide" },
      why: "what is running in the alert's namespace and what is not — the read that puts the alert's own claim beside the cluster's state",
      priority: "context",
    });
    add({
      step: "workload.events",
      tool: "kubectl_read",
      template: "events --namespace=${namespace}",
      input: { subcommand: "events", namespace },
      why: "the namespace event stream: scheduling failures, image pulls, probe failures and OOM kills that no metric names",
      priority: "context",
    });
  }

  if (namespaces.length === 0) {
    skipped.push({
      step: "workload.pods",
      tool: "kubectl_read",
      why: "what is running in the alert's namespace and what is not",
      reason: "No namespace could be resolved; see the namespace note above.",
    });
  }

  // ---- 3. Class-specific evidence, last and therefore furthest from the front.
  switch (classification.alertClass) {
    case "metric-absence": {
      add({
        step: "absence.targets-down",
        tool: "promql_query",
        template: "up == 0",
        input: { query: "up == 0" },
        why: "which scrape targets are actually down, as distinct from which series stopped arriving — the distinction the whole class turns on",
        priority: "targeted",
      });
      break;
    }
    case "pod-unhealthy": {
      const pod = label(payload, "pod");
      const container = label(payload, "container");
      const namespace = namespaces[0];
      if (namespace === undefined || pod === undefined) {
        skipped.push({
          step: "pod.describe",
          tool: "kubectl_read",
          why: "the named pod's status, conditions and its own events",
          reason:
            "the alert names " +
            (namespace === undefined ? "no namespace" : "no pod") +
            ", so there is no object to describe",
        });
        break;
      }
      add({
        step: "pod.describe",
        tool: "kubectl_read",
        template: "describe pods ${pod} --namespace=${namespace}",
        input: { subcommand: "describe", namespace, resource: "pods", name: pod },
        why: "the named pod's status, conditions, restart count and its own events — the first thing a responder reads for a pod that is not running",
        priority: "targeted",
      });
      add({
        step: "pod.logs",
        tool: "kubectl_read",
        template:
          "logs ${pod} --namespace=${namespace}" +
          (container === undefined ? "" : " --container=${container}") +
          ` --tail=${SWEEP_TAIL_LINES} --since=${SWEEP_LOG_SINCE}`,
        input: {
          subcommand: "logs",
          namespace,
          name: pod,
          ...(container === undefined ? {} : { container }),
          tailLines: SWEEP_TAIL_LINES,
          since: SWEEP_LOG_SINCE,
        },
        why: "what the failing container itself said, verbatim — bounded to the recent window so the sweep cannot flood the model's context",
        priority: "targeted",
      });
      break;
    }
    case "job-failed": {
      const jobName = label(payload, "job_name");
      const namespace = namespaces[0];
      if (namespace === undefined || jobName === undefined) {
        skipped.push({
          step: "job.describe",
          tool: "kubectl_read",
          why: "the failed Job's spec, conditions and events",
          reason:
            "the alert names " +
            (namespace === undefined ? "no namespace" : "no job_name") +
            ", so there is no Job to read",
        });
        break;
      }
      add({
        step: "job.describe",
        tool: "kubectl_read",
        template: "describe jobs ${job_name} --namespace=${namespace}",
        input: { subcommand: "describe", namespace, resource: "jobs", name: jobName },
        why: "the failed Job's spec (backoffLimit, activeDeadlineSeconds), its conditions and its events — the difference between 'the workload failed' and 'the Job never got to run'",
        priority: "targeted",
        fallback: {
          step: "job.describe/family",
          // the `why` says UNFILTERED out loud. Jobs a CronJob creates
          // carry no stable family label, so there is nothing to select on and
          // the substitute is genuinely the whole namespace's Jobs — siblings
          // and unrelated workloads together. Describing it as "its surviving
          // siblings" overstated what the model is handed, and the model was
          // handed it with no banner at all until this change.
          why: "the namespace's Jobs are listed instead — UNFILTERED, because Jobs a CronJob creates carry no family label to select on: it may contain siblings or unrelated workloads, or be empty",
          // A NAMED read of the Job itself. `describe jobs <name>` coming back
          // NotFound IS the API server saying that Job no longer exists, so the
          // collected wording is earned here and stays.
          absence: () =>
            `the Job the alert names (${jobName}) has been garbage-collected — describing it by name returned NotFound`,
          derive: () => ({
            subcommand: "get",
            namespace,
            resource: "jobs",
            output: "wide",
          }),
        },
      });
      add({
        step: "job.pods",
        tool: "kubectl_read",
        template: "get pods --namespace=${namespace} --selector=job-name=${job_name} --output=wide",
        input: {
          subcommand: "get",
          namespace,
          resource: "pods",
          selector: `job-name=${jobName}`,
          output: "wide",
        },
        why: "the pods the Job actually created, and what state they ended in",
        priority: "targeted",
        fallback: {
          step: "job.pods/family",
          // this `why` used to open "because the named Job is gone",
          // which is the same unearned claim as the banner's and travels to the
          // same two places (the model's copy and the footer). What the empty
          // listing establishes is in `absence`; this field now says only what
          // the substitute IS.
          why: "the `job-name=` selector matched nothing, so the namespace's pods are listed instead — UNFILTERED by that selector, and this is what names the surviving pod the log step then reads",
          // A SELECTOR listing, so its emptiness is a fact about PODS. Whether
          // the Job survives is `job.describe`'s answer, and it is charged
          // before this step; all three of its answers are said out loud.
          absence: (observed) => {
            const nothingMatches = `no pod carries the label job-name=${jobName} any more`;
            switch (observed.read("job.describe")) {
              case "not-found":
                return `${nothingMatches}, and job.describe found the Job itself gone as well: it has been garbage-collected, and its pods with it`;
              case "found":
                return (
                  `${nothingMatches}, but job.describe READ the Job successfully in this same sweep, so the ` +
                  `JOB ITSELF STILL EXISTS and only its PODS are gone. That is what an activeDeadlineSeconds ` +
                  `(DeadlineExceeded) kill leaves behind: the Job object is still there to be read`
                );
              default:
                return (
                  `${nothingMatches}; this sweep holds no successful read of the Job itself — job.describe ` +
                  `either did not run or did not come back with a readable answer — so whether ${jobName} ` +
                  `still exists is UNESTABLISHED here and must not be asserted in either direction`
                );
            }
          },
          derive: () => ({
            subcommand: "get",
            namespace,
            resource: "pods",
            output: "wide",
          }),
        },
      });
      add({
        step: "job.logs",
        tool: "kubectl_read",
        template: `logs jobs/\${job_name} --namespace=\${namespace} --tail=${SWEEP_TAIL_LINES}`,
        input: {
          subcommand: "logs",
          namespace,
          resource: "jobs",
          name: jobName,
          tailLines: SWEEP_TAIL_LINES,
        },
        why: "what the Job's own container logged before it failed — the evidence that names the cause when the events only name the symptom",
        priority: "targeted",
        fallback: {
          step: "job.logs/newest-pod",
          why: "the Job object is gone, but its pods are separate objects and outlive it — this reads the alert's own pod if it survives, and otherwise the newest FAILED pod of the same CronJob",
          // A NAMED read again (`logs jobs/<name>`): NotFound on it is the Job
          // being absent, not its pods being absent — a Job that exists with no
          // pods fails this read differently ("no pods found for job"), which
          // `isNotFound` does not match, so the step stays a visible failure
          // rather than reaching this clause.
          absence: () =>
            `the Job the alert names (${jobName}) has been garbage-collected — reading its log by name returned NotFound`,
          derive: (collected) => {
            const pod = newestPodOfFamily(collected, jobName);
            return pod === null
              ? null
              : {
                  subcommand: "logs",
                  namespace,
                  resource: "pods",
                  name: pod,
                  tailLines: SWEEP_TAIL_LINES,
                };
          },
        },
      });
      break;
    }
    case "unclassified":
      break;
  }

  const capSumChars = steps.reduce((sum, step) => sum + toolOutputCapChars(step.tool), 0);

  return {
    classification,
    steps,
    skipped,
    namespaces,
    ...(resolved.note ? { namespaceNote: resolved.note } : {}),
    evidenceBudgetChars: Math.min(capSumChars, SWEEP_EVIDENCE_BUDGET_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Execution

export type SweepCall = {
  step: string;
  tool: SweepToolName;
  toolUseId: string;
  input: Record<string, unknown>;
  /**
   * The result **as the model receives it**, status marker included.
   *
   * Verbatim unless the aggregate budget bound, in which case it carries an
   * in-band truncation marker and the step also appears in
   * {@link SweepOutcome.elided}. It is the injected text rather than the
   * collected text on purpose: this is what attribution grades against, and a
   * field holding more than the model saw would let a report "cite" output that
   * never reached it.
   */
  result: string;
  /**
   * Did the tool declare success? Computed from the **collected** result, before
   * any budget trim — trimming is the harness's doing and must not be able to
   * turn a successful read into an undeclared one.
   */
  ok: boolean;
  /**
   * Set when the planned read hit NotFound and a fallback ran in its place.
   *
   * `step` is the fallback's own id (`job.describe/family`) and `input` is the
   * call that ACTUALLY ran, which is not the same object — and often not the
   * same shape — as {@link SweepCall.input}. Its presence is what makes a
   * degraded step distinguishable from a step that genuinely returned that
   * data: without it, `job.describe` on a garbage-collected Job is recorded as
   * a plain `ok` whose result happens to be a namespace-wide `get jobs`, which
   * reads exactly like a sweep that meant to list the namespace.
   *
   * `because` is what the failed primary read ESTABLISHED, resolved against
   * what this sweep had observed at the moment it fired. It is stored
   * rather than recomputed so the footer and the model's in-band banner cannot
   * drift into saying two different things about the same substitution.
   */
  substituted?: { step: string; input: Record<string, unknown>; because: string };
};

export type SweepOutcome = {

  enabled: boolean;
  /** Why the mode is what it is, in one clause, for the report. */
  because: string;
  plan?: SweepPlan;
  calls: SweepCall[];
  /**
   * Steps the aggregate budget trimmed or dropped. Never silent: every entry is
   * rendered in the report footer with its reason and its arithmetic.
   */
  elided: SweepElision[];
  /**
   * How many assistant turns the harness authored at the head of the
   * conversation. 0 or 1 today; read by `src/replay.ts` so that a scenario's
   * `expectedToolFailures` turn numbers keep meaning *model* turns.
   */
  injectedAssistantTurns: number;
  /** The conversation prefix to splice in after the user turn. */
  messages: unknown[];
};

export const SWEEP_DISABLED: SweepOutcome = {
  enabled: false,
  because: "SRE_AGENT_EVIDENCE_SWEEP is off",
  calls: [],
  elided: [],
  injectedAssistantTurns: 0,
  messages: [],
};

/**
 * The provenance line the harness writes into the conversation above its own
 * calls. It exists so that nothing downstream — a reader, a judge, a future
 * grader — has to infer from turn position who issued them.
 */
export function sweepPreamble(plan: SweepPlan): string {
  return (
    `[HARNESS EVIDENCE SWEEP. Alert class \`${plan.classification.alertClass}\` ` +
    `(${plan.classification.decidedBy}). The ${plan.steps.length} tool call(s) in this turn were ` +
    "issued by the harness, not chosen by the model: they are the fixed read-only reads a " +
    "competent responder always runs for this alert class. They are a floor, not a ceiling — " +
    "every tool remains available and further investigation is expected.]" +
    (plan.namespaceNote ? `\n\n${plan.namespaceNote}` : "")
  );
}

/**
 * Deterministic `tool_use` ids for the sweep.
 *
 * Deliberately recognisable rather than random. A model that reuses one collides
 * with a harness id, and `toolCallsFromMessages` **throws** on a collision
 * rather than guessing — which is the safe direction: an ambiguous transcript
 * refuses the run instead of attributing a result to the wrong call.
 */
export function sweepToolUseId(index: number): string {
  return `toolu_sweep_${String(index + 1).padStart(2, "0")}`;
}

/**
 * Cut a result down to an allowance, keeping the parts that carry meaning.
 */
function trimToAllowance(resultText: string, allowanceChars: number, budgetChars: number): string {
  const payload = withoutStatus(resultText);
  const statusTail = resultText.slice(payload.length);
  const marker = (keptChars: number): string =>
    `\n\n[HARNESS EVIDENCE BUDGET — TRUNCATED. This command returned ${resultText.length} ` +
    `characters; ${keptChars} of them are above. The harness holds its evidence sweep to a ` +
    `declared aggregate budget of ${budgetChars} characters so that the whole conversation fits ` +
    "the context window this run is actually served (see src/contextWindow.ts). THE REMAINDER " +
    "WAS NOT PLACED IN CONTEXT: do not read what is above as the complete output of this " +
    "command, and re-run it narrowed if you need the rest.]";
  // `marker(allowanceChars)` is never shorter than `marker(body.length)`, so
  // reserving against it keeps the result inside the allowance.
  const room = allowanceChars - statusTail.length - marker(allowanceChars).length;
  const body = payload.slice(0, Math.max(0, room));
  return body + marker(body.length) + statusTail;
}

/**
 * Run the plan against the tools the run registered, **inside the plan's
 * declared aggregate evidence budget**.
 *
 * `tools` is the very array `runTriage` hands the SDK. Lookup is by name, the
 * same way the runner resolves a `tool_use` block, so a tool this deployment did
 * not register (no Grafana ⇒ no `promql_query`) drops its steps with the reason
 * recorded — there is no second availability path to disagree with the first.
 *
 * ## The budget, and why it is honoured here rather than checked elsewhere
 *
 * They are **emitted in plan order**, which is a different order and
 * deliberately so: charging order is a value judgement about what to keep, and
 * injection order is a defence against front truncation (see `planSweep` §2).
 *
 * Nothing given up is given up silently. Every trim and every drop lands in
 * `elided`, is rendered in the report footer with its arithmetic, and — for a
 * trim — carries a marker in the text the model itself reads.
 */
export async function executeSweep(options: {
  plan: SweepPlan;
  tools: readonly BetaRunnableTool[];
  because: string;
}): Promise<SweepOutcome> {
  const { plan, tools } = options;
  const skipped = [...plan.skipped];
  const elided: SweepElision[] = [];
  const budgetChars = plan.evidenceBudgetChars;
  let remaining = budgetChars;

  type Collected = { content: string | unknown[]; isError: boolean; call: Omit<SweepCall, "toolUseId"> };
  const collected = new Map<number, Collected>();

  const primaryReads = new Map<string, SweepReadOutcome>();
  const observations: SweepObservations = {
    read: (id) => primaryReads.get(id) ?? "unestablished",
  };

  const chargingOrder = plan.steps
    .map((step, index) => ({ step, index }))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.step.priority] - PRIORITY_RANK[b.step.priority] || a.index - b.index,
    );

  for (const { step, index } of chargingOrder) {
    const tool = tools.find((t) => "name" in t && t.name === step.tool);
    if (tool === undefined || !("run" in tool)) {
      skipped.push({
        step: step.step,
        tool: step.tool,
        why: step.why,
        reason: `${step.tool} is not registered on this deployment, so the sweep cannot run it`,
      });
      continue;
    }

    const protectedStep = step.priority === "posture";

    if (!protectedStep && remaining < MIN_USEFUL_EVIDENCE_CHARS) {
      // Dropped BEFORE the read: the budget is about the model's context, but
      // there is no reason to spend a cluster read on evidence that could not be
      // shown anyway.
      elided.push({
        step: step.step,
        tool: step.tool,
        why: step.why,
        disposition: "dropped",
        budgetChars,
        collectedChars: 0,
        keptChars: 0,
        reason:
          `higher-priority evidence had already spent the sweep's declared ${budgetChars}-char ` +
          `aggregate budget down to ${remaining} chars, below the ${MIN_USEFUL_EVIDENCE_CHARS} a ` +
          "truncated result needs to be worth reading, so this step was NOT RUN and none of its " +
          "evidence is in the model's context",
      });
      continue;
    }

    // The SDK's own parse → run → catch pipeline, mirrored exactly
    // (`lib/tools/BetaToolRunner`): parse with the tool's schema, run, and turn
    // a thrown value into an `is_error` result. Mirrored rather than reused so
    // that the sweep cannot end up on a different contract from the loop if the
    // SDK's private runner changes shape.
    let content: string | unknown[];
    let isError = false;
    let substituted: SweepCall["substituted"];
    try {
      const parsed = "parse" in tool && tool.parse ? tool.parse(step.input) : step.input;
      content = (await tool.run(parsed)) as string | unknown[];
    } catch (error) {
      content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      isError = true;
    }

    let resultText = typeof content === "string" ? content : JSON.stringify(content);

    // the named object has been garbage-collected. Degrade to the
    // workload it belongs to rather than spending the step on NotFound.
    const stepNotFound = isNotFound(resultText, { listing: stepReadsListing(step) });

    primaryReads.set(
      step.step,
      stepNotFound
        ? "not-found"
        : !isError && declaredToolStatus(resultText) === "ok"
          ? "found"
          : "unestablished",
    );

    if (step.fallback !== undefined && stepNotFound) {
      const collectedSoFar = [...collected.values()]
        .map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c.content)))
        .join("\n");
      const input = step.fallback.derive(collectedSoFar);
      if (input === null) {
        skipped.push({
          step: step.fallback.step,
          tool: step.tool,
          why: step.fallback.why,
          reason:
            `${step.step} returned NotFound and the fallback could not identify a surviving ` +
            "object from what this sweep had already read, so nothing was substituted",
        });
      } else {
        try {
          const parsed = "parse" in tool && tool.parse ? tool.parse(input) : input;
          const recovered = (await tool.run(parsed)) as string | unknown[];
          const recoveredText =
            typeof recovered === "string" ? recovered : JSON.stringify(recovered);
          if (declaredToolStatus(recoveredText) !== "ok") {
            throw new Error("fallback did not declare success");
          }
          // Say which of the two it actually is. A substituted read that still
          // names the alert's own object (a Job's pod outliving the Job) is NOT
          // a sibling, and labelling it one would understate the evidence — the
          // report would disclaim a provenance it is entitled to.
          const named = typeof input.name === "string" ? input.name : "";
          const originalName = typeof step.input.name === "string" ? step.input.name : "";
          const sameObject = named !== "" && originalName !== "" &&
            (named === originalName || named.startsWith(`${originalName}-`));

          const because = step.fallback.absence(observations);
          resultText =
            `[${step.step} returned NotFound — ${because}. ` +
            `Substituted ${step.fallback.step}: ${step.fallback.why}. ` +
            (sameObject
              ? `This evidence is ${named} — the alert's OWN object, which outlived the one that was collected.]`
              : named === ""
                ? "This is an UNFILTERED namespace listing; no sibling relationship has been established.]"
                : "This evidence describes a SIBLING of the object named in the alert, NOT the " +
                "object itself, and it is not filtered to that object.]") +
            "\n\n" +
            recoveredText;

          content = resultText;
          substituted = { step: step.fallback.step, input, because };
          isError = false;
        } catch {
          // Both thrown errors and non-ok declarations retain the primary
          // NotFound. Record the unsuccessful fallback separately for the footer.
          skipped.push({
            step: step.fallback.step, tool: step.tool, why: step.fallback.why,
            reason: `${step.step} returned NotFound; fallback failed or did not declare success, so nothing was substituted`,
          });
        }
      }
    }

    // Computed from what the TOOL returned, not from what survives the budget:
    // a trim is the harness's doing and must not be able to relabel a successful
    // read as an undeclared one.
    const ok = !isError && declaredToolStatus(resultText) === "ok";

    let keptText = resultText;
    let keptContent = content;
    if (resultText.length > remaining) {
      if (!protectedStep && remaining < MIN_USEFUL_EVIDENCE_CHARS) {
        elided.push({
          step: step.step,
          tool: step.tool,
          why: step.why,
          disposition: "dropped",
          budgetChars,
          collectedChars: resultText.length,
          keptChars: 0,
          reason:
            `it returned ${resultText.length} chars and only ${remaining} of the declared ` +
            `${budgetChars}-char aggregate budget remained — below the ` +
            `${MIN_USEFUL_EVIDENCE_CHARS} a truncated result needs to be worth reading, so it was ` +
            "dropped whole rather than shown as a fragment that would read as complete",
        });
        continue;
      }
      keptText = trimToAllowance(resultText, remaining, budgetChars);
      keptContent = keptText;
      elided.push({
        step: step.step,
        tool: step.tool,
        why: step.why,
        disposition: "trimmed",
        budgetChars,
        collectedChars: resultText.length,
        keptChars: keptText.length,
        reason:
          `it returned ${resultText.length} chars but only ${keptText.length} fit inside the ` +
          `declared ${budgetChars}-char aggregate evidence budget; the injected result carries an ` +
          "in-band truncation marker at the cut, so the model is not reading a fragment as a whole",
      });
    }

    // Clamped rather than allowed to go negative. It cannot today — the budget
    // is never smaller than the posture steps' own caps, and every later step is
    // trimmed to what is left — but a floor here means a future step type cannot
    // turn an accounting slip into an overflow.
    remaining = Math.max(0, remaining - keptText.length);

    collected.set(index, {
      content: keptContent,
      isError,
      call: {
        step: step.step,
        tool: step.tool,
        input: step.input,
        result: keptText,
        ok,
        ...(substituted === undefined ? {} : { substituted }),
      },
    });
  }

  // Emission: PLAN order, not charging order, and the ids follow it so that
  // `sweepToolUseId(i)` still names the i-th call in the transcript.
  const calls: SweepCall[] = [];
  const toolUse: unknown[] = [];
  const toolResults: unknown[] = [];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const entry = collected.get(index);
    if (entry === undefined) continue;
    const toolUseId = sweepToolUseId(calls.length);
    calls.push({ ...entry.call, toolUseId });
    toolUse.push({
      type: "tool_use",
      id: toolUseId,
      name: entry.call.tool,
      // the call the model is shown is the call that RAN. A substituted
      // step used to advertise the planned input (`describe jobs <gc'd name>`)
      // above a result that was plainly a namespace-wide `get jobs`, which is
      // incoherent to a reader and unattributable to a grader — a report citing
      // what it was actually given matched no recorded invocation. The planned
      // input is not lost: it stays on `SweepCall.input`, and the banner inside
      // the result names both the step that failed and the fallback that ran.
      input: entry.call.substituted?.input ?? entry.call.input,
    });
    toolResults.push({
      type: "tool_result",
      tool_use_id: toolUseId,
      content: entry.content,
      ...(entry.isError ? { is_error: true } : {}),
    });
  }

  const planWithSkips: SweepPlan = { ...plan, skipped };

  if (calls.length === 0) {
    // Nothing ran — every step was dropped. Injecting an empty assistant turn
    // would be a lie in the conversation shape, so the run proceeds
    // un-scaffolded and SAYS SO rather than reporting a sweep that swept
    // nothing.
    return {
      enabled: true,
      because: options.because,
      plan: planWithSkips,
      calls: [],
      elided,
      injectedAssistantTurns: 0,
      messages: [],
    };
  }

  return {
    enabled: true,
    because: options.because,
    plan: planWithSkips,
    calls,
    elided,
    injectedAssistantTurns: 1,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: sweepPreamble(planWithSkips) }, ...toolUse],
      },
      { role: "user", content: toolResults },
    ],
  };
}

export function sweepEnabled(config: Config): boolean {
  return config.SRE_AGENT_EVIDENCE_SWEEP;
}

/**
 * The one line that says which mode produced an artefact.
 *
 * Written into the report header AND the metering footer AND the run
 * transcript. The 7b/7d pair is why: two runs whose difference was invisible in
 * their own artefacts got compared, and the comparison was worthless. A reader
 * of any output of this harness can tell scaffolded from autonomous without
 * being told which run they are holding.
 */
export function describeSweepMode(outcome: SweepOutcome): string {
  if (!outcome.enabled) {
    return (
      "AUTONOMOUS (evidence sweep OFF, `SRE_AGENT_EVIDENCE_SWEEP=off`) — the model chose " +
      "every tool call in this run itself. This is the un-scaffolded path."
    );
  }
  const plan = outcome.plan;
  const cls = plan?.classification.alertClass ?? "unknown";
  if (outcome.calls.length === 0) {
    return (
      `SCAFFOLDED, BUT EMPTY (evidence sweep ON, alert class \`${cls}\`) — every planned step ` +
      `was dropped (${plan?.skipped.length ?? 0} skipped), so no evidence was supplied and this ` +
      "run is autonomous in substance. Do not compare it with a scaffolded run."
    );
  }
  const failed = outcome.calls.filter((c) => !c.ok).length;
  const trimmed = outcome.elided.filter((e) => e.disposition === "trimmed").length;
  const dropped = outcome.elided.filter((e) => e.disposition === "dropped").length;
  const budgetNote =
    trimmed + dropped === 0
      ? ""
      : `; the aggregate evidence budget (${outcome.plan?.evidenceBudgetChars ?? 0} chars) ` +
        `trimmed ${trimmed} and dropped ${dropped} step(s)`;
  return (
    `SCAFFOLDED (evidence sweep ON, \`SRE_AGENT_EVIDENCE_SWEEP=on\`) — alert class ` +
    `\`${cls}\`, ${outcome.calls.length} harness-issued read-only call(s) injected before the ` +
    `model's first turn` +
    (failed > 0 ? `, of which ${failed} returned no data` : "") +
    (plan && plan.skipped.length > 0 ? `; ${plan.skipped.length} step(s) skipped` : "") +
    budgetNote +
    "."
  );
}

/**
 * The per-step provenance table for the report footer.
 *
 * Three dispositions, kept apart on purpose. **skipped** is a step that could not
 * be planned or run at all. **trimmed (budget)** and **dropped (budget)** are
 * steps the aggregate evidence budget gave up — a different fact, calling for a
 * different response (raise the served window, or narrow the sweep), and the one
 * a reader must never have to infer from an absence.
 */
export function sweepFooterLines(outcome: SweepOutcome): string[] {
  if (!outcome.enabled) return [];
  const namespaceLines = outcome.plan?.namespaceNote ? ["", outcome.plan.namespaceNote] : [];
  if (outcome.calls.length === 0 && outcome.elided.length === 0) return namespaceLines;
  const lines = [
    ...namespaceLines,
    "",
    "| sweep step | tool | outcome |",
    "|---|---|---|",
    // a substituted step is neither a plain `ok` nor a failure, and
    // collapsing it into `ok` is what let a garbage-collected Job produce a
    // namespace-wide listing that read as the answer to the question asked. The
    // footer is the one place a human sees the sweep's shape, so the
    // substitution is named there with the step that actually ran.
    // the footer carried the SAME fixed "the object the alert names was
    // garbage-collected" claim the model's banner carried, over every
    // substitution alike — so the human reading the report and the model
    // writing it were told the same wrong thing about a `job.pods` empty
    // listing. It prints the substitution's own recorded reason now, which is
    // byte-for-byte the clause the model was given.
    ...outcome.calls.map((c) => {
      const outcomeCell = c.ok ? "ok" : "**no data**";
      const cell =
        c.substituted === undefined
          ? outcomeCell
          : `${outcomeCell} — **substituted \`${c.substituted.step}\`**: ${c.substituted.because}, ` +
            "so this step did NOT read what it planned. The result is the substitute's, and the " +
            "model's copy says so in-band";
      return `| \`${c.step}\` | \`${c.tool}\` | ${cell} |`;
    }),
  ];
  for (const skip of outcome.plan?.skipped ?? []) {
    lines.push(`| \`${skip.step}\` | \`${skip.tool}\` | **skipped** — ${skip.reason} |`);
  }
  for (const elision of outcome.elided) {
    lines.push(
      `| \`${elision.step}\` | \`${elision.tool}\` | **${elision.disposition} (budget)** — ` +
        `${elision.reason} (read ${elision.collectedChars} chars, kept ${elision.keptChars}, ` +
        `budget ${elision.budgetChars})|`,
    );
  }
  return lines;
}

/**
 * Every tool a sweep can reach is one the model already holds, and every kubectl
 * step it can plan is a read verb. Exported so the check suite can assert the
 * property directly against a plan rather than against this file's prose.
 */
export function sweepIsReadOnly(plan: SweepPlan): boolean {
  return plan.steps.every((step) => {
    if (!(SWEEP_TOOLS as readonly string[]).includes(step.tool)) return false;
    if (!isAgentToolName(step.tool as AgentToolName)) return false;
    if (step.tool !== "kubectl_read") return true;
    const subcommand = step.input["subcommand"];
    return (
      typeof subcommand === "string" &&
      (READ_SUBCOMMANDS as readonly string[]).includes(subcommand)
    );
  });
}
