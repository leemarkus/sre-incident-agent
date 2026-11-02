import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface AuditRow {
  namespace: string;
  line: number;
  raw: string;
  resource: string;
  urls: string[];
  names: string[];
  verbs: string[];
}
export interface AuditResult {
  exitCode: 0 | 1 | 2;
  rows: AuditRow[];
  counts: Record<string, number>;
  violations: { row: AuditRow; reason: string }[];
  errors: string[];
}

const READ = new Set(["get", "list", "watch"]);
const SELF_REVIEWS = new Set([
  "selfsubjectreviews.authentication.k8s.io",
  "selfsubjectaccessreviews.authorization.k8s.io",
  "selfsubjectrulesreviews.authorization.k8s.io",
]);
// The one proxy grant tolerated: fetching the sealed-secrets controller's public
// certificate (`kubeseal --fetch-cert`), which is a GET through the service
// proxy. Pinned to the controller's namespace, to these exact resourceNames (no
// substring or prefix matching) and to `get` only. Every other proxy-like
// subresource is a violation whatever its verb: `get nodes/proxy` reaches the
// kubelet API, and the exec/attach/port-forward subresources open a channel
// into a container.
export const DEFAULT_SEALED_SECRETS_NAMESPACE = "kube-system";
const CERT_PROXY_NAMES = new Set([
  "sealed-secrets-controller",
  "http:sealed-secrets-controller:",
  "http:sealed-secrets-controller:http",
]);
const CERT_PROXY_VERBS = new Set(["get"]);
const CHANNEL_SUBRESOURCES = new Set(["exec", "attach", "portforward", "proxy"]);
/**
 * `nodes/proxy`, `pods/exec`, `services/proxy`, `pods/*` … — anything that opens a
 * channel. A wildcard resource (`*`, `*.*`, `*.apps`) counts too: RBAC matches it
 * against every resource AND subresource, so `get *` includes `get nodes/proxy`.
 */
function channelResource(resource: string): boolean {
  // Split off the subresource first: the API group sits before the slash
  // (`deployments.apps/scale`, `widgets.example.com/proxy`).
  const slash = resource.indexOf("/");
  const base = slash === -1 ? resource : resource.slice(0, slash);
  const sub = slash === -1 ? "" : resource.slice(slash + 1);
  if (base.split(".")[0] === "*") return true;
  return sub === "*" || CHANNEL_SUBRESOURCES.has(sub);
}

export interface EvaluateOptions {
  /** Namespace the sealed-secrets controller runs in; the cert-fetch exception applies there only. */
  sealedSecretsNamespace?: string;
}
const HEADER = /^Resources\s+Non-Resource URLs\s+Resource Names\s+Verbs$/;
const words = (value: string): string[] => value.trim() ? value.trim().split(/\s+/) : [];

/** Pure: accepts one kubectl table or fixture tables prefixed with `### scope`.
 * Any unparsed text or empty section makes the whole result unevaluable.
 */
export function evaluateKubeIdentity(text: string, namespace = "unspecified", options: EvaluateOptions = {}): AuditResult {
  const certNamespace = options.sealedSecretsNamespace ?? DEFAULT_SEALED_SECRETS_NAMESPACE;
  const result: AuditResult = { exitCode: 2, rows: [], counts: {}, violations: [], errors: [] };
  let scope = namespace;
  let header = false;
  let rowCount = 0;
  let sectionStarted = false;
  const scopes = new Set<string>();
  const finish = (): void => {
    if (!header || rowCount === 0) result.errors.push(`${scope}: empty listing or missing header`);
  };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const marker = /^### ([a-z0-9][a-z0-9.-]*)$/.exec(trimmed);
    if (marker) {
      if (sectionStarted) finish();
      scope = marker[1]!;
      if (scopes.has(scope)) result.errors.push(`${scope}: duplicate section`);
      scopes.add(scope);
      sectionStarted = true;
      header = false;
      rowCount = 0;
      continue;
    }
    sectionStarted = true;
    if (HEADER.test(trimmed)) {
      if (header) result.errors.push(`${scope}:${index + 1}: duplicate header`);
      header = true;
      continue;
    }
    const match = /^\s*([^\s\[\]]*)\s+\[([^\[\]]*)\]\s+\[([^\[\]]*)\]\s+\[([^\[\]]*)\]\s*$/.exec(raw);
    if (!header || !match) {
      result.errors.push(`${scope}:${index + 1}: unrecognized row: ${raw}`);
      continue;
    }
    const row: AuditRow = { namespace: scope, line: index + 1, raw,
      resource: match[1]!, urls: words(match[2]!), names: words(match[3]!), verbs: words(match[4]!) };
    if ((!row.resource && row.urls.length === 0) || (row.resource && row.urls.length > 0)
      || (!row.resource && row.names.length > 0) || row.verbs.length === 0
      || row.verbs.some((v) => !/^(?:[a-z]+|\*)$/.test(v))
      || row.urls.some((url) => !url.startsWith("/"))) {
      result.errors.push(`${scope}:${index + 1}: malformed permission row: ${raw}`);
      continue;
    }
    rowCount++;
    result.rows.push(row);
    for (const verb of row.verbs) result.counts[verb] = (result.counts[verb] ?? 0) + 1;
    const channel = channelResource(row.resource);
    const certFetch = row.resource === "services/proxy" && scope === certNamespace
      && row.names.length > 0 && row.names.every((name) => CERT_PROXY_NAMES.has(name));
    const forbidden = row.verbs.filter((verb) => {
      if (channel) return !(certFetch && CERT_PROXY_VERBS.has(verb));
      if (READ.has(verb)) return false;
      return !(verb === "create" && SELF_REVIEWS.has(row.resource));
    });
    if (forbidden.length) result.violations.push({ row, reason: `forbidden verb(s) or proxy scope: ${forbidden.join(", ")}` });
  }
  finish();
  result.exitCode = result.errors.length ? 2 : result.violations.length ? 1 : 0;
  return result;
}

