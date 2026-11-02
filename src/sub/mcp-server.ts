/**
 * The read-only tool server for subscription mode.
 *
 * A stdio MCP server (newline-delimited JSON-RPC 2.0) that exposes exactly the
 * tools `runTriage` gives the model in API mode — `kubectl_read`,
 * `promql_query`, `argocd_status`, `docs_search`, `docs_read` — with the same
 * zod input schemas, the same implementations, the same egress belt, and the
 * same `[[tool-status: …]]` declarations. Claude Code launches it per run via
 * `--mcp-config`; the model sees the tools as `mcp__sre__<name>`.
 *
 * What it guarantees:
 *  - It refuses to start with an API credential in its environment (same rule
 *    as the runner; see `src/sub/config.ts`).
 *  - It refuses to start without `SRE_SUB_CALL_LOG`: a run whose tool calls
 *    cannot be graded is not a run this project wants.
 *  - Every `tools/call`, including schema rejections, is appended to the call
 *    log before the response is written.
 *  - Nothing but JSON-RPC ever goes to stdout; diagnostics go to stderr.
 */

import { createInterface } from "node:readline";

import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import { appendCall, callOk } from "./calllog.js";
import { loadSubscriptionConfig } from "./config.js";
import { knownSecrets, scrubSecrets, type KnownSecret } from "./redact.js";
import { buildReadOnlyTools, MCP_SERVER_NAME } from "./toolset.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: `sre-agent-readonly`, version: "0.1.0" } as const;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcId, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id: JsonRpcId, code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : JSON.stringify(block),
      )
      .join("\n");
  }
  return JSON.stringify(content);
}

/** The `tools/list` entry for one tool: MCP's shape over the SDK's `input_schema`. */
export function listEntry(tool: BetaRunnableTool): { name: string; description: string; inputSchema: unknown } {
  // `BetaRunnableTool` is a union that includes Anthropic's server-side tool
  // shapes (memory, computer, …), which carry no schema. Every tool this
  // project builds is a custom tool with `input_schema`; a tool without one
  // would be a programming error, so it is refused loudly rather than listed.
  const custom = tool as { name: string; description?: string; input_schema?: unknown };
  if (custom.input_schema === undefined) {
    throw new Error(`tool ${tool.name} has no input_schema; only custom tools can be served`);
  }
  return {
    name: custom.name,
    description: custom.description ?? "",
    inputSchema: custom.input_schema,
  };
}

export type ServeOptions = {
  tools: readonly BetaRunnableTool[];
  callLog: string;
  turnBase: number;
  input?: NodeJS.ReadableStream;
  /**
   * The final known-secret boundary. Built from the loaded
   * config's credential fields at server start and applied to every tool result
   * BEFORE it is logged and BEFORE it is replied to the model, so a credential
   * echoed by an endpoint cannot reach `calls.jsonl`, the transcripts, the
   * report, or Claude's context even if a tool forgot to redact it. The list is
   * never printed, logged, or included in a reply.
   */
  secrets?: readonly KnownSecret[];
};

/**
 * Serve until stdin closes. Exposed as a function so the offline check suite
 * can drive it in-process as well as over a real child process.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const { tools, callLog } = options;
  const secrets = options.secrets ?? [];
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  let sequence = 0;

  const handle = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      fail(null, PARSE_ERROR, "parse error");
      return;
    }
    if (message === null || typeof message !== "object" || typeof message.method !== "string") {
      if (message !== null && typeof message === "object" && message.id !== undefined) {
        fail(message.id ?? null, INVALID_REQUEST, "invalid request");
      }
      return;
    }
    const id = message.id;
    const isNotification = id === undefined;
    const method = message.method;

    if (isNotification) return; // notifications/initialized, notifications/cancelled: nothing to do.

    switch (method) {
      case "initialize": {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        reply(id, {
          protocolVersion: typeof requested === "string" ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Read-only investigation tools for a homelab k3s cluster. Every tool is " +
            "read-only by construction; there is no tool that mutates anything.",
        });
        return;
      }
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: tools.map(listEntry) });
        return;
      case "tools/call": {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === "string" ? params.name : "";
        const tool = byName.get(name);
        if (tool === undefined) {
          fail(id, INVALID_PARAMS, `unknown tool ${JSON.stringify(name)}; this server has: ${[...byName.keys()].join(", ")}`);
          return;
        }
        sequence += 1;
        const turn = options.turnBase + sequence;
        const toolUseId = `sub_${sequence}`;
        const rawInput = params.arguments !== null && typeof params.arguments === "object" ? params.arguments : {};
        let text: string;
        let isError = false;
        try {
          const parsed = tool.parse(rawInput);
          text = contentText(await tool.run(parsed));
        } catch (error) {
          // Same wording the SDK's tool runner hands the model on a thrown tool
          // (`toolErrorContent`): the transcript reads identically in both modes.
          text = `Error: ${error instanceof Error ? error.message : String(error)}`;
          isError = true;
        }
        // The boundary. Everything below this line — the call log AND the reply
        // — sees the scrubbed text and nothing else.
        text = scrubSecrets(text, secrets);
        const ok = !isError && callOk(text);
        appendCall(callLog, {
          at: new Date().toISOString(),
          turn,
          origin: "model",
          tool: name,
          toolUseId,
          input: rawInput as Record<string, unknown>,
          result: text,
          ok,
        });
        reply(id, { content: [{ type: "text", text }], isError });
        return;
      }
      default:
        fail(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  };

  const rl = createInterface({ input: options.input ?? process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  // Serialise: tool calls may be slow, and responses must not interleave
  // mid-line. Claude Code issues one call at a time in practice; this keeps the
  // server correct if it does not.
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain.then(() => handle(line)).catch((error) => {
      process.stderr.write(`sre-agent mcp-server: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
  await new Promise<void>((resolve) => rl.once("close", () => void chain.then(resolve, resolve)));
  for (const tool of tools) await tool.close?.();
}

async function main(): Promise<void> {
  const callLog = process.env["SRE_SUB_CALL_LOG"];
  if (callLog === undefined || callLog === "") {
    process.stderr.write(
      "sre-agent mcp-server: SRE_SUB_CALL_LOG is not set. This server refuses to serve tool calls it cannot log; " +
        "it is launched by `src/sub/run.ts`, not by hand.\n",
    );
    process.exit(2);
  }
  const turnBase = Number.parseInt(process.env["SRE_SUB_TURN_BASE"] ?? "0", 10);
  // The Claude child is spawned with an allowlisted environment, but Claude Code merges its own environment into the MCP child it
  // launches, so the subscription credential can still arrive here. This server
  // has no use for it and nothing it serves should be able to read it: drop it
  // before any tool is constructed.
  for (const variable of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_API_KEY"]) delete process.env[variable];
  const { config } = loadSubscriptionConfig(process.env);
  const tools = buildReadOnlyTools(config);
  const secrets = knownSecrets(config as unknown as Record<string, unknown>);
  process.stderr.write(
    `sre-agent mcp-server (${MCP_SERVER_NAME}): serving ${tools.map((t) => t.name).join(", ")}; log ${callLog}\n`,
  );
  await serve({ tools, callLog, turnBase: Number.isFinite(turnBase) ? turnBase : 0, secrets });
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /[/\\]mcp-server\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`sre-agent mcp-server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
