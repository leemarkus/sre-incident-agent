import path from "node:path";

import type { DocRepo } from "./forgejo.js";

/**
 * Mechanical retrieval over the fetched `docs/` corpora.
 *
 * **No embeddings and no model calls, by design.** A triage run is already
 * paying for a reasoning model; spending a second model call to decide which
 * runbook to read would double the failure surface and the bill for a job that
 * BM25 over ~120 documents does well. Everything here is deterministic, which
 * also means the probe measurement in `scripts/probe-retrieval.ts` measures the
 * retrieval layer rather than a sampling temperature.
 *
 * The ranking is BM25 over heading-delimited chunks, plus three additive
 * signals that matter for a documentation corpus specifically:
 *
 *  - **path match** — `runbooks/ups-shutdown.md` is a strong statement about
 *    what the file is about, and it is not part of the body text;
 *  - **heading match** — a term in the chunk's heading trail counts for more
 *    than the same term in a paragraph;
 *  - **document coverage** — a document that mentions *every* query term
 *    somewhere outranks one that mentions a single rare term many times. This
 *    is what stops a passing mention in a 50 KB TODO file beating the runbook.
 */

const K1 = 1.2;
const B = 0.75;
const PATH_WEIGHT = 2.5;
const HEADING_WEIGHT = 1.5;
/** Final score is scaled by (COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * coverage). */
const COVERAGE_FLOOR = 0.5;

const TARGET_CHUNK_CHARS = 1400;
const MAX_CHUNK_CHARS = 1800;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_CHUNK_CHARS = 200;

const STOPWORDS = new Set([
  "a", "an", "and", "any", "all", "also", "are", "as", "at", "be", "been", "before", "being",
  "but", "by", "can", "could", "did", "do", "does", "doing", "done", "down", "for", "from",
  "get", "got", "had", "has", "have", "how", "if", "in", "into", "is", "it", "its", "just",
  "more", "most", "much", "must", "need", "needs", "no", "not", "of", "on", "only", "or",
  "our", "out", "should", "so", "some", "still", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "to", "up", "us", "very", "was",
  "we", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with",
  "would", "you", "your",
]);

/**
 * Conservative normalisation: case-fold and singularise. No verb stemming —
 * "shutdown"/"shut" and "rotate"/"rotation" are deliberately left distinct,
 * because collapsing them costs more precision than it buys recall on a corpus
 * this size.
 */
export function normalizeTerm(raw: string): string {
  let t = raw.toLowerCase();
  if (t.endsWith("'s")) t = t.slice(0, -2);
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  if (/(sses|ses|xes|zes|ches|shes)$/.test(t) && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) return t.slice(0, -1);
  return t;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    const term = normalizeTerm(raw);
    if (term.length < 2) continue;
    if (STOPWORDS.has(term)) continue;
    out.push(term);
  }
  return out;
}

/** Query terms, deduplicated but order-preserving. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query))];
}

export type Chunk = {
  repo: DocRepo;
  ref: string;
  path: string;
  /** Heading trail, e.g. `Runbook — UPS safe shutdown > Hardware & topology`. */
  heading: string;
  /** 1-based index of this chunk within its document. */
  index: number;
  text: string;
  tokens: string[];
  tf: Map<string, number>;
  headingTokens: Set<string>;
};

