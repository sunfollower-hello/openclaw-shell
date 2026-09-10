// openclaw-shell 通道生图插件（2026-09-08 v13 起为空壳保留）：
// 生图已指令化（<生图:描述> 由通道补丁 v12 出口解析 → 调 dist/core/imageGen.js 出图），
// 与表情 v10 同样的处理：彻底移除 image_gen 工具注册，模型无从调用 → 不存在「工具回合+收尾」
// 两次聊天模型调用，也不会有工具与指令双路径。插件本体保留（openclaw.json 引用不失效）。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "openclaw-shell-imagegen",
  name: "Openclaw Shell Imagegen",
  description:
    "openclaw-shell 通道生图（指令式）：模型输出 <生图:描述> 由 QQ/微信插件补丁解析调独立生图接口出图，配置与网页端共用 data/imageConfig.json",
  register() {
    // 生图/表情均已指令化，通道侧不再注册任何工具（防双路径与两次模型调用）。
  },
});
