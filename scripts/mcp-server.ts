#!/usr/bin/env bun
/**
 * scripts/mcp-server.ts — MCP server (stdio) que expone los AgentTools
 *
 * Protocolo: MCP over stdio = JSON-RPC 2.0, una línea por mensaje.
 * Métodos implementados:
 *   - initialize   — handshake
 *   - tools/list   — devuelve descriptores MCP de las tools autorizadas
 *   - tools/call   — ejecuta una tool por nombre con sus args
 *
 * Uso:
 *   LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… bun run scripts/mcp-server.ts
 *
 * El cliente (Claude Code, Claude Desktop, IDE plugin) lanza este proceso y
 * habla con él vía stdin/stdout. Los logs van a stderr (no contaminan el
 * canal MCP).
 *
 * Cero dependencias — protocolo implementado a mano.
 */

import { listToolsForAgent, getTool } from "../shared/tools/registry";
import { toMcpToolset } from "../shared/tools/adapters/mcp-adapter";
import type { AgentType, ToolContext } from "../shared/tools/types";

// ─── Config ─────────────────────────────────────────────────────────────────

const AGENT_TYPE: AgentType =
  (process.env.MCP_AGENT_TYPE as AgentType) || "coordinator";
const STEP_BUDGET_MS = Number(process.env.MCP_STEP_BUDGET_MS ?? "10000");
const SERVER_NAME = "atlax-langfuse-bridge";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05"; // MCP spec version

// ─── JSON-RPC helpers ───────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function logErr(msg: string): void {
  process.stderr.write(`[mcp-server] ${msg}\n`);
}

function send(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}

function sendError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

// ─── Method handlers ────────────────────────────────────────────────────────

function handleInitialize(id: string | number | null, _params: unknown): void {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    },
  });
}

function handleToolsList(id: string | number | null): void {
  const tools = listToolsForAgent(AGENT_TYPE);
  send({
    jsonrpc: "2.0",
    id,
    result: {
      tools: toMcpToolset(tools),
    },
  });
}

async function handleToolsCall(
  id: string | number | null,
  params: unknown,
): Promise<void> {
  if (typeof params !== "object" || params === null) {
    sendError(id, -32602, "Invalid params (expected object)");
    return;
  }
  const { name, arguments: args } = params as {
    name?: string;
    arguments?: unknown;
  };
  if (typeof name !== "string") {
    sendError(id, -32602, "Missing 'name' in tools/call params");
    return;
  }

  const tool = getTool(name, AGENT_TYPE);
  if (!tool) {
    sendError(id, -32601, `Tool not found or not authorized: ${name}`);
    return;
  }

  const validated = tool.validate(args ?? {});
  if (!validated.ok) {
    sendError(id, -32602, `Tool '${name}' validation: ${validated.error}`);
    return;
  }

  const ctx: ToolContext = {
    agentType: AGENT_TYPE,
    stepBudgetMs: STEP_BUDGET_MS,
  };

  try {
    const output = await tool.execute(validated.data, ctx);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
        isError: false,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Tool error: ${msg}` }],
        isError: true,
      },
    });
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export async function dispatch(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      handleInitialize(id, req.params);
      return;
    case "initialized":
    case "notifications/initialized":
      // Notification — no response.
      return;
    case "tools/list":
      handleToolsList(id);
      return;
    case "tools/call":
      await handleToolsCall(id, req.params);
      return;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      // Notifications (no id) → silently ignored. Otherwise → -32601.
      if (req.id !== undefined) {
        sendError(id, -32601, `Method not found: ${req.method}`);
      }
      return;
  }
}

// ─── Main loop: line-delimited JSON-RPC over stdin ──────────────────────────

export async function runServer(): Promise<void> {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += (chunk as Buffer).toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        logErr(`parse error: ${(err as Error).message}`);
        sendError(null, -32700, "Parse error");
        continue;
      }
      try {
        await dispatch(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logErr(`dispatch error: ${msg}`);
        sendError(req.id ?? null, -32603, `Internal error: ${msg}`);
      }
    }
  }
}

if (import.meta.main) {
  logErr(`starting (agent=${AGENT_TYPE}, budget=${STEP_BUDGET_MS}ms)`);
  runServer().catch((err: Error) => {
    logErr(`fatal: ${err.message}`);
    process.exit(1);
  });
}
