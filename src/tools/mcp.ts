// MCP 客户端：连接配置的 MCP server（stdio），把其工具并入工具循环
// 参考 rikkahub 的 MCP 支持思路，用官方 @modelcontextprotocol/sdk 实现
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDef, ToolCtx } from "./registry.js";
import { dataDir } from "../core/cardStore.js";

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
}

export interface MCPConfig {
  servers: MCPServerConfig[];
}

async function configPath(): Promise<string> {
  return path.join(dataDir(), "mcp.json");
}

export async function loadMCPConfig(): Promise<MCPConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(await configPath(), "utf8"));
    return { servers: Array.isArray(raw?.servers) ? raw.servers : [] };
  } catch {
    return { servers: [] };
  }
}

export async function saveMCPConfig(cfg: MCPConfig): Promise<void> {
  await fs.mkdir(path.dirname(await configPath()), { recursive: true });
  await fs.writeFile(await configPath(), JSON.stringify(cfg, null, 2), "utf8");
}

const clients = new Map<string, Client>();
const toolCache = new Map<string, ToolDef[]>();

async function connectServer(srv: MCPServerConfig): Promise<ToolDef[]> {
  const cached = toolCache.get(srv.name);
  if (cached) return cached;
  const client = new Client({ name: "openclaw-shell", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: srv.command,
    args: srv.args ?? [],
    cwd: process.cwd(),
  });
  await client.connect(transport);
  clients.set(srv.name, client);
  const { tools } = await client.listTools();
  const defs: ToolDef[] = (tools ?? []).map((t) => ({
    id: `mcp__${srv.name}__${t.name}`,
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
  toolCache.set(srv.name, defs);
  return defs;
}

export async function getMCPTools(): Promise<{ tools: ToolDef[]; errors: string[] }> {
  const cfg = await loadMCPConfig();
  const tools: ToolDef[] = [];
  const errors: string[] = [];
  for (const srv of cfg.servers) {
    if (!srv.name || !srv.command) continue;
    try {
      tools.push(...(await connectServer(srv)));
    } catch (e) {
      errors.push(`${srv.name}: ${String(e)}`);
      toolCache.delete(srv.name);
    }
  }
  return { tools, errors };
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
