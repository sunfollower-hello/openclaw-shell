// 网关工具面裁剪（2026-09-18，P0-① 体检结论落地）。
// 通道人格 bot 是给最终用户用的，不应看到 exec/write/process/cron/gateway/tts 等系统级工具：
// 一是模型一旦调用就多烧一个工具回合（双倍模型调用），二是安全面暴露。
// openclaw.json 顶层 tools.deny（deny 永远赢、支持通配；实测确定生效于 image_generate 等条件工厂
// 工具，其余内建常驻工具以网关版本行为为准——deny 命中即拦，宁可多写）。
// botStore 与 providers 两处 openclaw.json 写入都必须经过 ensureGatewayToolPolicy，保证名单在场。
// 只保留 memory_search / memory_get（记忆召回）。
// ⚠️ web_search 有意不在名单里（2026-09-18 业主拍板恢复）：通道联网搜索走网关内建 web_search，
//    开关节流在卡片高级配置「联网搜索」开关 → compiler 的通道 SKILL 只对开了的卡教这个工具。
//    web_fetch（抓网页正文）继续禁用，业主要时再摘。
export const GATEWAY_TOOL_DENY = [
  "tts", "image_generate", "music_generate", "video_generate", "pdf",
  "exec", "write", "edit", "read", "apply_patch", "process",
  "cron", "gateway", "nodes", "tmux", "subagents",
  "sessions_spawn", "sessions_send", "sessions_yield", "sessions_list", "sessions_history", "session_status",
  "agents_list", "web_fetch", "weather", "message",
  "update_goal", "create_goal", "get_goal", "healthcheck",
  "meme-maker", "diagram-maker", "clawhub", "spike", "skill_workshop", "skill-creator",
  "taskflow", "taskflow-inbox-triage", "notion",
  "python-debugpy", "node-inspect-debugger", "node-connect",
  "qqbot_remind", "qqbot_platform_api", "qqbot-upgrade", "qqbot-remind", "qqbot-channel",
];

/** 合并工具策略：只保证 deny 名单与 skills 空白名单在场，不覆盖其他字段 */
export function ensureGatewayToolPolicy(cfg: Record<string, unknown>): Record<string, unknown> {
  cfg.tools = { ...((cfg.tools as Record<string, unknown>) ?? {}), deny: GATEWAY_TOOL_DENY };
  // skills 一并清空（2026-09-18 实测生效）：clawhub/taskflow/notion/tmux 等 20+ 个技能包
  // 全是提示词注入，对人格 bot 是纯噪音 + 上下文膨胀；空数组 = 显式白名单为空 = 全关。
  const agents = (cfg.agents ??= {}) as Record<string, unknown>;
  const defaults = (agents.defaults ??= {}) as Record<string, unknown>;
  if (!Array.isArray(defaults.skills)) defaults.skills = [];
  return cfg;
}
