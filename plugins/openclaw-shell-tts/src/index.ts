// openclaw-shell 语音插件（v14 空壳化，对齐 openclaw-shell-imagegen v13）
//
// 为什么不再注册 speak 工具：工具调用链路 = 「工具回合 + 收尾」两次聊天模型调用，
// 且模型会复读工具结果。2026-09-09 起语音改为纯文本指令 [语音!:要说的内容]（！与表情 [表情:名] 区分）：
//   QQ  → qqbot 插件补丁 v14 出口解析指令，动态 import 本项目 dist/core/ttsConfig.js（合成）
//         + dist/core/qqVoice.js（silk 直发 QQ 官方语音条），一次聊天调用完成；
//   微信 → 补丁剔除指令（微信插件发不了原生语音条，防漏原文）。
// 收件人解析也不再需要：补丁在投递路径上，直接用 deliverCtx 的 qualifiedTarget/chatScope/replyToId。
// 插件保留空壳：openclaw.json 的 plugins.allow/load 不用改，升级重装补丁时本插件无工具可丢。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "openclaw-shell-tts",
  name: "Openclaw Shell TTS",
  description: "openclaw-shell 语音（v14 指令化空壳）：[语音!:文字] 由通道补丁解析直发，不再注册 speak 工具",
  register() {
    // 故意不注册任何工具：语音走 [语音!:文字] 文本指令（见文件头注释）
  },
});
