# Safety model

The agent investigates; it does not act. This document says how that is
enforced, what the tests prove, and what is accepted as residual risk.

The guiding rule: **the agent never holds write credentials to the cluster.**
If a feature seems to need them, the feature gets redesigned.

## Layer 1: the tool layer cannot express a write

The model never writes a command line. Every tool takes typed fields, validated
by a strict zod schema, and the harness renders the command from them.

- `kubectl_read` (`src/tools/kubectl.ts`) has a closed `subcommand` enum of
  `get`, `describe`, `logs` and `events`. `apply`, `delete`, `patch`, `scale`,
  `exec` and every other write verb are not denied: they do not exist in the
  schema. Unknown keys (`args`, `flags`, …) are rejected, not stripped.
- Every call is **namespaced**. `resource` is a closed enum of namespaced kinds;
  Secrets, SealedSecrets and every cluster-scoped kind (nodes, PersistentVolumes,
  CRDs, ClusterRoles, namespaces) are absent and cannot be requested.
- Output formats are limited to `wide`, `json` and `yaml`. Template and
  file-backed formats (`go-template-file=…`, `jsonpath-file=…`), which could
  make kubectl read local files into the model's context, are unrepresentable.
- Field values are pattern-bounded (RFC 1123 names, equality selectors,
  durations), so a value cannot smuggle a flag. The argv is spawned with
  `shell: false`. Logs always carry a `--tail` bound.
- `promql_query` and `argocd_status` issue `GET` requests only. The Grafana
  datasource UID is validated and the proxy path is re-resolved to prove it
  stays under `/api/datasources/proxy/uid/<uid>/`.
- `docs_search` and `docs_read` issue `GET` requests only, force every path
  under `docs/`, and pin reads to a commit.

[`test/safety.test.ts`](../test/safety.test.ts) asserts this offline: every
write verb is rejected by the schema, and an exhaustive sweep over subcommand ×
resource × optional-field combinations finds no rendered argv that starts with
anything other than a read verb or carries a flag outside a fixed set.

The one write the system makes is outside the cluster: filing the published
report as an issue (`src/sub/issues.ts`). The destination is operator
configuration (`SRE_SUB_ISSUE_*`), validated as a bare https origin and an
`owner/name` repository; nothing the model writes can change it. The token is
read from 1Password only after the model's process has exited, is checked to
belong to the configured bot account before anything is posted, and is never
placed in the environment, an argument list or a run artefact.

## Layer 2: cluster RBAC

The kubeconfig belongs to a view-scoped, namespaced ServiceAccount. The tool
layer does not depend on RBAC to stay read-only, and RBAC does not depend on the
tool layer: either one alone holds. `scripts/kube-identity-audit.ts` lists what
the identity can do in every namespace (`kubectl auth can-i --list`), checks
that `kubectl auth whoami` names the expected identity, and fails on:

- any verb other than `get`, `list` and `watch`, except `create` on the
  self-review resources (which is how `can-i` itself works);
- any proxy, exec, attach or port-forward subresource (`nodes/proxy`,
  `pods/exec`, `services/proxy`, …), whatever the verb, because each opens a
  channel past the API's read semantics. The single exception is `get` on
  `services/proxy`, restricted by `resourceNames` to the sealed-secrets
  controller and only in its namespace (`--sealed-secrets-namespace`, default
  `kube-system`), which is what fetching its public certificate needs.

A wildcard resource (`*`, `*.*`) is also a violation whatever the verb, because
RBAC matches it against every subresource, `nodes/proxy` included. An
unparseable listing is "could not evaluate", never a pass. The audit does not
judge which readable resources are sensitive: `get` on Secrets in a namespace
passes it, and is kept from the model only by the tool layer's resource list.

## Layer 3: the harness around `claude -p`

API mode uses the Anthropic SDK tool runner, where the only tools that exist are
the five above. Subscription mode runs inside Claude Code, which ships shell,
file and web tools, so the read-only property there rests on versioned
configuration (`claudeArgs` in `src/sub/run.ts`):

