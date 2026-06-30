/**
 * Mock OmniMCP HTTP 服务（MCP Streamable HTTP 传输）。
 *
 * 用于在 `start:web` 模式下替代真实 OmniPanel 内置 MCP（crates/omnipanel-mcp，
 * http://127.0.0.1:12756/mcp）。仅实现知识库三个内置工具（与 builtin.rs 保持一致），
 * 其余模块通过 X-Omni-Module 过滤后返回空工具列表，与真实 OmniMCP 行为一致。
 *
 * 协议参考：MCP Streamable HTTP Transport（JSON-RPC 2.0 over HTTP）。
 */
import http from "node:http";

const PORT = 12756;
const HOST = "127.0.0.1";
const PATH = "/mcp";
const PROTOCOL_VERSION = "2025-06-18";

const X_OMNI_MODULE_HEADER = "x-omni-module";
const OMNI_MODULE_MASTER = "master";

/** 内存知识库（仅进程生命周期内有效）。 */
const knowledgeStore = new Map<string, Record<string, unknown>>();

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** 工具名是否符合 omni_{module}_{function} 规范。 */
function omniToolModuleKey(toolName: string): string | null {
  const rest = toolName.startsWith("omni_") ? toolName.slice(5) : null;
  if (!rest) return null;
  const idx = rest.indexOf("_");
  return idx === -1 ? null : rest.slice(0, idx);
}

function parseModuleScope(value: string | undefined): "unspecified" | "all" | string {
  if (!value) return "unspecified";
  const module = value.trim().toLowerCase();
  if (!module) return "unspecified";
  if (module === OMNI_MODULE_MASTER) return "all";
  return module;
}

/** X-Omni-Module 请求头过滤工具列表。 */
function filterToolsForScope(
  tools: { name: string }[],
  scope: "unspecified" | "all" | string,
): { name: string }[] {
  if (scope === "unspecified") return [];
  if (scope === "all") return tools;
  return tools.filter((t) => omniToolModuleKey(t.name) === scope);
}

/** 知识库工具 schema（与 crates/omnipanel-mcp/src/builtin.rs 保持一致）。 */
function buildKnowledgeTools() {
  return [
    {
      name: "omni_knowledge_create_document",
      description: "Create a knowledge document in the knowledge base",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          kind: { type: "string" },
          tags: { type: "string" },
          source: { type: "string" },
          env_tag: { type: "string" },
          risk_level: { type: "string" },
          parent_id: { type: "string" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "omni_knowledge_remove_document",
      description: "Remove a knowledge document by its ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "omni_knowledge_list_documents",
      description: "List knowledge documents, optionally filtered by kind or tag",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          tag: { type: "string" },
        },
      },
    },
  ];
}

