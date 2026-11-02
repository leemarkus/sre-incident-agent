import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import * as z from "zod/v4";

import {
  DOCS_TOOL_NAMES,
  NO_RETRIEVAL_EVIDENCE,
  evidenceFromCalls,
  type RetrievalEvidence,
} from "./citations.js";
import { POSTMORTEM_SECTIONS } from "./postmortem.js";
import {
  NO_QUERY_EVIDENCE,
  queryEvidenceFromCalls,
  resultIsEmptyVector,
  verdictTokens,
  type QueryEvidence,
} from "./queries.js";
import {
  toolEvidenceFromCalls,
  toolEvidenceFromMessages,
  type ToolEvidence,
} from "./toolCalls.js";
import { UNTRUSTED_BANNER } from "./docs/envelope.js";
import {
  TOOL_STATUS_FAILED,
  TOOL_STATUS_OK,
  declaredToolStatus,
} from "./tools/status.js";
import type { RecordedScript } from "./transport.js";

/**
 * Scenario definitions.
 *
 * A scenario directory contains:
 *
 *   scenario.json  — this schema: metadata, file pointers, and the rubric
 *   alert.json     — the AlertManager webhook payload to replay
 *   replay.json    — recorded assistant turns for the dry-run transport
 *   README.md      — narrative, evidence chain, provenance, the operator-gated repro
 *
 * The rubric is the part that matters. It is a **mechanical** specification of
 * what a correct triage report must contain: regexes over sections. It is not
 * model-graded, it holds no opinions, and it can be argued with by editing
 * JSON. That is the point — a grader you can argue with is a grader you can
 * trust to say the same thing twice.
 */

const patternSpec = z.object({
  id: z.string().min(1),
  /** JS regex source, matched case-insensitively unless `flags` says otherwise. */
  pattern: z.string().min(1),
  flags: z.string().default("i"),
  /** Why a correct report must (or must not) contain this. Human-facing. */
  why: z.string().min(1),
});

export type PatternSpec = z.infer<typeof patternSpec>;

/**
 * Strings an expected-tool-failure pattern must NOT match.
 *
 * . The allowance was a bare regex over the
 * failure text, so `[\s\S]*` (or `.*`, or `^`, or `(?:)`) reinstated the
 * pre-3a "every tool failure is fine" behaviour from inside the scenario data
 * that the gate is supposed to constrain — and it would have looked like an
 * ordinary entry in a JSON file nobody re-reads.
 *
 * The test is behavioural rather than a blocklist of wildcard spellings,
 * because there are unboundedly many spellings and exactly one property that
 * matters: a legitimate allowance describes *one specific recorded failure*, so
 * it cannot also match an empty string, a success, or unrelated prose. Anything
 * that matches these is over-broad whatever it looks like.
 *
 * The probes above are all things a failure text does *not* contain, which left
 * the complementary hole wide open: text that **every** failure contains. The
 * sharpest is `[[tool-status: failed]]` — by construction (`src/tools/status.ts`)
 * it terminates every declared failure, so an allowance whose pattern is exactly
 * that marker is 24 characters long, survives the `min(12)` specificity floor,
 * matches none of the probes above, and quietly excuses **every failure shape**
 * for its tool and turn. It reads like a careful, narrow entry.
 *
 * Two changes close it, and the first is the load-bearing one:
 *
 *  1. `src/transport.ts` now matches an allowance against the failure's
 *     *substance* — `withoutStatus(text)` — so the status marker is not part of
 *     what a pattern can match at all. A marker-only pattern therefore matches
 *     nothing and excuses nothing: it fails closed rather than open.
 *  2. the probes below are extended to cover universally-present markers, so
 *     such a pattern is refused at schema-load time with an explanation, rather
 *     than silently never firing. No legitimate allowance needs to match text
 *     that is present in every result regardless of what went wrong.
 */
const OVERBROAD_PROBES = [
  "",
  "\n",
  "ok",
  "the quick brown fox jumps over the lazy dog",
  "$ kubectl get pods --namespace=monitoring\n\nNAME READY STATUS\nfoo 1/1 Running",
  "(no output — the query matched nothing)",
  "Searched 121 documents across gitops@9b01aa30 (48 docs) for: \"ups runtime\"",
  // Universally-present markers (5c/5). Each appears in every result of its
  // class, so matching one says nothing about *which* failure is excused.
  TOOL_STATUS_FAILED,
  TOOL_STATUS_OK,
  `\n\n${TOOL_STATUS_FAILED}`,
  UNTRUSTED_BANNER,
];

/**
 * One declared, expected tool failure — bound to a tool and a turn.
 *
 * An allowance now says *which tool*, on *which recorded assistant turn*, may
 * come back failed, and the pattern still has to match that failure's text. All
 * three must hold, so an allowance written for turn 4's `kubectl_read` cannot
 * excuse a `docs_search` failure on turn 2.
 */
