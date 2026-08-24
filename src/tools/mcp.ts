// MCP 客户端：连接配置的 MCP server（stdio / SSE / StreamableHTTP），把其工具并入工具循环
// 参考 rikkahub 的 MCP 支持思路：表单化配置（类型+连接串）+ 按服务器启用 + 按工具勾选
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDef, ToolCtx } from "./registry.js";
import { dataDir } from "../core/cardStore.js";

export type MCPTransportType = "stdio" | "sse" | "streamable-http";

export interface MCPToolOption {
  name: string;
  enabled: boolean;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: MCPTransportType;
  command?: string;
  args?: string[];
  url?: string;
  /** 自定义请求头，如 Bearer 鉴权（Key → Value） */
  headers?: Record<string, string>;
  /** 用户勾选启用哪些工具；未记录时全部启用 */
  tools?: MCPToolOption[];
}

export interface MCPConfig {
  servers: MCPServerConfig[];
}

async function configPath(): Promise<string> {
  return path.join(dataDir(), "mcp.json");
}

function normServer(raw: Partial<MCPServerConfig> | undefined, idx: number): MCPServerConfig {
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : `mcp-${idx + 1}-${crypto.randomUUID().slice(0, 8)}`,
    name: String(raw?.name ?? "").trim() || `MCP 服务器 ${idx + 1}`,
    enabled: raw?.enabled !== false,
    type: (raw?.type === "sse" || raw?.type === "streamable-http" ? raw.type : "stdio"),
    command: raw?.command ? String(raw.command).trim() : undefined,
    args: Array.isArray(raw?.args) ? raw.args.map(String) : undefined,
    url: raw?.url ? String(raw.url).trim() : undefined,
    headers:
      raw?.headers && typeof raw.headers === "object"
        ? Object.fromEntries(Object.entries(raw.headers).filter(([, v]) => v))
        : undefined,
    tools: Array.isArray(raw?.tools) ? raw.tools.map((t) => ({ name: String(t?.name ?? ""), enabled: t?.enabled !== false })) : undefined,
  };
}

export async function loadMCPConfig(): Promise<MCPConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(await configPath(), "utf8"));
    const servers = (Array.isArray(raw?.servers) ? (raw.servers as Array<Partial<MCPServerConfig>>) : [])
      .map(normServer)
      .filter((s) => s.name && (s.type === "stdio" ? s.command : s.url));
    return { servers };
  } catch {
    return { servers: [] };
  }
}

export async function saveMCPConfig(cfg: MCPConfig): Promise<MCPConfig> {
  const clean: MCPConfig = {
    servers: (Array.isArray(cfg?.servers) ? cfg.servers : [])
      .map((s, i) => normServer(s, i))
      .filter((s) => s.name && (s.type === "stdio" ? s.command : s.url)),
  };
  await fs.mkdir(path.dirname(await configPath()), { recursive: true });
  await fs.writeFile(await configPath(), JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

function makeTransport(srv: MCPServerConfig): { transport: Transport } | { error: string } {
  if (srv.type === "sse" || srv.type === "streamable-http") {
    if (!srv.url) return { error: `「${srv.name}」缺少连接 URL` };
    let url: URL;
    try {
      url = new URL(srv.url);
    } catch {
      return { error: `「${srv.name}」连接 URL 无效` };
    }
    const requestInit: RequestInit | undefined = srv.headers ? { headers: srv.headers } : undefined;
    const transport =
      srv.type === "sse"
        ? new SSEClientTransport(url, { requestInit })
        : new StreamableHTTPClientTransport(url, { requestInit });
    return { transport };
  }
  if (!srv.command) return { error: `「${srv.name}」缺少启动命令` };
  return {
    transport: new StdioClientTransport({
      command: srv.command,
      args: srv.args ?? [],
      cwd: process.cwd(),
    }),
  };
}

const clients = new Map<string, Client>();
const toolCache = new Map<string, ToolDef[]>();

function toolEnabled(srv: MCPServerConfig, name: string): boolean {
  if (!Array.isArray(srv.tools) || srv.tools.length === 0) return true;
  const opt = srv.tools.find((t) => t.name === name);
  return opt ? opt.enabled : false;
}

/** 连接一个 server 并返回其（勾选过的）工具定义；失败返回错误串 */
async function connectServer(srv: MCPServerConfig): Promise<ToolDef[]> {
  const cached = toolCache.get(srv.id);
  if (cached) return cached;
  const made = makeTransport(srv);
  if ("error" in made) throw new Error(made.error);
  const client = new Client({ name: "openclaw-shell", version: "0.1.0" });
  await client.connect(made.transport);
  clients.set(srv.id, client);
  const { tools } = await client.listTools();
  const defs: ToolDef[] = (tools ?? [])
    .filter((t) => toolEnabled(srv, t.name))
    .map((t) => ({
      id: `mcp__${srv.id}__${t.name}`,
      name: `${t.name}（${srv.name}）`,
      description: t.description ?? `MCP 工具 ${t.name}`,
      parameters: t.inputSchema ?? { type: "object", properties: {} },
      dangerous: true, // MCP 工具默认走 ask 审批
      async run(args: Record<string, unknown>, _ctx: ToolCtx): Promise<string> {
        try {
          const res = await client.callTool({ name: t.name, arguments: args });
          const content = Array.isArray(res?.content)
            ? (res.content as { text?: string }[])
                .map((c) => c.text ?? JSON.stringify(c))
                .join("\n")
            : JSON.stringify(res);
          return String(content ?? "（无返回）").slice(0, 6000);
        } catch (e) {
          return `MCP 调用失败: ${String(e)}`;
        }
      },
    }));
  toolCache.set(srv.id, defs);
  return defs;
}

export async function getMCPTools(): Promise<{ tools: ToolDef[]; errors: string[] }> {
  const cfg = await loadMCPConfig();
  const tools: ToolDef[] = [];
  const errors: string[] = [];
  for (const srv of cfg.servers) {
    if (!srv.enabled) continue;
    try {
      tools.push(...(await connectServer(srv)));
    } catch (e) {
      errors.push(`${srv.name}: ${String(e)}`);
      toolCache.delete(srv.id);
    }
  }
  return { tools, errors };
}

/** 测试单个 MCP 服务器：连接 + 拉取工具列表（不缓存、不断开即弃） */
export async function testMCPServer(srv: MCPServerConfig): Promise<{
  ok: boolean;
  tools: { name: string; description?: string }[];
  error?: string;
}> {
  const made = makeTransport(normServer(srv, 0));
  if ("error" in made) return { ok: false, tools: [], error: made.error };
  const client = new Client({ name: "openclaw-shell-test", version: "0.1.0" });
  try {
    await client.connect(made.transport);
    const { tools } = await client.listTools();
    await client.close().catch(() => {});
    return { ok: true, tools: (tools ?? []).map((t) => ({ name: t.name, description: t.description })) };
  } catch (e) {
    await client.close().catch(() => {});
    return { ok: false, tools: [], error: String(e) };
  }
}

export async function reloadMCP(): Promise<void> {
  for (const [, c] of clients) {
    try {
      await c.close();
    } catch {
      /* 忽略关闭错误 */
    }
  }
  clients.clear();
  toolCache.clear();
}
