import { EgressError, checkEgressUrl } from "./egress.js";

/**
 * ## The problem this file exists for
 *
 * `EGRESS_URL_VARS` covers the five HTTP endpoints this process dials **in
 * process**, and the locality argument in `src/egress.ts` rests on the
 * connect-time half: a name is validated inside the socket's own DNS lookup, so
 * the address checked is the address connected to.
 *
 * `kubectl` has neither property. It is a **child process**: it does its own DNS
 * resolution and opens its own connection, so `checkEgressUrl`, `localOnlyLookup`
 * and `localFetch` never see it. Every `kubectl get`/`describe`/`logs` query, and
 * every byte of cluster output it returns, is investigation content — the single
 * largest source of it in a run — so under local mode the endpoint kubectl
 * dials has to be constrained by something.
 *
 *  - an accessor that can partially fail reported that failure as a benign value
 *    of its success type (`undefined` = "no kubeconfig" = "inject no `--server`"),
 *    so enforcement silently disappeared on the unhappy path; and
 *  - reading the document AT ALL ingests it: `config view --minify -o json`
 *    without `--raw` still emits `exec.env` values and `auth-provider`
 *    `client-secret`/`id-token`/`refresh-token` **verbatim** (reproduced), so
 *    `JSON.parse(stdout)` materialised credentials in this process — a breach of
 *    the never-read-the-credential invariant — and the refuse-on-field allowlist
 *    that followed was open-ended by construction.
 *
 * **So the endpoint is a value we DECLARE and VALIDATE, not one we re-derive
 * from someone else's document.** `KUBE_SERVER` is validated through exactly the
 * machinery the five HTTP endpoint vars use ({@link checkEgressUrl} /
 * `classifyHost`) and the validated canonical origin is injected as
 * `--server=<literal>` on every kubectl argv (`runKubectl`). `--server` on argv
 * overrides the file's cluster server entirely (verified), so **the kubeconfig's
 * `cluster.server` field cannot influence the endpoint kubectl is asked for.**
 * The kubeconfig supplies credentials and CA only; kubectl reads them, and this
 * process never opens, spawns against, or ingests the document.
 *
 * Two properties are load-bearing and are pinned by the offline check suite:
 *
 * ## Names are refused here, unlike the five HTTP vars (R17)
 *
 * A name is admitted for the HTTP endpoints only on the strength of being
 * re-checked inside the socket's own DNS lookup. There is no such lookup to hook
 * in another process, so an undecidable verdict folds into REFUSE (the polarity
 * rule, R6). A cluster addressed by name must be addressed by IP literal, or the
 * run must be in API mode, where locality is not claimed.
 *
 * ## The accepted residual
 *
 * Because nothing here inspects the kubeconfig, a dial-out mechanism planted in
 * it would still act — `proxy-url` (redirects the TCP destination), `exec` (runs
 * a command on the agent host at API-call time), `auth-provider` (dials an
 * issuer), and the set is open-ended rather than those three. A validated
 * `--server` constrains none of them. This is **accepted, not overlooked**.
 * Planting it requires writing a 600-perm file in the operator's home directory, i.e.
 * workstation compromise.
 *
 * ## What this does NOT check: the credential
 *
 * Nothing here says anything about what the credential in that kubeconfig is
 * allowed to DO. See `docs/safety-model.md`: the read-only half of "the
 * agent never gets write access to the cluster" is enforced by cluster RBAC and
 * by the rendered argv (only `get`/`describe`/`logs`/`events` exist), not by this
 * file.
 */

/** The minimum a config must expose for the kubectl child environment. */
export type KubectlEnvConfig = { HOME?: string; KUBECONFIG?: string };

/**
 * The one config field the endpoint guard reads. Nothing else.
 *
 * Typed `unknown` **deliberately**. `Config`
 * is structural and the exported library paths (`localTransport`,
 * `kubectlReadTool`) accept a hand-built one, so the static type `string` was a
 * claim about well-behaved callers rather than a fact about values. Declaring it
 * `unknown` makes the runtime `typeof` check below the thing that establishes the
 * type, which is what it always actually was.
 */
export type KubeServerConfig = { KUBE_SERVER?: unknown };

/**
 * The child's environment, built from the snapshot — not inherited from it.
 */
export function kubectlChildEnv(config: KubectlEnvConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if ((config.HOME ?? "") !== "") env["HOME"] = config.HOME;
  if ((config.KUBECONFIG ?? "") !== "") env["KUBECONFIG"] = config.KUBECONFIG;
  return env;
}

const REFUSE_PREFIX = "refusing to run in local-engine mode: ";

const HOW_TO_FIX =
  "Set KUBE_SERVER to the cluster's API endpoint as an ADDRESS LITERAL in the local set " +
  "(loopback, RFC 1918, CGNAT 100.64/10, ::1, fc00::/7) — for this deployment " +
  "`KUBE_SERVER=https://192.0.2.10:6443` — or run in API mode, where locality is not claimed.";

