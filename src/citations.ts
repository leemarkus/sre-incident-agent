import { defenced } from "./markdownFences.js";
/**
 * Citations.
 *
 * ## The failure mode this file exists to catch
 *
 * The retrieval layer can put the operator's own runbooks in front
 * of the model. The moment it does, a new and worse failure becomes available:
 * a report that *sounds* grounded. "Per the MinIO key-rotation runbook, the
 * shared credential has three consumers" is indistinguishable, to a tired human
 * at 02:00, from a sentence the model made up — unless the report says which
 * document, at which ref, and quotes it, and unless something mechanical checks
 * that the quote was actually returned by the retrieval layer in that same run.
 *
 * So the ranked severity here, worst first:
 *
 * ## Where the ground truth comes from
 *
 * Not from re-fetching. Re-fetching would make grading non-deterministic (the
 * corpus moves), require network and a Forgejo token at grade time, and — worst
 * — grade the report against a *different* corpus than the one the model saw.
 *
 * The ground truth is the run's own transcript: `src/replay.ts` already records
 * every exchange the SDK made, and each request carries the full conversation,
 * including the `tool_result` blocks that the `docs_search` / `docs_read` tools
 * produced. Those blocks are verbatim what the model was shown. Grading against
 * them is deterministic, offline, and asks the only question worth asking: did
 * the report quote what it was actually given?
 *
 * ## Coupling
 *
 * This module reads the docs tools' **output contract** — the `cite as
 * \`repo:path@ref\`` anchor that both tools emit and that their descriptions
 * promise the model — plus, since, the untrusted-content
 * envelope that separates that framing from document text
 * (`src/docs/envelope.ts`). It still knows nothing about how chunks are built,
 * ranked or cached.
 */

import { framingOnly, segmentUntrusted } from "./docs/envelope.js";
import { DOC_REPO_IDS } from "./docs/forgejo.js";

export const DOCS_TOOL_NAMES = ["docs_search", "docs_read"] as const;
export type DocsToolName = (typeof DOCS_TOOL_NAMES)[number];

/** One `docs_search` / `docs_read` call and what it returned, verbatim. */
export type RetrievalCall = {
  turn: number;
  tool: DocsToolName;
  toolUseId: string;
  input: Record<string, unknown>;
  result: string;
};

/** A document the retrieval layer actually returned during the run. */
export type RetrievedDoc = {
  repo: string;
  path: string;
  /** The ref exactly as the tool printed it (short sha in practice). */
  ref: string;
  /** Verbatim text the model was shown for this document. */
  text: string;
  via: DocsToolName;
  turn: number;
};

export type RetrievalEvidence = {
  /**
   * Was a retrieval transcript available at all? `false` means "we do not
   * know what was retrieved", which is NOT the same as "nothing was
   * retrieved" — the grader must not treat the two alike.
   */
  present: boolean;
  calls: RetrievalCall[];
  docs: RetrievedDoc[];
  /** Calls that came back `DOCUMENTATION RETRIEVAL FAILED`. */
  failedCalls: RetrievalCall[];
  /** Successful searches that matched nothing. Real information, not a failure. */
  zeroMatchCalls: RetrievalCall[];
};

export const NO_RETRIEVAL_EVIDENCE: RetrievalEvidence = {
  present: false,
  calls: [],
  docs: [],
  failedCalls: [],
  zeroMatchCalls: [],
};

const RETRIEVAL_FAILED_RE = /DOCUMENTATION RETRIEVAL FAILED/;
const ZERO_MATCHES_RE = /\bZERO MATCHES\b/;

// ---------------------------------------------------------------------------
// Parsing what the retrieval layer returned

/**
 * The citation anchor both docs tools emit:
 *
 * Anchoring on this rather than on the `###`/`#` result headers is deliberate:
 * it is the part of the output the tool descriptions *promise* to the model, so
 * it is the part least likely to be reformatted by a later change to how
 * excerpts are presented.
 */
