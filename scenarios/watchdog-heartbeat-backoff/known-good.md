## Symptom

`KubeJobFailed` (severity `warning`, `for: 15m`) is firing for
`monitoring/watchdog-heartbeat-29757262`. What it literally asserts is that
kube-state-metrics is reporting `kube_job_failed > 0` for one Job object. What
is actually happening is broader and steadier than one Job: the
`watchdog-heartbeat` CronJob runs on `*/2 * * * *` with `backoffLimit: 0`, so a
failing run produces a `Failed` Job every two minutes, and the alert will keep
re-firing against a new `job_name` each time rather than resolving.

An operator would observe a wall of `Error` pods in `monitoring` with the
`watchdog-heartbeat` label, three retained failed Jobs (`failedJobsHistoryLimit:
3`), and — the part that matters far more than the alert — **no heartbeat
arriving at the external Uptime Kuma push monitor**, which is the platform's
dead-man's switch for the monitoring stack. The Job is not malfunctioning. It is
refusing to push, which is precisely what it was built to do when it cannot
prove Prometheus is alive.

## Evidence

### 1. The CronJob and its cadence

```
$ kubectl get cronjobs --namespace=monitoring
```

```
NAME                 SCHEDULE       SUSPEND   ACTIVE   LAST SCHEDULE   AGE
watchdog-heartbeat   */2 * * * *    False     0        36s             8d
```

Not suspended, firing every two minutes as intended. `describe` shows
`backoffLimit: 0` and `activeDeadlineSeconds: 60` on the job template, which is
why each run becomes a `Failed` Job immediately rather than retrying: one pod
failure is terminal for that Job by design.

### 2. The Jobs

```
$ kubectl get jobs --namespace=monitoring
```

```
watchdog-heartbeat-29757258   Failed   0/1   …
watchdog-heartbeat-29757260   Failed   0/1   …
watchdog-heartbeat-29757262   Failed   0/1   …
```

Three consecutive failures, two minutes apart, matching the schedule exactly.
This is a repeating condition, not a one-off — which already argues against a
transient scheduling or image-pull problem.

### 3. The pods

```
$ kubectl get pods --namespace=monitoring --selector=app.kubernetes.io/name=watchdog-heartbeat
```

```
watchdog-heartbeat-29757258-jdw8l   0/1   Error   0   103m
watchdog-heartbeat-29757260-gv4ff   0/1   Error   0   101m
watchdog-heartbeat-29757262-6pwth   0/1   Error   0    99m
```

`Error`, not `CreateContainerConfigError` and not `ImagePullBackOff`. That
distinction is load-bearing: the documented *other* cause of exactly this alert
for exactly this CronJob is a missing `watchdog-heartbeat` Secret, which
presents as `CreateContainerConfigError` and never runs the container at all.
Here the container ran and exited non-zero, so the Secret is present and the
image pulled.

### 4. The pod log — the actual answer

```
$ kubectl logs pods/watchdog-heartbeat-29757262-6pwth --namespace=monitoring --tail=20
```

```
Watchdog not firing or Prometheus unreachable — withholding heartbeat
response was: {"status":"success","data":{"resultType":"vector","result":[]}}
```

Two facts in two lines. First, the container took the `exit 1` branch of its own
guard clause deliberately. Second — and this is the important one — Prometheus
answered the query **successfully**: HTTP 200, `"status":"success"`, and
`"result":[]`. The query is
`ALERTS{alertname="Watchdog",alertstate="firing"}`, and `Watchdog` is an
always-firing rule. An empty result for an always-firing alert is not a quiet
cluster; it means the rule manager is not evaluating or the TSDB is not storing
what it evaluates.

### 5. Cross-check against ingestion freshness

```
$ promql: ALERTS{alertname="Watchdog",alertstate="firing"} (instant)
```

```
[INGESTION GAP — Prometheus has written no `up` sample for 7620s (~2.1 h). …]

(empty result — zero series returned)
```

The measured verdict corroborates the container's own observation from a second
angle: this empty result is not evidence of health, because nothing has been
written for hours.

### 6. What could not be checked

I am namespaced-only, so node conditions, the PersistentVolume behind
Prometheus and the kubelet are unreadable from here — if the ingestion stall has
a storage cause, I cannot see the storage layer. I also could not verify the
external side: whether Uptime Kuma has actually gone DOWN and notified is
outside this cluster entirely (a separate observability host), and nothing in
my tool surface reaches it.

## Probable cause (ranked)

