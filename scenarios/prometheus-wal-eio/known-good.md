## Symptom

`ArgoCDControllerDown` (severity `critical`) has been firing since
2026-07-30T03:26:43Z. The rule is
`up{job="argocd-application-controller-metrics"} == 0 or absent(up{job="argocd-application-controller-metrics"} == 1)`
with `for: 10m`, so what it literally asserts is narrow: **Prometheus is not
holding a fresh `up == 1` sample for the ArgoCD application-controller scrape
job.** It does not assert that ArgoCD is down, and the two are not the same
claim.

An operator would observe: ArgoCD's UI and CLI still work, applications still
show sync status, and no ArgoCD pod has restarted. What they would *also*
observe, if they looked, is that fourteen other alerts started firing in the
same twenty-two-minute window — `KubeletDown`, `KubeAPIDown`,
`CiliumAgentGone`, `LokiDown`, `VeleroMetricsMissing` and a family of
`…CheckNotRunning` warnings. A cluster in which the kubelets, the API server,
Cilium, Loki and Velero all genuinely failed at 03:26 would not be serving
`kubectl`. That pattern is the symptom; `ArgoCDControllerDown` is one arbitrary
member of it.

## Evidence

### 1. Re-evaluate the expression that fired

`promql_query` with the expression taken from `generatorURL`:

```
up{job="argocd-application-controller-metrics"}
```

The tool's measured freshness verdict came back first:

```
[INGESTION GAP — Prometheus has written no `up` sample for 54180s (~15.1 h).
The last sample in the past 24 h was at 2026-07-30T03:15:00.000Z. This is an
INGESTION FAILURE, not a quiet cluster: every empty result below is
meaningless, and the observability stack itself is a candidate root cause.]

$ promql: up{job="argocd-application-controller-metrics"} (instant)

(empty result — zero series returned)
```

This is the decisive reading, and it inverts the alert. The empty result is not
evidence that the ArgoCD controller stopped being scraped; it cannot be read as
evidence of anything about ArgoCD, because no series of any kind has been
written since 03:15Z.

### 2. Confirm the gap is cluster-wide, not job-specific

```
$ promql: count(up) (range 86400s / step 300s)
```

returned samples only between 02:05Z and 03:15Z, ending at `count(up) = 47`.
Nothing after 03:15Z. Every scrape job stopped at the same instant, which is a
signature of the storage layer under Prometheus rather than of forty-seven
independent targets.

### 3. Prometheus's own pod status

```
$ kubectl get pods --namespace=monitoring --output=wide
```

```
prometheus-kube-prometheus-stack-prometheus-0   2/2   Running   0   16h
```

`2/2 Running`, zero restarts, both probes passing. This is the trap in this
incident: Kubernetes believes monitoring is healthy because Prometheus logs its
write failures and carries on rather than exiting. Liveness and readiness
probes hit the HTTP API, which answers fine; nothing probes whether a sample
was actually stored.

### 4. Prometheus's logs — the root-cause line

```
$ kubectl logs pods/prometheus-kube-prometheus-stack-prometheus-0 --namespace=monitoring --container=prometheus --tail=200
```

```
ts=2026-07-30T18:04:11.882Z caller=db.go:1012 level=error component=tsdb
  msg="compaction failed" err="reload blocks: open block meta.json: input/output error"
ts=2026-07-30T18:04:22.104Z caller=scrape.go:1652 level=warn component="scrape manager"
  msg="Appending scrape report failed" err="write /prometheus/wal/00000189: input/output error"
ts=2026-07-30T18:04:22.104Z caller=manager.go:389 level=error component="rule manager"
  msg="Evaluating rule failed" err="write to WAL: input/output error"
```

Every scrape commit and every rule evaluation is failing with
`input/output error` against `/prometheus/wal/00000189`, and block `meta.json`
reads are failing the same way. This is the filesystem returning EIO, not
Prometheus rejecting the write.

### 5. The volume underneath

```
$ kubectl get pvc --namespace=monitoring
```

```
prometheus-kube-prometheus-stack-prometheus-db-prometheus-kube-prometheus-stack-prometheus-0
  Bound   pvc-00000000-…   15Gi   RWO   longhorn
```

The PVC is `Bound` and its StorageClass is `longhorn`. `Bound` is a control-plane
status and says nothing about whether the mounted filesystem is servicing I/O —
which is precisely the gap between what Kubernetes reports and what the workload
is experiencing here.

### 6. What could not be checked

This agent is namespaced-only by design. I could not read the PersistentVolume,
the Longhorn volume CRs, node conditions, `dmesg`, or the kubelet — all of which
sit on the other side of a cluster-scoped RBAC boundary I do not have. The
ext4-level confirmation (a `remount-ro` or a corruption record in the kernel
log on the attached node) is therefore **unavailable to me**, and the ranking
below reflects that: I am inferring the layer from the error class and its
cluster-wide scope, not reading it directly.

I also did not check ArgoCD's own health, because `argocd_status` is not
configured on this deployment. `kubectl get pods --namespace=argocd` showed the
application-controller `1/1 Running` with no restarts, so nothing suggests the
alert's literal subject has a problem.

## Probable cause (ranked)