const CITE_AS_RE = /cite as:?\s*`([^`\s:]+):([^`@\s]+)@([A-Za-z0-9._-]{1,64})`/gi;

/**
 * Every document a single tool result put in front of the model.
 *
 * ## Why this walks segments rather than slicing between anchors
 *
 * . The previous version treated the tool result as
 * one flat string: it found `Cite as:` anchors anywhere in it and took each
 * document's verifiable text to be the bytes between one anchor and the next,
 * with a lookback for the `###` header and a trim for the trailing one. That
 * arithmetic was correct only while no *document* contained a `Cite as:` line
 * or a `###` result header — and a document can contain anything, because
 * `gitops` is world-readable and anyone who can land a docs commit chooses
 * its bytes. A document carrying its own `Cite as:` line could split itself in
 * two and make its own body the verifiable text of a document it named.
 *
 * The docs tools now separate the two layers structurally
 * (`src/docs/envelope.ts`): tool framing outside the envelope markers,
 * repository text inside them, under a per-call nonce. So:
 *
 *  - **anchors are read only from framing spans** — a `Cite as:` line inside a
 *    document is document text and can never be an anchor;
 *  - **verifiable text is only ever envelope content** — a quote verifies
 *    against what the repository actually said, never against the tool's own
 *    framing;
 *  - the ordering rule stays what it was: content belongs to the most recent
 *    preceding anchor, so document N's excerpt is never verifiable text for
 *    document N+1.
 */
export function docsInResult(call: RetrievalCall): RetrievedDoc[] {
  // Read the failure marker from framing only. A *document* containing the
  // words DOCUMENTATION RETRIEVAL FAILED must not be able to blank out the
  // evidence for every citation in the run.
  if (RETRIEVAL_FAILED_RE.test(framingOnly(call.result))) return [];

  const docs: RetrievedDoc[] = [];
  let current: RetrievedDoc | undefined;
  for (const segment of segmentUntrusted(call.result)) {
    if (segment.kind === "framing") {
      for (const m of segment.text.matchAll(CITE_AS_RE)) {
        current = {
          repo: m[1] ?? "",
          path: m[2] ?? "",
          ref: m[3] ?? "",
          text: "",
          via: call.tool,
          turn: call.turn,
        };
        docs.push(current);
      }
      continue;
    }
    // Untrusted content with no preceding anchor belongs to no document and is
    // deliberately dropped: it is not quotable, because nothing says what it is.
    if (current === undefined) continue;
    current.text = current.text === "" ? segment.text : `${current.text}\n${segment.text}`;
  }
  return docs;
}

export function evidenceFromCalls(calls: readonly RetrievalCall[]): RetrievalEvidence {
  const docs: RetrievedDoc[] = [];
  for (const call of calls) docs.push(...docsInResult(call));
  // Both markers are tool framing, and are read as such: a document quoting
  // "ZERO MATCHES" or the failure banner changes nothing about what the tool
  // reported.
  const framing = new Map(calls.map((c) => [c.toolUseId, framingOnly(c.result)]));
  const failed = (c: RetrievalCall): boolean =>
    RETRIEVAL_FAILED_RE.test(framing.get(c.toolUseId) ?? "");
  return {
    present: true,
    calls: [...calls],
    docs,
    failedCalls: calls.filter(failed),
    zeroMatchCalls: calls.filter(
      (c) => !failed(c) && ZERO_MATCHES_RE.test(framing.get(c.toolUseId) ?? ""),
    ),
  };
}

// ---------------------------------------------------------------------------
// Pulling the retrieval calls out of a run transcript

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockText(block: Record<string, unknown>): string {
  const content = block["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part["text"] === "string" ? part["text"] : JSON.stringify(part),
      )
      .join("\n");
  }
  return typeof content === "undefined" ? "" : JSON.stringify(content);
}

/**
 * Extract the docs-tool calls and their results from a **conversation** — the
 * ordered `messages` array the tool loop actually built.
 *
 * ##: why not the transport's exchanges
 *
 * This used to be `retrievalCallsFromExchanges`, walking the recorded
 * request/response pairs that `recordedTransport` captures at the HTTP
 * boundary. That source has two defects, and both of them disarm the grader
 * exactly where it matters most:
 *
 * The conversation the runner maintains (`runner.params.messages`) has neither
 * problem: the SDK appends every assistant message and every tool-result
 * message to it regardless of transport, including the results produced on the
 * final permitted iteration. The tools execute in-process either way, so this
 * is still the run's own verbatim tool output and still never a re-fetch.
 *
 * `turn` is the 1-based index of the **assistant turn that issued the call**,
 * counted over the conversation.
 *
 * ##: pairing consumes, it does not dedupe
 *
 * Identical in shape to the repair in `promqlCallsFromMessages`, and made for
 * the same reason: the old code skipped any result whose `tool_use_id` had
 * already been paired, which silently discarded the second of two calls when a
 * local model reused an id across turns. A discarded `docs_read` is a document
 * missing from the retrieval transcript, and a citation to it then fails
 * verification as if it had been fabricated — an evidence-integrity failure
 * pointing the wrong way, which is worse than a noisy one.
 *
 * So a `tool_use` registers a pending call and the matching `tool_result`
 * consumes it; each call keeps its own result, in order. Ambiguity that no rule
 * can resolve — two unanswered calls on one id, or a result with nothing
 * outstanding — throws rather than returning quietly incomplete evidence.
 */
export class RetrievalTranscriptError extends Error {}

export function retrievalCallsFromMessages(
  messages: readonly unknown[],
): RetrievalCall[] {
  const pending = new Map<
    string,
    Array<{ tool: DocsToolName; input: Record<string, unknown>; turn: number }>
  >();
  const known = new Set<string>();
  const calls: RetrievalCall[] = [];
  let assistantTurn = 0;

  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message["role"] === "assistant") assistantTurn += 1;
    const content = message["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] === "tool_use") {
        const name = block["name"];
        const id = block["id"];
        if (
          typeof name === "string" &&
          typeof id === "string" &&
          (DOCS_TOOL_NAMES as readonly string[]).includes(name)
        ) {
          const queue = pending.get(id);
          if (queue !== undefined && queue.length > 0) {
            throw new RetrievalTranscriptError(
              `two unanswered docs-tool calls share tool_use_id ${JSON.stringify(id)} ` +
                `(turns ${queue[0]?.turn} and ${assistantTurn}). Their results cannot be told ` +
                "apart, so the retrieval transcript citations are verified against would " +
                "attribute a document to the wrong call. Refusing to guess.",
            );
          }
          known.add(id);
          pending.set(id, [
            {
              tool: name as DocsToolName,
              input: isRecord(block["input"]) ? block["input"] : {},
              turn: assistantTurn,
            },
          ]);
        }
      } else if (block["type"] === "tool_result") {
        const id = block["tool_use_id"];
        if (typeof id !== "string") continue;
        const queue = pending.get(id);
        const issued = queue?.shift();
        if (issued === undefined) {
          if (known.has(id)) {
            throw new RetrievalTranscriptError(
              `a second tool_result arrived for docs-tool call ${JSON.stringify(id)} with no ` +
                "outstanding call to match it. The transcript is malformed; refusing to " +
                "attribute the document to an arbitrary call.",
            );
          }
          continue; // Another tool's result.
        }
        calls.push({
          turn: issued.turn,
          tool: issued.tool,
          toolUseId: id,
          input: issued.input,
          result: blockText(block),
        });
      }
    }
  }
  return [...calls].sort((a, b) => a.turn - b.turn);
}

