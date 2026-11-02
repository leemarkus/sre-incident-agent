/**
 * The read-only boundary, asserted offline: no cluster, no network, no model.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicationVerdict } from "../src/publication.js";
import { datasourceProxyPath } from "../src/tools/promql.js";
import { ALLOWED_RESOURCES, buildKubectlArgv, kubectlInputSchema } from "../src/tools/kubectl.js";
import { redactAuthorization, redactSecrets } from "../src/sub/redact.js";
import { CLAUDE_CHILD_ENV_ALLOW, claudeArgs, claudeChildEnv } from "../src/sub/run.js";
import { DENIED_BUILTIN_TOOLS, mcpToolId } from "../src/sub/toolset.js";
import type { SubConfig } from "../src/sub/config.js";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

const WRITE_VERBS = [
  "apply", "create", "delete", "edit", "patch", "replace", "scale", "set", "label",
  "annotate", "exec", "cp", "rollout", "drain", "cordon", "uncordon", "taint", "run",
  "expose", "autoscale", "port-forward", "proxy", "attach", "debug", "auth", "certificate",
];

describe("kubectl_read: write verbs cannot be expressed", () => {
  it("the subcommand enum is exactly get, describe, logs, events", () => {
    const options = kubectlInputSchema.shape.subcommand.options;
    assert.deepEqual([...options].sort(), ["describe", "events", "get", "logs"]);
  });

  for (const verb of WRITE_VERBS) {
    it(`subcommand "${verb}" is rejected by the schema`, () => {
      const parsed = kubectlInputSchema.safeParse({ subcommand: verb, namespace: "monitoring", resource: "pods" });
      assert.equal(parsed.success, false);
    });
  }

  it("there is no raw-argument field: unknown keys are rejected, not stripped", () => {
    for (const key of ["args", "flags", "extra_args", "command"]) {
      const parsed = kubectlInputSchema.safeParse({
        subcommand: "get",
        namespace: "monitoring",
        resource: "pods",
        [key]: ["delete", "pod", "x"],
      });
      assert.equal(parsed.success, false, `${key} was accepted`);
    }
  });

  it("Secrets and cluster-scoped kinds are absent from the resource list", () => {
    for (const kind of ["secrets", "secret", "sealedsecrets", "nodes", "persistentvolumes", "clusterroles", "namespaces", "customresourcedefinitions"]) {
      assert.equal((ALLOWED_RESOURCES as readonly string[]).includes(kind), false, `${kind} is allowed`);
      const parsed = kubectlInputSchema.safeParse({ subcommand: "get", namespace: "monitoring", resource: kind });
      assert.equal(parsed.success, false, `${kind} parsed`);
    }
  });

  it("template and file-backed output formats are unrepresentable", () => {
    for (const output of ["go-template", "go-template-file=/tmp/x", "jsonpath={.data}", "jsonpath-file=/etc/passwd", "custom-columns-file=/tmp/x"]) {
      const parsed = kubectlInputSchema.safeParse({ subcommand: "get", namespace: "monitoring", resource: "pods", output });
      assert.equal(parsed.success, false, output);
    }
  });

  it("field values cannot smuggle flags", () => {
    const attempts = [
      { name: "--kubeconfig=/tmp/k" },
      { name: "x --as=system:admin" },
      { selector: "app=x --all-namespaces" },
      { namespace: "--all-namespaces" },
      { since: "1h --raw" },
    ];
    for (const extra of attempts) {
      const parsed = kubectlInputSchema.safeParse({ subcommand: "get", namespace: "monitoring", resource: "pods", ...extra });
      assert.equal(parsed.success, false, JSON.stringify(extra));
    }
  });

  it("every argv the schema can render starts with a read verb and carries only allowed flags", () => {
    const optional = { name: "a-b.c-9", selector: "app.kubernetes.io/name=x-y_z.0,tier=web", container: "c-9", tailLines: 5_000, since: "99999h", output: "json" } as const;
    const keys = Object.keys(optional) as (keyof typeof optional)[];
    const allowedFlag = /^--(namespace|selector|output|container|tail|since|for)=[^\s]*$/;
    const writeToken = new RegExp(`^(${WRITE_VERBS.join("|")})$`);
    let rendered = 0;
    for (const subcommand of ["get", "describe", "logs", "events"]) {
      for (const resource of [undefined, ...ALLOWED_RESOURCES]) {
        for (let mask = 0; mask < 1 << keys.length; mask += 1) {
          const raw: Record<string, unknown> = { subcommand, namespace: "kube-system" };
          if (resource !== undefined) raw["resource"] = resource;
          keys.forEach((key, bit) => {
            if (mask & (1 << bit)) raw[key] = optional[key];
          });
          const parsed = kubectlInputSchema.safeParse(raw);
          if (!parsed.success) continue;
          let argv: string[];
          try {
            argv = buildKubectlArgv(parsed.data);
          } catch {
            continue; // refused at construction
          }
          rendered += 1;
          assert.ok(["get", "describe", "logs", "events"].includes(argv[0]!), argv.join(" "));
          for (const token of argv.slice(1)) {
            assert.equal(writeToken.test(token), false, `write token in ${argv.join(" ")}`);
            if (token.startsWith("-")) assert.match(token, allowedFlag, argv.join(" "));
          }
        }
      }
    }
    assert.ok(rendered > 1000, `only ${rendered} argv rendered`);
  });

  it("logs always carry a tail bound", () => {
    const argv = buildKubectlArgv(kubectlInputSchema.parse({ subcommand: "logs", namespace: "monitoring", name: "loki-0" }));
    assert.ok(argv.some((t) => /^--tail=\d+$/.test(t)), argv.join(" "));
  });
});

describe("promql_query: the datasource proxy path cannot be escaped", () => {
  it("a well-formed UID stays under the proxy prefix", () => {
    assert.equal(datasourceProxyPath("prometheus", "query"), "/api/datasources/proxy/uid/prometheus/api/v1/query");
  });
  for (const uid of ["../../admin", "a/b", "a?x=1", "%2e%2e", "a b"]) {
    it(`UID ${JSON.stringify(uid)} is refused`, () => {
      assert.throws(() => datasourceProxyPath(uid, "query"));
    });
  }
});

describe("subscription mode: the claude -p belt", () => {
  const sub = { SRE_SUB_MODEL: "sonnet", SRE_SUB_EFFORT: "medium", SRE_SUB_RUN_BUDGET_USD: 1.5 } as unknown as SubConfig;
  const tools = [{ name: "kubectl_read" }, { name: "promql_query" }] as unknown as BetaRunnableTool[];
  const argv = claudeArgs({ sub, tools, systemPrompt: "s", userPrompt: "u", mcpConfigPath: "/tmp/mcp.json" });
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  it("disables every built-in tool and runs restricted", () => {
    assert.ok(argv.includes("--restricted"));
    assert.equal(valueOf("--tools"), "");
  });

  it("pre-approves only this server's MCP tools, by explicit name", () => {
    assert.equal(valueOf("--allowedTools"), [mcpToolId("kubectl_read"), mcpToolId("promql_query")].join(","));
    assert.equal(valueOf("--permission-mode"), "dontAsk");
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.equal(valueOf("--setting-sources"), "");
  });

  it("denies the shell, file and web tools by name as a second layer", () => {
    const denied = (valueOf("--disallowedTools") ?? "").split(",");
    for (const name of ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task", "PowerShell", "REPL"]) {
      assert.ok(denied.includes(name), name);
      assert.ok((DENIED_BUILTIN_TOOLS as readonly string[]).includes(name), name);
    }
  });

  it("caps each run's spend", () => {
    assert.equal(valueOf("--max-budget-usd"), "1.50");
  });

  it("the child environment is an allowlist: provider routing and cloud credentials never reach claude", () => {
    const env = claudeChildEnv({
      PATH: "/usr/bin",
      HOME: "/var/lib/sre",
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
      ANTHROPIC_API_KEY: "sk-test-not-real",
      AWS_SECRET_ACCESS_KEY: "test-not-real",
      CLAUDE_CODE_USE_BEDROCK: "1",
      KUBECONFIG: "/tmp/kubeconfig",
      LC_ALL: "C",
    });
    assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "HOME", "LC_ALL", "PATH"]);
    for (const key of Object.keys(env)) {
      assert.ok((CLAUDE_CHILD_ENV_ALLOW as readonly string[]).includes(key) || /^LC_/.test(key) || key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
    }
  });
});

describe("redaction", () => {
  it("removes raw, URL-encoded and base64 forms of a known secret", () => {
    const secret = "s3cr3t/value+x";
    const text = `raw=${secret} url=${encodeURIComponent(secret)} b64=${Buffer.from(secret).toString("base64")}`;
    const out = redactSecrets(text, [{ label: "GRAFANA_TOKEN", value: secret }]);
    assert.equal(out.includes(secret), false);
    assert.equal(out.includes(encodeURIComponent(secret)), false);
    assert.equal(out.includes(Buffer.from(secret).toString("base64")), false);
  });

  it("removes credential-shaped header echoes it was never told about", () => {
    const out = redactAuthorization('{"Authorization": "Bearer abcdef123456"}');
    assert.equal(out.includes("abcdef123456"), false);
  });
});

describe("publication gate", () => {
  const alert = JSON.stringify({
    version: "4",
    status: "firing",
    groupLabels: { alertname: "KubeJobFailed", namespace: "monitoring" },
    commonLabels: { alertname: "KubeJobFailed", namespace: "monitoring", job_name: "nightly-backup-29757262" },
    alerts: [
      {
        status: "firing",
        labels: { alertname: "KubeJobFailed", namespace: "monitoring", job_name: "nightly-backup-29757262" },
        annotations: {},
        startsAt: "2026-01-01T00:00:00Z",
      },
    ],
  });

  it("refuses to publish a report that recommends deleting the alert's own object", () => {
    const report = "## Recommended next steps\n\n```sh\nkubectl delete job nightly-backup-29757262 -n monitoring\n```\n";
    const verdict = publicationVerdict(report, alert);
    assert.equal(verdict.publish, false);
  });

  it("publishes a report whose recommendations are read-only", () => {
    const report = "## Recommended next steps\n\n```sh\nkubectl describe job nightly-backup-29757262 -n monitoring\n```\n";
    assert.deepEqual(publicationVerdict(report, alert), { publish: true });
  });
});

describe("RBAC audit of the agent's service account", async () => {
  const { evaluateKubeIdentity } = await import("../scripts/kube-identity-audit.js");
  const header = "Resources                                       Non-Resource URLs   Resource Names   Verbs";
  const table = (...rows: string[]): string => ["### monitoring", header, ...rows].join("\n");

  it("a get/list/watch-only listing passes", () => {
    const result = evaluateKubeIdentity(table(
      "pods                                            []                  []               [get list watch]",
      "selfsubjectaccessreviews.authorization.k8s.io   []                  []               [create]",
      "                                                [/healthz]          []               [get]",
    ));
    assert.equal(result.exitCode, 0, JSON.stringify(result.errors));
  });

  it("any write verb is a violation", () => {
    for (const verb of ["create", "update", "patch", "delete", "deletecollection", "*"]) {
      const result = evaluateKubeIdentity(table(`pods                                            []                  []               [get ${verb}]`));
      assert.equal(result.exitCode, 1, verb);
    }
  });

  const row = (resource: string, names: string, verbs: string): string =>
    `${resource.padEnd(48)}[]                  [${names}]${" ".repeat(Math.max(1, 17 - names.length))}[${verbs}]`;
  const section = (ns: string, ...rows: string[]): string => [`### ${ns}`, header, ...rows].join("\n");

  it("proxy, exec, attach and port-forward subresources are violations whatever the verb", () => {
    for (const resource of ["nodes/proxy", "pods/proxy", "services/proxy", "pods/exec", "pods/attach", "pods/portforward", "pods/*", "*", "*.*", "*.apps"]) {
      for (const verb of ["get", "create"]) {
        assert.equal(evaluateKubeIdentity(section("monitoring", row(resource, "", verb))).exitCode, 1, `${verb} ${resource}`);
      }
    }
  });

  it("the sealed-secrets cert fetch is allowed only as get, by name, in the controller's namespace", () => {
    const names = "sealed-secrets-controller http:sealed-secrets-controller:";
    assert.equal(evaluateKubeIdentity(section("kube-system", row("services/proxy", names, "get"))).exitCode, 0);
    assert.equal(evaluateKubeIdentity(section("kube-system", row("services/proxy", names, "get create"))).exitCode, 1, "create");
    assert.equal(evaluateKubeIdentity(section("monitoring", row("services/proxy", names, "get"))).exitCode, 1, "other namespace");
    assert.equal(evaluateKubeIdentity(section("cluster", row("services/proxy", names, "get"))).exitCode, 1, "cluster scope");
    assert.equal(evaluateKubeIdentity(section("kube-system", row("services/proxy", "", "get"))).exitCode, 1, "no resourceNames");
    assert.equal(evaluateKubeIdentity(section("kube-system", row("services/proxy", "grafana", "get"))).exitCode, 1, "other service");
    assert.equal(
      evaluateKubeIdentity(section("sealed", row("services/proxy", names, "get")), "unspecified", { sealedSecretsNamespace: "sealed" }).exitCode,
      0,
      "configured namespace",
    );
  });

  it("an unparseable listing is never read as a pass", () => {
    assert.equal(evaluateKubeIdentity("### monitoring\nsomething unexpected").exitCode, 2);
  });
});