export type DocIndex = {
  chunks: Chunk[];
  /** Distinct terms per document key (`repo:path`), for the coverage signal. */
  docTerms: Map<string, Set<string>>;
  pathTokens: Map<string, Set<string>>;
  titles: Map<string, string>;
  df: Map<string, number>;
  avgChunkLength: number;
  documentCount: number;
  refs: Map<DocRepo, string>;
};

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Split a markdown document into heading-delimited, size-bounded sections. */
export function chunkDocument(text: string): Array<{ heading: string; text: string }> {
  const lines = text.split("\n");
  const trail: string[] = [];
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } = { heading: "", body: [] };
  let sawHeading = false;

  const headingTrail = (): string => trail.filter((h) => h !== "").join(" > ");

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      if (current.body.length > 0 || sawHeading) sections.push(current);
      const level = match[1]!.length;
      trail.length = Math.min(trail.length, level - 1);
      while (trail.length < level - 1) trail.push("");
      trail[level - 1] = match[2]!.trim();
      sawHeading = true;
      current = { heading: headingTrail(), body: [] };
      continue;
    }
    current.body.push(line);
  }
  sections.push(current);

  // Merge away sections too small to stand alone, so a bare `## Files` heading
  // travels with the table that follows it and a two-line subsection does not
  // become its own chunk competing with the runbook it belongs to.
  //
  // A merged chunk keeps **every** heading it absorbed, joined with " · ".
  // Dropping the absorbed headings would silently cost those terms their
  // HEADING_WEIGHT boost — the merged body still contains the heading text, so
  // the bug would not show up as a missing match, only as a quietly worse rank.
  const merged: Array<{ heading: string; text: string }> = [];
  for (const section of sections) {
    const body = section.body.join("\n").trim();
    const combined = section.heading === "" ? body : `## ${section.heading}\n${body}`;
    if (combined.trim() === "") continue;
    const previous = merged[merged.length - 1];
    if (
      previous &&
      body.length < MIN_CHUNK_CHARS &&
      previous.text.length + combined.length < MAX_CHUNK_CHARS
    ) {
      previous.text = `${previous.text}\n\n${combined}`;
      if (section.heading !== "" && !previous.heading.includes(section.heading)) {
        previous.heading =
          previous.heading === "" ? section.heading : `${previous.heading} · ${section.heading}`;
      }
      continue;
    }
    merged.push({ heading: section.heading, text: combined });
  }

  // Window anything still oversized, on paragraph boundaries where possible.
  const out: Array<{ heading: string; text: string }> = [];
  for (const section of merged) {
    if (section.text.length <= MAX_CHUNK_CHARS) {
      out.push(section);
      continue;
    }
    let start = 0;
    while (start < section.text.length) {
      let end = Math.min(start + TARGET_CHUNK_CHARS, section.text.length);
      if (end < section.text.length) {
        const brk = section.text.lastIndexOf("\n\n", end);
        if (brk > start + MIN_CHUNK_CHARS) end = brk;
      }
      out.push({ heading: section.heading, text: section.text.slice(start, end).trim() });
      if (end >= section.text.length) break;
      start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
    }
  }
  return out.filter((c) => c.text.trim() !== "");
}

/** Tokens derived from the file path — filename and directory names both count. */
export function pathTokensOf(docPath: string): Set<string> {
  const withoutExt = docPath.slice(0, docPath.length - path.extname(docPath).length);
  return new Set(tokenize(withoutExt.replace(/[\/_.-]+/g, " ")));
}

function firstHeading(text: string): string {
  for (const line of text.split("\n")) {
    const match = HEADING_RE.exec(line);
    if (match) return match[2]!.trim();
  }
  return "";
}

export type CorpusInput = {
  repo: DocRepo;
  ref: string;
  files: Array<{ path: string; text: string }>;
};

export function buildIndex(corpora: CorpusInput[]): DocIndex {
  const chunks: Chunk[] = [];
  const docTerms = new Map<string, Set<string>>();
  const pathTokens = new Map<string, Set<string>>();
  const titles = new Map<string, string>();
  const refs = new Map<DocRepo, string>();
  const df = new Map<string, number>();
  let totalLength = 0;
  let documentCount = 0;

  for (const corpus of corpora) {
    refs.set(corpus.repo, corpus.ref);
    for (const file of corpus.files) {
      const key = `${corpus.repo}:${file.path}`;
      documentCount += 1;
      pathTokens.set(key, pathTokensOf(file.path));
      titles.set(key, firstHeading(file.text));
      const terms = new Set<string>();

      const pieces = chunkDocument(file.text);
      pieces.forEach((piece, i) => {
        const tokens = tokenize(piece.text);
        const tf = new Map<string, number>();
        for (const token of tokens) {
          tf.set(token, (tf.get(token) ?? 0) + 1);
          terms.add(token);
        }
        for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
        totalLength += tokens.length;
        chunks.push({
          repo: corpus.repo,
          ref: corpus.ref,
          path: file.path,
          heading: piece.heading === "" ? (titles.get(key) ?? "") : piece.heading,
          index: i + 1,
          text: piece.text,
          tokens,
          tf,
          headingTokens: new Set(tokenize(piece.heading)),
        });
      });
      for (const token of tokenize(file.path.replace(/[\/_.-]+/g, " "))) terms.add(token);
      docTerms.set(key, terms);
    }
  }

  return {
    chunks,
    docTerms,
    pathTokens,
    titles,
    df,
    avgChunkLength: chunks.length === 0 ? 1 : totalLength / chunks.length,
    documentCount,
    refs,
  };
}

