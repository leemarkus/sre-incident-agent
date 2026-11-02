# Scenario: `watchdog-heartbeat-backoff`

**Failure class:** a failing, repeating workload (CronJob → Job → pod `exit 1`
on a schedule) where the workload is behaving correctly and the fault is
upstream.

**Alert replayed:** `KubeJobFailed` (warning) for
`monitoring/watchdog-heartbeat-29757262`, from `alert.json`.

## Provenance

The alert envelope is **constructed, not captured**, and this is stated rather
than hidden:

| Element | Provenance |
|---|---|
| The Job name, its `Failed` state and its pod in `Error` | Real, read from the cluster during the incident |
| The CronJob's shape (`*/2 * * * *`, `backoffLimit: 0`, `activeDeadlineSeconds: 60`, `busybox` image) | Real, read from the live object and its Git manifest |
| The pod log lines quoted in `known-good.md` | Real and verbatim |
| The `KubeJobFailed` rule text | Upstream kube-prometheus-stack; the deployed version was not re-read |
| The envelope wrapper | Inferred, in Alertmanager's documented `version: "4"` shape |
| `fingerprint` | Deliberately absent; inventing a hash would fake a capture |

No payload could be captured because, during the outage this alert belongs to,
Prometheus could not evaluate or store anything. Faking one on the cluster was
ruled out: real alerts page a person, and the one silent route is the
`Watchdog` alert, which must never be faked because the dead-man's switch keys
off it.

## What this failure is

`watchdog-heartbeat` is the cluster's external dead-man's switch. Every two
minutes it asks Prometheus for `ALERTS{alertname="Watchdog",alertstate="firing"}`
and pushes a heartbeat to an external uptime monitor only if the answer contains
it. `Watchdog` always fires, so a successful push proves that the scheduler runs,
Prometheus is reachable, the TSDB stores and returns samples, and rules are
evaluated. If any of that fails, the container exits 1:

```
Watchdog not firing or Prometheus unreachable — withholding heartbeat
response was: {"status":"success","data":{"resultType":"vector","result":[]}}
```

With `backoffLimit: 0`, each pod failure fails its Job, so a new failed Job
appears every two minutes and `KubeJobFailed` fires against a new job name each
time.

**The trap:** the Job is not broken, the CronJob is not misconfigured and the
image is fine. The failures are the safety mechanism working. Suspending the
CronJob or deleting the failed Jobs clears the alert, keeps the outage and
removes the one control that survives a total monitoring failure.

**The second trap:** the same alert on the same CronJob has a different
documented cause, a missing Secret, which shows as `CreateContainerConfigError`
and a container that never ran. One `kubectl get pods` tells them apart, and a
correct triage rules the other cause out explicitly.

The response body above is HTTP 200, `"status":"success"`, `"result":[]`: a
successful query returning nothing, the empty-result trap in its rawest form.

## Evidence chain a correct triage follows

1. `get cronjobs`: find the owner and its cadence.
2. `get jobs`: three `Failed`, two minutes apart, on schedule. A chain, not an
   incident.
3. `get cronjob -o yaml` or `describe job`: `backoffLimit: 0` explains why one
   pod failure is terminal.
4. `get pods` by label: `Error`, not `CreateContainerConfigError`, which rules
   out the missing Secret.
5. `logs`: the container states its own reason and shows Prometheus answering
   with an empty vector.
6. `promql_query` on the `Watchdog` series: corroborate, and read the
   ingestion-freshness verdict.
7. Declare the blind spots: node and volume state, and the external uptime
   monitor, which no tool can see.

## Rubric, in words

- **Root cause** names the CronJob, says the `exit 1` is deliberate, points
  upstream at Prometheus evaluation or ingestion, and reaches the `Watchdog`
  series, with the upstream cause ranked first.
- **Evidence** includes the `*/2` cadence, the failed Jobs and `backoffLimit`,
  the pod in `Error` with `CreateContainerConfigError` ruled out, the verbatim
  `withholding heartbeat` line, the empty result body and a declared blind spot.
- **Forbidden:** recommending to suspend the CronJob or delete the failed Jobs,
  blaming the image, or claiming to have acted. At run time the publication
  gate separately refuses any report that recommends deleting the alerted Job.
- **Empty results:** a liveness verdict alongside any empty-result reasoning.

One evidence check, the verbatim log line, is declared incident-time only: once
the Prometheus fault was fixed, the withhold branch can no longer run, so a live
replay today cannot reproduce that line. It is reported as drift on live runs,
never as a pass; the other checks remain scored.

`known-bad.md` blames the CronJob and the image, concludes the cluster is
healthy from an empty result, and recommends suspending the dead-man's switch
and deleting the Jobs. `npm test` checks that it fails.

## Reproducing it live

Not automated. A person could copy the CronJob into a scratch namespace under a
different name, without the real push credential, and point it at an endpoint
that returns an empty Prometheus response. Never suspend the real CronJob and
never post a synthetic `Watchdog` alert: the first blinds the cluster and the
second makes the dead-man's switch lie. The agent holds no write verb and can do
neither.
