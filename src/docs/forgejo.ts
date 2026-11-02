import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Config } from "../config.js";
import { egressFetch, type EgressFetch } from "../egress.js";

/**
 * Read-only fetch layer over the Forgejo-hosted `docs/` trees.
 *
 * ## Allowlist by construction, not by filtering
 *
 * Same posture as `src/tools/kubectl.ts`: the model never supplies a URL, or a
 * repo slug, or a path fragment that is concatenated verbatim. It supplies a
 * repo **enum member** and a `docs/`-relative path whose every segment has
 * passed a character class, and this module renders the API path.
 *
 * ## Read-only, and structurally so
 *
 * Every request in this file is a literal `method: "GET"`. There is no field,
 * anywhere, that could carry a method, a body, or an extra header. The token is
 * read-scoped (verified by `scripts/verify-forgejo-token.sh`: writes return 403)
 * and is sent **only** in the `Authorization` header — never in a query string,
 * never in argv, never logged. `redactToken` is applied to every error string
 * that leaves this module, so even a Forgejo error that echoed the credential
 * back cannot reach the model's context.
 */

/** The entire universe of readable repositories. A zod enum over these keys. */
export const DOC_REPOS = {
  gitops: "platform/gitops",
  homelab: "platform/homelab",
} as const;

export type DocRepo = keyof typeof DOC_REPOS;

export const DOC_REPO_IDS = Object.keys(DOC_REPOS) as [DocRepo, ...DocRepo[]];

/** Root every path is forced under. Not configurable — that is the point. */
export const DOCS_ROOT = "docs";

/** Extensions we treat as readable text. Anything else is skipped, not fetched. */
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".yaml", ".yml", ".log", ".json"]);

/** Bounds. A read-only tool has no business pulling an unbounded corpus. */
const MAX_DOC_BYTES = 256 * 1024;
const MAX_CORPUS_FILES = 400;
const MAX_CORPUS_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export class DocsError extends Error {}

/**
 * One path segment: letters, digits, dot, dash, underscore. No slash (segments
 * are split before this runs), no `%`, no backslash, no NUL, no space.
 * `.` and `..` match this class, so they are rejected explicitly below.
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Schema-level guard, exported for the zod field: a `/`-joined list of
 * `SEGMENT_RE` segments, with a leading negative lookahead that makes `.` and
 * `..` segments — at any position — unmatchable. A leading `/` cannot match
 * either, because the first segment must be non-empty.
 *
 * This is the outer guard, not the boundary. `assertDocPath` is what actually
 * holds, and it holds for every caller including ones that never saw zod. Both
 * exist because the model deserves a schema rejection for a traversing path
 * rather than a runtime error, and because the boundary must not depend on
 * anyone having applied the schema first.
 */
export const DOC_PATH_RE =
  /^(?!(?:.*\/)?\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Force a caller-supplied path under `docs/` and prove it stayed there.
 *
 * Accepts either a `docs/`-relative path (`runbooks/ups-shutdown.md`) or one
 * that already carries the prefix, because a
 * model that has just been handed a citation will copy the cited form back.
 * Returns the canonical repo-relative path, always beginning `docs/`.
 */
export function assertDocPath(input: string): string {
  if (input === "") throw new DocsError("Refusing an empty documentation path.");
  if (input.length > 300) throw new DocsError("Refusing a documentation path over 300 characters.");
  if (input.includes("\0") || input.includes("\\")) {
    throw new DocsError(`Refusing documentation path ${JSON.stringify(input)}: illegal character.`);
  }
  if (input.startsWith("/")) {
    throw new DocsError(
      `Refusing documentation path ${JSON.stringify(input)}: paths are relative to the repository root.`,
    );
  }

  const stripped = input.startsWith(`${DOCS_ROOT}/`) ? input.slice(DOCS_ROOT.length + 1) : input;
  const segments = stripped.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new DocsError(
        `Refusing documentation path ${JSON.stringify(input)}: "${segment}" segments cannot escape ${DOCS_ROOT}/.`,
      );
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new DocsError(
        `Refusing documentation path ${JSON.stringify(input)}: segment ${JSON.stringify(segment)} must match ${SEGMENT_RE.source}.`,
      );
    }
  }

  const candidate = `${DOCS_ROOT}/${stripped}`;

  // Belt and braces, exactly as the Grafana datasource proxy does it: resolve
  // against a dummy origin and confirm the pathname is still under the prefix.
  // This is what catches percent-encoded traversal without enumerating it.
  const prefix = `/repo/${DOCS_ROOT}/`;
  const resolved = new URL(candidate, "https://forgejo.invalid/repo/");
  if (
    !resolved.pathname.startsWith(prefix) ||
    resolved.search !== "" ||
    resolved.hash !== "" ||
    resolved.pathname !== `/repo/${candidate}`
  ) {
    throw new DocsError(
      `Refusing constructed documentation path "${resolved.pathname}${resolved.search}": ` +
        `it does not stay under "${prefix}".`,
    );
  }
  return candidate;
}

