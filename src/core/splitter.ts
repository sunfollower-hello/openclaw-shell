// 回复拆条引擎：把 AI 一次生成的长文本拆成多条消息（活人感分段）。
// 规则 v7 定稿（2026-09-07，与预设 prompt、通道插件补丁 scripts/patch-channels.mjs 同口径）：
//   公共：
//     1. 换行必分：任何单个换行即分段（AI 写的一行 = 一条消息），不再只认空行；
//     2. 绝不在逗号/分号/顿号处切；没有合法切分点的超长行整条保留（宁长不切，不切词）；
//     3. 切分点只有中文句号「。」，紧跟在句号后的 ！？… 并入本条（「真好。！」→「真好！」）；
//        !?… 自身不触发切分；英文句点/小数点（URL 扩展名、3.5、ok.）不切分不删除；
//     4. 无总字数限制（prompt 软约束已取消，运行时也不砍内容）。
//   轻对话（chat）：行内按「。」切分，一条消息最多一个完整句子。
//   重描写（rich）：行内本不切（一条可有多个句子多个句号）；仅当单行 > 100 字时，
//     找下一个括号外（（）和 {} 深度 0）的「。」兜底切分。
// 表情包/图片由通道侧独立发送，这里只处理文本条数（媒体条 + 文本条 ≤ max 由调用方/prompt 约定）。

export type SplitStyle = "chat" | "rich";

export interface SplitOptions {
  style: SplitStyle;
  /** 最多条数（1-7，用户每卡配置） */
  max: number;
  /** 最少条数（软期望：内容不足时不硬凑） */
  min?: number;
}

export interface SplitResult {
  parts: string[];
  /** 实际条数 */
  count: number;
  /** 总字数（去空白后） */
  totalChars: number;
  /** 是否发生了条数收敛（片段数 > max 合并过） */
  truncated: boolean;
}

/** 重描写运行时兜底：单行超过该长度且无换行时，找括号外句号切分 */
export const RICH_FALLBACK_AT = 100;

// ---------- URL / 图片路径保护 ----------
// 句号切分会把 URL 里 ".png" 的小数点当句号切开（实锤：/img/xxx.png → "/img/xxx" + " png"，
// 前端渲染不到图片）。拆条前把 URL 换成占位符，切分完再还原。
const URL_PLACEHOLDER = "\u0001IMG\u0001";
const URL_RE = /(\/img\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|gif|webp)|https?:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp))/gi;

function protectUrls(text: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  const out = text.replace(URL_RE, (m) => {
    const idx = urls.length;
    urls.push(m);
    return `${URL_PLACEHOLDER}${idx}${URL_PLACEHOLDER}`;
  });
  return { text: out, urls };
}

function restoreUrls(parts: string[], urls: string[]): string[] {
  if (!urls.length) return parts;
  return parts.map((p) =>
    p.replace(new RegExp(`${URL_PLACEHOLDER}(\\d+)${URL_PLACEHOLDER}`, "g"), (_, n) => urls[Number(n)] ?? "")
  );
}

/** 切分点句号：只认全角「。」——英文句点/小数点（URL 扩展名、3.5 数字）不触发分段 */
const PERIOD_RE = /。/;

/** 句号切点后紧跟的语气标点（并入本条，保持情绪完整：「真好。！」→「真好！」） */
const FOLLOW_RUN_RE = /[！？…]/;

/** 去掉句子末尾的中文句号（真人聊天一般不句号结尾）；英文句点/小数点保留（URL、数字、缩写不误伤）；!?… 保留 */
function stripTrailingPeriod(s: string): string {
  let t = s.trim();
  // 连续删掉末尾的「。」但保留 . ! ? …（半角句点不再删除）
  while (/。$/.test(t)) t = t.slice(0, -1).trim();
  return t;
}

/** 轻对话：一行按句号切分，每条最多一个完整句子；切点句号删除，紧跟的 !?… 并入本条 */
function splitLineByPeriod(line: string): string[] {
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    buf += ch;
    if (PERIOD_RE.test(ch)) {
      // 先删切分点的句号（真人聊天句末不句号），再吞并紧随的 ！？…（「真好。！」→「真好！」）
      const head = stripTrailingPeriod(buf);
      let j = i + 1;
      while (j < line.length && FOLLOW_RUN_RE.test(line[j])) j++;
      const piece = head + line.slice(i + 1, j);
      if (piece) parts.push(piece);
      buf = "";
      i = j - 1;
    }
  }
  const tail = stripTrailingPeriod(buf);
  if (tail) parts.push(tail);
  return parts;
}

