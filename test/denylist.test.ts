/**
 * The by-name deny list for `claude -p`, checked against independent literal
 * inventories of the built-in tool names present in each supported CLI version.
 * The inventories are written out here on purpose, NOT derived from
 * DENIED_BUILTIN_TOOLS: a name missing from the list must fail this file.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseClaudeVersion, SUPPORTED_CLAUDE_VERSIONS, supportedClaudeVersions } from "../src/sub/run.js";
import { DENIED_BUILTIN_TOOLS } from "../src/sub/toolset.js";

const denied = DENIED_BUILTIN_TOOLS as readonly string[];

/** Code-running and capability tools present in 2.1.258. */
const INVENTORY_2_1_258 = [
  "PowerShell", "REPL", "Computer", "Memory", "ToolSearch", "LSP", "ListMcpResources",
  "ReadMcpResource", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "BashOutput",
  "KillShell", "NotebookRead", "SendUserMessage", "TaskOutput", "TaskStop",
];

/** Every built-in tool name and alias present in 2.1.280, except the JSON response tool. */
const INVENTORY_2_1_280 = [
  "Agent", "AppifactRepl", "Artifact", "ArtifactCheck", "ArtifactComments", "ArtifactData",
  "AskUserQuestion", "Bash", "Brief", "ClaudeDesign", "CronCreate", "CronDelete", "CronList",
  "DesignSync", "Edit", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
  "FetchInboxMessage", "Glob", "Grep", "KillBash", "KillShell", "LSP", "ListAgents",
  "ListConnectors", "ListMcpResources", "ListMcpResourcesTool", "ListPeers", "ListPlugins",
  "ListSkills", "Monitor", "NotebookEdit", "ObserverReport", "Poll", "PowerShell", "Projects",
  "ProposeGoal", "PushNotification", "Read", "ReadMcpResource", "ReadMcpResourceDir",
  "ReadMcpResourceDirTool", "ReadMcpResourceTool", "ReadNotifications", "RefreshMcpTools",
  "RemoteTrigger", "ReportFindings", "RunWorkflow", "ScheduleWakeup", "SearchMcpRegistry",
  "SearchPlugins", "SearchSkills", "SendFeedback", "SendFile", "SendMessage", "SendUserFile",
  "SendUserMessage", "ShareOnboardingGuide", "ShowOnboardingRolePicker", "Skill",
  "SubagentHandback", "SuggestConnectors", "SuggestPluginInstall", "SuggestSkills", "Task",
  "TaskCreate", "TaskGet", "TaskList", "TaskStop", "TaskUpdate", "TodoWrite", "ToolSearch",
  "WaitForMcpServers", "WebFetch", "WebSearch", "Workflow", "Write",
  "enable__mcp__claude-in-chrome", "enable__mcp__remote-devices__Claude_Browser",
  "enable__mcp__remote-devices__computer", "mcp", "memory_list", "memory_read", "memory_write",
  "propose_skills", "self_hosted_runner_get_pool", "self_hosted_runner_list_runners",
  "self_hosted_runner_list_secrets", "self_hosted_runner_list_sessions",
  "self_hosted_runner_read_health", "self_hosted_runner_read_metrics",
  "self_hosted_runner_requeue_session", "self_hosted_runner_spawn_local",
  "self_hosted_runner_tail_log",
];

/** Every built-in tool name and alias present in 2.1.302, except the JSON response tool. */
const INVENTORY_2_1_302 = [
  "Agent", "AppifactRepl", "Artifact", "ArtifactCheck", "ArtifactComments", "ArtifactData",
  "AskUserQuestion", "Bash", "Brief", "ClaudeDesign", "CronCreate", "CronDelete", "CronList",
  "DesignSync", "Edit", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
  "FetchInboxMessage", "GetTask", "Glob", "Grep", "KillBash", "KillShell", "LSP", "ListAgents",
  "ListConnectors", "ListMcpResources", "ListMcpResourcesTool", "ListPeers", "ListPlugins",
  "ListSkills", "Monitor", "NotebookEdit", "ObserverReport", "OfferChromeSetup", "Poll",
  "PowerShell", "Projects", "ProposeGoal", "PublishPlugin", "PushNotification", "Read",
  "ReadMcpResource", "ReadMcpResourceDir", "ReadMcpResourceDirTool", "ReadMcpResourceTool",
  "ReadNotifications", "RefreshMcpTools", "RemoteTrigger", "ReportFindings", "RunWorkflow",
  "ScheduleWakeup", "SearchMcpRegistry", "SearchPlugins", "SearchSkills", "SendFeedback",
  "SendFile", "SendMessage", "SendUserFile", "SendUserMessage", "ShareOnboardingGuide",
  "ShowOnboardingRolePicker", "Skill", "SubagentHandback", "SuggestConnectors",
  "SuggestPluginInstall", "SuggestSkills", "Task", "TaskCreate", "TaskGet", "TaskList", "TaskStop",
  "TaskUpdate", "TodoWrite", "ToolSearch", "WaitForMcpServers", "WebFetch", "WebSearch",
  "Workflow", "Write", "enable__mcp__claude-in-chrome",
  "enable__mcp__remote-devices__Claude_Browser", "enable__mcp__remote-devices__computer", "mcp",
  "memory_list", "memory_read", "memory_write", "propose_skills", "request_computer",
  "self_hosted_runner_get_pool", "self_hosted_runner_list_runners",
  "self_hosted_runner_list_secrets", "self_hosted_runner_list_sessions",
  "self_hosted_runner_read_health", "self_hosted_runner_read_metrics",
  "self_hosted_runner_requeue_session", "self_hosted_runner_spawn_local",
  "self_hosted_runner_tail_log",
];

describe("deny list: complete for every supported CLI version", () => {
  const cases: [string, string[]][] = [
    ["2.1.258", INVENTORY_2_1_258],
    ["2.1.280", INVENTORY_2_1_280],
    ["2.1.302", INVENTORY_2_1_302],
  ];

  it("the version pin is exactly the versions inventoried here", () => {
    assert.deepEqual([...SUPPORTED_CLAUDE_VERSIONS].sort(), cases.map(([v]) => v).sort());
  });

  for (const [version, inventory] of cases) {
    it(`every ${version} built-in tool is denied by name`, () => {
      const missing = inventory.filter((name) => !denied.includes(name));
      assert.deepEqual(missing, [], `missing from the deny list: ${missing.join(", ")}`);
    });
  }

  it("the 2.1.302 inventory has 100 names", () => {
    assert.equal(INVENTORY_2_1_302.length, 100);
  });

  it("no name is listed twice", () => {
    assert.equal(new Set(denied).size, denied.length);
  });

  it("the JSON response tool stays available", () => {
    assert.equal(denied.includes("StructuredOutput"), false);
  });

  it("each reviewed version is pinned without an override, and an unreviewed successor is not", () => {
    for (const [version] of cases) {
      assert.equal(parseClaudeVersion(`${version} (Claude Code)\n`), version);
      assert.ok(supportedClaudeVersions({}).includes(version), version);
    }
    for (const unreviewed of ["2.1.281", "2.1.303"]) {
      assert.equal(supportedClaudeVersions({}).includes(unreviewed), false, unreviewed);
    }
  });
});