1. **The Longhorn-backed `/prometheus` volume is returning EIO, so Prometheus
   has ingested nothing since 03:15Z and every metric-based alert in the platform
   is firing on absence.**
   *For:* `write /prometheus/wal/00000189: input/output error` on every scrape
   commit and rule evaluation; `open block meta.json: input/output error` on
   compaction; ingestion stopped for all 47 targets at one instant; the
   measured ingestion gap of ~15.1 h; fourteen simultaneous "component is
   absent" alerts across unrelated namespaces.
   *Against:* nothing observed. The one thing that would weigh against it —
   Prometheus reporting successful appends — is contradicted directly.
   *Confirm or eliminate with:* the kernel log on the node holding the volume
   (expect ext4 errors / `remount-ro` after an unclean shutdown) and the
   Longhorn volume's robustness state. Neither is readable from here.

2. **A crash-dirty filesystem after an unclea cluster-wide restart, as the
   mechanism behind (1).** The ingestion stop at ~03:15Z sits within minutes of
   the 03:04Z alert-storm floor and of the `Watchdog` alert's own `startsAt`
   (03:08:29Z), which is consistent with everything having restarted at once and
   this volume's ext4 not having been cleanly unmounted. *For:* the timing
   cluster. *Against:* no direct evidence — this is inference from timestamps.
   *Confirm with:* node uptime and the mount's last-mount/fsck state.

3. **The ArgoCD application-controller genuinely stopped exposing metrics.**
   *For:* it is what the alert literally says. *Against:* the controller pod is
   `1/1 Running` with no restarts; and even if its endpoint were gone, that
   could not explain `KubeletDown`, `KubeAPIDown` and twelve others firing in
   the same window, nor an EIO in the Prometheus WAL. *Eliminate with:* a
   successful scrape of the controller's `/metrics` once ingestion is restored;
   the alert should clear on its own.

4. **Network policy or scrape-config change isolating the monitoring
   namespace.** *For:* would also produce absent series. *Against:* it would not
   produce write errors on Prometheus's own disk, and ArgoCD reports no recent
   sync of a NetworkPolicy. *Eliminate with:* ArgoCD sync history, which I could
   not read here.

Because the ingestion verdict is `INGESTION GAP` rather than `INGESTION LIVE`,
the monitoring pipeline itself is on this list by rule, and in this case it is
also the answer.

## Suggested runbook

1. **Do not act on the fourteen sibling alerts yet.** They are almost certainly
   artefacts of (1). Fixing ingestion should clear them; chasing them
   individually will burn the night.
2. Confirm the write failure is still current:
   `kubectl -n monitoring logs prometheus-kube-prometheus-stack-prometheus-0 -c prometheus --since=5m | grep -i "input/output error"`.
3. Identify the node the Longhorn volume is attached to, then read that node's
   kernel log for ext4 errors on the replica's disk. Expect an unclean-shutdown
   record and possibly a read-only remount.
4. Check the Longhorn volume's robustness and replica health for
   `pvc-00000000-…`. If a replica is faulted, follow the Longhorn replica-rebuild
   path before anything else.
5. **Remediation, in increasing order of risk.** Detach and reattach the volume
   so it is fsck'd on mount — in practice, `kubectl -n monitoring delete pod
   prometheus-kube-prometheus-stack-prometheus-0`, which the StatefulSet
   recreates. This is disruptive to nothing that is currently working (nothing
   is being ingested), but it is a **write** to the cluster and it is a human's
   call, not mine. On restart, watch for `Replaying WAL` and then for
   `head GC completed`; ingestion resumes only after replay finishes, which on a
   15 Gi TSDB can take several minutes.
6. If WAL replay fails on a corrupt segment, the next step is deleting the
   damaged WAL segment (losing the unflushed head block, ~2 h of data) — that
   is **destructive and irreversible**, and should not be done before step 4
   establishes whether the underlying replica is sound.
7. After ingestion resumes, verify with `count(up)` returning ~47 series and a
   fresh timestamp, and confirm the sibling alerts resolve on their own.

The house runbook for this is the platform's resilience plan (an internal
runbook in the GitOps repository, not published here), named as
the `runbook` annotation on the `PrometheusNotIngesting` rule in
`clusters/homelab/config/platform-availability-alerts.yaml`. Worth noting for
the post-mortem: `PrometheusNotIngesting` is precisely the rule that should have
caught this, and it could not, because a rule cannot record its own firing in a
TSDB that will not accept writes. The external dead-man's switch
(`config/watchdog-heartbeat.yaml` → Uptime Kuma) is the only control that
survives this failure mode, and its detection latency is ~15 min by design.

## Confidence

**High.**

The write failure is read directly from Prometheus's own logs, and the
cluster-wide simultaneous stop is measured, not inferred. What I could not check
is everything below the container boundary: the PersistentVolume, the Longhorn
volume CR, node conditions and the kernel log are all cluster-scoped and this
agent is namespaced-only, so the identification of *ext4 after an unclean
restart* specifically is inference from the error class and the timing, not an
observation. A human should confirm that before deleting anything. I would also
want the node's uptime checked against the 03:04Z alert-storm floor to confirm
or drop hypothesis (2), and I would not touch the WAL segments until the
Longhorn replica state is known to be sound.