/** 从 from 起找第一个括号外（（）和 {} 深度 0）的句号，找不到返回 -1 */
function findPeriodOutsideBrackets(s: string, from: number): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === "（" || ch === "{") depth++;
    else if (ch === "）" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && PERIOD_RE.test(ch)) return i;
  }
  return -1;
}

/**
 * 重描写：行内不按句号切（一条可有多个句子）；单行 > RICH_FALLBACK_AT（100 字）时，
 * 反复切出「下一个括号外句号」之前的内容；切点句号删除、紧跟的 !?… 并入本条；
 * 剩余部分同理；无括号外句号可切则整条保留（宁长不切）。
 */
function splitRichLine(line: string): string[] {
  if (line.length <= RICH_FALLBACK_AT) return line ? [line] : [];
  const parts: string[] = [];
  let start = 0;
  while (line.length - start > RICH_FALLBACK_AT) {
    const idx = findPeriodOutsideBrackets(line, start);
    if (idx < 0) break; // 没有括号外句号，宁长不切
    // 先删切分点句号，再吞并紧随的 ！？…
    const head = stripTrailingPeriod(line.slice(start, idx + 1));
    let end = idx + 1;
    while (end < line.length && FOLLOW_RUN_RE.test(line[end])) end++;
    const piece = head + line.slice(idx + 1, end);
    if (piece) parts.push(piece);
    start = end;
  }
  const tail = stripTrailingPeriod(line.slice(start));
  if (tail) parts.push(tail);
  return parts;
}

/**
 * 拆条主入口。
 * 流程：换行分段（一行 = 一条）→ 风格切分（chat 句号必切 / rich >100 字括号外句号兜底）
 * → 条数收敛（> max 合并最短相邻对）。不做任何字数硬切（宁长不切），无总字数限制。
 */
export function splitReply(text: string, opts: SplitOptions): SplitResult {
  const style = opts.style === "rich" ? "rich" : "chat";
  const max = Math.max(1, Math.min(7, Math.floor(opts.max || 7)));
  const min = Math.max(1, Math.floor(opts.min ?? 1));

  const raw = String(text ?? "").trim();
  if (!raw) return { parts: [], count: 0, totalChars: 0, truncated: false };

  // 0) URL/图片路径保护：句号切分不能切开 ".png" 这类扩展名（切完还原）
  const { text: protectedText, urls } = protectUrls(raw);

  // 1) 换行必分：任何单个换行即分段（AI 写的一行 = 一条消息）
  const lines = protectedText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 2) 风格切分
  let chunks: string[] = [];
  for (const line of lines) {
    chunks.push(...(style === "chat" ? splitLineByPeriod(line) : splitRichLine(line)));
  }
  // 行内切出的片段统一收白边（"ok. fine." → "ok" / "fine"）
  chunks = chunks.map((s) => s.trim()).filter(Boolean);

  let truncated = false;

  // 3) 条数收敛：片段数 > max → 合并最短相邻对（保持句子完整优先：尽量不跨句）。
  //    合并连接不用换行（换行=分段是硬规则，气泡内绝不允许出现换行）：前段以句末标点
  //    /语气词结尾时直接拼接，否则补一个空格。
  const JOIN_SPACE_RE = /[。！？…～~!?…]$/;
  while (chunks.length > max) {
    let bestIdx = 0;
    let bestLen = Infinity;
    for (let i = 0; i < chunks.length - 1; i++) {
      const len = chunks[i].length + chunks[i + 1].length;
      if (len < bestLen) {
        bestLen = len;
        bestIdx = i;
      }
    }
    const a = chunks[bestIdx];
    const b = chunks[bestIdx + 1];
    const merged = (JOIN_SPACE_RE.test(a) ? `${a}${b}` : `${a} ${b}`).trim();
    chunks.splice(bestIdx, 2, merged);
    truncated = true;
  }

  // 4) 不再按字数硬切任何句子——宁可一条长消息，也不在非标点处切断；无总字数限制（soft 由 prompt 管）

  // 5) 还原被保护的 URL/路径
  const parts = restoreUrls(chunks.filter(Boolean), urls);
  const totalChars = parts.reduce((n, c) => n + c.replace(/\s/g, "").length, 0);
  return {
    parts,
    count: parts.length,
    totalChars,
    truncated,
  };
}

/** 供日志/调试用的单条汇总 */
export function describeSplit(r: SplitResult): string {
  return `${r.count} 条 / ${r.totalChars} 字${r.truncated ? "（有截断）" : ""}`;
}