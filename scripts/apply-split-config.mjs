// 一次性：按现有 bots 同步通道拆条配置（openclaw.json 安全值 + 侧车表 split-styles.json 初始化）
// + 检索隔离（每 agent 只搜本卡的 memory-export/history-export，defaults 全局检索池关闭）
// 走的是 dist 里新编译的 applyAgentBlockStreaming / applyAgentSplitStyle / applyAgentMemoryScope，
// 与保存卡时的行为一致；顺带清掉微信账号残留死配置 streaming.preview.chunk（覆盖 streaming 对象时自动删除）。
import { promises as fs } from "node:fs";
import path from "node:path";
import { listBots, applyAgentBlockStreaming, applyAgentSplitStyle, applyAgentMemoryScope } from "../dist/core/botStore.js";

const dataDir = path.join(import.meta.dirname, "..", "data");
const bots = await listBots();
let n = 0;
for (const bot of bots) {
  let style = undefined;
  try {
    const card = JSON.parse(
      await fs.readFile(path.join(dataDir, "cards", bot.cardSlug, "persona.json"), "utf8")
    );
    style = card.presets?.style === "rich" ? "rich" : "chat";
  } catch (e) {
    console.log(`⚠️ 读卡 ${bot.cardSlug} 失败，风格默认 chat: ${String(e)}`);
  }
  await applyAgentBlockStreaming(bot.channel, bot.accountId, { style });
  await applyAgentSplitStyle(bot.agentId, style);
  await applyAgentMemoryScope(bot.agentId, bot.cardSlug);
  console.log(`✅ bot ${bot.agentId} (${bot.channel}/${bot.accountId}) → style=${style ?? "chat"}，检索范围=本卡`);
  n++;
}
console.log(n ? `完成 ${n} 个 bot` : "没有 bot，跳过");