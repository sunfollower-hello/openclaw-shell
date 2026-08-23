// 工具注册表：全部免 API key；沙箱化（参考 rikkahub 的 workspace 隔离思路，Windows 实现）
// 运行上下文 ctx：sandboxDir = 该人设卡的工作区沙箱目录，memoryPath = 长期记忆文件
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ToolCtx {
  slug: string;
  sandboxDir: string;
  memoryPath: string;
  imagesDir: string;
}

export interface ToolDef {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  dangerous?: boolean; // 危险工具 → 默认走 ask 审批
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
}

function execAsync(cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string }): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || "") || String(stderr || "");
        resolve(out ? out.slice(0, 6000) : err ? `（退出码 ${(err as NodeJS.ErrnoException).code ?? "?"}，无输出）` : "（无输出）");
      }
    );
  });
}

/** 沙箱路径解析：任何越界访问一律拒绝 */
export function resolveInSandbox(sandboxDir: string, p: string): string | null {
  const abs = path.resolve(sandboxDir, p || ".");
  if (abs === sandboxDir || abs.startsWith(sandboxDir + path.sep)) return abs;
  return null;
}

// ---------- 写代码并运行（沙箱内，Node 权限模型限制文件访问） ----------
const codeExec: ToolDef = {
  id: "code_exec",
  name: "写代码并运行（沙箱内）",
  description:
    "编写并执行 JavaScript/Node.js 代码。运行在「工作区沙箱」目录内：只能读写沙箱目录里的文件，内存上限 256MB，15 秒超时。用 console.log 输出；支持 async/await 和 require 内置模块。",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "要执行的完整 JavaScript 代码" } },
    required: ["code"],
  },
  dangerous: true,
  async run(args, ctx) {
    const code = String(args.code ?? "");
    if (!code.trim()) return "错误：代码为空";
    await fs.mkdir(ctx.sandboxDir, { recursive: true });
    const file = path.join(ctx.sandboxDir, `_exec_${Date.now()}.mjs`);
    await fs.writeFile(file, code, "utf8");
    try {
      // 第一优先：Node 权限模型（仅允许读写沙箱目录）
      const permArgs = [
        "--experimental-permission",
        `--allow-fs-read=${ctx.sandboxDir}`,
        `--allow-fs-write=${ctx.sandboxDir}`,
        "--max-old-space-size=256",
        file,
      ];
      const out = await execAsync(process.execPath, permArgs, { timeoutMs: 15000, cwd: ctx.sandboxDir });
      return out;
    } catch {
      // 权限模型在个别环境不兼容时的降级：普通运行（仍在沙箱目录内，有超时/内存限制）
      const out = await execAsync(process.execPath, ["--max-old-space-size=256", file], {
        timeoutMs: 15000,
        cwd: ctx.sandboxDir,
      });
      return out + "\n（注：当前环境未启用文件权限限制）";
    } finally {
      fs.unlink(file).catch(() => {});
    }
  },
};

// ---------- 沙箱文件工具集（参考 rikkahub workspace 文件工具思路） ----------
const sandboxList: ToolDef = {
  id: "sandbox_list",
  name: "列出沙箱文件",
  description: "列出工作区沙箱目录下的文件（相对路径）。参数 dir 为相对目录，空为根目录。",
  parameters: { type: "object", properties: { dir: { type: "string", description: "相对目录，默认空（根）" } } },
  async run(args, ctx) {
    const dir = resolveInSandbox(ctx.sandboxDir, String(args.dir ?? ""));
    if (!dir) return "拒绝访问沙箱外路径";
    const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (!items.length) return "（空目录）";
    return items
      .map((i) => `${i.isDirectory() ? "[目录]" : "[文件]"} ${i.name}`)
      .sort()
      .join("\n");
  },
};

const sandboxRead: ToolDef = {
  id: "sandbox_read",
  name: "读取沙箱文件",
  description: "读取工作区沙箱目录里的文件内容（最多 8000 字符）。参数 file 为相对路径。",
  parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
  async run(args, ctx) {
    const f = resolveInSandbox(ctx.sandboxDir, String(args.file ?? ""));
    if (!f) return "拒绝访问沙箱外路径";
    const content = await fs.readFile(f, "utf8").catch((e) => `读取失败: ${e.message}`);
    return content.slice(0, 8000);
  },
};

const sandboxWrite: ToolDef = {
  id: "sandbox_write",
  name: "写入沙箱文件",
  description: "在工作区沙箱目录里创建/覆盖文件（自动创建父目录）。参数 file 为相对路径，content 为内容。",
  parameters: {
    type: "object",
    properties: { file: { type: "string" }, content: { type: "string" } },
    required: ["file", "content"],
  },
  async run(args, ctx) {
    const f = resolveInSandbox(ctx.sandboxDir, String(args.file ?? ""));
    if (!f) return "拒绝访问沙箱外路径";
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, String(args.content ?? ""), "utf8");
    return `已写入 ${args.file}（${String(args.content ?? "").length} 字符）`;
  },
};