export function retrievalEvidenceFromMessages(
  messages: readonly unknown[],
): RetrievalEvidence {
  return evidenceFromCalls(retrievalCallsFromMessages(messages));
}

/** The persisted shape written next to a run's report and committed as a fixture. */
export type RetrievalTranscript = {
  scenario?: string;
  calls: RetrievalCall[];
};

export function evidenceFromTranscript(transcript: RetrievalTranscript): RetrievalEvidence {
  return evidenceFromCalls(transcript.calls);
}

// ---------------------------------------------------------------------------
// Parsing citations out of a report

/**
 * The house citation form, which the system prompts specify verbatim:
 *
 * One canonical form on purpose. A grader that accepts five shapes of citation
 * is a grader that will one day accept a sixth by accident.
 */
const CITATION_RE = new RegExp(
  "`([a-z0-9][a-z0-9-]*):(docs/[A-Za-z0-9._/-]+)@([A-Za-z0-9._-]{4,64})`" +
    "\\s*(?:[—–-]|:)\\s*" +
    "[\"“]([^\"”]{6,600})[\"”]",
  "g",
);

/**
 * A quoted passage may wrap across lines — reports are hard-wrapped prose — but
 * never across a blank line. Without that bound a stray quotation mark three
 * paragraphs later would swallow the intervening text into the "quote", and a
 * long enough swallow would eventually contain something that *is* in the
 * document.
 */
function isPlausibleQuote(quote: string): boolean {
  return !/\n\s*\n/.test(quote);
}

