/**
 * Subscription-mode poller: what replaces the AlertManager webhook.
 *
 * Grouping is the cost control that matters. The live cluster on 2026-09-02
 * carried 9 firing series that were 4 incidents: three `KubeJobFailed` for
 * successive `watchdog-heartbeat-<n>` Jobs are one CronJob problem, and the
 * agent should be asked about it once a day, not once per Job. A group key is
 * `alertname | namespace | subject`, where the subject is the CronJob stem for
 * Job alerts (`cronJobStem`, the same function the mutation safety check uses),
 * the workload stem for pod alerts, or the named deployment/statefulset/
 * daemonset/node otherwise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { webhookPayloadSchema, type WebhookPayload } from "../alert.js";
import type { RejectionSummary } from "../publication.js";
import type { Config } from "../config.js";
import { cronJobStem } from "../mutations.js";
import { promInstantQuery, promqlAvailable, type PromResponse } from "../tools/promql.js";
import { ledgerPath, monthOf, monthSpend, readLedger, budgetVerdict, describeBudget } from "./budget.js";
import { loadSubscriptionConfig, type SubConfig } from "./config.js";
import { fileIssue, isIssueRecord, issueRecordFrom, issueTargetFromEnv, ISSUE_MODES, type IssueMode, type IssueRecord } from "./issues.js";
import { EXIT_AUTH, EXIT_BUDGET, EXIT_CONFIG, EXIT_OK, EXIT_PUBLICATION_REJECTED, EXIT_USAGE_LIMIT, PROJECT_ROOT, readClaudeVersion, runSubscriptionTriage, supportedClaudeVersions, type RunOutcome } from "./run.js";

/**
 * the triage published but filing its Forgejo issue failed. The triage
 * itself stands (its cooldown is set); tools/sub-poll sends one STATUS.
 */
export const EXIT_ISSUE_FAILED = 8;

/** Alerts that are health signals, never incidents. */
export const IGNORED_ALERTNAMES: ReadonlySet<string> = new Set(["Watchdog", "InfoInhibitor"]);
export const FIRING_QUERY = 'ALERTS{alertstate="firing"}';
export const FOR_STATE_QUERY = "ALERTS_FOR_STATE";

export type FiringSeries = { labels: Record<string, string>; activeSince?: string };

export type AlertGroup = {
  key: string;
  alertname: string;
  namespace: string;
  subject: string;
  severity: string;
  members: FiringSeries[];
};

export function workloadStem(pod: string): string {
  const deployment = /^(.+)-[a-f0-9]{7,10}-[a-z0-9]{5}$/.exec(pod);
  if (deployment?.[1] !== undefined) return deployment[1];
  const statefulset = /^(.+)-\d+$/.exec(pod);
  if (statefulset?.[1] !== undefined) return statefulset[1];
  const daemonset = /^(.+)-[a-z0-9]{5}$/.exec(pod);
  if (daemonset?.[1] !== undefined) return daemonset[1];
  return pod;
}

/**
 * Exact scrape job/service identities and exporter workload stems; never infer from
 * a name prefix or container label. Add a renamed exporter's stem here explicitly.
 */
export const SCRAPER_LABEL_DENYLIST: ReadonlySet<string> = new Set([
  // Captured kube_job_failed results carry this job and service.
  "kube-state-metrics", "kube-prometheus-stack-kube-state-metrics",

  "node-exporter", "kube-prometheus-stack-prometheus-node-exporter",

  "prometheus-node-exporter",
  // The KubeletDown expression scrapes this job.
  // kube-prometheus-stack also scrapes cadvisor as job="kubelet", not "cadvisor".
  "kubelet",

  "blackbox-exporter",
]);

function isScrapeMetadataPod(labels: Record<string, string>, pod: string): boolean {
  const knownScraper = [labels["job"], labels["service"]]
    .some((value) => value !== undefined && SCRAPER_LABEL_DENYLIST.has(value));
  const exporterPod = SCRAPER_LABEL_DENYLIST.has(workloadStem(pod));
  // Match only the pod's workload: KSM's container label can name the exporter
  // while pod names the target. KubePod*/KubeContainer* health alerts describe
  // that pod itself, even when it IS the exporter; node/filesystem metrics can carry
  // the same pod as scrape metadata, so workload identity alone is insufficient.
  const selfHealth = /^(?:KubePod|KubeContainer)/.test(labels["alertname"] ?? "") && exporterPod;
  return knownScraper && exporterPod && !selfHealth;
}

