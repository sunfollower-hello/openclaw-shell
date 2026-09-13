// 一次性脚本：从 simple-icons CDN 抓厂商 logo 的 SVG path，生成 PROVIDER_BRANDS 映射，
// 注入 web/app.js 的 /* __PROVIDER_BRAND_ICONS__ */ 标记处。跑完可删。
import { promises as fs } from "node:fs";

const ICONS = [
  ["deepseek", "deepseek", "#4D6BFE"],
  ["openai", "openai", "#10A37F"],
  ["anthropic", "anthropic", "#D97757"],
  ["gemini", "googlegemini", "#4285F4"],
  ["openrouter", "openrouter", "#6B6B6B"],
  ["xai", "x", "#111111"],
  ["moonshot", "moonshotai", "#111111"],
  ["qwen", "qwen", "#615CED"],
  ["minimax", "minimax", "#F23F5D"],
  ["ollama", "ollama", "#111111"],
  ["mistral", "mistralai", "#FA520F"],
];

const out = [];
for (const [key, slug, color] of ICONS) {
  const url = `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) { console.error("SKIP", key, res.status); continue; }
  const svg = await res.text();
  const m = svg.match(/<path d="([^"]+)"/);
  if (!m) { console.error("SKIP no path", key); continue; }
  out.push({ key, color, d: m[1] });
  console.error("OK", key, m[1].length, "chars");
}

const lines = out.map((o) => `  ${o.key}: { color: "${o.color}", d: "${o.d}" },`);
const block = `const PROVIDER_BRANDS = {\n${lines.join("\n")}\n};\n`;
await fs.writeFile("data/_brand-block.js", block, "utf8");
console.error("wrote data/_brand-block.js", block.length, "chars");
