// 工具注册表：全部免 API key；沙箱化（参考 rikkahub 的 workspace 隔离思路，Windows 实现）
// 运行上下文 ctx：sandboxDir = 该人设卡的工作区沙箱目录，memoryPath = 长期记忆文件
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ToolCtx {
  slug: string;
  /** 当前对话的作用域（local / qq:<openid> / wx:<openid>），记忆按此隔离 */
  ns: string;
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

// ---------- 联网搜索 ----------
// 用国内可直连的搜索源：DuckDuckGo 在国内网络下连不上（实测三个域名全部连接超时），
// 换成 360 搜索为主、必应国内版兜底，都不需要 API key，也不用代理。
const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

function stripTags(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // 数字实体（搜索页里常见 &#0183; 之类的分隔符）
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": SEARCH_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** 360 搜索：结果块是 li.res-list，标题在 h3>a，摘要在 .res-desc / .res-rich */
function parseSo(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split(/<li[^>]*class="res-list/).slice(1);
  for (const b of blocks) {
    if (out.length >= limit) break;
    const title = stripTags((b.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) ?? [])[1] ?? "");
    const url = ((b.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/) ?? [])[1] ?? "").trim();
    const snippet = stripTags(
      (b.match(/class="res-desc"[^>]*>([\s\S]*?)<\/p>/) ??
        b.match(/class="res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/) ??
        [])[1] ?? ""
    );
    // 只要真结果：相关搜索/站内跳转是相对路径，翻译等 onebox 卡片没有摘要
    if (!title || !/^https?:\/\//i.test(url)) continue;
    if (!snippet) continue;
    out.push({ title, snippet, url });
  }
  return out;
}

/** 必应国内版兜底：结果块 li.b_algo */
function parseBing(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split(/<li[^>]*class="[^"]*b_algo/).slice(1);
  for (const b of blocks) {
    if (out.length >= limit) break;
    const title = stripTags((b.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) ?? [])[1] ?? "");
    const url = ((b.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/) ?? [])[1] ?? "").trim();
    const snippet = stripTags(
      (b.match(/class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ?? b.match(/<p[^>]*>([\s\S]*?)<\/p>/) ?? [])[1] ?? ""
    );
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, snippet: snippet || "（无摘要）", url });
  }
  return out;
}

/** 依次尝试各搜索源，第一个出结果的就用它 */
async function webSearchTop(query: string, limit: number): Promise<SearchHit[]> {
  const sources: { name: string; url: string; parse: (h: string, n: number) => SearchHit[] }[] = [
    { name: "360", url: `https://www.so.com/s?q=${encodeURIComponent(query)}`, parse: parseSo },
    { name: "bing", url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBing },
  ];
  for (const s of sources) {
    try {
      const hits = s.parse(await fetchHtml(s.url), limit);
      if (hits.length) return hits;
    } catch {
      // 这个源不通就换下一个
    }
  }
  return [];
}

const webSearch: ToolDef = {
  id: "web_search",
  name: "联网搜索",
  description: "搜索互联网并返回前几条结果的标题、摘要和链接（无需 API key）。",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  async run(args) {
    const query = String(args.query ?? "").trim();
    if (!query) return "没有给搜索关键词";
    const hits = await webSearchTop(query, 5);
    if (hits.length === 0) return "没有搜到结果（可以换个说法或换关键词再试）";
    return hits.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join("\n\n");
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

// ---------- 长期记忆（保存关于用户的事实，去重 + 关键词 + 关键记忆；按当前对话用户隔离） ----------
const memorySave: ToolDef = {
  id: "memory_save",
  name: "记住事实（长期记忆）",
  description:
    "把关于用户的重要事实保存到长期记忆（例如：用户住在上海、用户养了一只叫旺财的狗、用户下周三过生日）。只保存值得长期记住的事实，不要保存一次性对话内容。已记住的相同/相似事实不会重复写入。保存到当前对话用户的记忆空间，其他用户看不到。important 可选（true=关键记忆，用户明确说「总是/以后都/永远/记住/我绝对」等长期约定时必须设为 true）；keywords 可选（该事实的触发词，用户之后提到这些词时这条记忆优先被想起，如「咖啡」）。",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "要记住的事实" },
      important: { type: "boolean", description: "是否为关键记忆（长期约定/必须遵守，默认 false）" },
      keywords: { type: "array", items: { type: "string" }, description: "触发关键词（可选）" },
    },
    required: ["fact"],
  },
  async run(args, ctx) {
    const fact = String(args.fact ?? "").trim();
    if (!fact) return "错误：事实为空";
    const { appendEntry } = await import("../core/memoryStore.js");
    const res = await appendEntry(ctx.slug ?? "", {
      fact,
      important: args.important === true,
      keywords: Array.isArray(args.keywords) ? args.keywords.map((k) => String(k)).filter(Boolean) : [],
      src: "tool",
      ns: ctx.ns || "shared",
    });
    if (!res.ok) return res.duplicate ? `这条已经记住了：${fact}` : "错误：事实为空";
    return `已记住${res.entry!.important ? "（关键记忆）" : ""}：${fact}`;
  },
};

// ---------- 生图（NovelAI / OpenAI 兼容 / 本地 SD WebUI） ----------
const imageGen: ToolDef = {
  id: "image_gen",
  name: "生图（AI 绘画）",
  description:
    "根据文字描述生成图片并发送（需先在「生图配置」页配置提供商与 Key）。prompt 的写法取决于当前生效的提供商：若配置的是 NovelAI，prompt 必须用英文 Danbooru 标签风格（逗号分隔、含角色/服饰/动作/场景/光线/画质词，不要用自然语言）；若配置的是 OpenAI 兼容，prompt 用自然语言详细描述画面即可。若不确定当前提供商，默认按 NovelAI 的标签风格写。negative 为负面词（可选），aspect 为比例（square 方图/portrait 竖图/landscape 横图/auto 自动按画面内容选，可选，默认 auto——人物肖像/竖构图选竖图，风景横场景选横图，一般选方图），seed 为随机种子（可选，相同种子可复现）。内容尺度：图片必须得体（SFW），即使对话氛围开放也绝不使用裸体/性相关标签（nude、nsfw、nipples、explicit 等），用完整衣着与含蓄描述表达。",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "绘画提示词" },
      negative: { type: "string", description: "负面提示词（可选）" },
      aspect: { type: "string", description: "square/portrait/landscape/auto（方图/竖图/横图/自动，默认 auto）" },
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
    return `已生成图片：${url}\n提示词：${prompt}`;
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
