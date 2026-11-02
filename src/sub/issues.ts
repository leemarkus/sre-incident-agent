/**
 * File a published subscription-mode triage as a Forgejo issue.
 *
 * The token's path is the point of the design:
 *  - It is read from 1Password (`op read` of the operator's configured item,
 *    through a service account whose own token is a named Keychain item) only
 *    AFTER a triage has published, which is after the `claude` child and its MCP
 *    server have exited.
 *  - It lives in a local variable for one filing. It is never put in
 *    `process.env`, never an argv entry, never logged, never written to a run
 *    artefact; every string that leaves this module is scrubbed of it.
 *  - Before anything is posted, `/api/v1/user` must say the token IS the
 *    configured bot account.
 *  - The destination is operator configuration (`SRE_SUB_ISSUE_*`), validated
 *    before use: an https origin with no path, credentials or query, and an
 *    `owner/name` repository. Nothing the model or a response produces can
 *    change it. These variables name a destination and a secret reference,
 *    never the token, so their presence in other processes' environments
 *    reveals no credential.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { LedgerEntry } from "./budget.js";
import { scrubSecrets, type KnownSecret } from "./redact.js";

export const ISSUE_LABEL = "sre-agent";
export const ISSUE_LABEL_COLOR = "#d93f0b";

/** Where and as whom reports are filed. Operator configuration, never a default. */
export type IssueTarget = {
  /** Forgejo origin, e.g. `https://git.example.com`. */
  url: string;
  /** `owner/name`. */
  repo: string;
  /** The bot account the token must belong to. */
  bot: string;
  /** 1Password secret reference, `op://<vault>/<item>/<field>`. */
  tokenRef: string;
  /** Keychain service name holding the 1Password service-account token. */
  keychainItem: string;
};

export const ISSUE_TARGET_ENV = {
  url: "SRE_SUB_ISSUE_URL",
  repo: "SRE_SUB_ISSUE_REPO",
  bot: "SRE_SUB_ISSUE_BOT",
  tokenRef: "SRE_SUB_ISSUE_TOKEN_REF",
  keychainItem: "SRE_SUB_ISSUE_KEYCHAIN_ITEM",
} as const satisfies Record<keyof IssueTarget, string>;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const OP_REF_RE = /^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/;

/**
 * Read and validate the filing destination. Every variable is required: there is
 * no built-in host, repository, account or secret reference to fall back to.
 */
export function issueTargetFromEnv(env: NodeJS.ProcessEnv): IssueTarget {
  const raw = Object.fromEntries(
    (Object.keys(ISSUE_TARGET_ENV) as (keyof IssueTarget)[]).map((k) => [k, (env[ISSUE_TARGET_ENV[k]] ?? "").trim()]),
  ) as IssueTarget;
  const missing = (Object.keys(ISSUE_TARGET_ENV) as (keyof IssueTarget)[]).filter((k) => raw[k] === "").map((k) => ISSUE_TARGET_ENV[k]);
  if (missing.length > 0) throw new IssueError(`issue filing is not configured: set ${missing.join(", ")}`);
  let origin: URL;
  try {
    origin = new URL(raw.url);
  } catch {
    throw new IssueError(`${ISSUE_TARGET_ENV.url} is not a URL`);
  }
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== ""
    || origin.search !== "" || origin.hash !== "" || (origin.pathname !== "/" && origin.pathname !== "")
    || raw.url.replace(/\/$/, "") !== origin.origin) {
    throw new IssueError(`${ISSUE_TARGET_ENV.url} must be a bare https origin such as https://git.example.com`);
  }
  if (!REPO_RE.test(raw.repo) || raw.repo.includes("..")) throw new IssueError(`${ISSUE_TARGET_ENV.repo} must be owner/name`);
  if (!NAME_RE.test(raw.bot)) throw new IssueError(`${ISSUE_TARGET_ENV.bot} is not a valid account name`);
  if (!OP_REF_RE.test(raw.tokenRef)) throw new IssueError(`${ISSUE_TARGET_ENV.tokenRef} must be op://<vault>/<item>/<field>`);
  if (!NAME_RE.test(raw.keychainItem)) throw new IssueError(`${ISSUE_TARGET_ENV.keychainItem} is not a valid Keychain service name`);
  return { ...raw, url: origin.origin };
}
/** Forgejo keeps bodies in a TEXT column; stay well under any proxy limit. */
export const MAX_BODY_CHARS = 60_000;

