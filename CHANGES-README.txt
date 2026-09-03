openclaw-shell 代码改动备份包
==============================
生成时间：2026/9/2 00:14:15
对比基线：git 初始导入提交 6f899c7（GitHub 原始仓库 main 快照）
说明：仅包含相对原始仓库被修改/新增的源码与脚本文件；
  不含 node_modules / dist / data（运行数据）/ .git / 环境配置。
  还原：把本包内文件覆盖到 openclaw-shell 项目根目录即可，
  然后按 REPLICATE.md 复刻环境与配置。

改动文件清单：
  DEPLOY.md
  NEXT-TASK.md
  REPLICATE.md
  package.json
  plugins/openclaw-shell-imagegen/src/index.ts
  scripts/add-firewall-rule.bat
  scripts/autostart.bat
  scripts/open-console.ps1
  scripts/start-stack.ps1
  scripts/stop-stack.ps1
  scripts/toggle-stack.bat
  src/core/compiler.ts
  src/core/conversationStore.ts
  src/core/emojiStore.ts
  src/core/greetedStore.ts
  src/core/lifeScheduler.ts
  src/core/memoryStore.ts
  src/core/presets.ts
  src/core/providers.ts
  src/core/sanitize.ts
  src/core/schema.ts
  src/core/sessionMirror.ts
  src/server.ts
  src/tools/registry.ts
  web/app.js
  web/style.css

详细改动说明见 REPLICATE.md。
