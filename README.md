# openclaw-shell 🦞

OpenClaw 图形化外壳：引导接入 QQ/微信、人设卡编辑、聊天记录蒸馏。

> 状态：M1 基础构建中（人设卡内核 + 本地管理台）

## 技术栈

Node.js 24 + TypeScript + Express + zod。纯本地运行，数据不离开你的电脑。

## 快速开始

```bash
npm install

# 命令行操作卡库
npm run cli -- create --name 奶奶 --role family
npm run cli -- list
npm run cli -- validate 奶奶      # 或 npm run cli -- validate path/to/card.json

# 启动本地管理台（浏览器打开 http://127.0.0.1:17880）
npm run server
```

## 数据目录

卡片存储在 `<项目>/data/cards/<slug>/persona.json`，版本快照在 `versions/`。
可用环境变量 `OPENCLAW_SHELL_DATA` 覆盖存储位置。

## 目录结构

```
src/
├── cli.ts              # CLI 入口
├── server.ts           # 本地管理台（Express + 卡片 API）
├── core/
│   ├── schema.ts       # persona-card v1.0 格式（zod）
│   ├── validator.ts    # 结构 + 业务规则校验
│   └── cardStore.ts    # 卡库存储（文件 + 版本快照）
web/                    # 管理台前端（原生 JS）
data/cards/             # 卡库（gitignored）
```

## 路线图

- [x] M1 人设卡内核：schema + 校验器 + 卡库 + CLI + Web 编辑器
- [x] M2 编译器：persona.json → OpenClaw SOUL.md / skill / memory（CLI `compile` + 管理台"编译到 OpenClaw"按钮）
- [x] M3 蒸馏流水线骨架：WeFlow 导入 → 脱敏 → 四维蒸馏 → 组装卡（CLI `distill`，`--dry-run` 离线试跑；接真实 API 需配 `OPENCLAW_SHELL_API_BASE/KEY/MODEL`）
- [ ] M4 通道接入：openclaw-weixin（微信官方插件）+ napcat（QQ）
- [ ] M5 商业化：API 中转预填 + 计费

## 许可

MIT