export type IssueMode = "off" | "dry" | "live";
export const ISSUE_MODES: readonly IssueMode[] = ["off", "dry", "live"];

/** What the poll state remembers about a group's issue. */
export type IssueRecord = { number: number; url: string; filedAt: string };

export type IssueAction = "filed" | "commented" | "would-file" | "would-comment";

export type IssueResult = {
  action: IssueAction;
  number?: number;
  url?: string;
  /** The issue as it would be (dry) or was (live) sent. */
  title: string;
  bodyChars: number;
  /** Label problems are notes, not failures: the issue still lands. */
  notes: string[];
  /** Set by `dry` only: the exact body that would be sent. */
  body?: string;
};

export class IssueError extends Error {}

// ---------------------------------------------------------------------------
// Content

/** `git rev-parse HEAD` of this checkout, `-dirty` when the tree has changes; `unknown` if git fails. */
export function agentSha(root: string): string {
  try {
    const sha = execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
    return /^[0-9a-f]{7,40}$/.test(sha) ? `${sha}${dirty ? "-dirty" : ""}` : "unknown";
  } catch {
    return "unknown";
  }
}

/** The ledger line that settled this report, or undefined. */
export function ledgerLineFor(entries: readonly LedgerEntry[], reportPath: string): LedgerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.reportPath === reportPath) return entries[i];
  }
  return undefined;
}

export function issueTitle(key: string): string {
  return key;
}

/**
 * A hidden, immutable marker in every issue body: dedupe survives someone
 * renaming the issue (review MED). base64url, so no key can close the comment.
 */
export function groupMarker(key: string): string {
  return `<!-- sre-agent-group:v1:${Buffer.from(key, "utf8").toString("base64url")} -->`;
}

export function issueBody(options: { key: string; report: string; ledger?: LedgerEntry; sha: string; root: string; retriage?: { at: string } }): string {
  const ledger = options.ledger === undefined
    ? "(no ledger line found for this report)"
    : JSON.stringify({ ...options.ledger, ...(options.ledger.reportPath === undefined ? {} : { reportPath: path.relative(options.root, options.ledger.reportPath) }) });
  const footer = [
    "",
    "---",
    "",
    `<sub>Filed by sre-agent at \`${options.sha}\`. Ledger: \`${ledger.replace(/`/g, "'")}\`</sub>`,
    groupMarker(options.key),
  ].join("\n");
  const head = options.retriage === undefined ? "" : `**Re-triage at ${options.retriage.at}** (same group key; the issue stays open until someone closes it).\n\n`;
  const room = MAX_BODY_CHARS - head.length - footer.length;
  const report = options.report.length > room
    ? `${options.report.slice(0, Math.max(0, room - 160))}\n\n…(report truncated at ${room} characters; the full report is in the run directory)`
    : options.report;
  return `${head}${report}${footer}`;
}

// ---------------------------------------------------------------------------
// Token

export type TokenSource = (target: IssueTarget) => string;

/**
 * The real token source: the configured Keychain item → `op read` of the
 * configured reference, with the service-account token in the CHILD's
 * environment only. Throws an IssueError naming the step, never the value.
 */
export function onePasswordToken(target: IssueTarget): string {
  const sa = spawnSync("security", ["find-generic-password", "-s", target.keychainItem, "-w"], { encoding: "utf8" });
  const saToken = (sa.stdout ?? "").trim();
  if (sa.status !== 0 || saToken === "") throw new IssueError(`Keychain item ${target.keychainItem} is not readable`);
  const read = spawnSync("op", ["read", target.tokenRef], {
    encoding: "utf8",
    env: { OP_SERVICE_ACCOUNT_TOKEN: saToken, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: process.env["HOME"] ?? "" },
  });
  const token = (read.stdout ?? "").trim();
  if (read.status !== 0 || token === "") throw new IssueError(`cannot read ${target.tokenRef}`);
  return token;
}

