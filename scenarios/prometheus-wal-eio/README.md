# Scenario: `prometheus-wal-eio`

**Failure class:** a silent storage failure that becomes a total observability
outage, behind a Prometheus pod that reads `2/2 Running`.

**Alert replayed:** `ArgoCDControllerDown` (critical), from `alert.json`.

**Provenance:** reconstructed. The alert was genuinely firing and was read from
Alertmanager's `GET /api/v2/alerts`; the webhook envelope around it was written
by hand in Alertmanager's documented shape, because no webhook POST was captured.

## What happened

| Time (UTC) | Event |
|---|---|
| ~03:04 | Cluster-wide reboot. Everything restarts at once. |
| ~03:15 | Last sample Prometheus writes. `count(up)` is 47, then nothing. |
| 03:08–06:22 | Fifteen alerts fire, including `KubeAPIDown`, `KubeletDown`, `LokiDown` and `ArgoCDControllerDown`. All are absence alerts; every named component is fine. |
| 03:15–18:22 | About 15 hours of zero ingestion. Prometheus logs `input/output error` on every WAL append and on block `meta.json` reads. It does not exit. |
| throughout | The Prometheus pod reads `2/2 Running` with zero restarts. Its probes hit the HTTP API, which answers; nothing probes whether a sample was stored. |
| 18:22 | Resolved: the volume is fsck'd on reattach and the WAL replays. |

Root cause: the unclean restart left the ext4 filesystem on Prometheus's
Longhorn-backed volume crash-dirty, and the mounted filesystem then returned EIO
on writes.

The alert names Argo CD, and Argo CD is healthy. A triage that reasons from the
alert's text reaches a confident wrong answer; one that reasons from the empty
query result reaches a worse one ("nothing is failing"). That is why
`promql_query` reports ingestion freshness itself instead of trusting the model
to check.

## Evidence chain a correct triage follows

1. Re-evaluate the alert expression. The result is empty, and the freshness
   verdict arrives with it.
2. Read the verdict, not the emptiness: an ingestion gap inverts the alert.
3. Establish scope: `count(up)` over 24 hours shows all 47 targets stopping at
   the same instant.
4. Look at Prometheus: `Running`, zero restarts. Say explicitly that this is
   the trap.
5. Read its logs and quote the `input/output error` lines verbatim.
6. Go one layer down: the PVC is `Bound` on Longhorn, which is control-plane
   state and says nothing about I/O.
7. Exonerate the alert's subject by checking Argo CD itself.
8. Declare the blind spot: PVs, Longhorn volumes, node conditions and the kernel
   log are cluster-scoped and out of reach, so the filesystem conclusion is an
   inference and must be labelled as one.

## Rubric, in words

- **Root cause** names Prometheus ingestion, the EIO write failure, the WAL and
  the storage layer, ranked first.
- **Evidence** includes the re-evaluated expression, a quoted ingestion verdict,
  the pod reading `Running`, the EIO log line, the PVC on Longhorn, a check of
  Argo CD and a statement of what namespaced access prevented.
- **Forbidden:** asserting the Argo CD controller is down, declaring an
  all-clear, or claiming to have changed anything.
- **Empty results:** any reasoning about an empty result carries a liveness
  verdict, and no sentence concludes health from one.

Six checks that need the failure itself (EIO, the WAL, the storage layer, the
top ranking, the quoted ingestion verdict and the EIO log line) are declared
incident-time only in `scenario.json`: the fault was fixed, so a live run today
has nothing from which to reach them honestly. When a live run is graded they
are reported as drift and left out of the achievable total, never counted as
passes; on recorded reports they apply in full.

`known-bad.md` believes the alert, cites the metadata endpoint as proof that
Prometheus is fine, concludes health from an empty vector, invents sections,
drops the runbook and claims to have restarted a pod. `npm test` checks that it
fails.

## Reproducing it live

Not automated, on purpose. The scenario is backed by a real timeline, and
inducing storage errors on a production volume to test a triage agent is a bad
trade. If it is ever wanted, a person does it in a scratch namespace with a
throwaway Longhorn volume and a recent backup: run a pod that writes
continuously, detach or hard-power the volume's node underneath it, observe the
pod stay `Running` while writes fail, then recover by reattaching. The agent has
no part in any of it and no code path that could perform it.
