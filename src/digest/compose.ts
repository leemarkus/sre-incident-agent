import { scrubSecrets, type KnownSecret } from "../sub/redact.js";
import type { Digest, Heartbeats, Source } from "./sources.js";
import { inWindow, type WeekWindow } from "./window.js";

const TOP_N = 5;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function heartbeatMetrics(stream: Heartbeats["streams"][number], window: WeekWindow) {
  const slotMs = stream.cadenceSeconds * 1000;
  const expected = (Date.parse(window.end) - Date.parse(window.start)) / slotMs;
  const seen = new Set(stream.records.filter((r) => inWindow(r.at, window))
    .map((r) => Math.floor((Date.parse(r.at) - Date.parse(window.start)) / slotMs)));
  let run = 0, longest = 0;
  for (let slot = 0; slot < expected; slot++) {
    run = seen.has(slot) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return { expected, seen: seen.size, missing: expected - seen.size, longestSeconds: longest * stream.cadenceSeconds };
}

/** Pure, stable renderer. Every external string is scrubbed before Markdown escaping. */
export function compose(digest: Digest, secrets: readonly KnownSecret[] = []): string {
  const safe = (s: string) => scrubSecrets(s, secrets).replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
    .replace(/([\\`*_[\]{}()#!|])/g, "\\$1");
  const unknown = (s: Extract<Source<unknown>, { status: "unknown" }>) => `unknown — ${safe(s.reason)}.`;
  const list = (rows: string[]) => rows.length ? [...rows.slice(0, TOP_N).map((r) => `- ${r}`),
    ...(rows.length > TOP_N ? [`- … ${rows.length - TOP_N} more omitted (top ${TOP_N}).`] : [])] : ["- None in this window."];
  const { window, alerts, issues, argocd, heartbeats } = digest;
  const lines = [
    `# Weekly digest — ${safe(window.end.slice(0, 10))}`,
    "", `Window (Etc/UTC): [${safe(window.start)}, ${safe(window.end)}).`,
    "Sunday 16:30 cut-off; start inclusive, end exclusive.",
    "Fixture dry-run only; no issue posted. Lists show at most 5 entries.",
    "", "## Alerts seen", "",
  ];
  if (alerts.status === "unknown") lines.push(unknown(alerts));
  else {
    const records = alerts.data.records.filter((r) => inWindow(r.receivedAt, window)).flatMap((r) => r.alerts);
    const groups = new Map<string, number>();
    for (const alert of records) {
      const name = alert.labels.alertname ?? "unknown";
      groups.set(name, (groups.get(name) ?? 0) + 1);
    }
    lines.push(`Observations: ${records.length}; firing: ${records.filter((a) => a.status === "firing").length}; resolved: ${records.filter((a) => a.status === "resolved").length}.`,
      "Counts are received alert records, including repeats; not unique incidents.",
      ...list([...groups].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).map(([name, count]) => `${safe(name)}: ${count}`)));
  }
  lines.push("", "## Agent-filed issues", "");
  if (issues.status === "unknown") lines.push(unknown(issues));
  else {
    const records = issues.data.records.filter((r) => r.user.login === issues.data.agentLogin && !r.pull_request && inWindow(r.created_at, window));
    lines.push(`Filed: ${records.length}; open: ${records.filter((r) => r.state === "open").length}; closed: ${records.filter((r) => r.state === "closed").length}.`,
      ...list([...records].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.number - a.number)
        .map((r) => `#${r.number} — ${safe(r.title)} (${r.state})`)));
  }
  lines.push("", "## ArgoCD sync deltas", "");
  if (argocd.status === "unknown") lines.push(unknown(argocd));
  else {
    const { before, after, branch } = argocd.data;
    const commits = argocd.data.commits.filter((c) => inWindow(c.committedAt, window));
    const old = new Map(before.items.map((a) => [a.metadata.name, a]));
    const next = new Map(after.items.map((a) => [a.metadata.name, a]));
    const names = [...new Set([...old.keys(), ...next.keys()])].sort(compare);
    const value = (app: typeof before.items[number] | undefined) => ({
      revision: app?.status.sync?.revision ?? "unknown", sync: app?.status.sync?.status ?? "unknown", health: app?.status.health?.status ?? "unknown",
    });
    let revisions = 0, unknownRevisions = 0;
    for (const name of names) {
      const a = value(old.get(name)), b = value(next.get(name));
      if (a.revision === "unknown" || b.revision === "unknown") unknownRevisions++;
      else if (a.revision !== b.revision) revisions++;
    }
    lines.push(`Deploy branch: ${safe(branch)}; commits: ${commits.length}.`,
      `Applications: ${names.length}; known revision changes: ${revisions}; unknown revision comparisons: ${unknownRevisions}.`,
      "Boundary snapshots show net changes, not a complete sync-event history.",
      ...list(names.map((name) => {
        const a = value(old.get(name)), b = value(next.get(name));
        return `${safe(name)} — revision ${safe(a.revision)} → ${safe(b.revision)}; sync ${safe(a.sync)} → ${safe(b.sync)}; health ${safe(a.health)} → ${safe(b.health)}`;
      })), "", "Deploy commits:",
      ...list([...commits].sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt) || compare(a.sha, b.sha))
        .map((c) => `${safe(c.sha)} — ${safe(c.subject)}`)));
  }
  lines.push("", "## Silent gaps", "");
  if (heartbeats.status === "unknown") lines.push(unknown(heartbeats));
  else {
    const streams = heartbeats.data.streams.map((s) => ({ ...s, metrics: heartbeatMetrics(s, window) }));
    const totals = streams.reduce((t, s) => ({ expected: t.expected + s.metrics.expected, seen: t.seen + s.metrics.seen, missing: t.missing + s.metrics.missing }), { expected: 0, seen: 0, missing: 0 });
    lines.push(`Expected slots: ${totals.expected}; seen slots: ${totals.seen}; missing slots: ${totals.missing}.`,
      "Derived from declared git/log cadence; missing slots are evidence gaps, not proof of an outage.",
      ...list(streams.sort((a, b) => b.metrics.missing - a.metrics.missing || compare(a.name, b.name)).map((s) =>
        `${safe(s.name)} (${s.evidence}, every ${s.cadenceSeconds}s): expected ${s.metrics.expected}, seen ${s.metrics.seen}, missing ${s.metrics.missing}; longest silent run ${s.metrics.longestSeconds}s`)));
  }
  lines.push("", "## Evidence limits", "", "Frozen fixtures only. Live collection, publication safety gate, duplicate-issue prevention and scheduled delivery remain unverified.");
  return scrubSecrets(lines.join("\n") + "\n", secrets);
}
