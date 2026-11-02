/**
 * The one place subscription mode builds its tools.
 */

import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { Config } from "../config.js";
import { argocdAvailable, argocdStatusTool } from "../tools/argocd.js";
import { docsAvailable, docsReadTool, docsSearchTool } from "../tools/docs.js";
import { kubectlReadTool } from "../tools/kubectl.js";
import { promqlAvailable, promqlQueryTool } from "../tools/promql.js";

/** The MCP server name as it appears in `--mcp-config` and in tool ids. */
export const MCP_SERVER_NAME = "sre";

export type ToolAvailability = { promql: boolean; argocd: boolean; docs: boolean };

export function toolAvailability(config: Config): ToolAvailability {
  return {
    promql: promqlAvailable(config),
    argocd: argocdAvailable(config),
    docs: docsAvailable(config),
  };
}

export function buildReadOnlyTools(config: Config): BetaRunnableTool[] {
  const has = toolAvailability(config);
  return [
    kubectlReadTool(config),
    ...(has.promql ? [promqlQueryTool(config)] : []),
    ...(has.argocd ? [argocdStatusTool(config)] : []),
    ...(has.docs ? [docsSearchTool(config), docsReadTool(config)] : []),
  ];
}

/** `kubectl_read` → `mcp__sre__kubectl_read`, the name Claude Code addresses it by. */
export function mcpToolId(toolName: string): string {
  return `mcp__${MCP_SERVER_NAME}__${toolName}`;
}

/**
 * Built-in Claude Code tools denied BY NAME as the second layer under
 * `--tools ""`. The list is deliberately over-inclusive: a name that does not
 * exist in this Claude Code version costs a startup warning, a name that exists
 * and is missing here costs the read-only guarantee. It covers every built-in
 * tool name present in the supported CLI versions (SUPPORTED_CLAUDE_VERSIONS in
 * `src/sub/run.ts`) and must be re-reviewed at every version bump;
 * `test/denylist.test.ts` checks it against an independent literal inventory.
 */
export const DENIED_BUILTIN_TOOLS = [
  // Shell, file, web, agent, task and scheduling tools.
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "Skill",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "Workflow",
  "Artifact",
  "SendMessage",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "ScheduleWakeup",
  "PushNotification",
  "RemoteTrigger",
  "Monitor",
  // Code-running, capability and planning surfaces present in Claude Code 2.1.258.
  "PowerShell",
  "REPL",
  "Computer",
  "Memory",
  "ToolSearch",
  "LSP",
  "ListMcpResources",
  "ReadMcpResource",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  // Shell-output, notebook, task and messaging tools present in 2.1.258.
  "BashOutput",
  "KillShell",
  "NotebookRead",
  "SendUserMessage",
  "TaskOutput",
  "TaskStop",
  // The remaining built-in tools and aliases present in 2.1.280, including the
  // canonical MCP-resource names.
  "AppifactRepl",
  "ArtifactCheck",
  "ArtifactComments",
  "ArtifactData",
  "Brief",
  "ClaudeDesign",
  "CronDelete",
  "CronList",
  "DesignSync",
  "FetchInboxMessage",
  "KillBash",
  "ListAgents",
  "ListConnectors",
  "ListMcpResourcesTool",
  "ListPeers",
  "ListPlugins",
  "ListSkills",
  "ObserverReport",
  "Poll",
  "Projects",
  "ProposeGoal",
  "ReadMcpResourceDir",
  "ReadMcpResourceDirTool",
  "ReadMcpResourceTool",
  "ReadNotifications",
  "RefreshMcpTools",
  "ReportFindings",
  "RunWorkflow",
  "SearchMcpRegistry",
  "SearchPlugins",
  "SearchSkills",
  "SendFeedback",
  "SendFile",
  "SendUserFile",
  "ShareOnboardingGuide",
  "ShowOnboardingRolePicker",
  "SubagentHandback",
  "SuggestConnectors",
  "SuggestPluginInstall",
  "SuggestSkills",
  "TaskGet",
  "TaskList",
  "WaitForMcpServers",
  "enable__mcp__claude-in-chrome",
  "enable__mcp__remote-devices__Claude_Browser",
  "enable__mcp__remote-devices__computer",
  "mcp",
  "memory_list",
  "memory_read",
  "memory_write",
  "propose_skills",
  "self_hosted_runner_get_pool",
  "self_hosted_runner_list_runners",
  "self_hosted_runner_list_secrets",
  "self_hosted_runner_list_sessions",
  "self_hosted_runner_read_health",
  "self_hosted_runner_read_metrics",
  "self_hosted_runner_requeue_session",
  "self_hosted_runner_spawn_local",
  "self_hosted_runner_tail_log",
  // Built-in tools added in 2.1.302.
  "GetTask",
  "OfferChromeSetup",
  "PublishPlugin",
  "request_computer",
] as const;
