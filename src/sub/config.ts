/**
 * Subscription mode — configuration.
 *
 * ## What this mode is
 *
 * The same read-only agent, driven by the Claude Code harness (`claude -p`) on
 * The operator's Claude subscription instead of by the Anthropic SDK on an API key.
 *
 * ## What it refuses
 *
 * An `ANTHROPIC_API_KEY` in the environment. Subscription mode must carry no
 * API credential at all: Claude Code's precedence puts an API key ABOVE the
 * subscription login, so a stray key would silently turn a "free" run into a
 * Console-billed one — the exact accounting confusion this project has spent
 * three decisions avoiding.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import * as z from "zod/v4";

import { loadDiagnosticConfig, type Config } from "../config.js";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const subEnvSchema = z.object({

  SRE_SUB_MODEL: z.string().min(1).default("sonnet"),
  SRE_SUB_EFFORT: z.enum(EFFORT_LEVELS).default("high"),
  /** Per-run ceiling passed as `--max-budget-usd`; the harness stops the run. */
  SRE_SUB_RUN_BUDGET_USD: z.coerce.number().positive().max(20).default(1.5),
  /**
   * Monthly ceiling for this mode's own ledger, in estimated dollars. Default
   * 15: sized to the paused $20 Pro Agent SDK credit so nothing changes if it
   * is un-paused; on plan limits it is a proxy cap on window consumption.
   */
  SRE_SUB_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(15),
  SRE_SUB_STATE_DIR: z.string().min(1).default(path.join(homedir(), ".local", "state", "sre-agent")),
  /** Where run directories are written; relative to the project root. */
  SRE_SUB_OUTPUT_DIR: z.string().min(1).default("reports/sub"),
  /** Absolute path of the `claude` binary. Empty = resolve from PATH once, at load. */
  SRE_SUB_CLAUDE_BIN: z.string().default(""),
  SRE_SUB_POLL_COOLDOWN_HOURS: z.coerce.number().positive().default(24),

  SRE_SUB_REJECT_BACKOFF_HOURS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().nonnegative().max(720).default(24),
  ),
  /**
   * Local-time hours during which the poller may START runs, as `HH-HH`
   * (e.g. `23-07` = 23:00 through 06:59, wrapping midnight). Empty = always.
   * This is the lever for sharing one 5-hour window with a human: run the
   * agent while the operator is not.
   */
  SRE_SUB_POLL_HOURS: z
    .string()
    .regex(/^$|^([01]?\d|2[0-3])-([01]?\d|2[0-3])$/, "expected HH-HH, e.g. 23-07")
    .default(""),
  SRE_SUB_MAX_RUNS_PER_POLL: z.coerce.number().int().positive().max(10).default(2),
  /** Wall-clock ceiling for one `claude -p` run before it is killed. */
  SRE_SUB_WALL_CLOCK_MS: z.coerce.number().int().positive().default(900_000),

  SRE_SUB_ISSUES: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["off", "dry", "live"]).default("off"),
  ),
});

export type SubConfig = z.infer<typeof subEnvSchema> & {
  /** The resolved, existing, executable `claude` path this run will spawn. */
  claudeBin: string;
};

export type SubscriptionLoad = {
  config: Config;
  sub: SubConfig;
};

/** The variables a direct API credential could arrive through. */
export const REFUSED_API_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_PROFILE",
] as const;

/**
 * Provider routing and alternate credential names recognized by the reviewed
 * Claude Code builds. A shell configured for Bedrock,
 * Vertex, Foundry or an LLM gateway could silently make `claude -p`
 * bill someone else's account — and an attacker-supplied `ANTHROPIC_BASE_URL`
 * would receive the subscription credential itself. Neither is a thing this
 * mode may do quietly, so any of them, set non-empty, refuses the run.
 */
export const REFUSED_PROVIDER_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_HOST",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",

  "CLAUDE_CODE_API_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_AWS_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_OAUTH_ACCESS_TOKEN",

  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_ENDPOINT_URL_SSO",
  "AWS_ENDPOINT_URL_SSO_OIDC",
  "AWS_ENDPOINT_URL_STS",
  "CLAUDE_BRIDGE_BASE_URL",
  "CLAUDE_BRIDGE_OAUTH_TOKEN",
  "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
  "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION",
  "CLAUDE_CODE_ENVIRONMENT_KIND",
  "CLAUDE_CODE_FEDERATION_CACHE_DIR",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_CODE_MOCK_REMOTE_SETTINGS",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE",
  "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
  "CLAUDE_REMOTE_TOOLS_BRIDGE_URL",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  "CLOUDSDK_CONFIG",
  "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
  // provider/auth boundary names recovered from both bundled CLIs.
  // Most predate 2.1.280: the child allowlist blocked them, but config load did
  // not expose the ambient misconfiguration. See the review §D for evidence.
  // provider selectors and routing.
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_UNIX_SOCKET",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  // alternate authentication and host credentials.
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HFI_BEARER_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  // cloud credential chains and metadata routing.
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "GCE_METADATA_HOST",
  "GCE_METADATA_ROOT",
  "GCE_METADATA_IP",
  "METADATA_SERVER_DETECTION",
  // auxiliary service endpoints and credentials.
  "CLAUDE_CODE_ARTIFACTS_API_BASE_URL",
  "CLAUDE_CODE_ARTIFACTS_API_TOKEN",
  "CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL",
  "CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL",
  "CLAUDE_CODE_MEMORY_API_BASE_URL",
  "CLAUDE_CODE_MEMORY_API_TOKEN",
  "CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN",

  "ANTHROPIC_WORK_SECRET",
  "CLAUDE_CODE_REMOTE_SDK_URL",
  "CLAUDE_CODE_CLIENT_DATA_URL",
  "CLAUDE_CODE_REMOTE_MCP_CONFIG",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "CLAUDE_CODE_GB_BASE_URL",

  "CLAUDE_CODE_HOST_GATEWAY_LINEAGE",
] as const;