const expectedToolFailureSpec = z
  .object({
    id: z.string().min(1),
    /** The tool whose failure is excused. One name; there is no wildcard. */
    tool: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "tool must be a tool name, e.g. kubectl_read — no wildcards"),
    /** 1-based index of the recorded assistant turn that issues the call. */
    turn: z.number().int().positive(),
    pattern: z
      .string()
      .min(
        12,
        "an expected-failure pattern must be specific enough to describe one recorded failure",
      ),
    flags: z.string().default("i"),
    why: z.string().min(1),
  })
  .superRefine((spec, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(spec.pattern, spec.flags);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: `pattern is not a valid regex: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const matched = OVERBROAD_PROBES.filter((probe) => re.test(probe));
    if (matched.length > 0) {
      ctx.addIssue({
        code: "custom",
        message:
          `pattern /${spec.pattern}/${spec.flags} is trivially over-broad: it also matches ` +
          `${matched.map((m) => JSON.stringify(m.slice(0, 40))).join(", ")}. An expected tool ` +
          "failure declares one specific recorded failure; a pattern that matches unrelated " +
          "text (or nothing at all) re-opens the gate this field exists to keep shut.",
      });
    }
  });

export type ExpectedToolFailureSpec = z.infer<typeof expectedToolFailureSpec>;

const SECTIONS = [
  "Symptom",
  "Evidence",
  "Probable cause (ranked)",
  "Suggested runbook",
  "Confidence",
] as const;

export const REQUIRED_SECTIONS: readonly string[] = SECTIONS;

/**
 * Sections the *code* appends around the model's body (`src/triage.ts` writes
 * the metering footer). Allowed as extras; anything else is an extra section
 * the model invented, which the prompt forbids.
 */
export const FRAME_SECTIONS: readonly string[] = ["Run metering"];

/**
 * Post-mortem sections are addressable by a rubric too, so a post-mortem
 * scenario can require its evidence in "Investigation" rather than "Evidence".
 * The list itself is derived and documented in `src/postmortem.ts`.
 */
const sectionName = z.enum([
  ...SECTIONS,
  ...(POSTMORTEM_SECTIONS as readonly string[] as [string, ...string[]]),
  "Run metering",
  "(any)",
]);

/**
 * Evidence check ids the grader itself emits. A rubric item may not
 * take one: two checks sharing an id would make `incidentTimeOnly` ambiguous
 * and would let a scenario shadow a grader-owned check with a rubric pattern —
 * which is the "tune the rubric until the score moves" failure, arriving by
 * accident rather than on purpose.
 */
export const RESERVED_EVIDENCE_CHECK_IDS: readonly string[] = [
  "attributed-to-tool-calls",
  "investigation-happened",
];

const evidenceSpec = z.object({
  id: z
    .string()
    .min(1)
    .refine((id) => !RESERVED_EVIDENCE_CHECK_IDS.includes(id), {
      message:
        `this evidence check id is reserved by the grader — one of ${RESERVED_EVIDENCE_CHECK_IDS.join(", ")}. ` +
        "Two checks sharing an id would make incidentTimeOnly ambiguous; pick another id",
    }),
  /** Where the evidence must appear. `(any)` searches the whole report. */
  section: sectionName.default("Evidence"),
  /** All of these must match within that section. */
  patterns: z.array(patternSpec).min(1),
});

export const rubricSchema = z.object({
  /**
   * The root cause a correct report must name. Every pattern must match inside
   * the "Probable cause (ranked)" section.
   */
  rootCause: z.object({
    patterns: z.array(patternSpec).min(1),
    /**
     * Patterns that must match the **top-ranked** hypothesis specifically, not
     * merely appear somewhere in the section. This is what separates "named the
     * right cause" from "listed it fourth behind three wrong ones".
     */
    topRanked: z.array(patternSpec).default([]),
  }),
  evidence: z.array(evidenceSpec).default([]),
  /** Patterns that must NOT appear anywhere in the report. */
  forbidden: z.array(patternSpec).default([]),

  emptyVectorRule: z.boolean().default(true),
  /**
   * Rubric checks that can only be satisfied against **incident-time** cluster
   * state.
   *
   * ## What this is for
   *
   * So a scenario states, in advance and with a reason, which of its own checks
   * are historical. On a live/local run a **failing** declared check is
   * reported as `unsatisfiable-now` — a class beside `n/a`, not a pass — and
   * the grade prints both the raw and the achievable denominator.
   *
   * ## The four things this must not become
   *
   *  1. It cannot make a currently-failing thing pass by relabelling: only
   *     checks the scenario **declares**, each with a recorded `why`, are
   *     eligible, and an eligible check that *passes* stays a pass.
   *  2. It does not engage on the recorded/dry-run path. Incident-time checks
   *     are perfectly satisfiable against a recorded transcript — that is what
   *     a recorded transcript *is* — so relabelling there would hide real
   *     regressions in the fixtures.
   *  3. It never hides the raw numbers. `formatGrade` prints both.
   *  4. An id that matches no check is a hard error at grade time, so a
   *     scenario cannot quietly excuse a check it has since renamed.
   */
  incidentTimeOnly: z
    .array(
      z.object({
        /** The exact `Check.id`, e.g. `evidence.prometheus-logs-show-eio`. */
        checkId: z.string().min(1),
        /** Why this is historical. Printed in the grade output verbatim. */
        why: z.string().min(1),
      }),
    )
    .default([]),
});

export type Rubric = z.infer<typeof rubricSchema>;

/**
 * A scenario id is a **path component**, and is constrained like one.
 *
 * . The id was an unconstrained string and
 * is joined into an output path (`reports/<id>/` in `src/replay.ts`), so
 * `"id": "../../outside"` wrote report files outside the repo. A slug cannot
 * traverse: no separators, no dots, no leading dash.
 */
export const SCENARIO_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/* ------------------------------------------------- the fix link */

/**
 * What a CONFIRMED candidate's ground truth may be.
 *
 * The validator therefore requires, for a URL: `https:`, exactly this host, no
 * userinfo, no port, and a path that names a specific commit, issue or pull
 * request in some `<owner>/<repo>`. The alternative form is a bare gitops
 * commit SHA (7–40 hex), which is the same evidence by another route.
 */
export const FIX_SHA_RE = /^[0-9a-f]{7,40}$/;
/** The platform's Forgejo. Any other host is not a link this repo can vouch for. */
export const FIX_URL_HOST = "git.example.com";
/** `<owner>/<repo>/(issues/N | pulls/N | commit/<sha>)`. */
export const FIX_URL_PATH_RE =
  /^\/[^/]+\/[^/]+\/(issues\/\d+|commit\/[0-9a-f]{7,40}|pulls\/\d+)$/;

export type FixLinkKind = "sha" | "forgejo-url";

export function describeFixLink(fix: string): FixLinkKind | undefined {
  if (FIX_SHA_RE.test(fix)) return "sha";
  let url: URL;
  try {
    url = new URL(fix);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.hostname !== FIX_URL_HOST) return undefined;
  // Userinfo is how a link is dressed up to read as one host while resolving
  // to another; a port on this host names nothing this platform serves.
  if (url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  // A query or fragment can carry a token (`?token=…`) into a committed file.
  if (url.search !== "" || url.hash !== "") return undefined;
  if (!FIX_URL_PATH_RE.test(url.pathname)) return undefined;
  return "forgejo-url";
}

export const FIX_LINK_HELP =
  "a fix link must be a gitops commit SHA (7–40 hex characters) or an https URL on " +
  `${FIX_URL_HOST} naming a specific commit, issue or pull request ` +
  "(https://git.example.com/<owner>/<repo>/{issues/N,pulls/N,commit/<sha>}) — no " +
  "userinfo, no port, no query or fragment, no bare host";

export const scenarioSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      SCENARIO_ID_RE,
      "scenario id must be a lowercase slug (^[a-z0-9][a-z0-9-]*$) — it is used as a path component",
    ),
  title: z.string().min(1),
  /**
   * Which product this scenario exercises: the five-section triage report, or
   * the nine-section house post-mortem.
   *
   * This is a **product** flag, not a transport flag. It selects the system
   * prompt and the section set the grader applies. It does not introduce a
   * second code path through the tool loop, the tool execution, the report
   * writer or the transport seam — recorded-vs-live remains the only thing
   * that differs between a dry run and a real run (`src/transport.ts`).
   */
  mode: z.enum(["triage", "postmortem"]).default("triage"),
  /** Failure class — the two committed scenarios must differ here. */
  failureClass: z.string().min(1),
  /** One-paragraph statement of the expected root cause, for humans. */
  expectedRootCause: z.string().min(1),
  /** Provenance of the alert payload: captured, reconstructed or constructed. */
  alertProvenance: z.enum(["captured", "reconstructed", "constructed"]),
  /**
   * Where this scenario's ANSWER KEY came from.
   *
   *  - `human-authored` — the four committed scenarios. A person wrote the
   *    rubric and the known-good report from what actually happened. This is
   *    the default, so the committed files did not need editing to acquire it.
   *  - `frontier-provisional` — staged from a subscription run by
   *    `tools/sub-stage-scenario`. The "answer key" is one model's report and
   *    the rubric is a structural placeholder. **Nothing here is ground truth**,
   *    and a candidate is never enumerated into the graded suite.
   *  - `human-confirmed` — a candidate a human promoted with
   *    `tools/sub-confirm-candidate` by linking the change that actually fixed
   *    the incident (`fixLink`). That link is the ground truth; the frontier's
   *    hypothesis never is.
   *
   * REQUIRED — no default — for anything under `scenarios/candidates/`, so a
   * staged candidate cannot lose its provisional label by omission and read as
   * a human-authored scenario. `loadScenario` enforces that; see below.
   */
  answerKey: z
    .enum(["human-authored", "frontier-provisional", "human-confirmed"])
    .default("human-authored"),
  /**
   * The ranked causes the staged run proposed, verbatim. Recorded for
   * a human to confirm or reject; never read by the grader.
   */
  provisionalCauses: z.array(z.string()).default([]),
  /** How a candidate was produced. Absent on human-authored scenarios. */
  provenance: z
    .object({
      runDir: z.string().min(1),
      /** The commit the run was produced at, or `unknown` — never a guess. */
      sha: z.string().min(1),
      model: z.string().min(1),
      engine: z.string().min(1),
      stagedAt: z.string().min(1),
    })
    .optional(),
  /** The gitops SHA or Forgejo URL that confirmed this candidate's cause. */
  fixLink: z.string().optional(),

  confirmedAt: z.string().datetime({ offset: true }).optional(),
  /** Which provisional cause the human confirmed; `null` when none of them was. */
  confirmedCause: z.string().nullable().optional(),
  files: z.object({
    alert: z.string().min(1),
    replay: z.string().min(1),
    knownGoodReport: z.string().min(1),
    knownBadReport: z.string().optional(),
  }),
  /**
   * Tool results this scenario expects to come back *failed*, as regex specs
   * over the tool-result text.
   *
   * . The recorded transport advanced on
   * turn index alone, so the scripted final report was returned even when
   * every tool call had errored — a replay could PASS having proved nothing.
   * The transport now asserts the previous turn's tool results succeeded, and
   * this is the only escape hatch: an *explicitly declared, per-scenario*
   * expected failure. Anything not declared here is a hard replay failure.
   *
   * The one legitimate entry today is `prometheus-wal-eio`, whose recorded
   * `logs` call names a specific Prometheus pod; when that pod is recycled the
   * read returns NotFound, which is a fact about the live cluster and not a
   * defect in the harness.
   */
  expectedToolFailures: z.array(expectedToolFailureSpec).default([]),
  /**
   * Object names in the recorded script that are resolved against the live
   * cluster at replay time.
   *
   * A recorded `kubectl logs <pod>` names a pod, and pod names are not stable.
   * For `watchdog-heartbeat-backoff` — a two-minute CronJob keeping one or
   * two Jobs in history — every recorded pod name is stale within minutes, so
   * re-recording a literal name is not a fix, it is a fix that expires. The
   * script writes `{{ref:<id>}}` and `src/scenarioRefs.ts` substitutes the
   * current name before the transport is built.
   *
   * This resolves *names* only, through the agent's own read-only kubectl tool.
   * It cannot change what a tool returns, what the recorded report says, or what
   * the grader checks — so it cannot turn a failing scenario green by softening
   * anything. `expectedToolFailures` above stays the only way to excuse a failed
   * tool result, and it is untouched by this.
   */
  dynamicRefs: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must be a lowercase slug"),
        /**
         * Which pod matching the selector to resolve to.
         *
         * `newest-pod` — the newest readable pod, full stop.
         * `newest-failed-pod` — the newest readable pod that **failed**.
         *
         * The second exists because the first cannot express what a
         * failure scenario means. `watchdog-heartbeat-backoff` reads the log of
         * the run that withheld its heartbeat; once the CronJob recovers, the
         * newest pod is a healthy one whose log says `heartbeat pushed`, and the
         * ref's own evidence gate correctly refuses it. The gate was right and
         * the vocabulary was wrong: "newest" was standing in for "the one that
         * failed" only for as long as the workload stayed broken.
         *
         * This still resolves a NAME only. Neither kind can change what a tool
         * returns or what the grader checks, and the evidence gate applies
         * identically to both — a `newest-failed-pod` whose log lacks the
         * declared evidence stops the replay exactly as before.
         */
        kind: z.enum(["newest-pod", "newest-failed-pod"]),
        namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
        selector: z
          .string()
          .regex(
            /^[A-Za-z0-9./_-]+=[A-Za-z0-9./_-]*(,[A-Za-z0-9./_-]+=[A-Za-z0-9./_-]*)*$/,
            "must be an equality label selector, e.g. app.kubernetes.io/name=foo",
          ),
        why: z.string().min(1),
        /**
         * The evidence this ref exists to make readable, as a regex over the
         * run's tool-result text.
         *
         * Required, not optional. A dynamic ref's whole justification
         * is that the scenario's primary evidence read must keep working — the
         * `watchdog-heartbeat-backoff` ref exists so the container's verbatim
         * "withholding heartbeat" line stays obtainable. But the replay gate
         * only checked that the tool call *succeeded*, and a `kubectl logs`
         * against a freshly-started pod succeeds and returns nothing. The
         * scenario would then stay green over evidence that no longer supports
         * its conclusion, which is worse than the stale-name failure it
         * replaced: that one was loud.
         *
         * So the scenario states what the read is *for*, and `runReplay`
         * verifies it appeared. A ref that cannot say what it is fetching has
         * not earned a live cluster read on every replay.
         */
        evidence: z.object({
          pattern: z.string().min(1),
          flags: z.string().default("i"),
          why: z.string().min(1),
        }),
      }),
    )
    .default([]),
  rubric: rubricSchema,
})
  /**
   * The three answer-key states are not independent fields.
   *
   * Each is a claim about where this scenario's answer key came from, and each
   * claim has evidence that must be present for it to mean anything:
   *
   *  - `frontier-provisional` says "a staging tool produced this from a run",
   *    so the staging provenance must be there — and the CONFIRMATION fields
   *    must not, because a provisional candidate carrying a `fixLink` is a
   *    contradiction that would read to a human as confirmed.
   *  - `human-confirmed` says "a person linked the change that fixed it", so
   *    `fixLink` must be present AND valid by the same validator the confirm
   *    command uses, and `confirmedAt` must say when. Without those the label
   *    is an assertion with nothing behind it, which is the failure mode this
   *    whole two-step exists to prevent.
   *  - `human-authored` is the four committed scenarios and carries none of it.
   *
   * Enforced in the schema rather than in the writer, because the writer is not
   * the only way these files change: they are JSON in a repo, and a hand edit
   * that half-confirms a candidate has to fail at LOAD, where every consumer
   * goes through.
   */
  .superRefine((scenario, ctx) => {
    const confirmationFields = (["fixLink", "confirmedAt", "confirmedCause"] as const).filter(
      (field) => scenario[field] !== undefined,
    );
    if (scenario.answerKey === "frontier-provisional") {
      if (scenario.provenance === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["provenance"],
          message:
            "a frontier-provisional candidate must record how it was staged " +
            "(provenance.runDir/sha/model/engine/stagedAt). Without it the report in " +
            "answer-key.md cannot be traced back to the run that produced it.",
        });
      }
      for (const field of confirmationFields) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message:
            `a frontier-provisional candidate must not carry "${field}": confirmation fields on ` +
            "an unconfirmed candidate read as ground truth that nobody established. Run " +
            "tools/sub-confirm-candidate to change the state, rather than adding the field.",
        });
      }
    }
    if (scenario.answerKey === "human-confirmed") {
      if (scenario.fixLink === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["fixLink"],
          message:
            'a human-confirmed candidate must carry the "fixLink" that confirmed it. ' +
            "The link is the ground truth; the label without it is an unsupported claim.",
        });
      } else if (describeFixLink(scenario.fixLink) === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["fixLink"],
          message: `"${scenario.fixLink}" is not a usable fix link — ${FIX_LINK_HELP}`,
        });
      }
      if (scenario.confirmedAt === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmedAt"],
          message: 'a human-confirmed candidate must record "confirmedAt"',
        });
      }
    }
    if (scenario.answerKey === "human-authored" && scenario.provenance !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["provenance"],
        message:
          "a human-authored scenario carries no staging provenance; if this came out of a run " +
          "it is a candidate, and its answerKey should say so",
      });
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;

export type LoadedScenario = {
  scenario: Scenario;
  dir: string;
  alertJson: string;
  script: RecordedScript;
  /**
   * True when `replay.json` declares itself DERIVED from a run's own calls. Such a script is not a recording and must never be replayed;
   * `runReplay` refuses it.
   */
  replayIsDerived: boolean;
};

const recordedScriptSchema = z.object({
  turns: z
    .array(
      z.object({
        text: z.string().optional(),
        /** Read the assistant's final text from a file instead of inlining it. */
        text_file: z.string().optional(),
        tool_uses: z
          .array(
            z.object({
              name: z.string().min(1),
              input: z.record(z.string(), z.unknown()).default({}),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});

/** Absolute path to the committed `fixtures/` tree. */
export function fixturesRoot(): string {
  return path.resolve(new URL("../fixtures", import.meta.url).pathname);
}

class ScenarioPathError extends Error {}

/**
 * Resolve a file pointer out of a scenario and prove it stayed inside the
 * committed data.
 *
 * . `files.*` and `turns[].text_file` were
 * unconstrained strings passed straight to `readFileSync`, so
 * `"text_file": "../../.env"` read an arbitrary local file and spliced it into
 * the scripted assistant response — which the replay harness then writes to a
 * report on disk. Same resolve-and-assert-containment shape as
 * `datasourceProxyPath()` in `src/tools/promql.ts`.
 *
 * Containment is against **two** roots, not one: the scenario's own directory,
 * and `fixtures/`. The second root is required because a committed scenario
 * legitimately points at a shared AlertManager payload
 * (`prometheus-wal-eio/scenario.json` → `../../fixtures/alertmanager/…`), and
 * deduplicating those fixtures is worth more than a one-root rule. Neither
 * root contains `.env`, a kubeconfig, or anything else outside version
 * control, which is the property that actually matters.
 */
export function resolveScenarioFile(dir: string, pointer: string, field: string): string {
  if (pointer.includes("\0")) {
    throw new ScenarioPathError(`${field}: file pointer contains a NUL byte`);
  }
  if (path.isAbsolute(pointer)) {
    throw new ScenarioPathError(
      `${field}: "${pointer}" is an absolute path; scenario file pointers must be relative`,
    );
  }
  const resolved = path.resolve(dir, pointer);
  // . Containment used to be purely
  // lexical, and `realpathSync` was never called — so a committed symlink
  // `scenarios/x/report.md -> ../../.env` passed the check (its *path* is
  // inside the scenario directory) and was then read and spliced into a
  // scripted assistant turn, which the replay harness writes to a report on
  // disk. Resolve symlinks on both sides before comparing: the roots too,
  // because on macOS `/tmp` is itself a symlink to `/private/tmp` and
  // comparing a real path against a lexical root would reject legitimate files.
  const real = realpathOrNearest(resolved);
  const roots = [realpathOrNearest(path.resolve(dir)), realpathOrNearest(fixturesRoot())];
  const contained = roots.some(
    (root) => real === root || real.startsWith(`${root}${path.sep}`),
  );
  if (!contained) {
    throw new ScenarioPathError(
      `${field}: refusing "${pointer}" — it resolves to "${real}"` +
        (real === resolved ? "" : ` (via "${resolved}", which is a symlink)`) +
        `, which is outside both the scenario directory ("${roots[0]}") and the ` +
        `committed fixtures tree ("${roots[1]}").`,
    );
  }
  return resolved;
}

/**
 * `realpathSync` for a path that may not exist yet: resolve the longest
 * existing ancestor and re-append the rest.
 *
 * A missing file must not skip the symlink check — otherwise the check could be
 * evaded by pointing at a not-yet-created path under a symlinked directory,
 * which is the same escape one level up.
 */
function realpathOrNearest(target: string): string {
  const parts: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...parts.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      parts.push(path.basename(current));
      current = parent;
    }
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Absolute path to the committed `scenarios/` tree. */
export function scenariosRoot(): string {
  return path.resolve(new URL("../scenarios", import.meta.url).pathname);
}

/**
 * Staged scenario CANDIDATES live here and are **never** part of the
 * graded suite.
 *
 * A candidate's answer key is one model's report and its rubric is a
 * structural placeholder. Enumerating one would put an unconfirmed hypothesis
 * into the suite that judges the next model — the suite would start measuring
 * agreement with itself, and it would happen by directory listing rather than
 * by anybody deciding it. So the exclusion lives in the single enumeration
 * function every caller goes through (`listScenarioIds`), not in each caller.
 */
export const CANDIDATES_DIR_NAME = "candidates";

export function candidatesRoot(): string {
  return path.join(scenariosRoot(), CANDIDATES_DIR_NAME);
}

export const ANSWER_KEYS = ["human-authored", "frontier-provisional", "human-confirmed"] as const;

/**
 * The field a DERIVED replay script sets on itself.
 *
 * Machine-readable on purpose: the first version said "never replayed" only in
 * a prose `_comment`, which is a claim, not an enforcement. `loadScenario`
 * reads this and `runReplay` refuses to run a script that carries it.
 */
export const DERIVED_REPLAY_MARKER = "derivedFromRun";

/**
 * Is this directory THE candidates tree, or inside it?
 *
 * Canonical containment, not a segment-name test. The
 * first version asked whether any path segment was literally `candidates`,
 * which is wrong in both directions and each direction matters:
 *
 *  - A **symlink alias** to a real candidate resolved to a lexical path with
 *    no such segment, so the "answerKey is required here" rule could be walked
 *    around by loading the candidate through another name.
 *  - Any unrelated path that happened to contain a `candidates/` segment —
 *    someone's scratch directory, another project — was treated as a
 *    candidate and had candidate rules imposed on it.
 *
 * So both sides are canonicalised and compared with `path.relative`: inside
 * means the relative path neither escapes with `..` nor is absolute (a
 * different volume). Same shape as `resolveScenarioFile`'s containment check.
 */
export function isCandidatePath(dir: string): boolean {
  const root = realpathOrNearest(candidatesRoot());
  const target = realpathOrNearest(path.resolve(dir));
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function loadScenario(idOrDir: string): LoadedScenario {
  if (!idOrDir.includes(path.sep) && !SCENARIO_ID_RE.test(idOrDir)) {
    throw new Error(
      `"${idOrDir}" is not a valid scenario id (${SCENARIO_ID_RE.source}); ` +
        "pass a path if you mean a directory outside scenarios/.",
    );
  }
  const dir = idOrDir.includes(path.sep)
    ? path.resolve(idOrDir)
    : path.join(scenariosRoot(), idOrDir);

  const raw = readJson(path.join(dir, "scenario.json"));

  if (isCandidatePath(dir)) {
    const declared =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)["answerKey"]
        : undefined;
    if (declared === "human-authored") {
      throw new Error(
        `${dir}/scenario.json is under scenarios/${CANDIDATES_DIR_NAME}/ but claims ` +
          '"answerKey": "human-authored". Nothing staged from a run is human-authored; a ' +
          "candidate is frontier-provisional until a human confirms it with a fix link. " +
          "If this really is a hand-written scenario, it belongs in scenarios/, not here.",
      );
    }
    if (declared === undefined) {
      throw new Error(
        `${dir}/scenario.json is under scenarios/${CANDIDATES_DIR_NAME}/ and must declare ` +
          `"answerKey" explicitly (one of ${ANSWER_KEYS.join(", ")}). A candidate that omits it ` +
          "would default to human-authored, which is the one thing it is not.",
      );
    }
  }
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${dir}/scenario.json is not a valid scenario:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  const scenario = parsed.data;

  // Every file pointer is contained, including the two report fixtures the
  // loader does not itself read — the check suite reads those, and a pointer
  // that only escapes downstream is still an escape.
  const alertJson = readFileSync(
    resolveScenarioFile(dir, scenario.files.alert, "files.alert"),
    "utf8",
  );
  resolveScenarioFile(dir, scenario.files.knownGoodReport, "files.knownGoodReport");
  if (scenario.files.knownBadReport !== undefined) {
    resolveScenarioFile(dir, scenario.files.knownBadReport, "files.knownBadReport");
  }

  const replayJson = readJson(resolveScenarioFile(dir, scenario.files.replay, "files.replay"));

  const replayIsDerived =
    typeof replayJson === "object" &&
    replayJson !== null &&
    (replayJson as Record<string, unknown>)[DERIVED_REPLAY_MARKER] === true;
  const rawScript = recordedScriptSchema.safeParse(replayJson);
  if (!rawScript.success) {
    throw new Error(
      `${dir}/${scenario.files.replay} is not a valid replay script:\n` +
        rawScript.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }

  const script: RecordedScript = {
    turns: rawScript.data.turns.map((turn, i) => {
      const text =
        turn.text_file !== undefined
          ? `${turn.text ?? ""}${readFileSync(
              resolveScenarioFile(dir, turn.text_file, `turns[${i}].text_file`),
              "utf8",
            )}`
          : turn.text;
      const toolUses = turn.tool_uses;
      return {
        ...(text === undefined ? {} : { text }),
        ...(toolUses === undefined
          ? {}
          : { tool_uses: toolUses.map((u) => ({ name: u.name, input: u.input })) }),
      };
    }),
  };

  return { scenario, dir, alertJson, script, replayIsDerived };
}

/**
 * The committed retrieval transcript for a scenario, if there is one.
 *
 * `fixtures/retrieval/<id>.retrieval.json` is a **verbatim copy of what
 * `docs_search` / `docs_read` returned during a real replay run** — written by
 * `src/replay.ts` next to the report, then committed. It is what lets the
 * offline check suite verify citations with no network, no Forgejo token and no
 * dependence on the corpus not moving: the same bytes the model was shown are
 * the bytes the grader checks quotes against.
 */
export function retrievalFixtureFor(scenarioId: string): string | undefined {
  if (!SCENARIO_ID_RE.test(scenarioId)) return undefined;
  const file = path.join(fixturesRoot(), "retrieval", `${scenarioId}.retrieval.json`);
  return existsSync(file) ? file : undefined;
}

/** Load that transcript as grader evidence. */
export function loadRetrievalEvidence(scenarioId: string): RetrievalEvidence {
  const file = retrievalFixtureFor(scenarioId);
  if (file === undefined) return NO_RETRIEVAL_EVIDENCE;
  return loadRetrievalEvidenceFrom(file);
}

export function loadRetrievalEvidenceFrom(file: string): RetrievalEvidence {
  const parsed = retrievalTranscriptSchema.safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(
      `${file} is not a valid retrieval transcript:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  return evidenceFromCalls(parsed.data.calls);
}

/**
 * The committed **query** transcript for a scenario, if there is one.
 *
 * Provenance matters here and is stated per fixture in
 * `fixtures/queries/README.md`: a fixture is either lifted from a real run's
 * `.transcript.json`, or — for `prometheus-wal-eio`, whose outage was over
 * before this harness existed and whose alert payload is itself marked
 * `reconstructed` — reconstructed from the incident, in exactly the tool-output
 * form `src/tools/promql.ts` produces. A reconstruction is data about a past
 * incident, not evidence about the present cluster, and is labelled as such.
 */
export function queryFixtureFor(scenarioId: string): string | undefined {
  if (!SCENARIO_ID_RE.test(scenarioId)) return undefined;
  const file = path.join(fixturesRoot(), "queries", `${scenarioId}.queries.json`);
  return existsSync(file) ? file : undefined;
}

export function loadQueryEvidence(scenarioId: string): QueryEvidence {
  const file = queryFixtureFor(scenarioId);
  if (file === undefined) return NO_QUERY_EVIDENCE;
  return loadQueryEvidenceFrom(file);
}

export function loadQueryEvidenceFrom(file: string): QueryEvidence {
  const parsed = queryTranscriptSchema.safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(
      `${file} is not a valid query transcript:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }

  return queryEvidenceFromCalls(
    parsed.data.calls.map((call) => ({
      ...call,
      ok: declaredToolStatus(call.result) === "ok",
      empty: resultIsEmptyVector(call.result),
      verdict: verdictTokens(call.result)[0],
    })),
  );
}

const queryTranscriptSchema = z.object({
  scenario: z.string().optional(),
  calls: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      toolUseId: z.string().min(1),
      query: z.string(),
      range: z.boolean().default(false),
      result: z.string(),
    }),
  ),
});

/**
 * The **tool** transcript of a run: every call, of every tool, and what it
 * returned.
 *
 * There is deliberately no per-scenario committed fixture behind this one, and
 * that is a finding rather than an omission. A scenario's `known-good.md` is a
 * hand-written ideal report describing **incident-time** evidence; no transcript
 * that supports it exists or can be produced today (the WAL EIO is gone, the
 * volume is healthy), and manufacturing one to arm the check against a report
 * written before it would be fabricating the evidence this check exists to
 * demand. So the offline known-good/known-bad grades leave attribution `n/a`
 * and say so, and the armed proof lives in `fixtures/grader/` — a real run's
 * report committed together with that run's real transcript.
 */
/**
 * The refusal marker a REFUSED- artefact carries.
 *
 * Present = the file records a run that produced no report. Loading it into a
 * grader would grade a truncated investigation, which is the exact thing the
 * refusal it came from exists to prevent, so both loaders below refuse it by
 * name. This is the brace to the filename's belt: a REFUSED file that someone
 * renames, copies into `fixtures/`, or points `--tools` at still cannot be
 * graded, because the refusal travels INSIDE the artefact.
 */
const refusedMarkerSchema = z
  .object({ refusal: z.string().optional(), reason: z.string().optional() })
  .passthrough();

export function refusedRunDetail(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || !("refused" in raw)) return undefined;
  const marker = refusedMarkerSchema.safeParse((raw as { refused: unknown }).refused);
  return marker.success
    ? `${marker.data.refusal ?? "unknown refusal"} — ${marker.data.reason ?? "no reason recorded"}`
    : "the marker itself is malformed, which is not a reason to trust the file";
}

export function refusedRunError(what: string, detail: string): Error {
  return new Error(
    `${what} is the record of a REFUSED run and must not be graded: ${detail}\n` +
      "  A refused run produced no report and no complete investigation. Its transcript is " +
      "kept so the calls it made are recoverable, never so a truncated run can be scored.",
  );
}

function assertNotRefused(file: string, raw: unknown): void {
  const detail = refusedRunDetail(raw);
  if (detail === undefined) return;
  throw refusedRunError(file, detail);
}

/**
 * The same refusal, at the REPORT entry point (fix round, 2026-08-12).
 */
export function assertGradeableReport(what: string, text: string): void {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return; // not JSON at all: it is prose that happens to start with a brace
  }
  const detail = refusedRunDetail(parsed);
  if (detail === undefined) return;
  throw refusedRunError(what, detail);
}

const toolTranscriptSchema = z.object({
  refused: z.unknown().optional(),
  scenario: z.string().optional(),
  calls: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      tool: z.string().min(1),
      toolUseId: z.string().min(1),
      input: z.record(z.string(), z.unknown()).default({}),
      result: z.string(),
    }),
  ),
});

export function loadToolEvidenceFrom(file: string): ToolEvidence {
  const raw = readJson(file);
  assertNotRefused(file, raw);
  const parsed = toolTranscriptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${file} is not a valid tool transcript:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  // `ok` is re-derived from the recorded result text rather than trusted from
  // the file, for the same reason the query loader re-derives `empty`: a
  // fixture that claimed success over a result declaring failure would attribute
  // an observation to a call that read nothing.
  return toolEvidenceFromCalls(
    parsed.data.calls.map((call) => ({
      ...call,
      ok: declaredToolStatus(call.result) === "ok",
    })),
  );
}

/**
 * Lift the tool transcript out of a full `<report>.transcript.json`.
 */
export function loadToolEvidenceFromTranscript(file: string): ToolEvidence {
  const raw = readJson(file);
  assertNotRefused(file, raw);
  const parsed = fullTranscriptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${file} is not a valid run transcript:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  return toolEvidenceFromMessages(parsed.data.messages);
}

const fullTranscriptSchema = z.object({
  messages: z.array(z.unknown()),
});

const retrievalTranscriptSchema = z.object({
  scenario: z.string().optional(),
  calls: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      tool: z.enum(DOCS_TOOL_NAMES),
      toolUseId: z.string().min(1),
      input: z.record(z.string(), z.unknown()).default({}),
      result: z.string(),
    }),
  ),
});

/**
 * Every scenario id committed under `scenarios/` — the graded suite.
 *
 * `candidates/` is skipped: staged candidates are unconfirmed
 * hypotheses with placeholder rubrics and must never be graded as scenarios.
 * This is the one place the suite is enumerated, so this is the one place the
 * exclusion has to hold.
 */
export function listScenarioIds(): string[] {
  return readdirSync(scenariosRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== CANDIDATES_DIR_NAME)
    .map((entry) => entry.name)
    .sort();
}