const sandboxGrep: ToolDef = {
  id: "sandbox_grep",
  name: "搜索沙箱文件",
  description: "在沙箱目录文件里搜索关键词，返回匹配的文件和行（最多 20 条）。参数 keyword 为关键词。",
  parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
  async run(args, ctx) {
    const keyword = String(args.keyword ?? "");
    const hits: string[] = [];
    const walk = async (dir: string, rel: string) => {
      const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const it of items) {
        if (hits.length >= 20) return;
        const abs = path.join(dir, it.name);
        const relPath = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) await walk(abs, relPath);
        else {
          const text = await fs.readFile(abs, "utf8").catch(() => "");
          if (text.includes(keyword)) hits.push(`${relPath}: ${text.split("\n").find((l) => l.includes(keyword))?.slice(0, 80)}`);
        }
      }
    };
    await walk(ctx.sandboxDir, "");
    return hits.length ? hits.join("\n") : "没有匹配";
  },
};

// ---------- 联网搜索 / 天气 / 时间（同前，非危险） ----------
const webSearch: ToolDef = {
  id: "web_search",
  name: "联网搜索",
  description: "搜索互联网并返回前 5 条结果的标题、摘要和链接（DuckDuckGo，无需 API key）。",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
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
        s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
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
  description: "查询某个城市的当前天气（wttr.in，无需 API key）。",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  async run(args) {
    const city = String(args.city ?? "");
    try {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { signal: AbortSignal.timeout(20000) });
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

// ---------- 长期记忆（保存关于用户的事实，去重 + 分类） ----------
const memorySave: ToolDef = {
  id: "memory_save",
  name: "记住事实（长期记忆）",
  description:
    "把关于用户的重要事实保存到长期记忆（例如：用户住在上海、用户养了一只叫旺财的狗、用户下周三过生日）。只保存值得长期记住的事实，不要保存一次性对话内容。已记住的相同/相似事实不会重复写入。category 可选，取值为：信息/偏好/关系/事件/待定，默认信息。",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "要记住的事实" },
      category: { type: "string", description: "分类：信息/偏好/关系/事件/待定（可选）" },
    },
    required: ["fact"],
  },
  async run(args, ctx) {
    const fact = String(args.fact ?? "").trim();
    if (!fact) return "错误：事实为空";
    const { appendEntry } = await import("../core/memoryStore.js");
    const res = await appendEntry(ctx.slug ?? "", { fact, cat: String(args.category ?? "") as never, src: "tool" });
    if (!res.ok) return res.duplicate ? `这条已经记住了：${fact}` : "错误：事实为空";
    return `已记住（${res.entry!.cat}）：${fact}`;
  },
};

// ---------- 生图（NovelAI / OpenAI 兼容 / 本地 SD WebUI） ----------
const imageGen: ToolDef = {
  id: "image_gen",
  name: "生图（AI 绘画）",
  description:
    "根据文字描述生成图片并发送（需先在「生图配置」页配置提供商与 Key）。参数 prompt 为绘画提示词（中文会自动翻译扩写为英文），negative 为负面词（可选），aspect 为比例（square/portrait/landscape/tall/wide，可选），seed 为随机种子（可选，相同种子可复现）。",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "绘画提示词（中文自动翻译为英文）" },
      negative: { type: "string", description: "负面提示词（可选）" },
      aspect: { type: "string", description: "square/portrait/landscape/tall/wide" },
      seed: { type: "number", description: "随机种子（可选，固定可复现同一张图）" },
    },
    required: ["prompt"],
  },
  async run(args, ctx) {
    const { generateImage } = await import("../core/imageGen.js");
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return "错误：提示词为空";
    const res = await generateImage(
      {
        prompt,
        negative: args.negative ? String(args.negative) : undefined,
        aspect: args.aspect ? String(args.aspect) : undefined,
        seed: typeof args.seed === "number" ? args.seed : undefined,
      },
      ctx.imagesDir
    );
    if (!res.ok) return res.error ?? "生图失败";
    const file = res.file ? path.basename(res.file) : "gen.png";
    const url = `/img/${path.basename(ctx.imagesDir)}/${file}`;
    const translated = res.promptUsed && res.promptUsed !== prompt ? "（中文提示词已自动翻译扩写为英文）" : "";
    return `已生成图片：${url}${translated}\n实际提示词：${res.promptUsed ?? prompt}`;
  },
};

export const TOOL_REGISTRY: ToolDef[] = [
  codeExec,
  sandboxList,
  sandboxRead,
  sandboxWrite,
  sandboxGrep,
  webSearch,
  weather,
  datetime,
  memorySave,
  imageGen,
];

export function toolsToOpenAI(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.id, description: t.description, parameters: t.parameters },
  }));
}
