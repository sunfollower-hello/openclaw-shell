#!/usr/bin/env node
// 微信顶掉式归属自测（2026-09-18）：临时 OPENCLAW_SHELL_DATA，不碰真实归属表。
// 覆盖：重扫刷新凭证的账号顶掉旧主 / 新出现账号直接认领 / 快照内且凭证没动的账号不动 /
//       幂等（已归自己跳过）。运行：node scripts/test-wechat-takeover.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocls-wx-"));
const data = path.join(tmp, "data");
fs.mkdirSync(data, { recursive: true });
process.env.OPENCLAW_SHELL_DATA = data;

const DEV_NEW = "aaaaaaaa111122223333444455556666";
const DEV_OLD = "bbbbbbbb111122223333444455556666";
const NOW = Date.now();

const { beginLoginClaim, attributeWeChatLogin, accountOwner, setAccountOwner } = await import("../dist/core/channelOwners.js");

// 快照：扫码起点时已有 oldacc / otheracc / unrelated（newacc 尚不存在）
beginLoginClaim("openclaw-weixin", DEV_NEW, ["oldacc", "otheracc", "unrelated"]);
// 旧主：oldacc / otheracc 都归旧设备（全部走模块 API，别裸写文件——load() 有 2s 缓存会打架）
setAccountOwner("openclaw-weixin", "oldacc", DEV_OLD);
setAccountOwner("openclaw-weixin", "otheracc", DEV_OLD);

const ids = ["oldacc", "newacc", "otheracc", "unrelated"];
const mtime = (id) => (id === "oldacc" || id === "newacc" ? NOW : NOW - 3600 * 1000);

const { attributed, needBotCleanup } = attributeWeChatLogin(DEV_NEW, ids, mtime);

const results = [];
const check = (name, ok) => results.push(`${ok ? "✓" : "✗"} ${name}`);
const got = (id) => attributed.find((a) => a.accountId === id);

check("重扫刷新凭证的 oldacc 被顶掉改判", !!got("oldacc") && got("oldacc").prevOwner === DEV_OLD);
check("新出现的 newacc 直接认领", !!got("newacc") && got("newacc").prevOwner === null);
check("快照内且凭证没动的 otheracc 不动", !got("otheracc") && accountOwner("openclaw-weixin", "otheracc") === DEV_OLD);
check("快照内没动且无主的 unrelated 不动", !got("unrelated") && accountOwner("openclaw-weixin", "unrelated") === null);
check("needBotCleanup 只含有旧主的 oldacc", needBotCleanup.length === 1 && needBotCleanup[0] === "oldacc");
check("归属表已落盘改判", accountOwner("openclaw-weixin", "oldacc") === DEV_NEW);

// 幂等：再跑一遍应零改动
const second = attributeWeChatLogin(DEV_NEW, ids, mtime);
check("幂等：二次调用零改动", second.attributed.length === 0 && second.needBotCleanup.length === 0);

// 无活跃扫码会话时直接空返回（另一台设备没发起扫码）
const third = attributeWeChatLogin("cccccccc111122223333444455556666", ids, mtime);
check("无扫码会话的设备不触发归属", third.attributed.length === 0);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("✗"));
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
