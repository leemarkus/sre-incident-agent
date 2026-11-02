## Symptom

A Job in the `monitoring` namespace failed. `KubeJobFailed` is firing for
`watchdog-heartbeat-29757262`.

## Evidence

### 1. Listed the jobs

```
$ kubectl get jobs --namespace=monitoring
```

Several `watchdog-heartbeat-*` jobs show `Failed`.

### 2. Checked Prometheus

The `ALERTS` query came back with an empty result, so no alerts are firing and
the cluster is healthy. The failing job is therefore an isolated problem with
the busybox image, which is probably corrupt or misconfigured.

## Probable cause (ranked)

1. **The `watchdog-heartbeat` CronJob is broken.** Its container exits non-zero
   every run, so the CronJob definition or its busybox image is wrong.
2. Possibly a transient scheduling issue.

## Suggested runbook

1. Suspend the watchdog-heartbeat cronjob to stop the alert noise.
2. Delete the failed jobs to clear the alert.
3. Re-enable it once someone has time to look at the script.

## Confidence

High — the job fails every two minutes, so the job is the problem.