export function groupSubject(labels: Record<string, string>): string {
  const job = labels["job_name"];
  if (job !== undefined && job !== "") return cronJobStem(job) ?? job;
  for (const key of ["cronjob", "deployment", "statefulset", "daemonset", "horizontalpodautoscaler", "persistentvolumeclaim", "persistentvolume", "resourcequota"]) {
    const value = labels[key];
    if (value !== undefined && value !== "") return value;
  }
  const name = labels["name"];
  // The controller's captured job spelling is in fixtures/queries/prometheus-wal-eio.queries.json.
  // App sync metrics carry project but can lack dest_namespace; controller queues
  // also carry name, so a known job alone is insufficient. Aggregated app-info
  // alerts can drop job; require BOTH app labels in that case.
  const argoApp = Boolean(labels["project"]) && (
    ["argocd-metrics", "argocd-application-controller", "argocd-application-controller-metrics"].includes(labels["job"] ?? "")
    || Boolean(labels["dest_namespace"]));
  if (name !== undefined && name !== "" && argoApp) return name;
  const pod = labels["pod"];
  if (pod !== undefined && pod !== "" && !isScrapeMetadataPod(labels, pod)) return workloadStem(pod);
  for (const key of ["node", "instance"]) {
    const value = labels[key];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2, none: 3 };

export function groupFiring(series: readonly FiringSeries[]): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const s of series) {
    const alertname = s.labels["alertname"] ?? "";
    if (alertname === "" || IGNORED_ALERTNAMES.has(alertname)) continue;
    const severity = s.labels["severity"] ?? "none";
    if (severity === "info" || severity === "none") continue;
    const namespace = s.labels["namespace"] ?? "";
    const subject = groupSubject(s.labels);
    const key = `${alertname}|${namespace}|${subject}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { key, alertname, namespace, subject, severity, members: [s] });
    else existing.members.push(s);
  }
  return [...groups.values()].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    return a.key.localeCompare(b.key);
  });
}

function stripInternal(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (k === "__name__" || k === "alertstate") continue;
    out[k] = v;
  }
  return out;
}

function commonLabels(members: readonly FiringSeries[]): Record<string, string> {
  const first = members[0];
  if (first === undefined) return {};
  const common: Record<string, string> = { ...stripInternal(first.labels) };
  for (const m of members.slice(1)) {
    for (const key of Object.keys(common)) {
      if (m.labels[key] !== common[key]) delete common[key];
    }
  }
  return common;
}

/** The webhook-shaped payload `runTriage`'s prompts and sweep planner expect. */
export function payloadForGroup(group: AlertGroup, now: Date): WebhookPayload {
  const raw = {
    version: "4",
    groupKey: group.key,
    status: "firing",
    receiver: "sre-agent-sub-poll",
    groupLabels: { alertname: group.alertname, ...(group.namespace === "" ? {} : { namespace: group.namespace }) },
    commonLabels: commonLabels(group.members),
    commonAnnotations: {
      summary: `Synthesised by the subscription-mode poller from ${group.members.length} firing ALERTS series at ${now.toISOString()}. Alert annotations are not in ALERTS; read the rule for them.`,
    },
    alerts: group.members.map((m) => ({
      status: "firing",
      labels: stripInternal(m.labels),
      annotations: {},
      ...(m.activeSince === undefined ? {} : { startsAt: m.activeSince }),
    })),
  };
  return webhookPayloadSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Fetching

type PromVector = { metric: Record<string, string>; value?: [number, string] };

function vectorOf(body: PromResponse): PromVector[] {
  return (body.data?.result ?? []).map((row) => ({
    metric: row.metric ?? {},
    ...(row.value === undefined ? {} : { value: row.value }),
  }));
}

function signature(labels: Record<string, string>): string {
  return Object.entries(stripInternal(labels))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

export async function fetchFiring(config: Config): Promise<FiringSeries[]> {
  const firing = vectorOf(await promInstantQuery(config, FIRING_QUERY));
  const since = new Map<string, string>();
  try {
    for (const row of vectorOf(await promInstantQuery(config, FOR_STATE_QUERY))) {
      const seconds = Number.parseFloat(row.value?.[1] ?? "");
      if (Number.isFinite(seconds)) since.set(signature(row.metric), new Date(seconds * 1000).toISOString());
    }
  } catch {
    // ALERTS_FOR_STATE is optional context; a failure here costs startsAt, not the poll.
  }
  return firing.map((row) => {
    const activeSince = since.get(signature(row.metric));
    return { labels: row.metric, ...(activeSince === undefined ? {} : { activeSince }) };
  });
}

// ---------------------------------------------------------------------------
// State

/**
 * One firing series as a refused run saw it: its labels minus scrape addressing
 * (`memberMark`), and its `activeSince` when ALERTS_FOR_STATE supplied one.
 */
export type MemberMark = { labels: string; since?: string };

export type PollGroupState = {
  /** Set ONLY by a run that published a report (exit 0 + reportPath). */
  lastTriagedAt?: string;
  /** Set by any run that was attempted, successful or not. */
  lastAttemptAt?: string;
  lastSeenAt: string;
  runs: number;
  lastReport?: string;
  lastExit?: number;

  rejectedAt?: string;
  /** The firing members that refused run was asked about. */
  rejectedMembers?: MemberMark[];
  /** The most severe `severity` among them. */
  rejectedSeverity?: string;
  /** the Forgejo issue this group's triages go to while it stays open. */
  issue?: IssueRecord;
};

export type PollState = {
  groups: Record<string, PollGroupState>;
};

/**
 * How long a FAILED attempt suppresses its incident. A failure
 * used to write `lastTriagedAt`, so an expired OAuth token or a malformed result
 * silently retired the incident for the full 24-hour cooldown — the poller
 * claimed a triage that never happened. Failures now get an hour: long enough
 * not to hammer a broken login, short enough that fixing it brings the incident
 * back the same evening.
 */
export const FAILURE_BACKOFF_MS = 3_600_000;

/**
 * `SRE_SUB_REJECT_BACKOFF_HOURS` default: how long a SAFETY-REJECTED attempt suppresses its group while the group's alerts are unchanged.
 *
 * A rejection is not a transient failure like an expired login. The model did
 * the whole investigation and answered; the harness refused to publish the
 * answer. Asking again an hour later about the same alerts mostly buys the same
 * answer — measured 2026-10-06 → 10-11: 33 of 38 poller runs were refused, all
 * KubeJobFailed groups whose stale failed Jobs the model kept proposing to
 * `kubectl delete`, each re-run after the one-hour failure backoff and each a
 * STATUS notification. So a refusal is held like a published triage (24 h by
 * default, the same as SRE_SUB_POLL_COOLDOWN_HOURS) unless the alerts it was
 * about have changed (`rejectionReleased`). 0 restores the one-hour backoff.
 */
export const DEFAULT_REJECT_BACKOFF_HOURS = 24;

export function statePath(stateDir: string): string {
  return path.join(stateDir, "sub-poll-state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one persisted group. The file is the poller's own, but it is also a
 * plain JSON file a person can edit, and a rejection record that does not
 * parse must cost that record — never the poll. Problems go to `problems`.
 */
function normalizeGroup(key: string, raw: unknown, problems: string[]): PollGroupState | undefined {
  if (!isRecord(raw)) {
    problems.push(`state: dropped group ${JSON.stringify(key)}: not an object`);
    return undefined;
  }
  const group = { ...raw } as Record<string, unknown>;
  for (const field of ["lastTriagedAt", "lastAttemptAt"] as const) {
    if (group[field] !== undefined && !Number.isFinite(parseTime(group[field]))) {
      problems.push(`state: ${key}: dropped unparseable ${field}`);
      delete group[field];
    }
  }
  const hasRecord = group["rejectedAt"] !== undefined || group["rejectedMembers"] !== undefined || group["rejectedSeverity"] !== undefined;
  if (hasRecord && !Number.isFinite(parseTime(group["rejectedAt"]))) {
    problems.push(`state: ${key}: dropped a rejection record with no valid rejectedAt (the group falls back to the 1 h failure backoff)`);
    delete group["rejectedAt"];
    delete group["rejectedMembers"];
    delete group["rejectedSeverity"];
  } else if (hasRecord) {
    const members = group["rejectedMembers"];
    if (members !== undefined) {
      const valid = Array.isArray(members) ? members.filter(isMemberMark) : [];
      if (!Array.isArray(members) || valid.length !== members.length) {
        problems.push(`state: ${key}: dropped ${Array.isArray(members) ? members.length - valid.length : "all"} malformed rejectedMembers entr${Array.isArray(members) && members.length - valid.length === 1 ? "y" : "ies"}${valid.length === 0 ? " (the hold is now released by time or resolution only)" : ""}`);
      }
      if (valid.length > 0) group["rejectedMembers"] = valid;
      else delete group["rejectedMembers"];
    }
    if (group["rejectedSeverity"] !== undefined && (typeof group["rejectedSeverity"] !== "string" || SEVERITY_RANK[group["rejectedSeverity"]] === undefined)) {
      problems.push(`state: ${key}: dropped malformed rejectedSeverity (no escalation release for this record)`);
      delete group["rejectedSeverity"];
    }
  }
  if (group["issue"] !== undefined && !isIssueRecord(group["issue"])) {
    problems.push(`state: ${key}: dropped a malformed issue record (the next filing searches the bot's open issues by title instead)`);
    delete group["issue"];
  }
  return group as PollGroupState;
}