1. **The Job is failing on purpose: its guard clause found `ALERTS{alertname="Watchdog"}`
   empty and exited 1 rather than pushing a heartbeat. The real fault is
   upstream — Prometheus is not evaluating or not storing the `Watchdog` rule.**
   *For:* the container's own log line (`withholding heartbeat`); a `200
   success` response carrying `"result":[]`; `Error` rather than
   `CreateContainerConfigError`; failures repeating exactly on the `*/2`
   schedule; the independent `INGESTION GAP` verdict.
   *Against:* nothing observed.
   *Confirm or eliminate with:* `count(up)` over a 24 h range — if the last
   sample is hours old, the TSDB is the fault and this Job is a symptom.

2. **The Prometheus Service is unreachable from the `monitoring` namespace
   (NetworkPolicy, DNS, or a dead Service endpoint).** The guard clause treats
   "unreachable" and "empty" identically, and its message says so.
   *For:* the same log line covers this case. *Against:* `wget` returned a
   well-formed Prometheus JSON envelope, which an unreachable endpoint would
   not produce — `RESP` would have been empty and the log would have printed
   `response was: <empty>`. *Eliminate with:* the log line already eliminates
   it; this ranks second only because it is the other half of the message.

3. **The `Watchdog` alerting rule was removed or relabelled**, so the query is
   correct and the series genuinely does not exist. *For:* would produce an
   identical empty result. *Against:* the `INGESTION GAP` verdict means *no*
   series are being written, which is a broader failure than one rule; and the
   platform's own alert inventory showed `Watchdog` present and firing earlier
   today. *Eliminate with:* `kubectl get prometheusrules -n monitoring` and the
   Prometheus `/rules` page once ingestion is restored.

4. **A broken image or a missing Secret in the CronJob itself.** *For:* the
   documented failure mode for this exact CronJob when
   `sealed-secret-watchdog-heartbeat.yaml` is absent. *Against:* that presents
   as `CreateContainerConfigError` with no container start; here the container
   ran and produced application output. *Eliminate with:* the pod status above,
   which already does.

Because the ingestion verdict is not `INGESTION LIVE`, the monitoring pipeline
itself is a candidate by rule — and here it is the answer, with this alert as a
second-order symptom.

## Suggested runbook

1. **Do not suspend the CronJob and do not delete the failed Jobs to quiet the
   alert.** The failures are the dead-man's switch working; silencing them
   removes the only control that survives a total monitoring outage. Whoever
   deletes these Jobs will clear the alert and keep the outage.
2. Establish whether Prometheus is ingesting at all:
   `kubectl -n monitoring exec deploy/kube-prometheus-stack-grafana -- wget -qO- 'http://kube-prometheus-stack-prometheus:9090/api/v1/query?query=count(up)'`,
   or the same query through Grafana. An empty or hours-stale answer confirms
   hypothesis (1).
3. If ingestion has stalled, treat this as the monitoring-outage incident, not
   as a CronJob incident: check
   `kubectl -n monitoring logs prometheus-kube-prometheus-stack-prometheus-0 -c prometheus --since=15m`
   for `input/output error` on the WAL, then the Longhorn volume behind
   `/prometheus`. That path is the `prometheus-wal-eio` scenario in this repo
   and the platform's resilience plan (an internal runbook, not published here).
4. If ingestion is live and only the `Watchdog` rule is missing, restore the
   rule; the heartbeat resumes on the next `*/2` tick with no intervention.
5. Confirm recovery from the outside: a push should reach the Uptime Kuma
   monitor (id 101, heartbeat 300 s, retries 2) within two minutes of the fix,
   and the next Job should read `Complete`. Note the drill-measured detection
   latency is ~15 min, so absence of an alarm in the first five minutes proves
   nothing either way.

The house runbook is `gitops/clusters/homelab/config/watchdog-heartbeat.yaml`
(its header documents both failure modes and the alarm-path drill) plus
the platform's resilience plan, which puts detection outside the failure
domain on purpose. That plan also records that during an earlier ingestion
outage the identical query returned empty while every scrape target showed
up, which is exactly the shape of this alert. What no runbook currently says,
and should: **`KubeJobFailed` on `watchdog-heartbeat` is a monitoring-outage
alert wearing a workload-failure costume.** It deserves its own named rule at
`critical`, because the generic 15-minute `warning` reads as ordinary pod noise.

## Confidence

**High** on the mechanism, **Medium** on the layer beneath it.

The Job's own log line states its reason, and the `200 success` with
`"result":[]` is unambiguous about where the fault is not. What I have not
established is *why* Prometheus is not producing the `Watchdog` series — I can
see the gap but not its cause, because that trail runs into node and volume
state I cannot read as a namespaced-only agent. A human should confirm the
ingestion stall directly and then follow the storage path before touching
anything here. I would also want the Uptime Kuma monitor checked by hand: if it
has *not* alarmed after ~15 minutes of withheld heartbeats, the dead-man's
switch has a second, worse problem.