/** A bare `repo:path@ref` token, with or without a quote after it. */
const CITATION_TOKEN_RE = /`([a-z0-9][a-z0-9-]*):(docs\/[A-Za-z0-9._/-]+)@([A-Za-z0-9._-]{4,64})`/g;

/** A house documentation path named in prose, cited or not. */
const DOC_PATH_RE = /\bdocs\/[A-Za-z0-9._/-]+\.md\b/g;

export type Citation = {
  repo: string;
  path: string;
  ref: string;
  quote: string;
  /** The `##` section the citation was found in, for locality checks. */
  section: string;
};

/**
 * Strip fenced blocks before looking for citations.
 *
 * Two reasons, and both matter. A report legitimately pastes raw
 * `docs_search` output into Evidence, and that output contains `Cite as:` lines
 * — counting those as the report's own citations would let a report "cite" by
 * copy-paste without ever making a claim. And conversely, a citation buried in
 * a fence is not a statement the report is making in its own voice.
 */
export function stripFences(text: string): string {
  return defenced(text);
}

export function parseCitations(
  report: string,
  sections: readonly { heading: string; body: string }[],
): Citation[] {
  const found: Citation[] = [];
  const scopes =
    sections.length === 0
      ? [{ heading: "(whole report)", body: report }]
      : sections.map((s) => ({ heading: s.heading, body: s.body }));
  for (const scope of scopes) {
    for (const m of stripFences(scope.body).matchAll(CITATION_RE)) {
      if (!isPlausibleQuote(m[4] ?? "")) continue;
      found.push({
        repo: m[1] ?? "",
        path: m[2] ?? "",
        ref: m[3] ?? "",
        quote: m[4] ?? "",
        section: scope.heading,
      });
    }
  }
  return found;
}

/** `repo:path@ref` tokens that carry no quoted passage. */
export function unquotedCitationTokens(report: string): string[] {
  const stripped = stripFences(report);
  const quoted = new Set(
    [...stripped.matchAll(CITATION_RE)]
      .filter((m) => isPlausibleQuote(m[4] ?? ""))
      .map((m) => `${m[1]}:${m[2]}@${m[3]}`),
  );
  const all = [...stripped.matchAll(CITATION_TOKEN_RE)].map(
    (m) => `${m[1]}:${m[2]}@${m[3]}`,
  );
  return [...new Set(all.filter((t) => !quoted.has(t)))];
}

/** House documentation paths named anywhere in the report's own prose. */
export function namedDocPaths(report: string): string[] {
  return [...new Set([...stripFences(report).matchAll(DOC_PATH_RE)].map((m) => m[0]))];
}

// ---------------------------------------------------------------------------
// Verification

/**
 * Quote normalisation, kept deliberately shallow: whitespace collapse, quote
 * and dash unification, case folding. Nothing fuzzy, and **no elision
 * support** — `"the credential … has four consumers"` is not accepted as a
 * quote, because an elided quote can be stitched from fragments that never
 * appeared together, which is the thing this check exists to prevent. Quote a
 * contiguous span or quote a shorter one.
 */
export function normalizeQuote(text: string): string {
  return text
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Short refs are what the tools print, so a prefix match in either direction. */
export function refsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 7) return false;
  return a.slice(0, min) === b.slice(0, min);
}

export type CitationStatus =
  | "verified"
  | "unknown-repo"
  | "document-not-retrieved"
  | "ref-not-retrieved"
  | "quote-not-in-document"
  | "no-retrieval-transcript";

export type CitationVerdict = {
  citation: Citation;
  status: CitationStatus;
  detail: string;
};

