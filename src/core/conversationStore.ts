// 统一会话日志：网页聊天与通道（QQ/微信）的每一轮都追加到同一份日志。
// 文件：data/conversations/<slug>.jsonl，每行 { id, role, content, surface, ns, t }
// 设计：
//   - 绑定（联通）时：网页发消息经通道 agent 会话驱动，回复同时投递到微信/QQ 并回显网页；
//     通道里用户发来的消息由观察器轮询追加 —— 两边看到同一份记录（聊天记录相同）。
//   - 未绑定（断开）时：网页聊天照常走 /api/chat（local 作用域），轮次也落日志；
//     记忆与对话各自独立、不丢不串；解绑后记录保留，重绑续上。
//   - surface 标记消息来源：web=网页发出/回显，qq/wx=通道用户或通道投递。
//   - 一键「重置」时清空整个日志（连同记忆）。
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./cardStore.js";

export type ConvSurface = "web" | "qq" | "wx";

export interface ConvEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  surface: ConvSurface;
  /** 该消息所属用户作用域（local / qq:<openid> / wx:<openid>） */
  ns: string;
  t: string; // ISO
}

export function convFile(slug: string): string {
  return path.join(dataDir(), "conversations", `${slug}.jsonl`);
}

function newConvId(): string {
  return Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
}

/** 追加一条记录（自动补 id/t）；返回完整条目 */
export async function appendConv(
  slug: string,
  input: { role: "user" | "assistant"; content: string; surface: ConvSurface; ns: string }
): Promise<ConvEntry> {
  const entry: ConvEntry = {
    id: newConvId(),
    role: input.role,
    content: String(input.content ?? "").slice(0, 20000),
    surface: input.surface,
    ns: input.ns || "local",
    t: new Date().toISOString(),
  };
  const file = convFile(slug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/** 读取最近 limit 条（limit 0 = 全部） */
export async function readConv(slug: string, limit = 0): Promise<ConvEntry[]> {
  const raw = await fs.readFile(convFile(slug), "utf8").catch(() => "");
  const out: ConvEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<ConvEntry>;
      if (o && typeof o.content === "string") {
        out.push({
          id: String(o.id ?? ""),
          role: o.role === "assistant" ? "assistant" : "user",
          content: o.content,
          surface: (["web", "qq", "wx"] as const).includes(o.surface as ConvSurface)
            ? (o.surface as ConvSurface)
            : "web",
          ns: typeof o.ns === "string" && o.ns ? o.ns : "local",
          t: typeof o.t === "string" ? o.t : "",
        });
      }
    } catch {
      /* 跳过损坏行 */
    }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/** 清空某卡的会话日志（「重置」按钮用） */
export async function clearConv(slug: string): Promise<void> {
  await fs.rm(convFile(slug), { force: true }).catch(() => {});
}