/** Map an enum member to its slug. Unreachable for a non-member by typing. */
export function repoSlug(repo: DocRepo): string {
  const slug = DOC_REPOS[repo];
  if (slug === undefined) {
    throw new DocsError(
      `Refusing repository ${JSON.stringify(repo)}: not one of ${DOC_REPO_IDS.join(", ")}.`,
    );
  }
  return slug;
}

/** A ref is a branch name or a commit sha — never a path fragment. */
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function assertRef(ref: string): string {
  if (!REF_RE.test(ref)) {
    throw new DocsError(`Refusing ref ${JSON.stringify(ref)}: it must match ${REF_RE.source}.`);
  }
  return ref;
}

export type ForgejoAccess = {
  base: string;
  token: string;
  /**
   * The HTTP client this access object dials with.
   *
   * Under local mode this is `localFetch`, whose connections cannot land
   * off-LAN. `docs_search` reads a public repo, so this tool is the *proven*
   * injection vector — and it is also an outbound path carrying a model-chosen
   * query string. Both halves of that sentence have to be governed by the same
   * rule as the model endpoint, or the sovereignty claim covers one door out of
   * four.
   */
  fetchImpl: EgressFetch;
};

export function docsAvailable(config: Config): boolean {
  return Boolean(config.FORGEJO_URL && config.FORGEJO_TOKEN);
}

function requireForgejo(config: Config): ForgejoAccess {
  const base = config.FORGEJO_URL;
  const token = config.FORGEJO_TOKEN;
  if (!base || !token) {
    throw new DocsError(
      "FORGEJO_URL and FORGEJO_TOKEN must both be set; documentation retrieval is unavailable " +
        "without them. Do not report the platform as undocumented — report the tool as unavailable.",
    );
  }
  return { base: base.replace(/\/+$/, ""), token, fetchImpl: egressFetch(config) };
}

/**
 * Scrub the token out of anything on its way to the model or a log. The token
 * should never appear in these strings; this is the layer that makes that true
 * regardless of what Forgejo echoed back.
 */
export function redactToken(text: string, token: string): string {
  if (token === "") return text;
  const forms = new Set<string>([token]);
  // A token that reached a URL, a JSON body or a header dump may have been
  // re-encoded on the way. Redact the forms that cost nothing to cover.
  try {
    forms.add(encodeURIComponent(token));
  } catch {
    /* an unencodable token is still redacted in its raw form */
  }
  forms.add(Buffer.from(token, "utf8").toString("base64"));
  forms.add(JSON.stringify(token).slice(1, -1));
  let out = text;
  for (const form of forms) {
    if (form === "") continue;
    out = out.split(form).join("<redacted-forgejo-token>");
  }
  return out;
}

/**
 * Flatten an exception, including its `cause` chain, into one string.
 *
 * Node's fetch hides the interesting part in `cause` (`TypeError: fetch failed`
 * on its own is useless for diagnosis), and that cause is also where a
 * credential can surface. Every caller wraps this in `redactToken`; nothing in
 * this module should ever interpolate an exception without doing so.
 */
export function describeError(error: unknown, depth = 3): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let i = 0; i < depth && cause !== undefined && cause !== null; i += 1) {
    parts.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
  }
  return parts.join(" — caused by: ");
}