export function verifyCitation(
  citation: Citation,
  evidence: RetrievalEvidence,
): CitationVerdict {
  const cite = `${citation.repo}:${citation.path}@${citation.ref}`;
  if (!(DOC_REPO_IDS as readonly string[]).includes(citation.repo)) {
    return {
      citation,
      status: "unknown-repo",
      detail: `${cite} names repository "${citation.repo}", which is not one of ${DOC_REPO_IDS.join(", ")}`,
    };
  }
  if (!evidence.present) {
    return {
      citation,
      status: "no-retrieval-transcript",
      detail:
        `${cite} cannot be verified: this grade was run without a retrieval transcript, ` +
        "so there is no record of what was actually retrieved. An unverifiable citation " +
        "is treated as a failure, not as a pass — pass the run's retrieval transcript to " +
        "grade citations.",
    };
  }

  const sameDoc = evidence.docs.filter(
    (d) => d.repo === citation.repo && d.path === citation.path,
  );
  if (sameDoc.length === 0) {
    return {
      citation,
      status: "document-not-retrieved",
      detail:
        `${cite} was never retrieved in this run. Retrieved: ` +
        (evidence.docs.length === 0
          ? "(nothing)"
          : [...new Set(evidence.docs.map((d) => `${d.repo}:${d.path}`))].join(", ")),
    };
  }
  const sameRef = sameDoc.filter((d) => refsMatch(d.ref, citation.ref));
  if (sameRef.length === 0) {
    return {
      citation,
      status: "ref-not-retrieved",
      detail:
        `${cite} cites ref "${citation.ref}", but that document was retrieved at ` +
        `${[...new Set(sameDoc.map((d) => d.ref))].join(", ")} — a citation must name the ref it was read at`,
    };
  }

  const needle = normalizeQuote(citation.quote);
  const hit = sameRef.some((d) => normalizeQuote(d.text).includes(needle));
  if (!hit) {
    return {
      citation,
      status: "quote-not-in-document",
      detail:
        `${cite} quotes "${citation.quote.slice(0, 120)}" — that passage does not appear in ` +
        "what the retrieval layer returned for that document in this run",
    };
  }
  return { citation, status: "verified", detail: `${cite} — quote verified against the run's retrieval transcript` };
}

export function verifyCitations(
  report: string,
  sections: readonly { heading: string; body: string }[],
  evidence: RetrievalEvidence,
): CitationVerdict[] {
  return parseCitations(report, sections).map((c) => verifyCitation(c, evidence));
}

// ---------------------------------------------------------------------------
// Claims that need a citation

/**
 * Sentences that attribute a fact or a procedure to house documentation.
 *
 * Scoped tightly to *attribution*. "If a house runbook covers this, name it" and
 * "no runbook exists for this; one should contain …" are not attributions and
 * must not be caught — a report saying documentation is missing is doing the
 * right thing, and penalising it would push the model toward inventing a
 * citation, which is precisely the outcome this file exists to prevent.
 */
const DOC_ATTRIBUTION_RE = new RegExp(
  [
    String.raw`\b(per|according to|as documented in|documented in|described in|recorded in|set out in|noted in)\s+(the\s+)?(house\s+)?(runbook|adr|decision record|incident|root[- ]cause|write-?up|doc\b|docs\b|documentation)`,
    String.raw`\bthe\s+(house\s+)?(runbook|adr|decision record|incident report|incident write-?up|root[- ]cause (doc|analysis))\s+\w*\s*(says|states|specifies|requires|documents|records|notes|warns|confirms|shows|lists|prescribes)\b`,
    String.raw`\bdocs/[A-Za-z0-9._/-]+\.md\b`,
  ].join("|"),
  "i",
);

function sentencesOf(text: string): string[] {
  return stripFences(text)
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export type DocumentationClaim = { section: string; sentence: string };

export function documentationClaims(
  sections: readonly { heading: string; body: string }[],
  report: string,
): DocumentationClaim[] {
  const scopes =
    sections.length === 0
      ? [{ heading: "(whole report)", body: report }]
      : sections.map((s) => ({ heading: s.heading, body: s.body }));
  const claims: DocumentationClaim[] = [];
  for (const scope of scopes) {
    for (const sentence of sentencesOf(scope.body)) {
      if (DOC_ATTRIBUTION_RE.test(sentence)) {
        claims.push({ section: scope.heading, sentence });
      }
    }
  }
  return claims;
}

/**
 * Claims of the form "there is no documentation for this".
 */
const UNDOCUMENTED_CLAIM_RE = new RegExp(
  [
    String.raw`\b(no|not any|zero)\s+(house\s+|relevant\s+|existing\s+|applicable\s+)*(runbook|adr|doc|docs|documentation|write-?up|incident report)s?\b\s*(exists?|covers?|documents?|addresses|for this|on this|about this|were found|was found|matched)?`,
    String.raw`\b(is|are|remains?)\s+(entirely\s+|completely\s+|wholly\s+)?undocumented\b`,
    String.raw`\bnothing\s+(in|across)\s+(the\s+)?(docs|documentation|runbooks)\b`,
  ].join("|"),
  "i",
);

export function undocumentedClaimSentences(report: string): string[] {
  return sentencesOf(report).filter((s) => UNDOCUMENTED_CLAIM_RE.test(s));
}