export type KubectlRunner = (args: string[]) => string;
const kubectl: KubectlRunner = (args) => {
  const child = spawnSync("kubectl", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`kubectl failed: ${child.error?.message ?? child.stderr.trim() ?? child.status}`);
  // Incomplete rule evaluation can be reported as a warning with exit zero.
  if (child.stderr.trim()) throw new Error(`kubectl diagnostic (cannot certify completeness): ${child.stderr.trim()}`);
  if (!child.stdout.trim()) throw new Error("kubectl returned empty output");
  return child.stdout;
};

export const DEFAULT_IDENTITY = "system:serviceaccount:kube-system:sre-agent-ro";

/** Capture only identity/authorization metadata. Runner injection keeps checks offline. */
export function captureKubeIdentity(kubeconfig: string, context: string, run: KubectlRunner = kubectl): { whoami: string; listing: string } {
  const base = ["--kubeconfig", kubeconfig, "--context", context];
  const whoami = run([...base, "auth", "whoami"]);
  if (!/^Username\s+\S+\s*$/m.test(whoami)) throw new Error("auth whoami: missing Username");
  const namespaceText = run([...base, "get", "namespaces", "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}"]);
  const namespaces = words(namespaceText);
  if (!namespaces.length || namespaces.some((ns) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(ns))
    || new Set(namespaces).size !== namespaces.length) throw new Error("empty or malformed namespace inventory");
  // --list rejects --all-namespaces; --namespace='' silently selects a default.
  // A verified absent namespace has no RoleBindings, exposing ClusterRoleBindings.
  let clusterProbe = "rbac-audit-cluster-scope";
  while (namespaces.includes(clusterProbe)) clusterProbe += "-x";
  const sections = namespaces.map((ns) => ({ label: ns === "cluster" ? "namespace.cluster" : ns, namespace: ns }));
  sections.push({ label: "cluster", namespace: clusterProbe });
  const listing = sections.map((section) => `### ${section.label}\n${run([...base, "auth", "can-i", "--list", "--namespace", section.namespace])}`).join("\n");
  // Detect a namespace appearing during capture, including the cluster probe.
  const after = words(run([...base, "get", "namespaces", "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}"]));
  if (JSON.stringify([...namespaces].sort()) !== JSON.stringify(after.sort())) throw new Error("namespace inventory changed during audit; rerun");
  return { whoami, listing };
}

export function auditCli(args: string[], run: KubectlRunner = kubectl, out: (text: string) => void = console.log): 0 | 1 | 2 {
  try {
    let kubeconfig = path.join(homedir(), ".kube", "sre-agent.kubeconfig");
    let context = "homelab";
    let expectedIdentity = DEFAULT_IDENTITY;
    let fixture: string | undefined;
    let sealedSecretsNamespace = DEFAULT_SEALED_SECRETS_NAMESPACE;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === "--help") {
        out("Usage: tools/kube-identity-audit [--kubeconfig PATH] [--context CTX] [--expected-identity USER] [--sealed-secrets-namespace NS]\n       tools/kube-identity-audit --fixture FILE\nExit: 0 PASS, 1 FAIL, 2 could-not-evaluate. No environment files loaded.");
        return 0;
      }
      if (!["--kubeconfig", "--context", "--expected-identity", "--fixture", "--sealed-secrets-namespace"].includes(flag)) throw new Error(`unknown option: ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
      if (flag === "--kubeconfig") kubeconfig = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
      if (flag === "--context") context = value;
      if (flag === "--expected-identity") expectedIdentity = value;
      if (flag === "--fixture") fixture = value;
      if (flag === "--sealed-secrets-namespace") sealedSecretsNamespace = value;
    }
    let listing: string;
    if (fixture !== undefined) listing = readFileSync(fixture, "utf8");
    else {
      const capture = captureKubeIdentity(kubeconfig, context, run);
      out(capture.whoami.trimEnd());
      const identity = /^Username\s+(\S+)\s*$/m.exec(capture.whoami)?.[1];
      if (identity !== expectedIdentity) throw new Error(`identity mismatch: expected ${expectedIdentity}, got ${identity}`);
      listing = capture.listing;
      out(listing.trimEnd());
    }
    const result = evaluateKubeIdentity(listing, "unspecified", { sealedSecretsNamespace });
    for (const error of result.errors) out(`ERROR ${error}`);
    for (const { row, reason } of result.violations) out(`FAIL namespace=${row.namespace} line=${row.line}: ${row.raw.trim()} (${reason})`);
    out(`${["PASS", "FAIL", "COULD-NOT-EVALUATE"][result.exitCode]}: ${result.rows.length} rows; verbs=${JSON.stringify(result.counts)}; ${result.violations.length} forbidden rows; ${result.errors.length} parse errors`);
    return result.exitCode;
  } catch (error) {
    out(`COULD-NOT-EVALUATE: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = auditCli(process.argv.slice(2));
}