async function forgejoGet(
  access: ForgejoAccess,
  apiPath: string,
  accept: string,
): Promise<string> {
  const url = `${access.base}${apiPath}`;
  let response: Response;
  try {
    response = await access.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `token ${access.token}`, Accept: accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // . This interpolation used to be raw.
    // A `fetch` that fails while *constructing* the request reports the header
    // it choked on, and undici attaches the request to `cause`; a review recovered
    // a full sentinel token out of the resulting `DocsError`. Every string
    // built from an exception is now redacted, not only the ones built from a
    // response body — an exception is an egress path like any other.
    throw new DocsError(
      redactToken(
        `Forgejo is unreachable (${describeError(error)}). ` +
          "Documentation retrieval FAILED — this is not an empty corpus.",
        access.token,
      ),
    );
  }
  const body = redactToken(await response.text(), access.token);
  if (response.status === 401 || response.status === 403) {
    throw new DocsError(
      `Forgejo rejected the read token (HTTP ${response.status}) for ${apiPath}. ` +
        "Documentation retrieval FAILED — the corpus was never read, so nothing below is " +
        `evidence about what is or is not documented. ${body.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    throw new DocsError(
      `Forgejo returned ${response.status} for ${apiPath}: ${body.slice(0, 300)}`,
    );
  }
  return body;
}

/** Resolve `main` to a commit sha so every citation is reproducible. */
export async function resolveRef(config: Config, repo: DocRepo, branch = "main"): Promise<string> {
  const access = requireForgejo(config);
  const raw = await forgejoGet(
    access,
    `/api/v1/repos/${repoSlug(repo)}/branches/${assertRef(branch)}`,
    "application/json",
  );
  let parsed: { commit?: { id?: unknown } };
  try {
    parsed = JSON.parse(raw) as { commit?: { id?: unknown } };
  } catch {
    throw new DocsError(`Forgejo returned non-JSON for the ${repo} branch listing.`);
  }
  const id = parsed.commit?.id;
  if (typeof id !== "string" || id === "") {
    throw new DocsError(`Forgejo did not report a commit for ${repo}@${branch}.`);
  }
  // A server response is still untrusted input — it becomes part of a URL path.
  return assertRef(id);
}

export type DocEntry = { repo: DocRepo; path: string; size: number };

/**
 * What the `docs/` tree contained at a ref, split by what can be fetched.
 *
 * . The split is the point: an omission the
 * caller cannot see is an omission that cannot be declared, and this listing is
 * the only place that knows an oversized document ever existed.
 */
export type DocListing = {
  /** Blobs within `MAX_DOC_BYTES`, in path order. These get fetched. */
  entries: DocEntry[];
  /** Blobs under `docs/` that exceed `MAX_DOC_BYTES`. Present, unfetchable. */
  oversized: DocEntry[];
};

/** List every blob under `docs/` at a pinned ref, oversized ones included. */
export async function listDocs(
  config: Config,
  repo: DocRepo,
  ref: string,
): Promise<DocListing> {
  const access = requireForgejo(config);
  const raw = await forgejoGet(
    access,
    `/api/v1/repos/${repoSlug(repo)}/git/trees/${assertRef(ref)}?recursive=true&per_page=1000`,
    "application/json",
  );
  let parsed: { truncated?: boolean; tree?: unknown };
  try {
    parsed = JSON.parse(raw) as { truncated?: boolean; tree?: unknown };
  } catch {
    throw new DocsError(`Forgejo returned non-JSON for the ${repo} tree listing.`);
  }
  if (!Array.isArray(parsed.tree)) {
    throw new DocsError(`Forgejo returned no tree for ${repo}@${ref}.`);
  }
  if (parsed.truncated === true) {
    throw new DocsError(
      `The ${repo} tree listing was truncated by Forgejo, so the corpus is incomplete. ` +
        "Refusing to search a partial corpus silently.",
    );
  }

  const entries: DocEntry[] = [];
  const oversized: DocEntry[] = [];
  for (const node of parsed.tree as Array<Record<string, unknown>>) {
    if (node["type"] !== "blob") continue;
    const p = node["path"];
    if (typeof p !== "string") continue;
    if (!p.startsWith(`${DOCS_ROOT}/`)) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(p).toLowerCase())) continue;
    const size = typeof node["size"] === "number" ? node["size"] : 0;
    let canonical: string;
    try {
      canonical = assertDocPath(p);
    } catch {
      // A path the boundary refuses is skipped, not fetched. Nothing on the
      // server can make this module read outside `docs/`.
      continue;
    }
    // . This used to be `continue` *before*
    // the entry was recorded, so an oversized document did not merely go
    // unfetched — it went unmentioned. `listed` was built from the survivors,
    // so `included < listed` never fired for it and `formatHits` was free to
    // tell the model the corpus "WAS successfully retrieved and searched in
    // full". A zero-match answer then looked like an authoritative absence.
    //
    // That is a live injection vector, not a theoretical one: anyone who can
    // commit to the public docs repo can pad a runbook past MAX_DOC_BYTES and
    // it silently leaves the searchable platform while the tool keeps claiming
    // completeness. Oversized entries are now *returned*, separately, so the
    // omission is accounted for and declared like every other one.
    if (size > MAX_DOC_BYTES) {
      oversized.push({ repo, path: canonical, size });
      continue;
    }
    entries.push({ repo, path: canonical, size });
  }
  const byPath = (a: DocEntry, b: DocEntry): number => a.path.localeCompare(b.path);
  entries.sort(byPath);
  oversized.sort(byPath);
  return { entries, oversized };
}

/** Read one file's raw bytes at a pinned ref. */
export async function readDoc(
  config: Config,
  repo: DocRepo,
  ref: string,
  docPath: string,
): Promise<string> {
  const access = requireForgejo(config);
  const canonical = assertDocPath(docPath);
  const body = await forgejoGet(
    access,
    `/api/v1/repos/${repoSlug(repo)}/raw/${assertRef(ref)}/${canonical
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    "text/plain",
  );
  return body.length > MAX_DOC_BYTES ? body.slice(0, MAX_DOC_BYTES) : body;
}

// ---------------------------------------------------------------------------
// Bounded on-disk cache
//
// Layout:
//
//   <cacheDir>/<repo>/<ref>/manifest.json     — { repo, ref, fetchedAt, files[] }
//   <cacheDir>/<repo>/<ref>/blobs/<sha1>.txt  — one file body per doc path
//
// Keyed by repo + ref + path. The ref is a commit sha, so a cache hit is a hit
// on exactly the bytes that were cited, and a new commit lands in a new
// directory rather than overwriting history. Only the newest ref per repo is
// kept on disk; older refs are pruned on write. `.cache/` is gitignored.
// ---------------------------------------------------------------------------

export const DEFAULT_CACHE_DIR = path.join(process.cwd(), ".cache", "sre-agent-docs");

/**
 * How a corpus fell short of the repository's whole `docs/` tree.
 */
export type CorpusTruncation = {
  /**
   * Why the corpus is short. `oversized-file` and `multiple` were added by fix: a single-cause enum could not express "some files
   * were too large AND the budget was hit", so one omission would have masked
   * the other.
   */
  reason: "file-count" | "byte-budget" | "oversized-file" | "multiple";
  /**
   * How many files the tree listing contained under `docs/`.
   *
   * 5c/6: this now counts oversized blobs too. It used to count only the ones
   * small enough to fetch, which made `included < listed` structurally unable
   * to notice a file that was dropped for its size — the corpus was declared
   * complete while a document was missing from it.
   */
  listed: number;
  /** How many of them are actually in this corpus. */
  included: number;
  /**
   * Documents present under `docs/` but too large to fetch, named so the model
   * (and a human reading the report) can see exactly what is absent rather than
   * only that something is. Absent when nothing was dropped for size.
   */
  oversized?: Array<{ path: string; size: number }>;
  detail: string;
};

export type CachedCorpus = {
  repo: DocRepo;
  ref: string;
  fetchedAt: string;
  files: Array<{ path: string; text: string }>;
  /** Absent when the corpus is the complete `docs/` tree at this ref. */
  truncation?: CorpusTruncation;
};

/**
 * Bumped whenever the *meaning* of a manifest field changes rather than its
 * shape. changed what `listed` counts, which a type
 * check cannot notice — so the version is what forces a refetch.
 */
export const MANIFEST_ACCOUNTING = "5c-tree-count";

type Manifest = {
  repo: DocRepo;
  ref: string;
  fetchedAt: string;
  /** How omissions are accounted for. Required — see `readManifest`. */
  accounting?: string;
  /** Files the tree listing contained. Required — see `readManifest`. */
  listed: number;
  truncation?: CorpusTruncation;
  files: Array<{ path: string; blob: string; bytes: number }>;
};

function blobName(docPath: string): string {
  return `${createHash("sha1").update(docPath).digest("hex")}.txt`;
}

function refDir(cacheDir: string, repo: DocRepo, ref: string): string {
  return path.join(cacheDir, repo, assertRef(ref));
}

/** Exported for the check suite: cache-invalidation is a correctness property. */
export async function readManifest(
  cacheDir: string,
  repo: DocRepo,
  ref: string,
): Promise<Manifest | undefined> {
  try {
    const raw = await readFile(path.join(refDir(cacheDir, repo, ref), "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.ref !== ref || parsed.repo !== repo || !Array.isArray(parsed.files)) return undefined;
    // A manifest without `listed` predates truncation accounting. It cannot say whether it holds a whole corpus or a
    // truncated one, and "assume complete" is the exact mistake being fixed —
    // so it is treated as a cache miss and refetched.
    if (typeof parsed.listed !== "number") return undefined;
    // . `listed` changed meaning: it used to count
    // only the fetchable files, and now counts the whole `docs/` tree including
    // blobs dropped for their size. A manifest written before that change
    // cannot distinguish "complete" from "complete except the padded runbook",
    // and reusing it would reintroduce exactly the silent-omission bug through
    // the cache. Same posture as the missing-`listed` case above: refetch.
    if (parsed.accounting !== MANIFEST_ACCOUNTING) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Drop every cached ref for this repo except the one we just wrote. */
async function pruneOtherRefs(cacheDir: string, repo: DocRepo, keepRef: string): Promise<void> {
  const dir = path.join(cacheDir, repo);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keepRef) continue;
    if (!REF_RE.test(name)) continue;
    await rm(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Fetch (or load from cache) the whole `docs/` corpus of one repo at a pinned
 * ref. Throws on any transport failure and on an empty corpus — never returns
 * an empty array as if it were a fact about the platform.
 */
export async function loadCorpus(
  config: Config,
  repo: DocRepo,
  options: { cacheDir?: string; ref?: string } = {},
): Promise<CachedCorpus> {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const ref = options.ref ?? (await resolveRef(config, repo));

  const cached = await readManifest(cacheDir, repo, ref);
  if (cached) {
    const files: Array<{ path: string; text: string }> = [];
    let intact = true;
    for (const entry of cached.files) {
      try {
        const text = await readFile(
          path.join(refDir(cacheDir, repo, ref), "blobs", entry.blob),
          "utf8",
        );
        files.push({ path: entry.path, text });
      } catch {
        intact = false;
        break;
      }
    }
    if (intact && files.length > 0) {
      return {
        repo,
        ref,
        fetchedAt: cached.fetchedAt,
        files,
        ...(cached.truncation === undefined ? {} : { truncation: cached.truncation }),
      };
    }
  }

  const { entries: listed, oversized } = await listDocs(config, repo, ref);
  // 5c/6: `listed` alone is no longer the size of the tree — oversized blobs
  // are part of what `docs/` contains and must be counted as present-but-absent.
  const treeCount = listed.length + oversized.length;
  if (treeCount === 0) {
    throw new DocsError(
      `The ${DOCS_ROOT}/ tree of ${repo}@${ref.slice(0, 8)} listed zero readable files. ` +
        "That is a retrieval failure or a repository-layout change, not evidence that the " +
        "platform is undocumented.",
    );
  }
  if (listed.length === 0) {
    // Every document in the tree exceeded the per-file cap. Previously this was
    // indistinguishable from an empty tree; it is a different and much more
    // suspicious fact, so it gets its own refusal rather than a silent corpus.
    throw new DocsError(
      `All ${oversized.length} document(s) under ${DOCS_ROOT}/ in ${repo}@${ref.slice(0, 8)} ` +
        `exceed the ${MAX_DOC_BYTES}-byte per-file cap, so none could be fetched: ` +
        `${oversized.map((o) => `${o.path} (${o.size} bytes)`).join(", ")}. ` +
        "Refusing to return an empty corpus that would read as an undocumented platform.",
    );
  }

  const files: Array<{ path: string; text: string }> = [];
  let totalBytes = 0;
  let hitByteBudget = false;
  for (const entry of listed.slice(0, MAX_CORPUS_FILES)) {
    if (totalBytes >= MAX_CORPUS_BYTES) {
      hitByteBudget = true;
      break;
    }
    const text = await readDoc(config, repo, ref, entry.path);
    totalBytes += text.length;
    files.push({ path: entry.path, text });
  }
  if (files.length === 0) {
    throw new DocsError(`Fetched zero documents from ${repo}@${ref.slice(0, 8)}.`);
  }

  // . Both caps are ordinary operating
  // limits and neither is a reason to fail the whole retrieval — but a corpus
  // that is missing documents must never be *described* as the whole tree. The
  // list is sorted lexicographically, so a truncated corpus is not a random
  // sample either: it is the alphabetical head of `docs/`.
  // 5c/6: every kind of omission is declared, and they compose. A file dropped
  // for its size, the file cap and the byte budget are three independent ways
  // to be short of the tree; reporting only one of them would let a padded
  // document hide behind an unrelated cap (or behind no cap at all).
  const reasons: string[] = [];
  if (oversized.length > 0) {
    reasons.push(
      `${oversized.length} document(s) exceed the ${MAX_DOC_BYTES}-byte per-file cap and were ` +
        `not fetched: ${oversized.map((o) => `${o.path} (${o.size} bytes)`).join(", ")}`,
    );
  }
  if (hitByteBudget) {
    reasons.push(
      `the ${(MAX_CORPUS_BYTES / (1024 * 1024)).toFixed(0)} MB corpus budget was reached`,
    );
  } else if (files.length < listed.length) {
    reasons.push(
      `the ${MAX_CORPUS_FILES}-file corpus cap was reached; files are taken in path order, so the remainder is the alphabetical tail of ${DOCS_ROOT}/`,
    );
  }

  const truncation: CorpusTruncation | undefined =
    files.length < treeCount
      ? {
          reason:
            reasons.length > 1
              ? "multiple"
              : oversized.length > 0
                ? "oversized-file"
                : hitByteBudget
                  ? "byte-budget"
                  : "file-count",
          listed: treeCount,
          included: files.length,
          ...(oversized.length === 0
            ? {}
            : { oversized: oversized.map((o) => ({ path: o.path, size: o.size })) }),
          detail: reasons.join("; "),
        }
      : undefined;

  const fetchedAt = new Date().toISOString();
  const dir = refDir(cacheDir, repo, ref);
  await mkdir(path.join(dir, "blobs"), { recursive: true });
  const manifest: Manifest = {
    repo,
    ref,
    fetchedAt,
    accounting: MANIFEST_ACCOUNTING,
    // 5c/6: the tree count, not the fetchable count — a cache hit must be able
    // to reconstruct that something was omitted for its size.
    listed: treeCount,
    ...(truncation === undefined ? {} : { truncation }),
    files: [],
  };
  for (const file of files) {
    const blob = blobName(file.path);
    await writeFile(path.join(dir, "blobs", blob), file.text, "utf8");
    manifest.files.push({ path: file.path, blob, bytes: file.text.length });
  }
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await pruneOtherRefs(cacheDir, repo, ref);

  return {
    repo,
    ref,
    fetchedAt,
    files,
    ...(truncation === undefined ? {} : { truncation }),
  };
}

/** Bytes currently held under a cache directory — used by the bound assertions. */
export async function cacheBytes(cacheDir: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else total += info.size;
    }
  };
  await walk(cacheDir);
  return total;
}