/**
 * Read the poll state. A missing file is an empty state; a damaged one is
 * repaired in memory, entry by entry, with each repair reported to `problems`
 * (or to stderr when no list is given). Reading never throws.
 */
export function readState(file: string, problems?: string[]): PollState {
  const notes: string[] = [];
  const state = readStateInto(file, notes);
  if (problems !== undefined) problems.push(...notes);
  else for (const note of notes) process.stderr.write(`sub-poll: ${note}\n`);
  return state;
}

function readStateInto(file: string, problems: string[]): PollState {
  if (!existsSync(file)) return { groups: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    problems.push("state: the state file is not valid JSON; starting from an empty state");
    return { groups: {} };
  }
  const groups = isRecord(parsed) ? parsed["groups"] : undefined;
  if (!isRecord(groups)) {
    if (!(isRecord(parsed) && groups === undefined)) problems.push("state: no usable `groups` object; starting from an empty state");
    return { groups: {} };
  }
  const out: Record<string, PollGroupState> = {};
  for (const [key, raw] of Object.entries(groups)) {
    const group = normalizeGroup(key, raw, problems);
    if (group !== undefined) out[key] = group;
  }
  return { ...(parsed as Record<string, unknown>), groups: out };
}

export function writeState(file: string, state: PollState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Is `now` (local time) inside an `HH-HH` window? `23-07` covers 23:00–06:59
 * across midnight; `9-17` covers 09:00–16:59; empty means always.
 */
export function withinPollHours(window: string, now: Date): boolean {
  if (window === "") return true;
  const [startText, endText] = window.split("-");
  const start = Number.parseInt(startText ?? "", 10);
  const end = Number.parseInt(endText ?? "", 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  const hour = now.getHours();
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * A firing series' identity for "has this group changed since it was refused?".
 *
 * Labels that address the SCRAPE TARGET rather than the alert's subject are
 * dropped when the series comes from a known exporter (the grouper's own
 * SCRAPER_LABEL_DENYLIST): on a kube-state-metrics KubeJobFailed series,
 * `instance`/`endpoint`/`pod`/`container` name the exporter pod and change
 * every time it restarts (the exporter's pod IP changed between two
 * KubeJobFailed runs a month apart) while the failed Job they describe does not.
 * Everything else — job_name, namespace, severity, condition — is identity.
 */
export function memberMark(series: FiringSeries): MemberMark {
  const labels = stripInternal(series.labels);
  const scraped = [labels["job"], labels["service"]].some((v) => v !== undefined && SCRAPER_LABEL_DENYLIST.has(v));
  if (scraped) {
    delete labels["instance"];
    delete labels["endpoint"];
  }
  const pod = labels["pod"];
  if (pod !== undefined && pod !== "" && isScrapeMetadataPod(labels, pod)) {
    delete labels["pod"];
    delete labels["container"];
  }
  return { labels: signature(labels), ...(series.activeSince === undefined ? {} : { since: series.activeSince }) };
}

/** Alert families where one incident keeps adding members: each CronJob tick is a new Job. */
export const JOB_FAILURE_ALERTNAMES: ReadonlySet<string> = new Set(["KubeJobFailed", "KubeJobNotCompleted", "KubeCronJobLastRunFailed"]);

/**
 * How far ahead of this clock a persisted timestamp may be before it is treated
 * as clock error rather than as time. Beyond it, `rejectedAt`/`lastAttemptAt`
 * read as `now` (and pollOnce rewrites them): a refusal stamped two days in the
 * future must not become a three-day hold.
 */
export const CLOCK_SKEW_MS = 5 * 60_000;

function parseTime(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** A persisted time, with anything more than CLOCK_SKEW_MS in the future read as `now`. */
export function effectiveTime(value: unknown, now: Date): number {
  const t = parseTime(value);
  if (!Number.isFinite(t)) return Number.NaN;
  return t > now.getTime() + CLOCK_SKEW_MS ? now.getTime() : t;
}

export function isMemberMark(value: unknown): value is MemberMark {
  if (!isRecord(value) || typeof value["labels"] !== "string") return false;
  const since = value["since"];
  return since === undefined || Number.isFinite(parseTime(since));
}

/** The refused members, tolerating a hand-edited or corrupt record: never throws. */
function refusedMarks(entry: PollGroupState): MemberMark[] {
  const seen: unknown = entry.rejectedMembers;
  return Array.isArray(seen) ? seen.filter(isMemberMark) : [];
}

/**
 * Is `current` the same firing episode the refused run saw as `refused`?
 * Same identity labels, and:
 *  - a start time observed AFTER the refusal is a later episode, whatever the
 *    record lacks (the refused series was already firing at `rejectedAt`, so
 *    its own start precedes it);
 *  - otherwise, when either side lacks a start (ALERTS_FOR_STATE is optional
 *    and can fail) it matches: losing context must not read as "changed". The
 *    observed-resolution sweep in pollOnce is what retires such a record once
 *    the refused alert stops firing.
 */
function sameEpisode(current: MemberMark, refused: MemberMark, rejectedAtMs: number): boolean {
  if (current.labels !== refused.labels) return false;
  const started = parseTime(current.since);
  if (Number.isFinite(started) && Number.isFinite(rejectedAtMs) && started > rejectedAtMs) return false;
  if (current.since === undefined || refused.since === undefined) return true;
  return parseTime(current.since) === parseTime(refused.since);
}

function mostSevere(members: readonly FiringSeries[]): string {
  let best = "none";
  for (const m of members) {
    const s = m.labels["severity"] ?? "none";
    if ((SEVERITY_RANK[s] ?? 9) < (SEVERITY_RANK[best] ?? 9)) best = s;
  }
  return best;
}

function jobFailureFamily(members: readonly FiringSeries[]): boolean {
  return members.some((m) => JOB_FAILURE_ALERTNAMES.has(m.labels["alertname"] ?? "") || (m.labels["cronjob"] ?? "") !== "");
}

/**
 * Is any series the refused run saw still firing, as the same episode? With no
 * usable member record, "the group is firing at all" is the only evidence.
 */
export function refusedStillFiring(entry: PollGroupState, members: readonly FiringSeries[], now: Date = new Date()): boolean {
  const seen = refusedMarks(entry);
  if (seen.length === 0) return members.length > 0;
  const rejectedAtMs = effectiveTime(entry.rejectedAt, now);
  return members.map(memberMark).some((m) => seen.some((r) => sameEpisode(m, r, rejectedAtMs)));
}

/**
 * Does the group firing NOW differ enough from what the refused run saw to be
 * worth asking about again before the reject backoff runs out?
 *
 *  - NEW EPISODE (every family): no series the refused run saw is still firing
 *    as the same episode (`sameEpisode`). The rejected evidence is gone;
 *    whatever fires now, that run never looked at.
 *  - ESCALATION (every family): a member is more severe than anything the
 *    refused run saw.
 *  - NEW SUBJECT (every family EXCEPT Job/CronJob failures): any member the
 *    refused run did not see. A second pod crash-looping beside the refused one
 *    may be a different fault, so it is asked about.
 *
 * Job/CronJob failures (JOB_FAILURE_ALERTNAMES, or any alert carrying a
 * `cronjob` label) are the exception, and only them: the grouper already
 * decided successive Jobs of one CronJob are ONE incident (`cronJobStem`), and
 * a CronJob that keeps failing adds a new failed Job every tick — "a member
 * joined" would release the hold on every poll, the loop this exists to stop.
 * With failedJobsHistoryLimit 3 a continuously failing hourly CronJob comes
 * back once its three refused Jobs have rotated out (~3 h), not hourly.
 */
export function rejectionReleased(entry: PollGroupState, members: readonly FiringSeries[], now: Date = new Date()): boolean {
  const seen = refusedMarks(entry);
  if (seen.length === 0) return false; // no usable record: released by time (or by resolution) only
  const rejectedAtMs = effectiveTime(entry.rejectedAt, now);
  const matched = members.map(memberMark).map((m) => seen.some((r) => sameEpisode(m, r, rejectedAtMs)));
  if (!matched.some(Boolean)) return true;
  const before = typeof entry.rejectedSeverity === "string" ? SEVERITY_RANK[entry.rejectedSeverity] : undefined;
  if (before !== undefined && (SEVERITY_RANK[mostSevere(members)] ?? 9) < before) return true;
  return !jobFailureFamily(members) && matched.some((m) => !m);
}

export type TriageGate =
  | { due: true }
  | { due: false; reason: "cooldown" | "rejected-safety" | "failure-backoff" };

export type GateOptions = {
  /** SRE_SUB_REJECT_BACKOFF_HOURS; DEFAULT_REJECT_BACKOFF_HOURS when omitted. 0 = no hold at all. */
  rejectBackoffHours?: number;
  /** The group's firing members now; without them a refusal is released only by time. */
  members?: readonly FiringSeries[];
};

export function triageGate(state: PollState, key: string, now: Date, cooldownHours: number, options: GateOptions = {}): TriageGate {
  const entry: unknown = state.groups[key];
  if (!isRecord(entry)) return { due: true };
  const group = entry as PollGroupState;
  const triaged = parseTime(group.lastTriagedAt);
  if (Number.isFinite(triaged) && now.getTime() - triaged < cooldownHours * 3_600_000) return { due: false, reason: "cooldown" };
  const rejected = effectiveTime(group.rejectedAt, now);
  const rejectBackoffHours = options.rejectBackoffHours ?? DEFAULT_REJECT_BACKOFF_HOURS;
  if (rejectBackoffHours > 0 && Number.isFinite(rejected) && now.getTime() - rejected < rejectBackoffHours * 3_600_000
    && !(options.members !== undefined && rejectionReleased(group, options.members, now))) {
    return { due: false, reason: "rejected-safety" };
  }
  // The one-hour floor applies after ANY attempt, a released refusal included:
  // nothing re-runs the same group inside an hour. A refusal IS an attempt, so a
  // record missing lastAttemptAt falls back to its rejectedAt.
  const lastAttempt = effectiveTime(group.lastAttemptAt, now);
  const attempted = Number.isFinite(lastAttempt) ? lastAttempt : rejected;
  if (Number.isFinite(attempted) && now.getTime() - attempted < FAILURE_BACKOFF_MS) return { due: false, reason: "failure-backoff" };
  return { due: true };
}

export function dueForTriage(state: PollState, key: string, now: Date, cooldownHours: number, options: GateOptions = {}): boolean {
  return triageGate(state, key, now, cooldownHours, options).due;
}

// ---------------------------------------------------------------------------
// The poll

/**
 * Per-poll upkeep of refusal records, before any gate is evaluated:
 *  - CLOCK SKEW: a `rejectedAt`/`lastAttemptAt` more than CLOCK_SKEW_MS in the
 *    future is rewritten to `now` (the gate already reads it so; persisting it
 *    makes the hold run from here instead of renewing every poll).
 *  - OBSERVED RESOLUTION: a record none of whose refused alerts is firing (as
 *    the same episode) is cleared. This is what retires a record whose members
 *    lack a start time: once one poll has seen the refused alerts gone, a later
 *    re-fire with the same labels is a new question, not the refused one.
 */
function sweepRejections(state: PollState, groups: readonly AlertGroup[], now: Date, notes: string[]): void {
  const firing = new Map(groups.map((g) => [g.key, g.members] as const));
  for (const [key, entry] of Object.entries(state.groups)) {
    for (const field of ["rejectedAt", "lastAttemptAt"] as const) {
      const t = parseTime(entry[field]);
      if (Number.isFinite(t) && t > now.getTime() + CLOCK_SKEW_MS) {
        notes.push(`clock: ${key}: ${field} ${entry[field]} is more than ${CLOCK_SKEW_MS / 60_000} min ahead of this clock; reset to ${now.toISOString()}`);
        entry[field] = now.toISOString();
      }
    }
    if (entry.rejectedAt !== undefined && !refusedStillFiring(entry, firing.get(key) ?? [], now)) {
      notes.push(`resolved: ${key}: the refused alerts are no longer firing; rejection hold cleared`);
      // A refusal IS an attempt: keep its time as the one-hour floor before the
      // record goes, or a missing/unparseable lastAttemptAt lets the group re-run
      // inside the hour (review P2-4 re-verify).
      const refusedAtMs = parseTime(entry.rejectedAt);
      const attemptedMs = parseTime(entry.lastAttemptAt);
      if (Number.isFinite(refusedAtMs) && !(Number.isFinite(attemptedMs) && attemptedMs >= refusedAtMs)) entry.lastAttemptAt = entry.rejectedAt;
      delete entry.rejectedAt;
      delete entry.rejectedMembers;
      delete entry.rejectedSeverity;
    }
  }
}

export type PollSummary = {
  at: string;
  firingSeries: number;
  groups: number;
  due: number;
  ran: { key: string; exitCode: number; reportPath?: string; rejectionPath?: string; rejection?: RejectionSummary; outcome?: "rejected-safety"; costUsd: number; message: string; issue?: RanIssue; issueError?: string }[];
  skipped: { key: string; why: string }[];
  budget: string;
  exitCode: number;
  /** State repairs, clock-skew clamps and resolved refusals this poll made; absent when none. */
  stateNotes?: string[];
  /**
   * the CLI version this poll saw and whether it is in the reviewed pin.
   * Probed on every poll (`--version` makes no model call: $0), not only when an
   * alert triggers a triage, so a CLI upgrade that would refuse every run is seen
   * before the next incident. Absent when the probe could not run. tools/sub-poll
   * reads it and sends one STATUS per unreviewed version.
   */
  cliPin?: CliPin;
};

export type CliPin = { version: string; supported: boolean };

export type RanIssue = { action: string; number?: number; url?: string; title: string; bodyChars: number; notes: string[] };

/** `claude --version` against the same allowlist the run gate uses. Never throws. */
export async function probeCliPin(env: NodeJS.ProcessEnv = process.env): Promise<CliPin | undefined> {
  try {
    const { sub } = loadSubscriptionConfig(env);
    const version = await readClaudeVersion(sub.claudeBin, env);
    return { version, supported: supportedClaudeVersions(env).includes(version) };
  } catch {
    return undefined;
  }
}

export async function pollOnce(options: { dryRun?: boolean; maxRuns?: number; now?: Date; env?: NodeJS.ProcessEnv; issues?: IssueMode; fileIssueImpl?: typeof fileIssue; fetchFiringImpl?: typeof fetchFiring; runTriageImpl?: typeof runSubscriptionTriage }): Promise<PollSummary> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const loaded = loadSubscriptionConfig(env);
  const { config, sub } = loaded;
  if (!promqlAvailable(config)) {
    throw new Error("the poller needs GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN and GRAFANA_PROM_DATASOURCE_UID: it reads ALERTS through the Grafana datasource proxy");
  }
  const maxRuns = options.maxRuns ?? sub.SRE_SUB_MAX_RUNS_PER_POLL;
  const issueMode: IssueMode = options.issues ?? sub.SRE_SUB_ISSUES;
  const fileIssueImpl = options.fileIssueImpl ?? fileIssue;
  const series = await (options.fetchFiringImpl ?? fetchFiring)(config);
  const groups = groupFiring(series);
  const stateFile = statePath(sub.SRE_SUB_STATE_DIR);
  const stateNotes: string[] = [];
  const state = readState(stateFile, stateNotes);
  for (const group of groups) {
    const entry = state.groups[group.key];
    if (entry !== undefined) entry.lastSeenAt = now.toISOString();
  }
  sweepRejections(state, groups, now, stateNotes);

  const inHours = withinPollHours(sub.SRE_SUB_POLL_HOURS, now);
  const gates = new Map(groups.map((g) => [g, triageGate(state, g.key, now, sub.SRE_SUB_POLL_COOLDOWN_HOURS, {
    rejectBackoffHours: sub.SRE_SUB_REJECT_BACKOFF_HOURS,
    members: g.members,
  })] as const));
  const due = inHours ? groups.filter((g) => gates.get(g)?.due === true) : [];
  const ledger = readLedger(ledgerPath(sub.SRE_SUB_STATE_DIR));
  let budget = budgetVerdict(monthSpend(ledger, monthOf(now)), sub.SRE_SUB_MONTHLY_BUDGET_USD);

  const summary: PollSummary = {
    at: now.toISOString(),
    firingSeries: series.length,
    groups: groups.length,
    due: due.length,
    ran: [],
    skipped: [],
    budget: describeBudget(budget),
    exitCode: EXIT_OK,
    ...(stateNotes.length === 0 ? {} : { stateNotes }),
  };

  for (const g of groups) {
    if (!inHours) summary.skipped.push({ key: g.key, why: `outside SRE_SUB_POLL_HOURS=${sub.SRE_SUB_POLL_HOURS} (the usage window is shared with interactive use)` });
    else if (!due.includes(g)) {
      const entry = state.groups[g.key];
      const gate = gates.get(g);
      const reason = gate !== undefined && !gate.due ? gate.reason : "cooldown";
      summary.skipped.push({
        key: g.key,
        why: reason === "rejected-safety"
          ? `suppressed after a safety rejection (publication gate, exit 7 at ${entry?.rejectedAt ?? "?"}): ${sub.SRE_SUB_REJECT_BACKOFF_HOURS} h or until the group's firing alerts change`
          : reason === "failure-backoff"
            ? `in failure backoff (${FAILURE_BACKOFF_MS / 3_600_000} h since a failed attempt, exit ${entry?.lastExit ?? "?"})`
            : `in cooldown (${sub.SRE_SUB_POLL_COOLDOWN_HOURS} h)`,
      });
    }
  }

  let ran = 0;
  for (const group of due) {
    if (ran >= maxRuns) {
      summary.skipped.push({ key: group.key, why: `over SRE_SUB_MAX_RUNS_PER_POLL=${maxRuns}; next poll` });
      continue;
    }
    if (budget.state === "exhausted") {
      summary.skipped.push({ key: group.key, why: "monthly ceiling reached" });
      summary.exitCode = EXIT_BUDGET;
      continue;
    }
    const payload = payloadForGroup(group, now);
    let outcome: RunOutcome;
    try {
      outcome = await (options.runTriageImpl ?? runSubscriptionTriage)({ payload, mode: "triage", dryRun: options.dryRun ?? false, now, env, loaded });
    } catch (error) {
      summary.ran.push({ key: group.key, exitCode: EXIT_CONFIG, costUsd: 0, message: error instanceof Error ? error.message : String(error) });
      summary.exitCode = EXIT_CONFIG;
      break;
    }
    ran += 1;
    // message and paths are local-log fields. Notifications consume only rejection.
    summary.ran.push({ key: group.key, exitCode: outcome.exitCode, costUsd: outcome.costUsd, message: outcome.message, ...(outcome.rejection === undefined ? {} : { rejection: outcome.rejection }), ...(outcome.reportPath === undefined ? {} : { reportPath: outcome.reportPath }), ...(outcome.rejectionPath === undefined ? {} : { rejectionPath: outcome.rejectionPath, outcome: "rejected-safety" }) });
    budget = outcome.budget;
    if (!options.dryRun) {
      const previous = state.groups[group.key];
      // Only a published report is a triage. A safety rejection is not one
      // either — it never sets lastTriagedAt — but it records what it was
      // about, and triageGate holds the group for SRE_SUB_REJECT_BACKOFF_HOURS
      // unless those alerts change. Every other failure keeps the one-hour
      // backoff, and any attempt that is not a refusal clears the record.
      const triaged = outcome.exitCode === EXIT_OK && outcome.reportPath !== undefined;
      const refused = outcome.exitCode === EXIT_PUBLICATION_REJECTED;
      state.groups[group.key] = {
        ...(triaged ? { lastTriagedAt: now.toISOString() } : previous?.lastTriagedAt === undefined ? {} : { lastTriagedAt: previous.lastTriagedAt }),
        lastAttemptAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        runs: (previous?.runs ?? 0) + 1,
        lastExit: outcome.exitCode,
        ...(outcome.reportPath === undefined ? (previous?.lastReport === undefined ? {} : { lastReport: previous.lastReport }) : { lastReport: outcome.reportPath }),
        ...(refused ? { rejectedAt: now.toISOString(), rejectedMembers: group.members.map(memberMark), rejectedSeverity: mostSevere(group.members) } : {}),
        ...(previous?.issue === undefined ? {} : { issue: previous.issue }),
      };
      // only a PUBLISHED triage is filed, and only after the claude
      // child and its MCP server have exited (runSubscriptionTriage returned).
      // A filing failure never undoes the triage: the cooldown stands, the
      // summary says what failed, and the wrapper sends one STATUS.
      if (triaged && issueMode !== "off" && outcome.reportPath !== undefined) {
        const ranEntry = summary.ran[summary.ran.length - 1];
        try {
          const result = await fileIssueImpl({
            mode: issueMode,
            target: issueTargetFromEnv(env),
            key: group.key,
            reportPath: outcome.reportPath,
            ...(previous?.issue === undefined ? {} : { previous: previous.issue }),
            ledger: readLedger(ledgerPath(sub.SRE_SUB_STATE_DIR)),
            root: PROJECT_ROOT,
            lockDir: sub.SRE_SUB_STATE_DIR,
            now,
          });
          if (ranEntry !== undefined) ranEntry.issue = { action: result.action, ...(result.number === undefined ? {} : { number: result.number }), ...(result.url === undefined ? {} : { url: result.url }), title: result.title, bodyChars: result.bodyChars, notes: result.notes };
          if (issueMode === "live") {
            const record = issueRecordFrom(result, previous?.issue, now);
            const entry = state.groups[group.key];
            if (entry !== undefined && record !== undefined) entry.issue = record;
          }
        } catch (error) {
          if (ranEntry !== undefined) ranEntry.issueError = error instanceof Error ? error.message : String(error);
          if (summary.exitCode === EXIT_OK) summary.exitCode = EXIT_ISSUE_FAILED;
        }
      }
    }
    if (outcome.exitCode === EXIT_AUTH || outcome.exitCode === EXIT_BUDGET || outcome.exitCode === EXIT_USAGE_LIMIT || outcome.exitCode === EXIT_PUBLICATION_REJECTED) {
      summary.exitCode = outcome.exitCode;
      break; // auth/budget/limit affect all runs; safety rejection stops this poll to conserve the window.
    }
    // A triage failure outranks a filing-only failure (exit 8) from an earlier group.
    if (outcome.exitCode !== EXIT_OK && (summary.exitCode === EXIT_OK || summary.exitCode === EXIT_ISSUE_FAILED)) summary.exitCode = outcome.exitCode;
  }

  if (!options.dryRun) writeState(stateFile, state);
  summary.budget = describeBudget(budget);
  return summary;
}

export async function main(runPoll: typeof pollOnce = pollOnce, probe: typeof probeCliPin = probeCliPin): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const maxIndex = argv.indexOf("--max-runs");
  const maxRuns = maxIndex >= 0 ? Number.parseInt(argv[maxIndex + 1] ?? "", 10) : undefined;
  const issuesIndex = argv.indexOf("--issues");
  const issuesArg = issuesIndex >= 0 ? (argv[issuesIndex + 1] ?? "") : undefined;
  if (issuesArg !== undefined && !(ISSUE_MODES as readonly string[]).includes(issuesArg)) {
    process.stderr.write(`sub-poll: --issues takes ${ISSUE_MODES.join("|")}\n`);
    process.exitCode = EXIT_CONFIG;
    return;
  }
  try {
    const summary = await runPoll({ dryRun, ...(maxRuns !== undefined && Number.isFinite(maxRuns) ? { maxRuns } : {}), ...(issuesArg === undefined ? {} : { issues: issuesArg as IssueMode }) });
    // After the poll, so it never delays or changes a triage; it never sets the exit code.
    const cliPin = await probe();
    if (cliPin !== undefined) summary.cliPin = cliPin;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = summary.exitCode;
  } catch (error) {
    process.stderr.write(`sub-poll: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_CONFIG;
  }
}

const invokedDirectly = typeof process.argv[1] === "string" && /[/\\]poll\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) void main();

export { type SubConfig };