// ---------------------------------------------------------------------------
// Forgejo

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

type Api = (method: string, apiPath: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

/**
 * The credential boundary. Every request goes through here, and every string a
 * response can contribute to an error is scrubbed IN FULL before it is cut down
 * (review 2026-10-19 HIGH: a slice before the scrub could leave half a token).
 */
function makeApi(origin: string, token: string, fetchImpl: FetchLike, secrets: readonly KnownSecret[]): Api {
  const scrub = (text: string) => scrubSecrets(text, secrets);
  return async (method, apiPath, body) => {
    const headers: Record<string, string> = { Authorization: `token ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let status: number;
    let text: string;
    try {
      const res = await fetchImpl(`${origin}/api/v1${apiPath}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      status = res.status;
      text = await res.text();
    } catch (error) {
      throw new IssueError(scrub(`${method} ${apiPath}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300));
    }
    let json: unknown = undefined;
    try {
      json = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      json = { message: scrub(text).slice(0, 300) };
    }
    return { status, json };
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function failure(what: string, res: { status: number; json: unknown }, secrets: readonly KnownSecret[]): IssueError {
  const message = field(res.json, "message");
  return new IssueError(scrubSecrets(`${what}: HTTP ${res.status}${typeof message === "string" ? ` ${message}` : ""}`, secrets).slice(0, 400));
}

/** Issue URLs are built here, never taken from a response: nothing server-supplied reaches the summary or state. */
export function issueUrl(target: IssueTarget, number: number): string {
  return `${target.url}/${target.repo}/issues/${number}`;
}

async function ensureLabel(api: Api, target: IssueTarget, secrets: readonly KnownSecret[], notes: string[]): Promise<number | undefined> {
  const list = await api("GET", `/repos/${target.repo}/labels?limit=50`);
  if (list.status !== 200 || !Array.isArray(list.json)) throw failure("list labels", list, secrets);
  const found = list.json.find((l) => field(l, "name") === ISSUE_LABEL);
  const id = field(found, "id");
  if (typeof id === "number") return id;
  const made = await api("POST", `/repos/${target.repo}/labels`, { name: ISSUE_LABEL, color: ISSUE_LABEL_COLOR, description: "Filed by the sre-agent poller" });
  const madeId = field(made.json, "id");
  if (made.status === 201 && typeof madeId === "number") {
    notes.push(`created label ${ISSUE_LABEL}`);
    return madeId;
  }
  notes.push(`label ${ISSUE_LABEL} is missing and ${target.bot} could not create it (HTTP ${made.status}); filing unlabelled`);
  return undefined;
}

/** Is this API issue object one of OUR issues for this group: the bot's, open, and carrying the marker or the exact title? */
function isGroupIssue(issue: unknown, key: string, bot: string): boolean {
  if (field(field(issue, "user"), "login") !== bot || field(issue, "state") !== "open") return false;
  const body = field(issue, "body");
  return (typeof body === "string" && body.includes(groupMarker(key))) || field(issue, "title") === issueTitle(key);
}

export const SEARCH_MAX_PAGES = 20;

/**
 * The bot's open issue for this group, found by its marker (a rename does not
 * lose it) or exact title, when the state has no usable record. Fails CLOSED
 * when the search hits its page cap: an unread page is not an absence.
 */
async function findOpenGroupIssue(api: Api, target: IssueTarget, key: string, secrets: readonly KnownSecret[]): Promise<number | undefined> {
  for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
    const res = await api("GET", `/repos/${target.repo}/issues?state=open&type=issues&created_by=${encodeURIComponent(target.bot)}&limit=50&page=${page}`);
    if (res.status !== 200 || !Array.isArray(res.json)) throw failure("search open issues", res, secrets);
    for (const issue of res.json) {
      const number = field(issue, "number");
      if (typeof number === "number" && Number.isInteger(number) && number > 0 && isGroupIssue(issue, key, target.bot)) return number;
    }
    if (res.json.length < 50) return undefined;
  }
  throw new IssueError(`${target.bot} has more than ${SEARCH_MAX_PAGES * 50} open issues; the dedupe search is incomplete, so nothing was filed`);
}

// ---------------------------------------------------------------------------
// Publication evidence and the filing lock

export function publicationEvidence(reportPath: string, ledger: readonly LedgerEntry[]): { ok: true; line: LedgerEntry } | { ok: false; why: string } {
  const rejected = reportPath.replace(/\.md$/, ".rejected.json");
  if (existsSync(rejected)) return { ok: false, why: `the publication gate refused this report (${path.basename(rejected)} exists)` };
  const line = ledgerLineFor(ledger, reportPath);
  if (line === undefined) return { ok: false, why: "no ledger line settles this report" };
  if (line.outcome !== "completed") return { ok: false, why: `its ledger outcome is ${line.outcome}, not completed` };
  return { ok: true, line };
}

export const LOCK_STALE_MS = 10 * 60_000;
export const LOCK_WAIT_MS = 60_000;

/**
 * One filing at a time across the poller and the hand CLI (review MED: two
 * concurrent searches could both miss and both create). A directory made with
 * one mkdir; a holder older than LOCK_STALE_MS is broken.
 */
export async function withIssueLock<T>(lockDir: string, fn: () => Promise<T>, waitMs: number = LOCK_WAIT_MS): Promise<T> {
  mkdirSync(lockDir, { recursive: true });
  const dir = path.join(lockDir, "issues.lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch {
      let age = Number.POSITIVE_INFINITY;
      try {
        age = Date.now() - statSync(dir).mtimeMs;
      } catch {
        continue; // released between the mkdir and the stat
      }
      if (age > LOCK_STALE_MS) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new IssueError(`another filing holds ${dir}; nothing was filed`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Filing

export type FileOptions = {
  mode: Exclude<IssueMode, "off">;
  key: string;
  reportPath: string;
  /** The group's issue record from the poll state, when it has one. */
  previous?: IssueRecord;
  ledger: readonly LedgerEntry[];
  root: string;
  /** Where the filing lock lives: the poller's SRE_SUB_STATE_DIR. */
  lockDir: string;
  now: Date;
  /** Filing destination; read from SRE_SUB_ISSUE_* when omitted. */
  target?: IssueTarget;
  /** Test seams; production uses the 1Password token and global fetch. */
  token?: TokenSource;
  fetchImpl?: FetchLike;
  sha?: string;
};

/**
 * File (or comment) one published report. Throws IssueError on any failure, with
 * the token scrubbed. Writes `<report stem>.issue.json` (number, url, action:
 * never the token) next to the report on a live success. Every string in the
 * result is built here, from the key, numbers and fixed text.
 */
export async function fileIssue(options: FileOptions): Promise<IssueResult> {
  if (!existsSync(options.reportPath)) throw new IssueError(`no report at ${options.reportPath}`);
  const evidence = publicationEvidence(options.reportPath, options.ledger);
  if (!evidence.ok) throw new IssueError(`not filing ${path.basename(options.reportPath)}: ${evidence.why}`);
  const ledger = evidence.line;
  const report = readFileSync(options.reportPath, "utf8");
  const sha = options.sha ?? agentSha(options.root);
  const title = issueTitle(options.key);
  const target = options.target ?? issueTargetFromEnv(process.env);

  if (options.mode === "dry") {
    const retriage = options.previous !== undefined;
    const body = issueBody({ key: options.key, report, sha, root: options.root, ledger, ...(retriage ? { retriage: { at: options.now.toISOString() } } : {}) });
    return {
      action: retriage ? "would-comment" : "would-file",
      ...(options.previous === undefined ? {} : { number: options.previous.number, url: issueUrl(target, options.previous.number) }),
      title,
      bodyChars: body.length,
      notes: retriage ? [`dry: the state records #${options.previous?.number}; live mode comments if it is still open, else files anew`] : [`dry: live mode first searches ${target.bot}'s open issues for this group's marker or exact title`],
      body,
    };
  }

  return withIssueLock(options.lockDir, async () => {
    const token = (options.token ?? onePasswordToken)(target);
    const secrets: KnownSecret[] = [{ label: "SRE_SUB_ISSUE_TOKEN", value: token }];
    const api = makeApi(target.url, token, options.fetchImpl ?? (fetch as unknown as FetchLike), secrets);

    const who = await api("GET", "/user");
    if (who.status !== 200) throw failure("token check /user", who, secrets);
    if (field(who.json, "login") !== target.bot) throw new IssueError(`the issue token does not belong to ${target.bot}; nothing was posted`);

    let open: number | undefined;
    if (options.previous !== undefined) {
      const got = await api("GET", `/repos/${target.repo}/issues/${options.previous.number}`);
      if (got.status === 200 && isGroupIssue(got.json, options.key, target.bot)) open = options.previous.number;
      else if (got.status !== 200 && got.status !== 404) throw failure(`read issue #${options.previous.number}`, got, secrets);
    }
    open ??= await findOpenGroupIssue(api, target, options.key, secrets);

    const notes: string[] = [];
    let result: IssueResult;
    if (open !== undefined) {
      const body = issueBody({ key: options.key, report, sha, root: options.root, ledger, retriage: { at: options.now.toISOString() } });
      const res = await api("POST", `/repos/${target.repo}/issues/${open}/comments`, { body });
      if (res.status !== 201) throw failure(`comment on #${open}`, res, secrets);
      result = { action: "commented", number: open, url: issueUrl(target, open), title, bodyChars: body.length, notes };
    } else {
      const labelId = await ensureLabel(api, target, secrets, notes);
      const body = issueBody({ key: options.key, report, sha, root: options.root, ledger });
      const res = await api("POST", `/repos/${target.repo}/issues`, { title, body, ...(labelId === undefined ? {} : { labels: [labelId] }) });
      const number = field(res.json, "number");
      if (res.status !== 201 || typeof number !== "number" || !Number.isInteger(number) || number <= 0) throw failure("create issue", res, secrets);
      const labels = field(res.json, "labels");
      if (labelId !== undefined && !(Array.isArray(labels) && labels.some((l) => field(l, "id") === labelId))) {
        notes.push(`Forgejo dropped label ${ISSUE_LABEL} on create (${target.bot} lacks write on issues); the issue is unlabelled`);
      }
      result = { action: "filed", number, url: issueUrl(target, number), title, bodyChars: body.length, notes };
    }
    // Belt: nothing above came from a response, but scrub the result anyway.
    const clean = JSON.parse(scrubSecrets(JSON.stringify(result), secrets)) as IssueResult;
    const record = path.join(path.dirname(options.reportPath), `${path.basename(options.reportPath, ".md")}.issue.json`);
    writeFileSync(record, `${JSON.stringify({ at: options.now.toISOString(), key: options.key, ...clean }, null, 2)}\n`, "utf8");
    return clean;
  });
}

/** The poll-state record a successful live filing leaves. */
export function issueRecordFrom(result: IssueResult, previous: IssueRecord | undefined, now: Date): IssueRecord | undefined {
  if (result.action === "commented" && result.number !== undefined && result.url !== undefined) {
    return previous?.number === result.number ? previous : { number: result.number, url: result.url, filedAt: now.toISOString() };
  }
  if (result.action === "filed" && result.number !== undefined && result.url !== undefined) return { number: result.number, url: result.url, filedAt: now.toISOString() };
  return previous;
}

export function isIssueRecord(value: unknown): value is IssueRecord {
  const number = field(value, "number");
  const url = field(value, "url");
  const filedAt = field(value, "filedAt");
  return typeof number === "number" && Number.isInteger(number) && number > 0
    && typeof url === "string" && /^https:\/\/[^/\s]+\/[^\s]+\/issues\/\d+$/.test(url) && url.endsWith(`/issues/${number}`)
    && typeof filedAt === "string" && Number.isFinite(Date.parse(filedAt));
}
