# Replay scenarios

A scenario is data plus documentation: a frozen alert, a rubric, and two
hand-written reports that pin the grader's behaviour. Nothing in this directory
can change cluster state.

```
scenarios/<id>/
  scenario.json   metadata, file pointers and the grading rubric
  alert.json      the Alertmanager webhook payload to replay
  replay.json     recorded assistant turns for the dry-run transport
  known-good.md   a report that must pass the rubric
  known-bad.md    a plausible wrong report that must fail it
  README.md       what happened, the evidence chain, provenance
```

| Scenario | Failure class | Alert |
|---|---|---|
| [prometheus-wal-eio](prometheus-wal-eio/README.md) | Silent storage failure behind a pod that reads `Running` | `ArgoCDControllerDown` |
| [watchdog-heartbeat-backoff](watchdog-heartbeat-backoff/README.md) | A repeating Job failure where the workload is right and the fault is upstream | `KubeJobFailed` |

Both are built from real incidents on the cluster this agent was written for.
Each README states which parts of its alert payload were captured, reconstructed
or constructed.

## Running one

```sh
npm run grade  -- --scenario prometheus-wal-eio --known-good     # offline
npm run grade  -- --scenario prometheus-wal-eio --report <path>  # offline
npm run replay -- --scenario prometheus-wal-eio --dry-run        # needs a cluster
npm run replay -- --scenario prometheus-wal-eio --live           # needs a cluster and an API key
```

Grading is offline. A replay is not: in every mode the tools really execute
their read-only calls against the cluster in `.env`. `--dry-run`, `--live` and
`--local` differ only in which transport supplies the assistant turns
(`src/transport.ts`). A dry run therefore proves the harness, never the model:
its turns are hand-written and its report says so in its first line.

## The rubric

The grader (`src/grade.ts`) is mechanical: regular expressions and structure
assertions over a report and a committed rubric. No model grades anything.

| Dimension | Check ids | Question |
|---|---|---|
| root cause | `root-cause.*`, `forbidden.*` | Is the expected cause named and ranked first? Is nothing forbidden claimed or recommended? |
| evidence | `evidence.*` | Is the expected evidence cited in the Evidence section? |
| sections | `sections.*` | Are the five required sections present, in order, with nothing invented? |
| empty results | `f3.*` | Is every conclusion from an empty query result paired with a liveness verdict or a named gap? |
| citations | `citations.*` | Does every documentation claim quote, verbatim, a document this run actually retrieved, at the commit it names? |
| post-mortem | `postmortem.*` | For post-mortem drafts: nine sections, none hollow, a stamped timeline, actionable follow-ups |

A citation has this form in the report's prose:

```
`gitops:docs/runbook-example.md@0123abcd` — "the quoted passage"
```

Elision is refused, citations inside fenced blocks do not count, and a citation
that cannot be checked because no retrieval transcript was supplied is not
counted as verified.

When a report is graded without its run's tool transcript, evidence that
matches the rubric is reported as unverified rather than verified, so the best
offline verdict is `PASS-WITH-UNVERIFIED`. A pass means the report did not fail
mechanically. It is a floor, not a quality score; whether a report is good is
still a human judgement.

## Adding a scenario

1. Commit the alert payload and state its provenance honestly in
   `scenario.json` and the README. Do not invent fields a real capture would
   have had.
2. Write `known-good.md`, the report you would accept at 03:00.
3. Write the rubric so `known-good.md` passes and a plausible wrong report does
   not; write that wrong report as `known-bad.md` and check it fails for the
   reasons you intended. `npm test` checks both for every scenario.
4. Record the assistant turns in `replay.json` along the evidence chain.
5. If reproducing the failure live needs a cluster change, write it down as a
   manual runbook for a person. Do not script it.