/**
 * The validated Kubernetes API endpoint for a local run, as a **canonical
 * primitive string** — the exact value that reaches `--server=` on argv.
 *
 * Reads `config.KUBE_SERVER` and nothing else. It opens no file and spawns no
 * child process — see the file header for why that is the point rather than an
 * implementation detail.
 *
 * ##: the value validated IS the value shipped
 *
 *  - **Node canonicalises IPv4; Go does not.** `https://127.1:6443`,
 *    `https://127.0.0.1.:6443`, `https://2130706433:6443` and
 *    `https://0x7f000001:6443` all parse to hostname `127.0.0.1` in Node and are
 *    correctly classified loopback — but Go's `net.ParseIP` rejects the short,
 *    decimal and hex forms, so kubectl would treat the shipped string as a **DNS
 *    name** and resolve it in the child. That is exactly the undecidable
 *    connect-time lookup R17 says must fold to REFUSE. These spellings are not
 *    refused — they *are* loopback — they are **normalised**: shipping the
 *    canonical dotted-quad is what makes Go agree with Node.
 *  - **A non-string `KUBE_SERVER` coerces twice, differently.** `Config` is
 *    structural and the exported `localTransport`/`kubectlReadTool` paths accept
 *    a hand-built one, so an object whose `toString()` returns a local URL to
 *    `new URL()` and a public one to the `` `--server=${…}` `` template would
 *    validate local and inject public. The `typeof` guard below refuses that
 *    before any coercion happens.
 *
 * So: **an explicit `typeof === "string"` guard, an origin-only contract, and a
 * return of `url.origin` — the canonical primitive the validator actually
 * judged — never `declared`.** The origin-only contract is what keeps step three
 * lossless: `url.origin` drops any path, query or fragment, so rather than
 * silently discard them this refuses them. `url.origin` also renders IPv6
 * correctly bracketed (`https://[::1]:6443`), which re-serialising a raw string
 * would not guarantee.
 *
 * ## The origin-only contract is a DELIBERATE RESTRICTION, not a fact about
 * ## Kubernetes
 *
 * This used to say "a Kubernetes API endpoint is an origin", and that is too
 * categorical to be true. A kubeconfig's `cluster.server` may carry a path, and
 * path-prefixed API endpoints are real deployments — a Rancher-style proxy
 * publishes `https://host/k8s/clusters/c-xxyyzz`, and kubectl appends its own
 * API paths beneath the prefix perfectly happily. `KUBE_SERVER` with such a
 * prefix is REFUSED here, and that refusal is a decision this project made, not
 * a property of the protocol.
 *
 * **What it costs, stated rather than hidden.** A reverse-proxy or path-prefix
 * deployment cannot be addressed by this agent in local mode at all. That is
 * a real limitation and not a security property; it is affordable only because
 * this deployment's endpoint is `https://192.0.2.10:6443`, an origin. If a
 * path-prefixed cluster ever needs to be reached, the work is to carry the
 * normalised path through `assertKubectlServerLocality`'s return value into
 * `--server=` and pin the canonicalisation of BOTH components against Go's — not
 * to relax this check and let the path be dropped silently.
 */
export function assertKubectlServerLocality(config: KubeServerConfig): string {

  const raw = config.KUBE_SERVER;
  if (raw !== undefined && typeof raw !== "string") {
    throw new EgressError(
      REFUSE_PREFIX +
        `KUBE_SERVER must be a string, got ${typeof raw}. This is a real boundary and not a ` +
        "formality: `Config` is structural, and the exported library entrypoints " +
        "(`localTransport`, `kubectlReadTool`) accept a hand-built one, so a value whose " +
        "`toString()`/`valueOf()` answers differently on its second interrogation would be " +
        "VALIDATED as one endpoint and INJECTED on argv as another. The endpoint is declared " +
        "as text, and only text is accepted. " +
        HOW_TO_FIX,
    );
  }
  const declared = (raw ?? "").trim();
  if (declared === "") {
    throw new EgressError(
      REFUSE_PREFIX +
        "KUBE_SERVER is not set. kubectl is a child process — it resolves and connects on its " +
        "own, so neither localOnlyLookup nor localFetch can see where it goes, and this process " +
        "no longer derives that address from the kubeconfig. The endpoint must " +
        "therefore be DECLARED, and an undeclared one is refused rather than left unconstrained. " +
        HOW_TO_FIX,
    );
  }

  // The same validation the five HTTP endpoint vars get: scheme, no embedded
  // userinfo, canonicalised host, and a locality classification. `checkEgressUrl`
  // already throws for a public address literal.
  const { url, hostClass } = checkEgressUrl(declared, "KUBE_SERVER");

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new EgressError(
      REFUSE_PREFIX +
        `KUBE_SERVER must be an ORIGIN and nothing more, got ${JSON.stringify(declared)}. ` +
        "This process ships the canonical origin it validated, so a path, query or fragment " +
        "here could only be discarded on the way to argv — and a value that is validated " +
        "whole and used in part is the exact seam this guard exists to close. NOTE that a " +
        "path-prefixed API endpoint (a Rancher-style `/k8s/clusters/…` proxy, say) is " +
        "perfectly legal Kubernetes: this agent refuses one DELIBERATELY, because carrying a " +
        "path through to `--server=` means pinning a second canonicalisation against Go's, " +
        "and no deployment here needs it. It is a limitation of this agent, not a fact about " +
        "your cluster. " +
        HOW_TO_FIX,
    );
  }

  if (hostClass !== "local-address") {
    throw new EgressError(
      REFUSE_PREFIX +
        `KUBE_SERVER is ${url.origin}, and ${JSON.stringify(url.hostname)} is a NAME. Every ` +
        "kubectl query and every byte of cluster output it returns is investigation content, " +
        "and kubectl resolves and connects in a child process — so unlike the five HTTP " +
        "endpoint variables, a name here has no connect-time lookup to be re-checked inside " +
        "(R17). An address that cannot be decided before the child dials it folds into REFUSE " +
        "(R6). " +
        HOW_TO_FIX,
    );
  }

  return url.origin;
}