| Control | Effect |
|---|---|
| `--restricted` | The CLI removes its command- and code-running built-ins |
| `--tools ""` | Disables every built-in tool and plugin tool registration |
| `--disallowedTools Bash,Read,Write,Edit,…` | Denies shell, file, web, agent and task tools by name as a second layer on the same deny path |
| `--allowedTools mcp__sre__kubectl_read,…` | An explicit list of this server's tools, never a glob |
| `--permission-mode dontAsk` | Anything not pre-approved is refused, never prompted |
| `--strict-mcp-config`, `--setting-sources ""` | No other MCP servers, no user or project settings |
| Empty working directory, `--no-session-persistence` | Nothing on disk for the run to read or leave behind |
| `SUPPORTED_CLAUDE_VERSIONS` | The run refuses any CLI version the belt has not been reviewed against |
| `--max-budget-usd` | Per-run spend ceiling |

Two boundaries sit beside the belt:

- **The child environment is an allowlist.** `claude` gets `PATH`, `HOME`,
  locale and terminal variables, and the subscription credential if one is set;
  nothing else. Provider routing and cloud credentials (`ANTHROPIC_BASE_URL`,
  Bedrock, Vertex, AWS, Azure and similar) refuse the run at config load. The
  MCP server gets a separate tool-only environment and drops the subscription
  credential at startup.
- **Known-secret redaction.** Tool output is scrubbed of the configured tokens
  (raw, URL-encoded, base64 and JSON-escaped forms) and of any
  `Authorization`/`Bearer` echo before it is logged or returned to the model.

## Layer 4: the publication gate

A read-only agent can still recommend something destructive. `src/mutations.ts`
lexes every command line a report recommends; `src/publication.ts` refuses to
publish a report that recommends a destructive verb aimed at the object the
alert is about, one of its pods, or a population selector that includes it.
That object is the incident's evidence: deleting a failed Job clears the alert
and keeps the fault. A refused report exits 7, is kept on disk beside a
`.rejected.json` marker, and is never filed. The poller then holds that incident
group for 24 hours unless its alerts change.

The gate reads commands, not intent. It does not judge prose advice, and a
report that quotes a forbidden command in order to warn against it can be
refused. Both are accepted: a false refusal costs a report, a false pass costs
an incident's evidence.

## Retrieved text is untrusted

Runbook text comes from Git repositories that more than one person can write.
`src/docs/envelope.ts` wraps every retrieved span in markers carrying a per-call
random nonce, so a document cannot forge them, and the system prompt tells the
model that instructions inside the markers are findings to report, never
instructions to follow. Citations are graded against what the tool actually
returned in that run ([evaluation.md](evaluation.md)).

## Egress in local-engine mode

When a local model drives the loop, no investigation data may leave the local
network. `src/egress.ts` resolves every name at connect time and requires every
resolved address to be loopback, RFC 1918, CGNAT or IPv6 local; a name that
resolves to a mixed set is refused. The Kubernetes API endpoint must be declared
as an address literal (`KUBE_SERVER`), because kubectl is a child process whose
connections this process cannot see.

## Accepted residuals

- **Subscription mode is read-only by versioned configuration, not only by
  construction.** A future Claude Code release could add a built-in tool that
  ignores `--tools ""` and is missing from the deny list. The version pin
  refuses unreviewed builds; the tool layer and RBAC still hold underneath.
- **An empty `permission_denials` list proves the model did not try, not that
  trying would have failed.** No adversarial capability probe against the live
  CLI is part of this repository.
- **The budget ledger is a local, best-effort control**, not a billing limit.
- **Redaction covers known credentials and header-shaped echoes.** It cannot
  catch an arbitrary secret printed in a log line the agent reads. Run
  directories are treated like cluster logs and kept out of Git.
- **The grader's root-cause ranking check is a shape check.** A report can pass
  it while exonerating the right cause in unusual words, so root-cause quality
  still needs a human read.
- **A process that can write this process's memory or environment owns it.**
  The guards above are determinism measures against mistakes and hostile
  endpoints, not against a compromised host.
