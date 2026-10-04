// Minimal stateless MCP server over Streamable HTTP (JSON responses).
// Spec: https://modelcontextprotocol.io/specification

import { Env } from "./tiktok";
import { tools } from "./tools";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `You manage a TikTok account through the official TikTok API.
- Call get_creator_info before posting; only use privacy levels it allows.
- Posts default to SELF_ONLY (private) unless the owner asks otherwise.
- After post_video/post_photos, poll get_post_status with the publish_id.
- Use analyze_performance to pick topics and posting times; schedule_post to plan content.
- Never post without the owner's approval of the caption and media unless they explicitly told you to.`;

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function dispatch(env: Env, req: JsonRpcRequest) {
  switch (req.method) {
    case "initialize": {
      const requested = req.params?.protocolVersion;
      return result(req.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tiktok-mcp", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(req.id, {});
    case "tools/list":
      return result(req.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === req.params?.name);
      if (!tool) return error(req.id, -32602, `Unknown tool: ${req.params?.name}`);
      try {
        const output = await tool.handler(env, req.params?.arguments ?? {});
        return result(req.id, { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] });
      } catch (err) {
        // Tool failures are returned as results so the agent can read and react to them.
        const message = err instanceof Error ? err.message : String(err);
        return result(req.id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      return error(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    // No server-initiated stream in stateless mode.
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await request.json();
  } catch {
    return Response.json(error(null, -32700, "Parse error"), { status: 400 });
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of batch) {
    // Notifications (no id) and client responses need no reply.
    if (msg.id === undefined || msg.method === undefined) continue;
    responses.push(await dispatch(env, msg));
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
