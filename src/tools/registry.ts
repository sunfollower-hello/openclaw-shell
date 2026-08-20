// 工具注册表：全部免 API key（本机运行 / DuckDuckGo / wttr.in）
// 由 /api/chat 的 function calling 循环调用
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ToolDef {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

function execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || "") || String(stderr || "");
        resolve(out ? out.slice(0, 6000) : err ? `（退出码 ${(err as NodeJS.ErrnoException).code ?? "?"}，无输出）` : "（无输出）");
      }
    );
  });
}

const codeExec: ToolDef = {
  id: "code_exec",
  name: "写代码并运行（JavaScript/Node.js）",
  description:
    "编写并执行 JavaScript/Node.js 代码（在本机运行，15 秒超时，输出最多 6000 字符）。适合计算、数据处理、生成脚本。用 console.log 输出结果；支持 async/await；也可以使用 require 引入内置模块。",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "要执行的完整 JavaScript 代码" } },
    required: ["code"],
  },
  async run(args) {
    const code = String(args.code ?? "");
    if (!code.trim()) return "错误：代码为空";
    const file = path.join(os.tmpdir(), `ocs-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    await fs.writeFile(file, code, "utf8");
    try {
      return await execAsync(process.execPath, [file], 15000);
    } catch (e) {
      return `执行失败: ${String(e)}`;
    } finally {
      fs.unlink(file).catch(() => {});
    }
  },
};

const webSearch: ToolDef = {
  id: "web_search",
  name: "联网搜索",
  description: "搜索互联网并返回前 5 条结果的标题、摘要和链接（DuckDuckGo，无需 API key）。适合查新闻、资料、实时信息。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "搜索关键词" } },
    required: ["query"],
  },
  async run(args) {
    const query = String(args.query ?? "");
    try {
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(20000),
      });
      const html = await r.text();
      const results: string[] = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const clean = (s: string) =>
        s
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&#39;/g, "'")
          .trim();
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(html)) !== null && count < 5) {
        const url = decodeURIComponent((m[1].match(/uddg=([^&]+)/)?.[1] ?? m[1]).replace(/\+/g, " "));
        results.push(`${count + 1}. ${clean(m[2])}\n   ${clean(m[3])}\n   ${url}`);
        count++;
      }
      return results.length ? results.join("\n\n") : "没有搜到结果";
    } catch (e) {
      return `搜索失败: ${String(e)}`;
    }
  },
};

const weather: ToolDef = {
  id: "weather",
  name: "查天气",
  description: "查询某个城市的当前天气（wttr.in，无需 API key）。参数 city 为城市名（中文或拼音）。",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "城市名，如 北京 / beijing" } },
    required: ["city"],
  },
  async run(args) {
    const city = String(args.city ?? "");
    try {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
        signal: AbortSignal.timeout(20000),
      });
      const data = (await r.json()) as {
        current_condition?: { temp_C?: string; FeelsLikeC?: string; humidity?: string; windspeedKmph?: string; lang_zh?: { value?: string }[] }[];
        nearest_area?: { areaName?: { value?: string }[] }[];
      };
      const cur = data.current_condition?.[0];
      if (!cur) return `查询 ${city} 天气失败`;
      const area = data.nearest_area?.[0]?.areaName?.[0]?.value ?? city;
      const desc = cur.lang_zh?.[0]?.value ?? "";
      return `${area}：${cur.temp_C ?? "?"}°C，体感 ${cur.FeelsLikeC ?? "?"}°C${desc ? `，${desc}` : ""}，湿度 ${cur.humidity ?? "?"}%，风速 ${cur.windspeedKmph ?? "?"}km/h`;
    } catch (e) {
      return `天气查询失败: ${String(e)}`;
    }
  },
};

const datetime: ToolDef = {
  id: "datetime",
  name: "当前时间",
  description: "获取当前日期和时间（本机时区）。",
  parameters: { type: "object", properties: {} },
  async run() {
    const d = new Date();
    return `${d.toLocaleString("zh-CN", { hour12: false })}（${d.toString()}）`;
  },
};

export const TOOL_REGISTRY: ToolDef[] = [codeExec, webSearch, weather, datetime];

export function toolsToOpenAI(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.id, description: t.description, parameters: t.parameters },
  }));
}
