#!/usr/bin/env node
/**
 * sre-agent CLI shell.
 */

import { PublicationRejectedError } from "./publication.js";
import { sealUnsafeTestPairing } from "./transport.js";

const USAGE = `sre-agent — read-only triage agent for the homelab k3s cluster

Usage:
  sre-agent <command> [options]

Commands:
  triage   Read an AlertManager webhook payload on stdin, write triage-<date>.md
           e.g. sre-agent triage < scenarios/prometheus-wal-eio/alert.json
  env      Print the resolved (non-secret) configuration and exit.
           Diagnostic: works without ANTHROPIC_API_KEY (reports it <unset>).
  version  Print the version and exit
  help     Print this message
`;

const VERSION = "0.1.0";

/**
 * The real enforcement now lives at the pairing/run boundary all three share
 * (`assertTransportPairing`, called by `runTriage` on every run), and the gate
 * there needs an in-process arming call that no inherited environment can
 * supply. This file's job shrinks to two belt-and-braces lines:
 *
 *  - SEAL arming for this process, so nothing loaded later — a plugin, a
 *    dynamic import, a future subcommand — can open the gate in a CLI process
 *    at all; and
 *  - delete the variable, so the CLI's behaviour does not depend on ambient
 *    state a caller happened to export.
 *
 * Neither is a defence against an attacker who can write this process's memory
 * or environment mid-flight; such an attacker already owns the process
 * (docs/safety-model.md). They are determinism measures, and they are no
 * longer load-bearing.
 */
sealUnsafeTestPairing();
delete process.env["SRE_AGENT_UNSAFE_TEST_TRANSPORT"];

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "help";

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;

    case "version":
    case "--version":
    case "-V":
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case "env": {
      // Diagnostic load: everything stays strict except the API key, so this
      // command still works on a fresh checkout (and `<unset>` below is a
      // reachable state). `triage` and `createClient` use the strict loader.
      const { loadDiagnosticConfig } = await import("./config.js");
      const config = loadDiagnosticConfig();
      const redacted = {
        triageModel: config.ANTHROPIC_TRIAGE_MODEL,
        triageEffort: config.ANTHROPIC_TRIAGE_EFFORT,
        digestModel: config.ANTHROPIC_DIGEST_MODEL,
        maxIterations: config.SRE_AGENT_MAX_ITERATIONS,

        evidenceSweep: config.SRE_AGENT_EVIDENCE_SWEEP ? "on (scaffolded)" : "off (autonomous)",
        monthlyBudgetUsd: config.SRE_AGENT_MONTHLY_BUDGET_USD,
        kubeconfig: config.KUBECONFIG === "" ? null : config.KUBECONFIG,
        kubeContext: config.KUBE_CONTEXT,

        kubeServer: config.KUBE_SERVER === "" ? null : config.KUBE_SERVER,
        // Resolved once at config load — printed because "which
        // binary will this run execute" is now a decided fact, not a lookup.
        kubectlBin: config.KUBECTL_BIN === "" ? null : config.KUBECTL_BIN,
        kubectlChildHome: config.HOME === "" ? null : config.HOME,
        prometheusUrl: config.PROMETHEUS_URL ?? null,
        grafanaUrl: config.GRAFANA_URL ?? null,
        grafanaPromDatasourceUid: config.GRAFANA_PROM_DATASOURCE_UID ?? null,
        argocdUrl: config.ARGOCD_URL ?? null,
        forgejoUrl: config.FORGEJO_URL ?? null,
        anthropicApiKey: config.ANTHROPIC_API_KEY ? "<set>" : "<unset>",
        grafanaServiceAccountToken: config.GRAFANA_SERVICE_ACCOUNT_TOKEN
          ? "<set>"
          : "<unset>",
        argocdToken: config.ARGOCD_TOKEN ? "<set>" : "<unset>",
        forgejoToken: config.FORGEJO_TOKEN ? "<set>" : "<unset>",
        // Which tools `triage` would actually register with this config.
        toolsEnabled: [
          "kubectl_read",
          ...(config.GRAFANA_URL && config.GRAFANA_SERVICE_ACCOUNT_TOKEN
            ? ["promql_query"]
            : []),
          ...(config.ARGOCD_URL && config.ARGOCD_TOKEN ? ["argocd_status"] : []),
        ],
      };
      process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
      return 0;
    }

    case "triage": {
      const [{ parseWebhookPayload }, { runTriage }] = await Promise.all([
        import("./alert.js"),
        import("./triage.js"),
      ]);

      const raw = await readStdin();
      if (raw.trim() === "") {
        process.stderr.write(
          "triage expects an AlertManager webhook payload on stdin.\n" +
            "e.g. sre-agent triage < scenarios/prometheus-wal-eio/alert.json\n",
        );
        return 64; // EX_USAGE
      }

      const payload = parseWebhookPayload(raw);
      // No transport passed: runTriage builds a liveTransport() itself, whose
      // factory performs the strict config load (hard-fails without
      // ANTHROPIC_API_KEY, before any turn runs), snapshots it frozen, and
      // binds the client to that snapshot.
      const { describeSweepMode } = await import("./sweep.js");
      const result = await runTriage({
        payload,
        onSweep: (outcome) =>
          process.stderr.write(`[sweep] ${describeSweepMode(outcome)}\n`),
        onTurn: (u) =>
          process.stderr.write(
            `[turn ${u.turn}] in=${u.input_tokens} out=${u.output_tokens} ` +
              `cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens}\n`,
          ),
      });

      process.stderr.write(
        `\nwrote ${result.reportPath} (${result.turns} turns, stop_reason=${result.stopReason ?? "unknown"})\n` +
          `usage total: in=${result.totals.input_tokens} out=${result.totals.output_tokens} ` +
          `cache_write=${result.totals.cache_creation_input_tokens} cache_read=${result.totals.cache_read_input_tokens}\n`,
      );
      process.stdout.write(`${result.reportPath}\n`);
      return 0;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 64; // EX_USAGE
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof PublicationRejectedError ? error.exitCode : 1;
  },
);