function callKnowledgeTool(
  name: string,
  args: Record<string, unknown>,
): { content: { type: string; text: string }[]; isError?: boolean } {
  if (name === "omni_knowledge_create_document") {
    const now = Date.now();
    const id = `doc_${now}`;
    const entry = {
      id,
      kind: (args.kind as string) ?? "snippet",
      title: (args.title as string) ?? "",
      content: (args.content as string) ?? "",
      tags: typeof args.tags === "string"
        ? (args.tags as string).split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      risk_level: (args.risk_level as string) ?? "safe",
      source: (args.source as string) ?? "mcp",
      env_tag: (args.env_tag as string) ?? "dev",
      created_at: now,
      updated_at: now,
      parent_id: (args.parent_id as string) ?? "",
    };
    knowledgeStore.set(id, entry);
    return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
  }

  if (name === "omni_knowledge_remove_document") {
    const id = (args.id as string) ?? "";
    const deleted = knowledgeStore.delete(id);
    return {
      content: [{ type: "text", text: JSON.stringify({ deleted, id }) }],
    };
  }

  if (name === "omni_knowledge_list_documents") {
    const kind = (args.kind as string) ?? null;
    const tag = (args.tag as string) ?? null;
    let entries = Array.from(knowledgeStore.values());
    if (kind) entries = entries.filter((e) => (e.kind as string) === kind);
    if (tag) {
      entries = entries.filter((e) =>
        Array.isArray(e.tags) ? (e.tags as string[]).includes(tag) : false,
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(entries) }],
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Mock 未知工具: ${name}` }],
  };
}

/** 处理单条 JSON-RPC 请求。 */
function handleRequest(
  req: JsonRpcRequest,
  moduleScope: "unspecified" | "all" | string,
): JsonRpcResponse | null {
  const id = req.id ?? null;
  const params = req.params ?? {};

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: "OmniMCP-Mock",
            version: "0.1.0",
          },
          instructions:
            "OmniMCP-Mock：替代 OmniPanel 内置 MCP 的模拟服务。仅实现 omni_knowledge_* 工具。",
        },
      };

    case "notifications/initialized":
      return null; // 通知，无响应

    case "tools/list": {
      const tools = filterToolsForScope(buildKnowledgeTools(), moduleScope);
      return { jsonrpc: "2.0", id, result: { tools } };
    }

    case "tools/call": {
      const toolName = (params as Record<string, unknown>).name as string | undefined;
      const args = ((params as Record<string, unknown>).arguments ?? {}) as Record<string, unknown>;

      // 模块权限校验（与 omni_module.rs::ensure_tool_allowed_for_module 一致）
      if (moduleScope === "unspecified") {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: "缺少 X-Omni-Module 请求头或值为空，无法调用 MCP 工具",
          },
        };
      }
      if (moduleScope !== "all") {
        const toolModule = toolName ? omniToolModuleKey(toolName) : null;
        if (!toolModule || toolModule !== moduleScope) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `工具 ${toolName ?? ""} 不属于模块 ${moduleScope}（当前 X-Omni-Module 请求头）`,
            },
          };
        }
      }

      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "缺少 tool name" },
        };
      }

      const result = callKnowledgeTool(toolName, args);
      return { jsonrpc: "2.0", id, result };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Mock 不支持的方法: ${req.method}` },
      };
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    // 客户端发起的 SSE 订阅（server→client 通知）；mock 无主动通知，返回 405
    // 告知客户端停止后续 GET 重试。
    res.writeHead(405, { Allow: "POST, DELETE" }).end();
    return;
  }

  if (req.method === "DELETE") {
    sendJson(res, 200, {});
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST, GET, DELETE" });
    res.end("Method Not Allowed");
    return;
  }

  const pathname = req.url?.split("?")[0] ?? "";
  if (pathname !== PATH) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) {
      res.writeHead(400).end("Empty body");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const moduleHeader = req.headers[X_OMNI_MODULE_HEADER] as string | undefined;
    const moduleScope = parseModuleScope(moduleHeader);

    // JSON-RPC 批处理
    if (Array.isArray(parsed)) {
      const results: JsonRpcResponse[] = [];
      for (const item of parsed as JsonRpcRequest[]) {
        const resp = handleRequest(item, moduleScope);
        if (resp) results.push(resp);
      }
      if (results.length === 0) {
        res.writeHead(202).end(); // 全为通知
        return;
      }
      const headers: Record<string, string> = {};
      if (results.some((r) => r.result !== undefined && !r.error)) {
        // 只在 initialize 响应里带 session id
      }
      sendJson(res, 200, results, headers);
      return;
    }

    const req0 = parsed as JsonRpcRequest;
    const resp = handleRequest(req0, moduleScope);

    if (resp === null) {
      // 通知：202，无 body
      res.writeHead(202).end();
      return;
    }

    const headers: Record<string, string> = {};
    if (req0.method === "initialize") {
      headers["Mcp-Session-Id"] = `mock-${Date.now()}`;
    }
    sendJson(res, 200, resp, headers);
  });

  req.on("error", (err) => {
    console.error("[mock-omnimcp] 读取请求体失败:", err);
    if (!res.headersSent) res.writeHead(400).end();
  });
});

server.listen(PORT, HOST, () => {
  console.error(`[mock-omnimcp] 监听 http://${HOST}:${PORT}${PATH}（替代 OmniPanel 内置 MCP）`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}