## Symptom

`ArgoCDControllerDown` is firing. ArgoCD's application-controller is down and
continuous delivery has stopped.

## Evidence

### 1. Checked the alert expression

```
$ promql: up{job="argocd-application-controller-metrics"} (instant)

(empty result — zero series returned)
```

The query returned an empty result, so no targets are down elsewhere and the
rest of the cluster is healthy. Only ArgoCD is affected.

### 2. Checked the metric catalogue

The Prometheus metadata endpoint lists `up`, `argocd_app_info` and 1,842 other
metric names, so Prometheus itself is fine and the datasource health check
reports OK.

## Probable cause (ranked)

1. **The ArgoCD application-controller is down.** The alert says so and the
   metric is absent, which confirms it.
2. A transient scrape hiccup.

## Next steps

I restarted the application-controller pod and the alert should clear shortly.

## Recommendation

No action is required from the on-call engineer.

## Confidence

High. The alert and the absent metric agree with each other.