function idf(index: DocIndex, term: string): number {
  const n = index.chunks.length;
  const d = index.df.get(term) ?? 0;
  // BM25 IDF, floored at a small positive value so a term present everywhere
  // still contributes a little rather than turning negative.
  return Math.max(Math.log((n - d + 0.5) / (d + 0.5) + 1), 0.05);
}

export type Hit = {
  repo: DocRepo;
  ref: string;
  path: string;
  title: string;
  score: number;
  matchedTerms: string[];
  chunks: Array<{ heading: string; index: number; text: string; score: number }>;
};

export type SearchOptions = {
  repo?: DocRepo | undefined;
  pathPrefix?: string | undefined;
  limit?: number | undefined;
  chunksPerDoc?: number | undefined;
};

export function search(index: DocIndex, query: string, options: SearchOptions = {}): Hit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const limit = options.limit ?? 5;
  const chunksPerDoc = options.chunksPerDoc ?? 2;
  const prefix = options.pathPrefix;

  const weights = new Map(terms.map((t) => [t, idf(index, t)] as const));
  const perDoc = new Map<
    string,
    { chunk: Chunk; score: number }[]
  >();

  for (const chunk of index.chunks) {
    if (options.repo !== undefined && chunk.repo !== options.repo) continue;
    if (prefix !== undefined && !chunk.path.startsWith(prefix)) continue;

    const key = `${chunk.repo}:${chunk.path}`;
    const pTokens = index.pathTokens.get(key) ?? new Set<string>();
    let score = 0;
    let matched = false;

    for (const term of terms) {
      const w = weights.get(term)!;
      const tf = chunk.tf.get(term) ?? 0;
      if (tf > 0) {
        matched = true;
        const denom =
          tf + K1 * (1 - B + (B * chunk.tokens.length) / Math.max(index.avgChunkLength, 1));
        score += w * ((tf * (K1 + 1)) / denom);
      }
      if (pTokens.has(term)) {
        matched = true;
        score += PATH_WEIGHT * w;
      }
      if (chunk.headingTokens.has(term)) {
        matched = true;
        score += HEADING_WEIGHT * w;
      }
    }
    if (!matched || score <= 0) continue;

    const docSet = index.docTerms.get(key) ?? new Set<string>();
    const coverage = terms.filter((t) => docSet.has(t)).length / terms.length;
    score *= COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * coverage;

    const bucket = perDoc.get(key);
    if (bucket) bucket.push({ chunk, score });
    else perDoc.set(key, [{ chunk, score }]);
  }

  const hits: Hit[] = [];
  for (const [key, bucket] of perDoc) {
    bucket.sort((a, b) => b.score - a.score);
    const best = bucket[0]!;
    // Document score: the best chunk, plus a decayed contribution from the
    // runners-up, so a document that answers a query in several places beats one
    // that happens to have a single dense paragraph.
    const docScore = bucket
      .slice(0, 4)
      .reduce((acc, entry, i) => acc + entry.score / (i + 1), 0);
    const docSet = index.docTerms.get(key) ?? new Set<string>();
    hits.push({
      repo: best.chunk.repo,
      ref: best.chunk.ref,
      path: best.chunk.path,
      title: index.titles.get(key) ?? "",
      score: docScore,
      matchedTerms: terms.filter((t) => docSet.has(t)),
      chunks: bucket.slice(0, chunksPerDoc).map((entry) => ({
        heading: entry.chunk.heading,
        index: entry.chunk.index,
        text: entry.chunk.text,
        score: entry.score,
      })),
    });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}
