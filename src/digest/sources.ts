import { readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import type { WeekWindow } from "./window.js";

const timestamp = z.iso.datetime();
const coverage = z.object({ start: timestamp, end: timestamp });
const text = z.string().min(1);
const alertSchema = z.object({
  coverage,
  records: z.array(z.object({
    receivedAt: timestamp,
    alerts: z.array(z.object({
      status: z.enum(["firing", "resolved"]),
      labels: z.record(z.string(), z.string()),
      annotations: z.record(z.string(), z.string()),
      startsAt: timestamp,
      endsAt: timestamp.optional(),
      fingerprint: text,
    })),
  })),
});
const issueSchema = z.object({
  coverage, agentLogin: text,
  records: z.array(z.object({
    number: z.number().int().positive(), title: text,
    user: z.object({ login: text }),
    created_at: timestamp, state: z.enum(["open", "closed"]),
    pull_request: z.unknown().optional(),
  })),
});
const appSchema = z.object({
  metadata: z.object({ name: text }),
  status: z.object({
    sync: z.object({ revision: text.optional(), status: text.optional() }).optional(),
    health: z.object({ status: text.optional(), message: z.string().optional() }).optional(),
  }),
});
const snapshot = z.object({ at: timestamp, items: z.array(appSchema) }).refine(
  (s) => new Set(s.items.map((a) => a.metadata.name)).size === s.items.length,
);
const argoSchema = z.object({
  coverage, branch: text,
  commits: z.array(z.object({ sha: text, committedAt: timestamp, subject: text })),
  before: snapshot, after: snapshot,
});
const heartbeatSchema = z.object({
  coverage,
  streams: z.array(z.object({
    name: text,
    // Slots are anchored at the window start. A cadence must divide the week.
    cadenceSeconds: z.number().int().min(60).max(604800).refine((n) => 604800 % n === 0),
    evidence: z.enum(["git", "log"]),
    records: z.array(z.object({ at: timestamp, ref: text })),
  })).min(1),
}).refine((s) => new Set(s.streams.map((v) => v.name)).size === s.streams.length);

export type Alerts = z.infer<typeof alertSchema>;
export type Issues = z.infer<typeof issueSchema>;
export type Argo = z.infer<typeof argoSchema>;
export type Heartbeats = z.infer<typeof heartbeatSchema>;
export type Source<T> = { status: "ok"; data: T } | { status: "unknown"; reason: string };
export interface DigestGatherer {
  alerts(window: WeekWindow): Promise<Source<Alerts>>;
  issues(window: WeekWindow): Promise<Source<Issues>>;
  argocd(window: WeekWindow): Promise<Source<Argo>>;
  heartbeats(window: WeekWindow): Promise<Source<Heartbeats>>;
}
export type Digest = {
  window: WeekWindow;
  alerts: Source<Alerts>; issues: Source<Issues>; argocd: Source<Argo>; heartbeats: Source<Heartbeats>;
};

/** Reads only four fixed filenames; error details/input contents never become diagnostics. */
export class FixtureGatherer implements DigestGatherer {
  constructor(private readonly directory: string) {}
  private async read<T extends { coverage: { start: string; end: string } }>(
    name: string, schema: z.ZodType<T>, window: WeekWindow,
  ): Promise<Source<T>> {
    let raw: string;
    try { raw = await readFile(path.join(this.directory, `${name}.json`), "utf8"); }
    catch { return { status: "unknown", reason: `${name} fixture unavailable` }; }
    try {
      const data = schema.parse(JSON.parse(raw));
      if (Date.parse(data.coverage.start) !== Date.parse(window.start) || Date.parse(data.coverage.end) !== Date.parse(window.end)) {
        return { status: "unknown", reason: `${name} fixture coverage does not match window` };
      }
      return { status: "ok", data };
    } catch { return { status: "unknown", reason: `${name} fixture invalid` }; }
  }
  alerts(w: WeekWindow) { return this.read("alerts", alertSchema, w); }
  issues(w: WeekWindow) { return this.read("issues", issueSchema, w); }
  async argocd(w: WeekWindow): Promise<Source<Argo>> {
    const source = await this.read("argocd", argoSchema, w);
    if (source.status === "ok" && (Date.parse(source.data.before.at) !== Date.parse(w.start) || Date.parse(source.data.after.at) !== Date.parse(w.end))) {
      return { status: "unknown", reason: "argocd snapshots do not match window boundaries" };
    }
    return source;
  }
  heartbeats(w: WeekWindow) { return this.read("heartbeats", heartbeatSchema, w); }
}

export class LiveGatherer implements DigestGatherer {
  async alerts(_w: WeekWindow): Promise<Source<Alerts>> { throw new Error("not wired: live source not implemented"); }
  async issues(_w: WeekWindow): Promise<Source<Issues>> { throw new Error("not wired: live source not implemented"); }
  async argocd(_w: WeekWindow): Promise<Source<Argo>> { throw new Error("not wired: live source not implemented"); }
  async heartbeats(_w: WeekWindow): Promise<Source<Heartbeats>> { throw new Error("not wired: live source not implemented"); }
}

export async function gather(gatherer: DigestGatherer, window: WeekWindow): Promise<Digest> {
  const [alerts, issues, argocd, heartbeats] = await Promise.all([
    gatherer.alerts(window), gatherer.issues(window), gatherer.argocd(window), gatherer.heartbeats(window),
  ]);
  return { window, alerts, issues, argocd, heartbeats };
}