export const REFUSED_CREDENTIAL_PREFIXES = [/^AZURE_/, /^ANTHROPIC_FOUNDRY_/, /^CLAUDE_LOCAL_OAUTH_/] as const;

/** Everything refused by exact name. Kept as one list for callers and checks. */
export const REFUSED_CREDENTIAL_VARS = [
  ...REFUSED_API_CREDENTIAL_VARS,
  ...REFUSED_PROVIDER_VARS,
] as const;

/** The names in `env` that this mode refuses to run beside, if any. */
export function refusedCredentialNames(env: NodeJS.ProcessEnv): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value === "") continue;
    const named = (REFUSED_CREDENTIAL_VARS as readonly string[]).includes(key);
    const prefixed = REFUSED_CREDENTIAL_PREFIXES.some((re) => re.test(key));
    if (named || prefixed) found.push(key);
  }
  return found.sort();
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveClaudeBinary(declared: string, env: NodeJS.ProcessEnv): string {
  if (declared !== "") {
    // A declared path is a statement, not a hint: if it is wrong, say so rather
    // than quietly running some other claude.
    if (existsSync(declared) && isExecutable(declared)) return declared;
    throw new Error(
      `SRE_SUB_CLAUDE_BIN=${JSON.stringify(declared)} is not an executable file. Fix the path — under ` +
        "launchd there is no shell PATH to fall back on.",
    );
  }
  const candidates: string[] = [];
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (dir !== "") candidates.push(path.join(dir, "claude"));
  }
  candidates.push(path.join(homedir(), ".local", "bin", "claude"));
  for (const candidate of candidates) {
    if (existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  throw new Error(
    "no executable `claude` found on PATH or in ~/.local/bin. Set SRE_SUB_CLAUDE_BIN to its absolute " +
      "path — under launchd there is no shell PATH.",
  );
}

/**
 * Load the tool-layer config WITHOUT an API key, plus this mode's own settings.
 *
 * The tool layer's `Config` type carries `ANTHROPIC_API_KEY: string` because the
 * strict loader requires it; here it is set to the empty string. Nothing in
 * `src/tools/*` or `src/sweep.ts` reads it (checked 2026-09-02 — only
 * `src/client.ts` does, and this mode never imports the client), and
 * The offline check suite asserts that a key in the environment is refused.
 */
export function loadSubscriptionConfig(env: NodeJS.ProcessEnv = process.env): SubscriptionLoad {
  const refused = refusedCredentialNames(env);
  const first = refused[0];
  if (first !== undefined) {
    throw new Error(
      `${refused.join(", ")} is set. Subscription mode carries no API credential and no provider ` +
        "routing: the run must be billed to the host's own Claude Code login. Claude Code ranks " +
        "these variables ABOVE that login, so any of them turns a subscription run into a " +
        "Console-, Bedrock-, Vertex-, Foundry- or gateway-billed one without saying so — and an " +
        "alternate base URL would additionally receive the subscription credential itself. That is " +
        "the billing and credential-custody premise of subscription mode, not a preference. Unset " +
        `${first} (\`env -u ${first} …\`), or run API mode (\`sre-agent triage\`) on purpose.`,
    );
  }
  const diagnostic = loadDiagnosticConfig(env);
  const config: Config = Object.freeze({ ...diagnostic, ANTHROPIC_API_KEY: "" });

  const parsed = subEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`subscription-mode configuration is invalid:\n${issues}`);
  }
  const claudeBin = resolveClaudeBinary(parsed.data.SRE_SUB_CLAUDE_BIN, env);
  return { config, sub: Object.freeze({ ...parsed.data, claudeBin }) };
}

/** Non-secret view for `--dry-run` output and the report footer. */
export function describeSubConfig(sub: SubConfig): Record<string, unknown> {
  return {
    model: sub.SRE_SUB_MODEL,
    effort: sub.SRE_SUB_EFFORT,
    runBudgetUsd: sub.SRE_SUB_RUN_BUDGET_USD,
    monthlyBudgetUsd: sub.SRE_SUB_MONTHLY_BUDGET_USD,
    stateDir: sub.SRE_SUB_STATE_DIR,
    outputDir: sub.SRE_SUB_OUTPUT_DIR,
    claudeBin: sub.claudeBin,
    pollCooldownHours: sub.SRE_SUB_POLL_COOLDOWN_HOURS,
    rejectBackoffHours: sub.SRE_SUB_REJECT_BACKOFF_HOURS,
    pollHours: sub.SRE_SUB_POLL_HOURS === "" ? "always" : sub.SRE_SUB_POLL_HOURS,
    maxRunsPerPoll: sub.SRE_SUB_MAX_RUNS_PER_POLL,
    wallClockMs: sub.SRE_SUB_WALL_CLOCK_MS,
    issues: sub.SRE_SUB_ISSUES,
  };
}
