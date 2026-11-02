# Evaluation

How the agent is measured, and what the measurements said. The method is all in
this repository. The results come from runs against the private cluster this
agent was built for; their transcripts and reports contain operational data and
are not published.

## Method

**Frozen scenarios.** Each scenario under [`scenarios/`](../scenarios/README.md)
pins a real incident: the alert payload, a rubric, a known-good report that must
pass and a plausible known-bad report that must fail. The pair keeps the grader
honest: a grader that failed everything, or passed everything, would break one
side.

**A mechanical grader.** `src/grade.ts` scores a report with regular
expressions and structure checks against the rubric. No model grades a model.
It checks the ranked root cause, the cited evidence, the required sections,
reasoning from empty query results, and documentation citations. Evidence and
citations are verified against the tool transcripts the run wrote, so a report
cannot cite a document it never retrieved or quote words the tool never
returned. Without a transcript, a match counts as unverified, not as a pass.

**One loop, swappable transports.** API, subscription and local runs share the
same tools, prompt, evidence sweep, report writer and grader. The recorded
transport replays hand-written turns through that same loop, which tests the
harness without a model; it can never stand in for a model result.

**Incident-time drift is declared, not hidden.** Once an incident is fixed, a
live run cannot observe some of its evidence. A rubric may declare those checks
incident-time only, with a reason each, and a live grade then reports them as
drift and leaves them out of the achievable total. A scenario that declares more
than a third of its scored checks this way is refused as broken.

**Every live run leaves its evidence.** Each run writes the report, the tool,
query and retrieval transcripts, the CLI's raw result (including any permission
denials) and its cost. Results are compared by re-grading those files at a
pinned commit, not by reading the reports by eye.

## Results

**Claude in subscription mode, live.** In its first overnight week (2–8
September 2026) the poller ran 36 live triages with a median of 9.5 turns each,
until the monthly budget guard stopped it as designed. It has run again since
6 October 2026 and has filed its reports as issues since 19 October 2026.

**The publication gate, in production.** Between 6 and 11 October 2026 the gate
refused 33 of 38 poller runs, each for a report that recommended a destructive
command against the alerted object. The refusals were correct, and their volume
is why a refused incident group is now held for 24 hours unless its alerts
change, instead of being retried every hour.

**Local models as the investigator.** The local engine exists to test whether a
model running on local hardware could do this job autonomously. It could not:

- 0 of 20 autonomous runs passed, with a median of one tool call per run;
- the citation check passed in 0 of 29 graded reports;
- the right cause was ranked first in 3 of 15;
- in the watchdog family, all 7 runs that recommended a cluster change
  recommended deleting the alerted Job, which is the incident's evidence.

**Writing from fixed evidence (August 2026).** On a live `KubeJobFailed` alert,
one evidence set was gathered once, interactively, with an operator choosing
each read-only call. Writers were then given identical evidence bytes,
instructions and rubric, with only the model swapped. Claude, as the writer,
passed all five root-cause checks; the local writers passed 0 of 5 cells on
each of the two checks that carry the finding, and 2 of 5 local cells
recommended deleting the alerted Job. This measures report writing from given
evidence. Because an operator chose the calls, it says nothing about how either
model investigates on its own, and no score is compared across the two seats.

**How large a difference means anything.** Four pairs of identically configured
evaluation runs, run back to back, differed in total score by a mean absolute
4.8 points (maximum 8.9). No aggregate gap between configurations was treated
as a result unless it exceeded that; comparisons are made per check instead.

These results are why subscription mode with Claude is the live path, why the
local engine remains an evaluation bench, and why the publication gate exists:
a read-only investigator can still write a destructive recommendation, and a
person reading it at 03:00 might follow it.

## Limits

- Two scenarios are published; the private suite has more, built on data that
  could not be cleaned for publication.
- The root-cause ranking check is a shape check
  ([safety-model.md](safety-model.md#accepted-residuals)); a passing report still
  needs a human read.
- The live comparisons are small samples on one cluster. They show failure
  modes clearly; they do not support fine-grained ranking of models.
