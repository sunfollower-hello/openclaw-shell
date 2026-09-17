#!/usr/bin/env node
// openclaw-shell 通道插件补丁维护脚本（可重放，当前补丁版本 v9）：
//   QQ  (openclaw-qqbot  dist/index.cjs)       —— block 文本块：MEDIA 剥离(保险丝) + [表情:名] 转媒体 + 按卡风格拆条
//   微信 (openclaw-weixin dist/src/messaging/process-message.js) —— deliver：同上 + 60s 内容去重 + disableBlockStreaming:false
// 用途：插件升级/重装后补丁会丢，重跑本脚本一键重打（已打过会跳过；v7/v8 旧补丁自动升级到 v9）。
// 运行：node scripts/patch-channels.mjs          （两个插件）
//       node scripts/patch-channels.mjs --selftest （插件内嵌拆条与本地引擎对拍）
//
// 拆条规则与项目 src/core/splitter.ts 同口径（v7 定稿 2026-09-07）：
//   换行必分 / chat 句号必切(!?…不切，切点句号删除) / rich 行内不切、>100字括号外(（）{})句号兜底
// 风格查侧车表 ~/.openclaw/split-styles.json（agentId → chat|rich，项目保存卡时维护）
//
// v8（含外部增强）：MEDIA: 行只剥离不发图（发图交给核心层 media payload，防双发）+ pending-media.jsonl
//   30s 保险丝兜底；微信另加 60s 内容去重（无 kind 区分防 final 重复投递）。
// v9 新增（爱语式指令模式）：出口解析 [表情:名字] 标签 → 查 ~/.openclaw/media/emojis/<名>.<ext>
//   （emoji_send 工具落盘目录）→ 直接发图。通道侧 SKILL.md 改用 inline 表情文案后，
//   模型一次生成内输出 [表情:名] 即可发表情，不再有「工具回合 + 复读 MEDIA:」的两次聊天模型调用。
//   升级路径为增量插入（保留线上已有的增强代码），全新安装打完整增强基线。

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const QQ_DIST = path.join(
  os.homedir(),
  ".openclaw/npm/projects/tencent-connect-openclaw-qqbot-a7ec020d86__openclaw-generation__tencent-connect-openclaw-qqbot-2.0.3-tencent-conne-bf17e205db/node_modules/@tencent-connect/openclaw-qqbot/dist/index.cjs"
);
const WX_DIST = path.join(
  os.homedir(),
  ".openclaw/npm/projects/tencent-weixin-openclaw-weixin-7783ac86ba/node_modules/@tencent-weixin/openclaw-weixin/dist/src/messaging/process-message.js"
);

// ---------- v9 表情解析（增量插入块，CJS 版；插到 QQ helper 段尾部） ----------
const EMOJI_HELPER_CJS = String.raw`
// [openclaw-shell patch v9] 表情指令解析：一次生成内 [表情:名] 直接发图（爱语式，不走工具/保险丝）
// v9.1：未命中的 [表情:名] 标签一律剔除（模型幻觉不发给用户）；过滤核心层媒体失败警告文本
function __ocsEmojiDir() { return require("path").join(require("os").homedir(), ".openclaw", "media", "emojis"); }
function __ocsFindEmojiFile(name) {
  try {
    var dir = __ocsEmojiDir();
    var safe = String(name).replace(/[\\/:*?"<>|\s]+/g, "_");
    var files = require("fs").readdirSync(dir);
    for (var i = 0; i < files.length; i++) {
      var dot = files[i].lastIndexOf(".");
      var base = dot > 0 ? files[i].slice(0, dot) : files[i];
      if (base === safe) return require("path").join(dir, files[i]);
    }
  } catch (e) { /* 目录不存在/读失败 → 未命中 */ }
  return null;
}
function __ocsExtractEmojiTags(text) {
  var rest = String(text || "");
  // v11：兼容全角方括号【表情:名】（模型常把 [表情:名] 写成全角）
  var re = /\[表情:([^\]]+)\]|【表情:([^】]+)】/g, m, file, paths = [];
  while ((m = re.exec(rest))) {
    file = __ocsFindEmojiFile((m[1] || m[2] || "").trim());
    if (file && paths.length === 0) paths.push(file); // 一次回复最多 1 个表情
  }
  // 无论命中与否都剔除标签：表情名是封闭集合，查不到就是模型幻觉，不该外泄成乱码
  if (rest.includes("[表情:") || rest.includes("【表情:")) rest = rest.replace(/\[表情:[^\]]+\]|【表情:[^】]+】/g, "");
  return { paths: paths, rest: rest.trim() };
}
// 核心层在媒体路径规范化失败时会生成 "⚠️ Media failed." 提示文本并投递（例如模型编造了
// 不存在的 MEDIA: 路径）——这是系统噪音，剥掉不让它出现在用户面前
function __ocsStripMediaWarnings(text) {
  return String(text || "").replace(/^⚠️\s*Media failed\.\s*$/gim, "").trim();
}
// v10：未绑定人设卡的账号禁止聊天（侧车表 split-styles.json 有 agentId 才算已绑定）。
// 背景：共享 workspace(data/workspace) 里有最近编译的人设，裸 main agent 会「意外能演」该人设，
// 但拿不到 USER.md 的配置提醒/侧车风格 → 风格切换不生效、表情库不认识，极难排查。
function __ocsIsBoundAgent(agentId) {
  if (!agentId || agentId === "main" || agentId === "default") return false;
  try {
    var map = (JSON.parse(require("fs").readFileSync(__ocsSplitFile(), "utf8")) || {}).styles || {};
    return Object.prototype.hasOwnProperty.call(map, agentId);
  } catch (e) { return false; }
}
// v9.3：MEDIA 提取只收本地路径（http/https 远程行剔除——远程图床（如 tenor）被墙会下载失败）
function __ocsExtractMediaLocal(text) {
  var r = __ocsExtractMediaDirectives(text);
  var local = [];
  for (var i = 0; i < r.paths.length; i++) {
    if (!/^https?:\/\//i.test(r.paths[i])) local.push(r.paths[i]);
  }
  return { paths: local, rest: r.rest };
}
// [/openclaw-shell patch v9 emoji]`;

// ---------- v9 表情解析（增量插入块，ESM 版；插到微信 helper 段尾部） ----------
const EMOJI_HELPER_ESM = String.raw`
// [openclaw-shell patch v9] 表情指令解析：一次生成内 [表情:名] 直接发图（爱语式，不走工具/保险丝）
// v9.1：未命中的 [表情:名] 标签一律剔除（模型幻觉不发给用户）；过滤核心层媒体失败警告文本
function __ocsWxEmojiDir() { return path.join(os.homedir(), ".openclaw", "media", "emojis"); }
function __ocsWxFindEmojiFile(name) {
  try {
    const dir = __ocsWxEmojiDir();
    const safe = String(name).replace(/[\\/:*?"<>|\s]+/g, "_");
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const dot = f.lastIndexOf(".");
      const base = dot > 0 ? f.slice(0, dot) : f;
      if (base === safe) return path.join(dir, f);
    }
  } catch (e) { /* 目录不存在/读失败 → 未命中 */ }
  return null;
}
function __ocsWxExtractEmojiTags(text) {
  let rest = String(text || "");
  // v11：兼容全角方括号【表情:名】（模型常把 [表情:名] 写成全角）
  const re = /\[表情:([^\]]+)\]|【表情:([^】]+)】/g;
  let m, file;
  const paths = [];
  while ((m = re.exec(rest))) {
    file = __ocsWxFindEmojiFile((m[1] || m[2] || "").trim());
    if (file && paths.length === 0) paths.push(file); // 一次回复最多 1 个表情
  }
  // 无论命中与否都剔除标签：表情名是封闭集合，查不到就是模型幻觉，不该外泄成乱码
  if (rest.includes("[表情:") || rest.includes("【表情:")) rest = rest.replace(/\[表情:[^\]]+\]|【表情:[^】]+】/g, "");
  return { paths, rest: rest.trim() };
}
// 核心层在媒体路径规范化失败时会生成 "⚠️ Media failed." 提示文本并投递（例如模型编造了
// 不存在的 MEDIA: 路径）——这是系统噪音，剥掉不让它出现在用户面前
function __ocsWxStripMediaWarnings(text) {
  return String(text || "").replace(/^⚠️\s*Media failed\.\s*$/gim, "").trim();
}
// v10：未绑定人设卡的账号禁止聊天（侧车表 split-styles.json 有 agentId 才算已绑定）。
// 背景：共享 workspace(data/workspace) 里有最近编译的人设，裸 main agent 会「意外能演」该人设，
// 但拿不到 USER.md 的配置提醒/侧车风格 → 风格切换不生效、表情库不认识，极难排查。
function __ocsWxIsBoundAgent(agentId) {
  if (!agentId || agentId === "main" || agentId === "default") return false;
  try {
    const map = ((JSON.parse(fs.readFileSync(__ocsWxSplitFile(), "utf8")) || {}).styles) || {};
    return Object.prototype.hasOwnProperty.call(map, agentId);
  } catch (e) { return false; }
}
// v9.3：MEDIA 提取只收本地路径（http/https 远程行剔除——远程图床（如 tenor）被墙会下载失败）
function __ocsWxExtractMediaLocal(text) {
  const r = __ocsWxExtractMediaDirectives(text);
  const local = [];
  for (const p of r.paths) {
    if (!/^https?:\/\//i.test(p)) local.push(p);
  }
  return { paths: local, rest: r.rest };
}
// [/openclaw-shell patch v9 emoji]`;

// ---------- QQ 分支的 v9 表情插入（升级用：替换拆条锚点行） ----------
const QQ_PIECES_ANCHOR = `                        const pieces = __ocsSplitHumanLike(ocsMedia.rest, __ocsSplitStyle(deliverCtx.agentId));`;
const QQ_PIECES_V9 = `                        // [openclaw-shell patch v9] [表情:名] 指令直接发图（核心层不会为指令投递媒体，无双发风险）
                        const ocsEmoji = __ocsExtractEmojiTags(ocsMedia.rest);
                        if (ocsEmoji.paths.length) {
                          await forwardMediaUrls({ mediaUrls: ocsEmoji.paths }, deliverCtx, deliveredMediaUrls, dlog);
                        }
                        const pieces = __ocsSplitHumanLike(ocsEmoji.rest, __ocsSplitStyle(deliverCtx.agentId));`;

// v9.1：MEDIA 提取前剥离核心层媒体失败警告，纯警告块直接不发（v9 分支已打时替换这一行）
// 注意：QQ 分支里 text 是 const，不能重新赋值 → 用新变量 ocsT
const QQ_MEDIA_LINE_ANCHOR = `                        const ocsMedia = __ocsExtractMediaDirectives(text);`;
const QQ_MEDIA_LOCAL_ANCHOR = `                        const ocsMedia = __ocsExtractMediaLocal(ocsT);`;
const QQ_MEDIA_LINE_V91 = `                        // [openclaw-shell patch v9.1] 过滤核心层媒体失败警告（模型编造 MEDIA 路径时核心层会生成 ⚠️ Media failed.）
                        const ocsT = __ocsStripMediaWarnings(text);
                        if (!ocsT.trim()) { return; } // 纯警告块不发
                        const ocsMedia = __ocsExtractMediaLocal(ocsT);`;
// v9.2 修复：v9.1 曾对 const text 重新赋值导致 QQ 全部回复 TypeError（发不出）
const QQ_MEDIA_LINE_V91_BROKEN = `                        // [openclaw-shell patch v9.1] 过滤核心层媒体失败警告（模型编造 MEDIA 路径时核心层会生成 ⚠️ Media failed.）
                        text = __ocsStripMediaWarnings(text);
                        if (!text.trim()) { return; } // 纯警告块不发
                        const ocsMedia = __ocsExtractMediaDirectives(text);`;

// ---------- 微信分支的 v9 表情插入（升级用：替换拆条锚点行） ----------
const WX_PIECES_ANCHOR = `                    const pieces = __ocsWxSplitHumanLike(ocsMedia.rest, __ocsWxSplitStyle(route.agentId));`;
const WX_PIECES_V9 = `                    // [openclaw-shell patch v9] [表情:名] 指令直接发图（核心层不会为指令投递媒体，无双发风险）
                    const ocsEmoji = __ocsWxExtractEmojiTags(ocsMedia.rest);
                    for (const ocsEmojiPath of ocsEmoji.paths) {
                        await sendWeixinMediaFile({
                            filePath: ocsEmojiPath,
                            to: ctx.To,
                            text: "",
                            opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
                            cdnBaseUrl: deps.cdnBaseUrl,
                        });
                        emitWeixinMessageSent({ to: ctx.To, content: "", success: true, accountId: deps.accountId, runId });
                    }
                    const pieces = __ocsWxSplitHumanLike(ocsEmoji.rest, __ocsWxSplitStyle(route.agentId));`;

// v9.1：MEDIA 提取前剥离核心层媒体失败警告，纯警告块直接不发
// 微信分支里 text 是 let，但统一用新变量 ocsT 更稳（防将来变 const）
const WX_MEDIA_LINE_ANCHOR = `                    const ocsMedia = __ocsWxExtractMediaDirectives(text);`;
const WX_MEDIA_LOCAL_ANCHOR = `                    const ocsMedia = __ocsWxExtractMediaLocal(ocsT);`;

// v10：QQ 入站守卫 —— 未绑定人设卡的账号直接拒接 + 详细身份日志
const QQ_GUARD_ANCHOR = '  const agentId = route.agentId ?? "default";';
const QQ_GUARD_V10 = QQ_GUARD_ANCHOR + "\n" +
  '  // [openclaw-shell patch v10] 详细身份日志 + 未绑定卡拒接\n' +
  '  log4?.info(`[openclaw-shell] IDENTITY account=${account.accountId} agent=${agentId} bound=${__ocsIsBoundAgent(agentId)}`);\n' +
  '  if (!__ocsIsBoundAgent(agentId)) {\n' +
  '    log4?.warn(`[openclaw-shell] BLOCKED account=${account.accountId} 未绑定人设卡（agent=${agentId}），消息不处理`);\n' +
  '    return;\n' +
  '  }';

// v10：微信入站守卫 —— 未绑定人设卡的账号直接拒接 + 详细身份日志（谁在跟谁聊、路由到哪个 agent）
// 锚点是 route.agentId 那行 debug 日志（上游稳定存在）；用字符串拼接避免模板嵌套转义问题
const WX_GUARD_ANCHOR = '    logger.debug(`resolveAgentRoute: agentId=${route.agentId ?? "(none)"} sessionKey=${route.sessionKey ?? "(none)"} mainSessionKey=${route.mainSessionKey ?? "(none)"}`);';
const WX_GUARD_V10 = WX_GUARD_ANCHOR + "\n" +
  '    // [openclaw-shell patch v10] 详细身份日志 + 未绑定卡拒接\n' +
  '    logger.info(`[openclaw-shell] IDENTITY account=${deps.accountId} peer=${ctx.To} agent=${route.agentId ?? "(none)"} bound=${__ocsWxIsBoundAgent(route.agentId)}`);\n' +
  '    if (!__ocsWxIsBoundAgent(route.agentId)) {\n' +
  '      logger.warn(`[openclaw-shell] BLOCKED account=${deps.accountId} 未绑定人设卡（agent=${route.agentId ?? "none"}），消息不处理`);\n' +
  '      return;\n' +
  '    }';
const WX_MEDIA_LINE_V91 = `                    // [openclaw-shell patch v9.1] 过滤核心层媒体失败警告（模型编造 MEDIA 路径时核心层会生成 ⚠️ Media failed.）
                    const ocsT = __ocsWxStripMediaWarnings(text);
                    if (!ocsT.trim()) { return; } // 纯警告块不发
                    const ocsMedia = __ocsWxExtractMediaLocal(ocsT);`;
// v9.2 修复：v9.1 曾对 const text 重新赋值导致 QQ 全部回复 TypeError（发不出）——微信是 let 不崩，但统一修
const WX_MEDIA_LINE_V91_BROKEN = `                    // [openclaw-shell patch v9.1] 过滤核心层媒体失败警告（模型编造 MEDIA 路径时核心层会生成 ⚠️ Media failed.）
                    text = __ocsWxStripMediaWarnings(text);
                    if (!text.trim()) { return; } // 纯警告块不发
                    const ocsMedia = __ocsWxExtractMediaDirectives(text);`;

// ---------- v12 生图指令（增量插入块，CJS 版；插到 QQ helper 段尾部） ----------
const GEN_HELPER_CJS = String.raw`
// [openclaw-shell patch v12] 生图指令解析：一次生成内 <生图:描述> 直接出图
// （爱语同源但自定格式：尖括号+中文前缀，与表情 [表情:名] 一尖一方不混淆；生图走独立接口，
//   不是聊天模型 → 发表情/发图都只消耗一次聊天模型调用）
function __ocsExtractGenerateImage(text) {
  var rest = String(text || "");
  // v12：兼容全角尖括号＜生图:…＞；一次回复最多 1 张
  var re = /<生图:([^<>]+)>|＜生图:([^＜＞]+)＞/g, m, prompt = "";
  while ((m = re.exec(rest))) {
    var p = (m[1] || m[2] || "").trim();
    if (!prompt && p) prompt = p;
  }
  if (prompt) rest = rest.replace(/<生图:[^<>]+>|＜生图:[^＜＞]+＞/g, "");
  return { prompt: prompt, rest: rest.trim() };
}
function __ocsShellRoot() {
  var candidates = [];
  if (process.env.OPENCLAW_SHELL_ROOT) candidates.push(process.env.OPENCLAW_SHELL_ROOT);
  candidates.push(require("path").join(require("os").homedir(), "ai_workspace", "openclaw-shell"));
  candidates.push("D:/ai_workspace/openclaw-shell");
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (require("fs").existsSync(require("path").join(candidates[i], "dist", "core", "imageGen.js"))) return candidates[i];
    } catch (e) { /* 继续探测 */ }
  }
  return null;
}
function __ocsGenerateImage(prompt) {
  var root = __ocsShellRoot();
  if (!root) return Promise.resolve({ ok: false, error: "openclaw-shell 根目录未找到" });
  var entry = "file:///" + require("path").join(root, "dist", "core", "imageGen.js").replace(/\\/g, "/");
  return import(entry).then(function (m) {
    return m.generateImage({ prompt: prompt, aspect: "auto" }, require("path").join(require("os").homedir(), ".openclaw", "media"));
  }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
}
// [/openclaw-shell patch v12 gen]`;

// ---------- v13 群聊（QQ 专属；群聊与单聊/网页彻底隔离，不做记忆总结） ----------
// 入站：群消息前先向管理台要「该成员的历史检索上下文（最近 6 轮 + 关键词命中轮次）」并拼到正文前
// 出站：把「成员名 + 提问 + 机器人回复」一一对应存档（data/groupchat/<slug>/<gid>.jsonl）
// 进群：rawEvent GROUP_ADD_ROBOT → 只登记群（按用户要求不发开场白）
const GROUP_HELPER_CJS = String.raw`
// [openclaw-shell patch v13] 群聊：按人检索注入 + 一一对应存档（不总结、不进网页单聊）
var __ocsShellPort = process.env.OPENCLAW_SHELL_PORT || "17880";
function __ocsShellPost(pathname, body, timeoutMs) {
  var payload = JSON.stringify(body || {});
  return new Promise(function (resolve) {
    var done = false;
    var finish = function (v) { if (!done) { done = true; resolve(v); } };
    try {
      var req = require("http").request(
        {
          host: "127.0.0.1",
          port: Number(__ocsShellPort),
          path: pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
        function (res) {
          var buf = "";
          res.on("data", function (d) { buf += d; });
          res.on("end", function () {
            try { finish(JSON.parse(buf)); } catch (e) { finish(null); }
          });
        }
      );
      req.on("error", function () { finish(null); });
      req.setTimeout(timeoutMs || 4000, function () { try { req.destroy(); } catch (e) {} finish(null); });
      req.write(payload);
      req.end();
    } catch (e) { finish(null); }
  });
}
function __ocsGroupRecall(params) { return __ocsShellPost("/api/internal/groupchat/recall", params, 5000); }
function __ocsGroupSaveTurn(params) { return __ocsShellPost("/api/internal/groupchat/turn", params, 5000); }
function __ocsGroupJoin(params) { return __ocsShellPost("/api/internal/groupchat/join", params, 5000); }
// [/openclaw-shell patch v13 group]`;

// ---------- v12 生图指令（增量插入块，ESM 版；插到微信 helper 段尾部） ----------
const GEN_HELPER_ESM = String.raw`
// [openclaw-shell patch v12] 生图指令解析：一次生成内 <生图:描述> 直接出图
// （爱语同源但自定格式：尖括号+中文前缀，与表情 [表情:名] 一尖一方不混淆；生图走独立接口，
//   不是聊天模型 → 发表情/发图都只消耗一次聊天模型调用）
function __ocsWxExtractGenerateImage(text) {
  let rest = String(text || "");
  // v12：兼容全角尖括号＜生图:…＞；一次回复最多 1 张
  const re = /<生图:([^<>]+)>|＜生图:([^＜＞]+)＞/g;
  let m;
  let prompt = "";
  while ((m = re.exec(rest))) {
    const p = (m[1] || m[2] || "").trim();
    if (!prompt && p) prompt = p;
  }
  if (prompt) rest = rest.replace(/<生图:[^<>]+>|＜生图:[^＜＞]+＞/g, "");
  return { prompt, rest: rest.trim() };
}
function __ocsWxShellRoot() {
  const candidates = [];
  if (process.env.OPENCLAW_SHELL_ROOT) candidates.push(process.env.OPENCLAW_SHELL_ROOT);
  candidates.push(path.join(os.homedir(), "ai_workspace", "openclaw-shell"));
  candidates.push("D:/ai_workspace/openclaw-shell");
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "dist", "core", "imageGen.js"))) return c;
    } catch (e) { /* 继续探测 */ }
  }
  return null;
}
function __ocsWxGenerateImage(prompt) {
  const root = __ocsWxShellRoot();
  if (!root) return Promise.resolve({ ok: false, error: "openclaw-shell 根目录未找到" });
  const entry = "file:///" + path.join(root, "dist", "core", "imageGen.js").replace(/\\/g, "/");
  return import(entry).then((m) =>
    m.generateImage({ prompt, aspect: "auto" }, path.join(os.homedir(), ".openclaw", "media"))
  ).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}
// [/openclaw-shell patch v12 gen]`;

// ---------- v12 生图：QQ 分支两处插入（pieces 行替换 + 循环尾后执行块） ----------
// 注意：替换 pieces 行时必须整段带上 ocsEmoji 声明 + 表情发图段（v12 曾只留 ocsGen 行，
// 把 ocsEmoji 声明吞掉 → 运行时 ReferenceError: ocsEmoji is not defined，消息全挂）
const QQ_GEN_PIECES_V12 = `                        // [openclaw-shell patch v9] [表情:名] 指令直接发图（核心层不会为指令投递媒体，无双发风险）
                        const ocsEmoji = __ocsExtractEmojiTags(ocsMedia.rest);
                        if (ocsEmoji.paths.length) {
                          await forwardMediaUrls({ mediaUrls: ocsEmoji.paths }, deliverCtx, deliveredMediaUrls, dlog);
                        }
                        // [openclaw-shell patch v12] <生图:描述> 指令：从正文提取并剔除，文本按原风格拆条
                        const ocsGen = __ocsExtractGenerateImage(ocsEmoji.rest);
                        const pieces = __ocsSplitHumanLike(ocsGen.rest, __ocsSplitStyle(deliverCtx.agentId));`;
const QQ_GEN_AFTER_V12 = `                          if (ocsI < pieces.length - 1) await __ocsSleep(250 + Math.random() * 500);
                        }
                        // [openclaw-shell patch v12] 生图执行：文本先发，再异步出图；失败只发「生图失败」（不丢提示词）
                        if (ocsGen.prompt) {
                          const ocsGenRes = await __ocsGenerateImage(ocsGen.prompt);
                          if (ocsGenRes && ocsGenRes.ok && ocsGenRes.file) {
                            await forwardMediaUrls({ mediaUrls: [ocsGenRes.file] }, deliverCtx, deliveredMediaUrls, dlog);
                          } else {
                            await deliverReply({ ...payload, text: "生图失败" }, info, deliverCtx);
                          }
                        }
                      } else {`;

// ---------- v12 生图：微信分支两处插入 ----------
// 同 QQ：pieces 替换必须整段带 ocsEmoji 声明 + 表情发图段（缺了会 ReferenceError）
const WX_GEN_PIECES_V12 = `                    // [openclaw-shell patch v9] [表情:名] 指令直接发图（核心层不会为指令投递媒体，无双发风险）
                    const ocsEmoji = __ocsWxExtractEmojiTags(ocsMedia.rest);
                    for (const ocsEmojiPath of ocsEmoji.paths) {
                        await sendWeixinMediaFile({
                            filePath: ocsEmojiPath,
                            to: ctx.To,
                            text: "",
                            opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
                            cdnBaseUrl: deps.cdnBaseUrl,
                        });
                        emitWeixinMessageSent({ to: ctx.To, content: "", success: true, accountId: deps.accountId, runId });
                    }
                    // [openclaw-shell patch v12] <生图:描述> 指令：从正文提取并剔除，文本按原风格拆条
                    const ocsGen = __ocsWxExtractGenerateImage(ocsEmoji.rest);
                    const pieces = __ocsWxSplitHumanLike(ocsGen.rest, __ocsWxSplitStyle(route.agentId));`;
const WX_GEN_AFTER_V12 = `                    logger.info(\`outbound: text sent OK to=\${ctx.To} pieces=\${pieces.length} media=\${ocsMedia.paths.length + ocsEmoji.paths.length}\`);
                    // [openclaw-shell patch v12] 生图执行：文本先发，再异步出图；失败只发「生图失败」（不丢提示词）
                    if (ocsGen.prompt) {
                        try {
                            const ocsGenRes = await __ocsWxGenerateImage(ocsGen.prompt);
                            if (ocsGenRes && ocsGenRes.ok && ocsGenRes.file) {
                                await sendWeixinMediaFile({
                                    filePath: ocsGenRes.file,
                                    to: ctx.To,
                                    text: "",
                                    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
                                    cdnBaseUrl: deps.cdnBaseUrl,
                                });
                                emitWeixinMessageSent({ to: ctx.To, content: "", success: true, accountId: deps.accountId, runId });
                            } else {
                                await sendMessageWeixin({ to: ctx.To, text: "生图失败", opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId } });
                                emitWeixinMessageSent({ to: ctx.To, content: "生图失败", success: true, accountId: deps.accountId, runId });
                            }
                        } catch (e) {
                            logger.warn(\`outbound: imagegen failed to=\${ctx.To} err=\${String(e)}\`);
                        }
                    }
                }`;

// ---------- v14：出口剥离「生图自检（CoT）」 ----------
// 生图 CoT 让模型在正文前输出 <cot>…</cot> 的本轮自检；那是给它自己看的内部推理，
// **绝不能发给用户**。两个抽取函数（QQ/WX）是所有出口的第一站，剥离挂在那里一处生效。
// 成对先剥，再兜底剥未闭合的：模型漏写 </cot> 时按"从这里到文末全剥"，否则整条消息都变成思维链。
const COT_STRIP_HELPER = String.raw`/* [openclaw-shell patch v14] 出口剥离生图自检（CoT）：内部推理不发给用户 */
function __ocsStripCot(text) {
  var s = String(text || "");
  s = s.replace(/<cot>[\s\S]*?<\/cot>\s*/gi, "");
  s = s.replace(/<cot_protocol>[\s\S]*?<\/cot_protocol>\s*/gi, "");
  s = s.replace(/<cot>[\s\S]*$/i, "");
  s = s.replace(/<cot_protocol>[\s\S]*$/i, "");
  return s;
}`;

// ---------- 全新安装的完整基线：QQ helper（v8 增强 + v9 表情） ----------
const QQ_HELPER_FULL = String.raw`
// ==== [openclaw-shell patch v9] 活人感拆条 + MEDIA/[表情] 转媒体：发送前拦截 ====
// 与项目 src/core/splitter.ts 同口径：换行必分 / chat 句号必切(!?…不切) / rich >100字括号外句号兜底
// 风格查侧车表 ~/.openclaw/split-styles.json（agentId → chat|rich，项目保存卡时维护）
var __ocsSplitCache = { mtimeMs: -1, map: {} };
function __ocsSplitFile() { return require("path").join(require("os").homedir(), ".openclaw", "split-styles.json"); }
function __ocsSplitStyle(agentId) {
  try {
    var st = require("fs").statSync(__ocsSplitFile());
    if (st.mtimeMs !== __ocsSplitCache.mtimeMs) {
      __ocsSplitCache = { mtimeMs: st.mtimeMs, map: (JSON.parse(require("fs").readFileSync(__ocsSplitFile(), "utf8")) || {}).styles || {} };
    }
  } catch (e) { /* 表不存在/读失败 → 默认 chat */ }
  return __ocsSplitCache.map[agentId] === "rich" ? "rich" : "chat";
}
function __ocsStripPeriod(s) {
  var t = String(s).trim();
  while (/。$/.test(t)) t = t.slice(0, -1).trim();
  return t;
}
function __ocsSplitLineByPeriod(line) {
  var parts = [], buf = "", i, ch, j, head, piece;
  for (i = 0; i < line.length; i++) {
    ch = line[i];
    buf += ch;
    if (/。/.test(ch)) {
      head = __ocsStripPeriod(buf);
      j = i + 1;
      while (j < line.length && /[！？…]/.test(line[j])) j++;
      piece = head + line.slice(i + 1, j);
      if (piece) parts.push(piece);
      buf = "";
      i = j - 1;
    }
  }
  var tail = __ocsStripPeriod(buf);
  if (tail) parts.push(tail);
  return parts;
}
function __ocsFindPeriodOutsideBrackets(s, from) {
  var depth = 0, ch, i;
  for (i = from; i < s.length; i++) {
    ch = s[i];
    if (ch === "（" || ch === "{") depth++;
    else if (ch === "）" || ch === "}") depth = depth > 0 ? depth - 1 : 0;
    else if (depth === 0 && /。/.test(ch)) return i;
  }
  return -1;
}
function __ocsSplitRich(line) {
  if (line.length <= 100) return line ? [line] : [];
  var parts = [], start = 0, idx, end, head, piece;
  while (line.length - start > 100) {
    idx = __ocsFindPeriodOutsideBrackets(line, start);
    if (idx < 0) break;
    head = __ocsStripPeriod(line.slice(start, idx + 1));
    end = idx + 1;
    while (end < line.length && /[！？…]/.test(line[end])) end++;
    piece = head + line.slice(idx + 1, end);
    if (piece) parts.push(piece);
    start = end;
  }
  var tail = __ocsStripPeriod(line.slice(start));
  if (tail) parts.push(tail);
  return parts;
}
function __ocsSplitHumanLike(text, style) {
  var lines = String(text || "").split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  var parts = [];
  for (var i = 0; i < lines.length; i++) {
    if (style === "rich") parts.push.apply(parts, __ocsSplitRich(lines[i]));
    else parts.push.apply(parts, __ocsSplitLineByPeriod(lines[i]));
  }
  parts = parts.filter(Boolean);
  return parts.length ? parts : (String(text || "").trim() ? [String(text || "").trim()] : []);
}
// 提取文本里的 MEDIA: 指令行（模型可能复读工具返回的 MEDIA: 路径，且可能在同一行后粘别的文字；
// block 管线不解析 MEDIA:，这里按扩展名截断提取路径，剩余文字保留继续发送）
const __ocsMediaPathRe = /^\s*MEDIA:\s*(?:\`([^\`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv))\`|([^\s\`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv)))/i;
${COT_STRIP_HELPER}
function __ocsExtractMediaDirectives(text) {
  text = __ocsStripCot(text);
  var rawLines = String(text || "").split("\n"), paths = [], kept = [], i, m, line;
  for (i = 0; i < rawLines.length; i++) {
    line = rawLines[i];
    m = line.match(__ocsMediaPathRe);
    if (m) {
      paths.push((m[1] || m[2]).trim());
      kept.push(line.slice(m[0].length));
    } else {
      kept.push(line);
    }
  }
  return { paths: paths, rest: kept.join("\n").trim() };
}
var __ocsSleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
// 待发媒体队列：核心层会把工具结果媒体投递为 media payload（QQ forwardMediaUrls / 微信 sendWeixinMediaFile），
// 补丁不再从 MEDIA 行发图（防双发）；队列只作保险丝：媒体 payload 到达时删同路径，
// 文本侧只兜底消费超过 minAge(ms) 仍未被核心层投递的条目。
function __ocsPendingFile() { return require("path").join(require("os").homedir(), ".openclaw", "pending-media.jsonl"); }
function __ocsConsumeStalePendingMedia(minAge) {
  var out = [], fresh = [];
  try {
    var now = Date.now();
    var lines = require("fs").readFileSync(__ocsPendingFile(), "utf8").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      try {
        var o = JSON.parse(l);
        if (o && o.path) {
          if (now - (o.ts || 0) >= (minAge || 30000)) out.push(o.path);
          else fresh.push(l);
        }
      } catch (e) { /* 坏行丢弃 */ }
    }
    require("fs").writeFileSync(__ocsPendingFile(), fresh.join("\n") + (fresh.length ? "\n" : ""));
  } catch (e) { /* 队列文件不存在/读失败 */ }
  return out;
}
function __ocsDropPendingMedia(paths) {
  if (!paths || !paths.length) return;
  try {
    var lines = require("fs").readFileSync(__ocsPendingFile(), "utf8").split("\n");
    var kept = lines.filter(function (l) {
      try { var o = JSON.parse(l); return !paths.includes(o.path); } catch (e) { return false; }
    });
    require("fs").writeFileSync(__ocsPendingFile(), kept.join("\n") + (kept.length ? "\n" : ""));
  } catch (e) { /* 无队列文件 */ }
}
// [openclaw-shell patch v9] 表情指令解析：一次生成内 [表情:名] 直接发图（爱语式，不走工具/保险丝）
function __ocsEmojiDir() { return require("path").join(require("os").homedir(), ".openclaw", "media", "emojis"); }
function __ocsFindEmojiFile(name) {
  try {
    var dir = __ocsEmojiDir();
    var safe = String(name).replace(/[\\/:*?"<>|\s]+/g, "_");
    var files = require("fs").readdirSync(dir);
    for (var i = 0; i < files.length; i++) {
      var dot = files[i].lastIndexOf(".");
      var base = dot > 0 ? files[i].slice(0, dot) : files[i];
      if (base === safe) return require("path").join(dir, files[i]);
    }
  } catch (e) { /* 目录不存在/读失败 → 未命中 */ }
  return null;
}
function __ocsExtractEmojiTags(text) {
  var rest = String(text || "");
  var re = /\[表情:([^\]]+)\]/g, m, file, paths = [];
  while ((m = re.exec(rest))) {
    file = __ocsFindEmojiFile(m[1].trim());
    if (file) paths.push(file);
  }
  if (paths.length) rest = rest.replace(/\[表情:[^\]]+\]/g, "");
  return { paths: paths, rest: rest.trim() };
}
// [openclaw-shell patch v12] 生图指令解析：一次生成内 <生图:描述> 直接出图（独立生图接口，无第二次聊天模型调用）
function __ocsExtractGenerateImage(text) {
  var rest = String(text || "");
  var re = /<生图:([^<>]+)>|＜生图:([^＜＞]+)＞/g, m, prompt = "";
  while ((m = re.exec(rest))) {
    var p = (m[1] || m[2] || "").trim();
    if (!prompt && p) prompt = p;
  }
  if (prompt) rest = rest.replace(/<生图:[^<>]+>|＜生图:[^＜＞]+＞/g, "");
  return { prompt: prompt, rest: rest.trim() };
}
function __ocsShellRoot() {
  var candidates = [];
  if (process.env.OPENCLAW_SHELL_ROOT) candidates.push(process.env.OPENCLAW_SHELL_ROOT);
  candidates.push(require("path").join(require("os").homedir(), "ai_workspace", "openclaw-shell"));
  candidates.push("D:/ai_workspace/openclaw-shell");
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (require("fs").existsSync(require("path").join(candidates[i], "dist", "core", "imageGen.js"))) return candidates[i];
    } catch (e) { /* 继续探测 */ }
  }
  return null;
}
function __ocsGenerateImage(prompt) {
  var root = __ocsShellRoot();
  if (!root) return Promise.resolve({ ok: false, error: "openclaw-shell 根目录未找到" });
  var entry = "file:///" + require("path").join(root, "dist", "core", "imageGen.js").replace(/\\/g, "/");
  return import(entry).then(function (m) {
    return m.generateImage({ prompt: prompt, aspect: "auto" }, require("path").join(require("os").homedir(), ".openclaw", "media"));
  }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
}
// ==== [/openclaw-shell patch v9] ====`;

// ---------- 全新安装的完整基线：微信 helper（v8 增强 + v9 表情） ----------
const WX_HELPER_FULL = String.raw`
// ==== [openclaw-shell patch v9] 活人感拆条 + MEDIA/[表情] 转媒体：发送前拦截 ====
// 与项目 src/core/splitter.ts 同口径：换行必分 / chat 句号必切(!?…不切) / rich >100字括号外句号兜底
// 风格查侧车表 ~/.openclaw/split-styles.json（agentId → chat|rich，项目保存卡时维护）
const __ocsWxSplitFile = () => path.join(os.homedir(), ".openclaw", "split-styles.json");
let __ocsWxSplitCache = { mtimeMs: -1, map: {} };
function __ocsWxSplitStyle(agentId) {
  try {
    const st = fs.statSync(__ocsWxSplitFile());
    if (st.mtimeMs !== __ocsWxSplitCache.mtimeMs) {
      __ocsWxSplitCache = { mtimeMs: st.mtimeMs, map: ((JSON.parse(fs.readFileSync(__ocsWxSplitFile(), "utf8")) || {}).styles) || {} };
    }
  } catch (e) { /* 表不存在/读失败 → 默认 chat */ }
  return __ocsWxSplitCache.map[agentId] === "rich" ? "rich" : "chat";
}
function __ocsWxStripPeriod(s) {
  let t = String(s).trim();
  while (/。$/.test(t)) t = t.slice(0, -1).trim();
  return t;
}
function __ocsWxSplitLineByPeriod(line) {
  const parts = [];
  let buf = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    buf += ch;
    if (/。/.test(ch)) {
      const head = __ocsWxStripPeriod(buf);
      let j = i + 1;
      while (j < line.length && /[！？…]/.test(line[j])) j++;
      const piece = head + line.slice(i + 1, j);
      if (piece) parts.push(piece);
      buf = "";
      i = j - 1;
    }
  }
  const tail = __ocsWxStripPeriod(buf);
  if (tail) parts.push(tail);
  return parts;
}
function __ocsWxFindPeriodOutsideBrackets(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === "（" || ch === "{") depth++;
    else if (ch === "）" || ch === "}") depth = depth > 0 ? depth - 1 : 0;
    else if (depth === 0 && /。/.test(ch)) return i;
  }
  return -1;
}
function __ocsWxSplitRich(line) {
  if (line.length <= 100) return line ? [line] : [];
  const parts = [];
  let start = 0;
  while (line.length - start > 100) {
    const idx = __ocsWxFindPeriodOutsideBrackets(line, start);
    if (idx < 0) break;
    const head = __ocsWxStripPeriod(line.slice(start, idx + 1));
    let end = idx + 1;
    while (end < line.length && /[！？…]/.test(line[end])) end++;
    const piece = head + line.slice(idx + 1, end);
    if (piece) parts.push(piece);
    start = end;
  }
  const tail = __ocsWxStripPeriod(line.slice(start));
  if (tail) parts.push(tail);
  return parts;
}
function __ocsWxSplitHumanLike(text, style) {
  const lines = String(text || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const parts = [];
  for (const line of lines) {
    if (style === "rich") parts.push(...__ocsWxSplitRich(line));
    else parts.push(...__ocsWxSplitLineByPeriod(line));
  }
  return parts.length ? parts.filter(Boolean) : (String(text || "").trim() ? [String(text || "").trim()] : []);
}
// 提取文本里的 MEDIA: 指令行（模型可能复读工具返回的 MEDIA: 路径，且可能在同一行后粘别的文字；
// block 管线不解析 MEDIA:，这里按扩展名截断提取路径，剩余文字保留继续发送）
const __ocsWxMediaPathRe = /^\s*MEDIA:\s*(?:\`([^\`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv))\`|([^\s\`]+?\.(?:png|jpe?g|gif|webp|bmp|silk|mp3|amr|wav|ogg|flac|aac|m4a|mp4|mov|avi|mkv|webm|flv|wmv)))/i;
${COT_STRIP_HELPER}
function __ocsWxExtractMediaDirectives(text) {
  text = __ocsStripCot(text);
  const rawLines = String(text || "").split("\n");
  const paths = [];
  const kept = [];
  for (const rawLine of rawLines) {
    const m = rawLine.match(__ocsWxMediaPathRe);
    if (m) {
      paths.push((m[1] || m[2]).trim());
      kept.push(rawLine.slice(m[0].length));
    } else {
      kept.push(rawLine);
    }
  }
  return { paths, rest: kept.join("\n").trim() };
}
const __ocsWxPendingFile = () => path.join(os.homedir(), ".openclaw", "pending-media.jsonl");
function __ocsWxConsumeStalePendingMedia(minAge) {
  const out = [];
  const fresh = [];
  try {
    const now = Date.now();
    const lines = fs.readFileSync(__ocsWxPendingFile(), "utf8").split("\n");
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (o && o.path) {
          if (now - (o.ts || 0) >= (minAge || 30000)) out.push(o.path);
          else fresh.push(l);
        }
      } catch (e) { /* 坏行丢弃 */ }
    }
    fs.writeFileSync(__ocsWxPendingFile(), fresh.join("\n") + (fresh.length ? "\n" : ""));
  } catch (e) { /* 队列文件不存在/读失败 */ }
  return out;
}
function __ocsWxDropPendingMedia(paths) {
  if (!paths || !paths.length) return;
  try {
    const lines = fs.readFileSync(__ocsWxPendingFile(), "utf8").split("\n");
    const kept = lines.filter((l) => {
      try { const o = JSON.parse(l); return !paths.includes(o.path); } catch (e) { return false; }
    });
    fs.writeFileSync(__ocsWxPendingFile(), kept.join("\n") + (kept.length ? "\n" : ""));
  } catch (e) { /* 无队列文件 */ }
}
// 微信插件无 kind 区分，网关 final 会把已发文本再投递一次（QQ 有 blockTextSent 去重、微信没有）
// → 按「账号 + 文本 + 60s 窗口」内容去重：同一文本在窗口内只发一次
const __ocsWxSentCache = new Map(); // accountId -> Map<text, ts>
function __ocsWxIsDuplicate(accountId, text, windowMs) {
  const now = Date.now();
  let m = __ocsWxSentCache.get(accountId);
  if (!m) { m = new Map(); __ocsWxSentCache.set(accountId, m); }
  for (const [t, ts] of m) { if (now - ts > (windowMs || 60000)) m.delete(t); }
  if (m.has(text)) return true;
  m.set(text, now);
  return false;
}
// [openclaw-shell patch v9] 表情指令解析：一次生成内 [表情:名] 直接发图（爱语式，不走工具/保险丝）
function __ocsWxEmojiDir() { return path.join(os.homedir(), ".openclaw", "media", "emojis"); }
function __ocsWxFindEmojiFile(name) {
  try {
    const dir = __ocsWxEmojiDir();
    const safe = String(name).replace(/[\\/:*?"<>|\s]+/g, "_");
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const dot = f.lastIndexOf(".");
      const base = dot > 0 ? f.slice(0, dot) : f;
      if (base === safe) return path.join(dir, f);
    }
  } catch (e) { /* 目录不存在/读失败 → 未命中 */ }
  return null;
}
function __ocsWxExtractEmojiTags(text) {
  let rest = String(text || "");
  const re = /\[表情:([^\]]+)\]/g;
  let m, file;
  const paths = [];
  while ((m = re.exec(rest))) {
    file = __ocsWxFindEmojiFile(m[1].trim());
    if (file) paths.push(file);
  }
  if (paths.length) rest = rest.replace(/\[表情:[^\]]+\]/g, "");
  return { paths, rest: rest.trim() };
}
// [openclaw-shell patch v12] 生图指令解析：一次生成内 <生图:描述> 直接出图（独立生图接口，无第二次聊天模型调用）
function __ocsWxExtractGenerateImage(text) {
  let rest = String(text || "");
  const re = /<生图:([^<>]+)>|＜生图:([^＜＞]+)＞/g;
  let m;
  let prompt = "";
  while ((m = re.exec(rest))) {
    const p = (m[1] || m[2] || "").trim();
    if (!prompt && p) prompt = p;
  }
  if (prompt) rest = rest.replace(/<生图:[^<>]+>|＜生图:[^＜＞]+＞/g, "");
  return { prompt, rest: rest.trim() };
}
function __ocsWxShellRoot() {
  const candidates = [];
  if (process.env.OPENCLAW_SHELL_ROOT) candidates.push(process.env.OPENCLAW_SHELL_ROOT);
  candidates.push(path.join(os.homedir(), "ai_workspace", "openclaw-shell"));
  candidates.push("D:/ai_workspace/openclaw-shell");
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "dist", "core", "imageGen.js"))) return c;
    } catch (e) { /* 继续探测 */ }
  }
  return null;
}
function __ocsWxGenerateImage(prompt) {
  const root = __ocsWxShellRoot();
  if (!root) return Promise.resolve({ ok: false, error: "openclaw-shell 根目录未找到" });
  const entry = "file:///" + path.join(root, "dist", "core", "imageGen.js").replace(/\\/g, "/");
  return import(entry).then((m) =>
    m.generateImage({ prompt, aspect: "auto" }, path.join(os.homedir(), ".openclaw", "media"))
  ).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}
// ==== [/openclaw-shell patch v9] ====`;

// ---------- 全新安装的分支（v8 增强基线 + v9 表情） ----------
const QQ_BRANCH_FULL = `                      } else if (text) {
                        dlog?.info(\`[b] BLOCK send len=\${text.length} text=\${text.slice(0,30)}\`);
                        blockTextSent = true;
                        // [openclaw-shell patch v8] MEDIA: 行只剥离不发图（发图交给核心层 media payload，防双发）；
                        // 待发队列作 30s 保险丝：核心层一直没投递时才兜底
                        const ocsMedia = __ocsExtractMediaDirectives(text);
                        if (ocsMedia.paths.length) {
                          __ocsDropPendingMedia(ocsMedia.paths);
                        }
                        const ocsStale = __ocsConsumeStalePendingMedia(30000);
                        if (ocsStale.length) {
                          await Promise.race([
                            forwardMediaUrls({ mediaUrls: ocsStale }, deliverCtx, deliveredMediaUrls, dlog),
                            __ocsSleep(20000).then(() => { dlog?.warn(\`[openclaw-shell] stale media forward timed out (20s), continue text\`); })
                          ]);
                        }
                        // [openclaw-shell patch v9] [表情:名] 指令直接发图（核心层不会为指令投递媒体，无双发风险）
                        const ocsEmoji = __ocsExtractEmojiTags(ocsMedia.rest);
                        if (ocsEmoji.paths.length) {
                          await forwardMediaUrls({ mediaUrls: ocsEmoji.paths }, deliverCtx, deliveredMediaUrls, dlog);
                        }
                        // [openclaw-shell patch v12] <生图:描述> 指令：从正文提取并剔除，文本按原风格拆条
                        const ocsGen = __ocsExtractGenerateImage(ocsEmoji.rest);
                        const pieces = __ocsSplitHumanLike(ocsGen.rest, __ocsSplitStyle(deliverCtx.agentId));
                        for (let ocsI = 0; ocsI < pieces.length; ocsI++) {
                          const pc = pieces[ocsI];
                          if (!pc.trim()) { continue; } // v9.5：空文本不发（微信 ret=-2 invalid arguments）
                          await deliverReply({ ...payload, text: pc }, info, deliverCtx);
                          deliveredTexts.add(pc);
                          if (ocsI < pieces.length - 1) await __ocsSleep(250 + Math.random() * 500);
                        }
                        // [openclaw-shell patch v12] 生图执行：文本先发，再异步出图；失败只发「生图失败」（不丢提示词）
                        if (ocsGen.prompt) {
                          const ocsGenRes = await __ocsGenerateImage(ocsGen.prompt);
                          if (ocsGenRes && ocsGenRes.ok && ocsGenRes.file) {
                            await forwardMediaUrls({ mediaUrls: [ocsGenRes.file] }, deliverCtx, deliveredMediaUrls, dlog);
                          } else {
                            await deliverReply({ ...payload, text: "生图失败" }, info, deliverCtx);
                          }
                        }
                      } else {
                        // [openclaw-shell patch v8] 核心层投递的媒体 payload：发图 + 清队列同路径（防保险丝双发）
                        __ocsDropPendingMedia(payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []));
                        await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog);
                      }`;

const WX_BRANCH_FULL = `                else {
                    // [openclaw-shell patch v8] MEDIA: 行只剥离不发图（发图交给核心层 media payload，防双发）；
                    // 待发队列作 30s 保险丝：核心层一直没投递时才兜底
                    const ocsMedia = __ocsWxExtractMediaDirectives(text);
                    if (ocsMedia.paths.length) {
                        __ocsWxDropPendingMedia(ocsMedia.paths);
                    }
                    const ocsStale = __ocsWxConsumeStalePendingMedia(30000);
                    for (const ocsPath of ocsStale) {
                        // 保险丝兜底发送：20s 超时保护，失败不阻塞后续文本
                        try {
                            await Promise.race([
                                sendWeixinMediaFile({
                                    filePath: ocsPath,
                                    to: ctx.To,
                                    text: "",
                                    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
                                    cdnBaseUrl: deps.cdnBaseUrl,
                                }),
                                new Promise((r) => setTimeout(r, 20000)),
                            ]);
                            emitWeixinMessageSent({ to: ctx.To, content: "", success: true, accountId: deps.accountId, runId });
                        } catch (e) {
                            logger.warn(\`outbound: stale media send failed (continue text) filePath=\${ocsPath} err=\${String(e)}\`);
                        }
                    }
                    // [openclaw-shell patch v9] [表情:名] 指令直接发图（核心层不会为指令投递媒体，无双发风险）
                    const ocsEmoji = __ocsWxExtractEmojiTags(ocsMedia.rest);
                    for (const ocsEmojiPath of ocsEmoji.paths) {
                        await sendWeixinMediaFile({
                            filePath: ocsEmojiPath,
                            to: ctx.To,
                            text: "",
                            opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
                            cdnBaseUrl: deps.cdnBaseUrl,
                        });
                        emitWeixinMessageSent({ to: ctx.To, content: "", success: true, accountId: deps.accountId, runId });
                    }
                    // [openclaw-shell patch v12] <生图:描述> 指令：从正文提取并剔除，文本按原风格拆条
                    const ocsGen = __ocsWxExtractGenerateImage(ocsEmoji.rest);
                    const pieces = __ocsWxSplitHumanLike(ocsGen.rest, __ocsWxSplitStyle(route.agentId));
                    for (let ocsI = 0; ocsI < pieces.length; ocsI++) {
                        const pc = pieces[ocsI];
                        if (!pc.trim()) { continue; } // v9.5：空文本不发（微信 ret=-2 invalid arguments）
                        // 网关 final 会重复投递已发文本（微信无 kind 区分）→ 60s 内容去重
                        if (__ocsWxIsDuplicate(deps.accountId, pc, 60000)) {
                            logger.debug(\`outbound: skip dup text to=\${ctx.To} piece=\${ocsI + 1}\`);
                            continue;
                        }
                        logger.debug(\`outbound: sending text piece=\${ocsI + 1}/\${pieces.length} to=\${ctx.To}\`);
                        await sendMessageWeixin({ to: ctx.To, text: pc, opts: {
                                baseUrl: deps.baseUrl,
                                token: deps.token,
                                contextToken,
                                runId,
                            } });
                        emitWeixinMessageSent({ to: ctx.To, content: pc, success: true, accountId: deps.accountId, runId });
                        if (ocsI < pieces.length - 1) await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
                    }
                    logger.info(\`outbound: text sent OK to=\${ctx.To} pieces=\${pieces.length} media=\${ocsMedia.paths.length + ocsEmoji.paths.length}\`);
                    // [openclaw-shell patch v12] 生图执行：文本先发，再异步出图；失败只发「生图失败」（不丢提示词）
                    if (ocsGen.prompt) {
                        try {
                            const ocsGenRes = await __ocsWxGenerateImage(ocsGen.prompt);
                            if (ocsGenRes && ocsGenRes.ok && ocsGenRes.file) {
                                await sendWeixinMediaFile({
                                    filePath: ocsGenRes.file,
                                    to: ctx.To,
                                    text: "",
                                    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
                                    cdnBaseUrl: deps.cdnBaseUrl,
                                });
                                emitWeixinMessageSent({ to: ctx.To, content: "", success: true, accountId: deps.accountId, runId });
                            } else {
                                await sendMessageWeixin({ to: ctx.To, text: "生图失败", opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId } });
                                emitWeixinMessageSent({ to: ctx.To, content: "生图失败", success: true, accountId: deps.accountId, runId });
                            }
                        } catch (e) {
                            logger.warn(\`outbound: imagegen failed to=\${ctx.To} err=\${String(e)}\`);
                        }
                    }
                }`;

const QQ_HELPER_ANCHOR = `"use strict";
var _F=Function;`;
const QQ_BRANCH_FRESH = [
  // 上游原始（无补丁）
  `                      } else if (text) {
                        await deliverReply({ ...payload, text }, info, deliverCtx);
                      } else {`,
];
const WX_HELPER_ANCHOR = `import path from "node:path";`;
const WX_IMPORT_ADD = `import path from "node:path";
import fs from "node:fs";
import os from "node:os";`;
const WX_BRANCH_ORIGINAL = `                else {
                    logger.debug(\`outbound: sending text message to=\${ctx.To}\`);
                    await sendMessageWeixin({ to: ctx.To, text, opts: {
                            baseUrl: deps.baseUrl,
                            token: deps.token,
                            contextToken,
                            runId,
                        } });
                    emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
                    logger.info(\`outbound: text sent OK to=\${ctx.To}\`);
                }`;
const WX_STREAM_ANCHOR = `                    ...(replyProgressSender?.replyOptions ?? {}),
                    disableBlockStreaming: false,`;
const WX_STREAM_REPLACEMENT = `                    ...(replyProgressSender?.replyOptions ?? {}),
                    disableBlockStreaming: false, // [openclaw-shell patch v9] 强制走 block 管线（插件默认 true 会整条发送）`;

// ---------- v13 群聊：入站注入 / 出站存档 / 进群登记（QQ） ----------
// 注意：入站块必须放在 route 定义之后（route.agentId 依赖），之前插在 assembled 行后
// 会触发 const TDZ ReferenceError → 被 catch 吞掉 → 检索/存档全部失效（0人0轮 bug，已修）
const QQ_GROUP_INBOUND_ANCHOR = `  const agentId = route.agentId ?? "default";`;
const QQ_GROUP_INBOUND_V13 = QQ_GROUP_INBOUND_ANCHOR + `
  // [openclaw-shell patch v13] 群聊按人检索：把该成员的历史（最近 6 轮 + 关键词命中）注入正文前
  var __ocsGroupInfo = null;
  if (envelope.chatScope === "group") {
    try {
      var __ocsGid = envelope.groupId ?? envelope.senderId;
      var __ocsRecall = await __ocsGroupRecall({
        accountId: account.accountId,
        agentId: route.agentId,
        gid: __ocsGid,
        memberId: envelope.senderId,
        memberName: envelope.senderName,
        text: assembled.rawBody || ""
      });
      if (__ocsRecall && __ocsRecall.ok) {
        __ocsGroupInfo = { gid: __ocsGid, memberId: envelope.senderId, memberName: __ocsRecall.memberName, user: assembled.rawBody || "" };
        if (__ocsRecall.inject) {
          assembled.agentBody = __ocsRecall.inject;
          dlog?.info(\`[openclaw-shell] GROUP recall member=\${__ocsRecall.memberName} gid=\${__ocsGid} len=\${String(__ocsRecall.inject).length}\`);
        }
      }
    } catch (e) { dlog?.warn(\`[openclaw-shell] group recall failed: \${String(e)}\`); }
  }`;

const QQ_GROUP_SAVE_ANCHOR = `                        // [openclaw-shell patch v12] 生图执行：文本先发，再异步出图；失败只发「生图失败」（不丢提示词）`;
const QQ_GROUP_SAVE_V13 = `                        // [openclaw-shell patch v13] 群聊存档：成员名 + 提问 + 回复一一对应（不做总结）
                        if (__ocsGroupInfo && pieces.length) {
                          void __ocsGroupSaveTurn({
                            accountId: deliverCtx.accountId,
                            agentId: deliverCtx.agentId,
                            gid: __ocsGroupInfo.gid,
                            memberId: __ocsGroupInfo.memberId,
                            memberName: __ocsGroupInfo.memberName,
                            user: __ocsGroupInfo.user,
                            assistant: pieces.join("\\n")
                          });
                        }
` + QQ_GROUP_SAVE_ANCHOR;

const QQ_GROUP_JOIN_ANCHOR = `    this.bot.on("interaction", (_ctx, event) => {`;
const QQ_GROUP_JOIN_V13 = `    // [openclaw-shell patch v13] 进群/退群感知：上游只 emit rawEvent 无人订阅，这里接住并登记（不发开场白）
    this.bot.on("rawEvent", (rawCtx) => {
      try {
        var et = rawCtx?.eventType || "";
        if (et !== "GROUP_ADD_ROBOT" && et !== "GROUP_DEL_ROBOT") return;
        var gid = rawCtx?.data?.group_openid || rawCtx?.data?.group_id || "";
        this.log.info(\`[openclaw-shell] GROUP \${et} account=\${this.account.accountId} gid=\${gid}\`);
        if (et === "GROUP_ADD_ROBOT" && gid) {
          void __ocsGroupJoin({ accountId: this.account.accountId, gid: gid });
        }
      } catch (e) { /* 事件异常不影响消息通道 */ }
    });
` + QQ_GROUP_JOIN_ANCHOR;

// v13.1 修复（2026-09-09）：旧版入站块插在 route 定义之前、引用了 route.agentId，
// 触发 const TDZ ReferenceError 被 catch 吞掉 → 检索/存档全部失效（用户实测 0人0轮）。
// 修复：先移除旧块（assembled 行之后、cfg 行之前的 v13 段），再重新插到 agentId 行之后。
const QQ_GROUP_OLD_BLOCK_RE = /  \/\/ \[openclaw-shell patch v13\] 群聊按人检索[\s\S]*?\n  \}\n(?=  const cfg = adapters\.getConfig)/g;
const QQ_GROUP_NEW_ANCHOR = `  const agentId = route.agentId ?? "default";`;
const QQ_GROUP_NEW_MARK = QQ_GROUP_NEW_ANCHOR + "\n  // [openclaw-shell patch v13] 群聊按人检索";

const V9_MARKER = "[openclaw-shell patch v9]";

/** 在已打 v8 补丁的文件上做 v9 增量：helper 段尾插表情函数 + 分支锚点行替换（保留外部增强） */
// ---------- v14-voice：语音指令段（2026-09-17 补录进脚本） ----------
// 历史：语音指令（QQ [语音!:文字] 直发语音条 / 微信剔除防漏原文）当时是手改进 dist 的，补丁脚本一直缺失
// → 服务器重打补丁后插件只剩调用没有定义，QQ 出口 ReferenceError（拆条/表情发图全断，2026-09-17 线上实锤）。
// 两段各自幂等：定义块查「函数声明」、调用点查「ocsVoice 变量」——残缺文件（只有调用没有定义）也能自愈。
const QQ_VOICE_HELPER_CJS = String.raw`// [openclaw-shell patch v14] 语音指令解析：[语音!:文字]（！与表情 [表情:名] 区分；合成走独立接口不是聊天模型 → 只耗一次聊天调用）
function __ocsExtractVoiceCmd(text) {
  var rest = String(text || "");
  var re = /\[语音\s*[!！]\s*[:：]([^\]]+)\]/g, m, say = "";
  while ((m = re.exec(rest))) {
    var t = (m[1] || "").trim();
    if (!say && t) say = t; // 一次回复最多 1 条语音
  }
  if (say || /\[语音\s*[!！]\s*[:：]/.test(rest)) rest = rest.replace(/\[语音\s*[!！]\s*[:：][^\]]+\]/g, "");
  return { text: say, rest: rest.trim() };
}
// 合成 + silk 转码 + QQ 官方两步式直发语音条（收件人直接用 deliverCtx 的真实会话上下文，比插件工具猜得准）
function __ocsSendVoiceCmd(text, ctx) {
  var root = __ocsShellRoot();
  if (!root) return Promise.resolve({ ok: false, error: "openclaw-shell 根目录未找到" });
  var ttsEntry = "file:///" + require("path").join(root, "dist", "core", "ttsConfig.js").replace(/\\/g, "/");
  var qqEntry = "file:///" + require("path").join(root, "dist", "core", "qqVoice.js").replace(/\\/g, "/");
  return Promise.all([import(ttsEntry), import(qqEntry)]).then(function (mods) {
    var tts = mods[0], qq = mods[1];
    return tts.synthesize(text).then(function (raw) {
      return tts.convertAudio(raw, "silk").then(function (silk) {
        return qq.sendVoice({
          accountId: ctx.accountId,
          scope: ctx.chatScope === "group" ? "group" : "c2c",
          targetId: ctx.qualifiedTarget,
          silk: silk,
          msgId: ctx.replyToId
        }).then(function (r) {
          return { ok: true, kb: silk.length / 1024, messageId: r && r.messageId };
        });
      });
    });
  }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
}
// [/openclaw-shell patch v14 voice]`;

// QQ 调用点：v12 gen pieces 链的拆条行前插语音提取行（拆条源换成 ocsVoice.rest）
const QQ_VOICE_PIECES_V14 = QQ_GEN_PIECES_V12.replace(
  "const pieces = __ocsSplitHumanLike(ocsGen.rest, __ocsSplitStyle(deliverCtx.agentId));",
  "// [openclaw-shell patch v14] [语音!:文字] 指令：剔除后拆条，文本发完再直发语音条\n" +
  "                        const ocsVoice = __ocsExtractVoiceCmd(ocsGen.rest);\n" +
  "                        const pieces = __ocsSplitHumanLike(ocsVoice.rest, __ocsSplitStyle(deliverCtx.agentId));"
);

// QQ 执行块：紧跟 v12 生图执行块之后（文本条发完再直发语音条）
const QQ_VOICE_EXEC_V14 = `                        // [openclaw-shell patch v14] 语音执行：合成→silk→QQ 官方直发；失败只发「语音发送失败」
                        if (ocsVoice.text) {
                          const ocsVoiceRes = await __ocsSendVoiceCmd(ocsVoice.text, deliverCtx);
                          if (!(ocsVoiceRes && ocsVoiceRes.ok)) {
                            dlog?.error(\`[openclaw-shell] voice cmd failed: \${ocsVoiceRes && ocsVoiceRes.error}\`);
                            await deliverReply({ ...payload, text: "语音发送失败" }, info, deliverCtx);
                          } else {
                            dlog?.info(\`[openclaw-shell] voice sent \${(ocsVoiceRes.kb || 0).toFixed(1)}KB msgId=\${ocsVoiceRes.messageId ?? "-"}\`);
                          }
                        }`;
const QQ_GEN_AFTER_V12_VOICE = QQ_GEN_AFTER_V12.replace(
  "                      } else {",
  () => QQ_VOICE_EXEC_V14 + "\n                      } else {"
);

const WX_VOICE_HELPER_ESM = String.raw`// [openclaw-shell patch v14] [语音!:文字] 指令剔除（微信插件发不了原生语音条，只防指令漏成原文；QQ 侧由 qqbot 补丁直发语音条）
function __ocsWxStripVoiceCmd(text) {
  let rest = String(text || "");
  if (/\[语音\s*[!！]\s*[:：]/.test(rest)) rest = rest.replace(/\[语音\s*[!！]\s*[:：][^\]]+\]/g, "");
  return rest.trim();
}`;

// 微信调用点：拆条源从 ocsGen.rest 换成剔除后的 ocsVoiceStripped
const WX_VOICE_PIECES_V14 = WX_GEN_PIECES_V12.replace(
  "const pieces = __ocsWxSplitHumanLike(ocsGen.rest, __ocsWxSplitStyle(route.agentId));",
  "// [openclaw-shell patch v14] [语音!:文字] 指令剔除（微信无原生语音条，防漏原文）\n" +
  "                    const ocsVoiceStripped = __ocsWxStripVoiceCmd(ocsGen.rest);\n" +
  "                    const pieces = __ocsWxSplitHumanLike(ocsVoiceStripped, __ocsWxSplitStyle(route.agentId));"
);

// ---------- 符号自检：所有 __ocs* 引用必须有定义 ----------
// 防"只有调用没有定义"的残缺形态上线（运行时 ReferenceError，语法检查查不出；v12/v14 各栽过一次）
function symbolsMissing(src) {
  const used = [...new Set(src.match(/__ocs[A-Za-z0-9_]*/g) || [])];
  return used.filter((fn) => !new RegExp("function\\s+" + fn + "\\b|(?:const|var|let)\\s+" + fn + "\\s*=").test(src));
}

function incrementalUpgrade(src, helperEndTag, emojiBlock, piecesAnchor, piecesV9) {
  if (src.includes(V9_MARKER)) return { ok: true, reason: "已打过 v9 补丁（跳过）", src };
  if (!src.includes(helperEndTag)) return { ok: false, reason: `helper 段尾标记 ${helperEndTag} 未找到（结构变了？）` };
  if (!src.includes(piecesAnchor)) return { ok: false, reason: "拆条锚点行未找到（文件被手动改过？）" };
  let out = src.replace(helperEndTag, emojiBlock + "\n" + helperEndTag);
  out = out.replace(piecesAnchor, piecesV9);
  return { ok: true, reason: "v8 → v9 增量升级完成", src: out };
}

function patchQQ(force = false) {
  const file = QQ_DIST;
  if (!fs.existsSync(file)) return { file, ok: false, reason: "QQ 插件 dist 不存在（可能升级换路径了）" };
  let src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  // 跳过判定必须校验「函数声明」而非标识符：历史上表情块整段替换吞过 gen helper，
  // 只剩调用点时运行时 ReferenceError → 回复全挂，却被误判为已打完补丁
  // 群聊入站块校验 QQ_GROUP_NEW_MARK（agentId 行后）——旧版插在 route 前的 TDZ 块不算数
  if (
    src.includes("__ocsExtractMediaLocal") &&
    src.includes("一次回复最多 1 个表情") &&
    src.includes("v9.5") &&
    src.includes("[openclaw-shell] IDENTITY") &&
    src.includes("【表情:") &&
    src.includes("function __ocsExtractGenerateImage") &&
    src.includes("function __ocsGenerateImage") &&
    src.includes("function __ocsShellRoot") &&
    src.includes("function __ocsGroupRecall") &&
    src.includes(QQ_GROUP_NEW_MARK) &&
    // v14 出口剥离生图自检：缺它就还得跑一遍升级分支（否则新版本只会"跳过"，新加的东西永远装不上）
    src.includes("function __ocsStripCot") &&
    // v14-voice：语音段同样按「函数声明」校验——残缺形态（只有调用没有定义）必须进升级分支自愈
    src.includes("function __ocsExtractVoiceCmd") &&
    src.includes("function __ocsSendVoiceCmd") &&
    !force
  ) return { file, ok: true, reason: "已打过 v14 补丁（跳过）" };
  const v8End = "// ==== [/openclaw-shell patch v8] ====";
  if (src.includes(v8End) || src.includes("__ocsConsumeStalePendingMedia")) {
    let out = src;
    // v9 未打（无表情块）→ 先增量插表情块 + pieces 行
    if (!out.includes("// [openclaw-shell patch v9] 表情指令解析")) {
      const r = incrementalUpgrade(out, v8End, EMOJI_HELPER_CJS, QQ_PIECES_ANCHOR, QQ_PIECES_V9);
      if (!r.ok) return { file, ok: false, reason: r.reason };
      out = r.src;
    }
    // v9.1/v9.2：表情块换成 v9.1 版（无条件剔除 + strip 警告函数）+ MEDIA 提取前剥离警告
    // （v9.2 修复 v9.1 对 const text 赋值的崩溃：统一用新变量 ocsT）
    const emojiStart = out.indexOf("// [openclaw-shell patch v9] 表情指令解析");
    const emojiEnd = out.indexOf("// [/openclaw-shell patch v9 emoji]");
    if (emojiStart >= 0 && emojiEnd > emojiStart) {
      out = out.slice(0, emojiStart) + EMOJI_HELPER_CJS + out.slice(emojiEnd + "// [/openclaw-shell patch v9 emoji]".length);
    }
    if (out.includes(QQ_MEDIA_LINE_V91_BROKEN)) {
      out = out.replace(QQ_MEDIA_LINE_V91_BROKEN, QQ_MEDIA_LINE_V91);
    } else if (out.includes("const ocsMedia = __ocsExtractMediaDirectives(ocsT);")) {
      out = out.replace("const ocsMedia = __ocsExtractMediaDirectives(ocsT);", "const ocsMedia = __ocsExtractMediaLocal(ocsT);");
    } else if (out.includes("const ocsMedia = __ocsExtractMediaLocal(ocsT);")) {
      // 已是 v9.3 Local 形态 → 无需替换
    } else if (out.includes(QQ_MEDIA_LINE_ANCHOR)) {
      out = out.replace(QQ_MEDIA_LINE_ANCHOR, QQ_MEDIA_LINE_V91);
    } else {
      return { file, ok: false, reason: "MEDIA 提取行未找到（文件被手动改过？）" };
    }
    // v10：入站守卫（未绑定人设卡拒接 + 详细身份日志）
    if (!out.includes("[openclaw-shell] IDENTITY") && out.includes(QQ_GUARD_ANCHOR)) {
      out = out.replace(QQ_GUARD_ANCHOR, QQ_GUARD_V10);
    }
    // v9.5：空文本防护（表情剔除后剩余为空时不再发空消息，微信服务端拒收 ret=-2）
    out = out.replace("return parts.length ? parts : [String(text || \"\").trim()];",
      "return parts.length ? parts : (String(text || \"\").trim() ? [String(text || \"\").trim()] : []);");
    out = out.replace("const pc = pieces[ocsI];\n                          await deliverReply({ ...payload, text: pc }, info, deliverCtx);",
      "const pc = pieces[ocsI];\n                          if (!pc.trim()) { continue; } // v9.5：空文本不发（微信 ret=-2 invalid arguments）\n                          await deliverReply({ ...payload, text: pc }, info, deliverCtx);");
    // v12：生图指令（helper 尾插 + pieces 行替换 + 循环尾插执行块）
    // 残缺自愈：表情块整段替换会覆盖 gen helper（只剩调用点 → 运行时 ReferenceError 回复全挂），
    // 所以判据是「函数声明是否存在」而不是「标识符是否出现」
    if (!out.includes("function __ocsExtractGenerateImage")) {
      const genStart = out.indexOf("// [/openclaw-shell patch v9 emoji]");
      if (genStart < 0) return { file, ok: false, reason: "v9 emoji 段尾标记未找到（结构变了？）" };
      out = out.slice(0, genStart) + GEN_HELPER_CJS + "\n" + out.slice(genStart);
    }
    if (!out.includes("const ocsGen = __ocsExtractGenerateImage")) {
      if (!out.includes(QQ_PIECES_V9)) return { file, ok: false, reason: "v9 pieces 锚点未找到（文件被手动改过？）" };
      out = out.replace(QQ_PIECES_V9, QQ_GEN_PIECES_V12);
    }
    // 残缺自愈（v12 旧版曾吞掉 ocsEmoji 声明 → ReferenceError）：已打 v12 但缺表情声明 → 补插
    if (out.includes("const ocsGen = __ocsExtractGenerateImage") && !out.includes("const ocsEmoji = __ocsExtractEmojiTags")) {
      const v12Comment = "                        // [openclaw-shell patch v12] <生图:描述> 指令：从正文提取并剔除，文本按原风格拆条";
      if (!out.includes(v12Comment)) return { file, ok: false, reason: "v12 注释锚点未找到（残缺形态无法自愈，需手动）" };
      const emojiDecl = QQ_GEN_PIECES_V12.slice(0, QQ_GEN_PIECES_V12.indexOf("// [openclaw-shell patch v12]"));
      out = out.replace(v12Comment, emojiDecl + v12Comment);
    }
    if (!out.includes("生图执行：文本先发")) {
      const tailAnchor = `                          if (ocsI < pieces.length - 1) await __ocsSleep(250 + Math.random() * 500);
                        }
                      } else {`;
      if (!out.includes(tailAnchor)) return { file, ok: false, reason: "QQ 循环尾锚点未找到（文件被手动改过？）" };
      out = out.replace(tailAnchor, QQ_GEN_AFTER_V12);
    }
    // v13：群聊（helper + 入站按人检索注入 + 出站一一对应存档 + 进群登记）
    // 插到 v8 helper 段尾（v8 尾标记是最稳定的，不会被表情/生图块的整段替换波及；
    // 早期版本插在 v12/v9 段尾会与 gen helper 互相覆盖）
    if (!out.includes("function __ocsGroupRecall")) {
      const v8Tag = "// ==== [/openclaw-shell patch v8] ====";
      if (!out.includes(v8Tag)) return { file, ok: false, reason: "v8 helper 段尾标记未找到（结构变了？）" };
      out = out.replace(v8Tag, GROUP_HELPER_CJS + "\n" + v8Tag);
    }
    // v13.1：旧版入站块在 route 定义前引 route.agentId → TDZ 崩（检索/存档失效）
    // 先移除旧块，再插到 agentId 行之后
    QQ_GROUP_OLD_BLOCK_RE.lastIndex = 0;
    if (QQ_GROUP_OLD_BLOCK_RE.test(out)) {
      QQ_GROUP_OLD_BLOCK_RE.lastIndex = 0;
      out = out.replace(QQ_GROUP_OLD_BLOCK_RE, "");
    }
    if (!out.includes(QQ_GROUP_NEW_MARK)) {
      if (!out.includes(QQ_GROUP_NEW_ANCHOR)) return { file, ok: false, reason: "群聊入站锚点（agentId 行）未找到（上游结构变了）" };
      out = out.replace(QQ_GROUP_NEW_ANCHOR, QQ_GROUP_INBOUND_V13);
    }
    if (!out.includes("群聊存档：成员名")) {
      if (!out.includes(QQ_GROUP_SAVE_ANCHOR)) return { file, ok: false, reason: "群聊存档锚点未找到（文件被手动改过？）" };
      out = out.replace(QQ_GROUP_SAVE_ANCHOR, QQ_GROUP_SAVE_V13);
    }
    if (!out.includes("进群/退群感知")) {
      if (!out.includes(QQ_GROUP_JOIN_ANCHOR)) return { file, ok: false, reason: "进群事件锚点未找到（上游结构变了）" };
      out = out.replace(QQ_GROUP_JOIN_ANCHOR, QQ_GROUP_JOIN_V13);
    }
    // v14：出口剥离生图自检（CoT）——已打过补丁的安装也要补上这道闸（幂等：有 __ocsStripCot 就跳过）
    if (!out.includes("__ocsStripCot")) {
      const fnAnchor = "function __ocsExtractMediaDirectives(text) {";
      if (!out.includes(fnAnchor)) return { file, ok: false, reason: "生图自检剥离锚点未找到（文件被手动改过？）" };
      out = out.replace(fnAnchor, () => `${COT_STRIP_HELPER}\n${fnAnchor}`);
      out = out.replace(`${fnAnchor}\n`, () => `${fnAnchor}\n  text = __ocsStripCot(text);\n`);
    }
    // v14-voice：语音指令段（定义插到 v12 gen 段尾之后；调用点/执行块各自独立幂等，
    // 残缺文件——只有调用没有定义——只会补定义，不会重复插调用）
    if (!out.includes("function __ocsExtractVoiceCmd")) {
      const genEndTag = "// [/openclaw-shell patch v12 gen]";
      if (!out.includes(genEndTag)) return { file, ok: false, reason: "v14 voice 定义锚点（v12 gen 段尾）未找到（结构变了？）" };
      out = out.replace(genEndTag, () => `${genEndTag}\n${QQ_VOICE_HELPER_CJS}`);
    }
    if (!out.includes("const ocsVoice = __ocsExtractVoiceCmd")) {
      if (!out.includes(QQ_GEN_PIECES_V12)) return { file, ok: false, reason: "v14 voice 调用点锚（v12 pieces 行）未找到（文件被手动改过？）" };
      out = out.replace(QQ_GEN_PIECES_V12, () => QQ_VOICE_PIECES_V14);
    }
    if (!out.includes("语音执行：合成")) {
      if (!out.includes(QQ_GEN_AFTER_V12)) return { file, ok: false, reason: "v14 voice 执行块锚（v12 生图执行块）未找到（文件被手动改过？）" };
      out = out.replace(QQ_GEN_AFTER_V12, () => QQ_GEN_AFTER_V12_VOICE);
    }
    // 符号自检：宁可报错也不能把"只有调用没有定义"的残缺文件写回去
    const qqMissing = symbolsMissing(out);
    if (qqMissing.length) return { file, ok: false, reason: `符号自检失败（缺定义）: ${qqMissing.join(", ")}` };
    fs.writeFileSync(file, out, "utf8");
    return { file, ok: true, reason: "升级完成（含 v14-voice 补录与符号自检）" };
  }
  // 全新安装（上游原始）
  if (!src.includes(QQ_HELPER_ANCHOR)) return { file, ok: false, reason: "文件头锚点不匹配（上游结构变了）" };
  src = src.replace(QQ_HELPER_ANCHOR, QQ_HELPER_FULL + "\n" + QQ_HELPER_ANCHOR);
  let branch = null;
  for (const cand of QQ_BRANCH_FRESH) {
    if (src.includes(cand)) { branch = cand; break; }
  }
  if (!branch) return { file, ok: false, reason: "block 分支锚点不匹配（上游代码变了，需手动核对）" };
  src = src.replace(branch, QQ_BRANCH_FULL);
  if (!src.includes("let blockTextSent")) src = src.replace(/const deliveredTexts = \/\* @__PURE__ \*\/ new Set\(\);/, "const deliveredTexts = /* @__PURE__ */ new Set();\n  let blockTextSent = false;");
  fs.writeFileSync(file, src, "utf8");
  return { file, ok: true, reason: "已打 v9 补丁（全新）" };
}

function patchWX(force = false) {
  const file = WX_DIST;
  if (!fs.existsSync(file)) return { file, ok: false, reason: "微信插件文件不存在（可能升级换路径了）" };
  let src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  // 跳过判定必须校验「函数声明」而非标识符（QQ 侧同款教训）：标识符在调用点也算命中，
  // 残缺文件（只有调用没有定义）会被误判为已打完，永远不自愈 → 09-17 线上微信出口全挂的根因之一
  if (
    src.includes("function __ocsWxExtractMediaLocal") &&
    src.includes("一次回复最多 1 个表情") &&
    src.includes("v9.5") &&
    src.includes("[openclaw-shell] IDENTITY") &&
    src.includes("【表情:") &&
    src.includes("function __ocsWxExtractGenerateImage") &&
    src.includes("function __ocsWxGenerateImage") &&
    src.includes("function __ocsWxShellRoot") &&
    src.includes("function __ocsStripCot") &&
    src.includes("function __ocsWxStripVoiceCmd") &&
    !force
  ) return { file, ok: true, reason: "已打过 v14 补丁（跳过）" };
  const v8End = "// ==== [/openclaw-shell patch v8] ====";
  if (src.includes(v8End) || src.includes("__ocsWxConsumeStalePendingMedia")) {
    let out = src;
    if (!out.includes("// [openclaw-shell patch v9] 表情指令解析")) {
      const r = incrementalUpgrade(out, v8End, EMOJI_HELPER_ESM, WX_PIECES_ANCHOR, WX_PIECES_V9);
      if (!r.ok) return { file, ok: false, reason: r.reason };
      out = r.src;
    }
    // v9.1/v9.2：表情块换成 v9.1 版 + MEDIA 提取前剥离警告（统一新变量 ocsT，修复 const 崩溃）
    const emojiStart = out.indexOf("// [openclaw-shell patch v9] 表情指令解析");
    const emojiEnd = out.indexOf("// [/openclaw-shell patch v9 emoji]");
    if (emojiStart >= 0 && emojiEnd > emojiStart) {
      out = out.slice(0, emojiStart) + EMOJI_HELPER_ESM + out.slice(emojiEnd + "// [/openclaw-shell patch v9 emoji]".length);
    }
    if (out.includes(WX_MEDIA_LINE_V91_BROKEN)) {
      out = out.replace(WX_MEDIA_LINE_V91_BROKEN, WX_MEDIA_LINE_V91);
    } else if (out.includes("const ocsMedia = __ocsWxExtractMediaDirectives(ocsT);")) {
      out = out.replace("const ocsMedia = __ocsWxExtractMediaDirectives(ocsT);", "const ocsMedia = __ocsWxExtractMediaLocal(ocsT);");
    } else if (out.includes("const ocsMedia = __ocsWxExtractMediaLocal(ocsT);")) {
      // 已是 v9.3 Local 形态 → 无需替换
    } else if (out.includes(WX_MEDIA_LINE_ANCHOR)) {
      out = out.replace(WX_MEDIA_LINE_ANCHOR, WX_MEDIA_LINE_V91);
    } else {
      return { file, ok: false, reason: "MEDIA 提取行未找到（文件被手动改过？）" };
    }
    if (out.includes(WX_STREAM_ANCHOR)) out = out.replace(WX_STREAM_ANCHOR, WX_STREAM_REPLACEMENT);
    // v10：入站守卫（未绑定人设卡拒接 + 详细身份日志）
    if (!out.includes("[openclaw-shell] IDENTITY") && out.includes(WX_GUARD_ANCHOR)) {
      out = out.replace(WX_GUARD_ANCHOR, WX_GUARD_V10);
    }
    // v9.5：空文本防护
    out = out.replace("return parts.length ? parts.filter(Boolean) : [String(text || \"\").trim()];",
      "return parts.length ? parts.filter(Boolean) : (String(text || \"\").trim() ? [String(text || \"\").trim()] : []);");
    out = out.replace("const pc = pieces[ocsI];\n                        // 网关 final 会重复投递已发文本（微信无 kind 区分）→ 60s 内容去重",
      "const pc = pieces[ocsI];\n                        if (!pc.trim()) { continue; } // v9.5：空文本不发（微信 ret=-2 invalid arguments）\n                        // 网关 final 会重复投递已发文本（微信无 kind 区分）→ 60s 内容去重");
    // v12：生图指令（helper 尾插 + pieces 行替换 + logger 行后插执行块）
    // 判据必须是「函数声明」：裸标识符会被调用点命中（残缺文件：有调用没定义），helper 永远插不进去
    if (!out.includes("function __ocsWxExtractGenerateImage")) {
      const genStart = out.indexOf("// [/openclaw-shell patch v9 emoji]");
      if (genStart < 0) return { file, ok: false, reason: "v9 emoji 段尾标记未找到（结构变了？）" };
      out = out.slice(0, genStart) + GEN_HELPER_ESM + "\n" + out.slice(genStart);
    }
    if (!out.includes("const ocsGen = __ocsWxExtractGenerateImage")) {
      if (!out.includes(WX_PIECES_V9)) return { file, ok: false, reason: "v9 pieces 锚点未找到（文件被手动改过？）" };
      out = out.replace(WX_PIECES_V9, WX_GEN_PIECES_V12);
    }
    // 残缺自愈（v12 旧版曾吞掉 ocsEmoji 声明 → ReferenceError）：已打 v12 但缺表情声明 → 补插
    if (out.includes("const ocsGen = __ocsWxExtractGenerateImage") && !out.includes("const ocsEmoji = __ocsWxExtractEmojiTags")) {
      const v12Comment = "                    // [openclaw-shell patch v12] <生图:描述> 指令：从正文提取并剔除，文本按原风格拆条";
      if (!out.includes(v12Comment)) return { file, ok: false, reason: "v12 注释锚点未找到（残缺形态无法自愈，需手动）" };
      const emojiDecl = WX_GEN_PIECES_V12.slice(0, WX_GEN_PIECES_V12.indexOf("// [openclaw-shell patch v12]"));
      out = out.replace(v12Comment, emojiDecl + v12Comment);
    }
    if (!out.includes("生图执行：文本先发")) {
      // 微信线上分支的 logger 行可能比模板旧（media 计数不含表情）→ 按前缀定位行尾再插执行块
      const logPrefix = "                    logger.info(\`outbound: text sent OK to=";
      const tailIdx = out.indexOf(logPrefix);
      if (tailIdx < 0) return { file, ok: false, reason: "微信 logger 尾锚点未找到（文件被手动改过？）" };
      const lineEnd = out.indexOf("\n", tailIdx);
      const closeIdx = out.indexOf("\n                }", lineEnd);
      if (closeIdx < 0) return { file, ok: false, reason: "微信分支尾 } 未找到（文件被手动改过？）" };
      const genBlockStart = "                    // [openclaw-shell patch v12] 生图执行：文本先发，再异步出图；失败只发「生图失败」（不丢提示词）";
      const genBlock = WX_GEN_AFTER_V12.slice(WX_GEN_AFTER_V12.indexOf(genBlockStart), WX_GEN_AFTER_V12.lastIndexOf("\n                }"));
      out = out.slice(0, closeIdx) + "\n" + genBlock + out.slice(closeIdx);
    }
    // v14：出口剥离生图自检（CoT）——同上，幂等
    if (!out.includes("__ocsStripCot")) {
      const fnAnchor = "function __ocsWxExtractMediaDirectives(text) {";
      if (!out.includes(fnAnchor)) return { file, ok: false, reason: "生图自检剥离锚点未找到（微信侧，文件被手动改过？）" };
      out = out.replace(fnAnchor, () => `${COT_STRIP_HELPER}\n${fnAnchor}`);
      out = out.replace(`${fnAnchor}\n`, () => `${fnAnchor}\n  text = __ocsStripCot(text);\n`);
    }
    // v14-voice：语音指令剔除段（定义插到 v12 gen 段尾之后；调用点独立幂等）
    if (!out.includes("function __ocsWxStripVoiceCmd")) {
      const genEndTag = "// [/openclaw-shell patch v12 gen]";
      if (!out.includes(genEndTag)) return { file, ok: false, reason: "v14 voice 定义锚点（v12 gen 段尾）未找到（微信侧，结构变了？）" };
      out = out.replace(genEndTag, () => `${genEndTag}\n${WX_VOICE_HELPER_ESM}`);
    }
    if (!out.includes("const ocsVoiceStripped = __ocsWxStripVoiceCmd")) {
      if (!out.includes(WX_GEN_PIECES_V12)) return { file, ok: false, reason: "v14 voice 调用点锚（v12 pieces 行）未找到（微信侧，文件被手动改过？）" };
      out = out.replace(WX_GEN_PIECES_V12, () => WX_VOICE_PIECES_V14);
    }
    // 符号自检：宁可报错也不能把"只有调用没有定义"的残缺文件写回去
    const wxMissing = symbolsMissing(out);
    if (wxMissing.length) return { file, ok: false, reason: `符号自检失败（缺定义）: ${wxMissing.join(", ")}` };
    fs.writeFileSync(file, out, "utf8");
    return { file, ok: true, reason: "升级完成（含 v12 gen 补插与 v14-voice 补录）" };
  }
  // 全新安装（上游原始）
  if (src.includes(WX_IMPORT_ADD)) {
    // imports 已在（可能上次只差引擎）→ 无操作
  } else if (src.includes(WX_HELPER_ANCHOR)) {
    src = src.replace(WX_HELPER_ANCHOR, WX_HELPER_FULL + "\n" + WX_IMPORT_ADD);
  } else {
    return { file, ok: false, reason: "import 锚点不匹配（上游结构变了）" };
  }
  if (!src.includes(WX_BRANCH_ORIGINAL)) return { file, ok: false, reason: "deliver 文本分支锚点不匹配（上游代码变了，需手动核对）" };
  src = src.replace(WX_BRANCH_ORIGINAL, WX_BRANCH_FULL);
  if (src.includes(WX_STREAM_ANCHOR)) src = src.replace(WX_STREAM_ANCHOR, WX_STREAM_REPLACEMENT);
  else if (src.includes("disableBlockStreaming: true")) src = src.replace("disableBlockStreaming: true", "disableBlockStreaming: false, // [openclaw-shell patch v9]");
  fs.writeFileSync(file, src, "utf8");
  return { file, ok: true, reason: "已打 v9 补丁（全新）" };
}

// ---------- 校验 ----------
function checkSyntax(file) {
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    return r.status === 0 ? null : r.stderr.split("\n").slice(0, 3).join(" | ");
  } catch (e) {
    return String(e);
  }
}

// ---------- 自检：插件内嵌拆条与 src/core/splitter.ts 同口径 ----------
async function selftest() {
  const vm = await import("node:vm");
  const src = fs.readFileSync(QQ_DIST, "utf8");
  const start = src.indexOf("// ==== [openclaw-shell patch v");
  if (start < 0) { console.log("❌ 提取不到 QQ 补丁段（先打补丁再自检）"); process.exit(1); }
  const end = src.indexOf("// ==== [/openclaw-shell patch v");
  if (end < 0 || end < start) { console.log("❌ QQ 补丁段结尾标记未找到"); process.exit(1); }
  const helperCode = src.slice(start, end);
  const sandbox = { require, process, console, setTimeout };
  vm.runInNewContext(helperCode, sandbox, { filename: "qq-dist-helper" });
  const pluginSplit = sandbox.__ocsSplitHumanLike;
  const pluginMedia = sandbox.__ocsExtractMediaDirectives;
  const pluginEmoji = sandbox.__ocsExtractEmojiTags;
  const { splitReply } = await import("../dist/core/splitter.js");

  const cases = [
    // [text, style, max, expectedParts]（注意：插件侧句号只认全角 。，与引擎的 。．. 有差异，
    // 对拍用例统一用全角句号）
    ["在干嘛呢", "chat", 5, ["在干嘛呢"]],
    ["在干嘛\n吃了吗", "chat", 5, ["在干嘛", "吃了吗"]],
    ["第一段话。这里还有一句。", "chat", 5, ["第一段话", "这里还有一句"]],
    ["在吗？出来玩啊！真的不来？", "chat", 5, ["在吗？出来玩啊！真的不来？"]],
    ["真好。！你说呢", "chat", 5, ["真好！", "你说呢"]],
    ["好。行。拜。", "chat", 5, ["好", "行", "拜"]],
    ["（心里想着。这件事不能提。）".repeat(7) + "他终于开口了。说了一句很长的话。", "rich", 7, null],
    ["（第一句。第二句。第三句。）".repeat(8), "rich", 7, null],
  ];
  let failed = 0;
  for (const [text, style, max, expected] of cases) {
    const fromPlugin = pluginSplit(text, style);
    const fromEngine = splitReply(text, { style, max }).parts;
    const same = JSON.stringify(fromPlugin) === JSON.stringify(fromEngine);
    const ok = expected ? same && JSON.stringify(fromPlugin) === JSON.stringify(expected) : same;
    if (!ok) {
      failed++;
      console.log(`  ✗ [${style}] ${text.slice(0, 24)}…\n     插件: ${JSON.stringify(fromPlugin)}\n     引擎: ${JSON.stringify(fromEngine)}${expected ? "\n     期望: " + JSON.stringify(expected) : ""}`);
    } else {
      console.log(`  ✓ [${style}] ${text.slice(0, 24)}… → ${fromPlugin.length} 条`);
    }
  }
  // MEDIA 提取
  const mediaIn = "给你看\nMEDIA:C:/Users/x/.openclaw/media/emojis/惊喜.gif\n收好";
  const pm = pluginMedia(mediaIn);
  if (pm.paths.length !== 1 || !pm.paths[0].endsWith("惊喜.gif")) {
    failed++;
    console.log(`  ✗ MEDIA 提取: ${JSON.stringify(pm)}`);
  } else {
    console.log(`  ✓ MEDIA 提取 ${pm.paths.length} 条，剩余文本 "${pm.rest}"`);
  }
  // 表情提取：命中真实落盘的 emoji（media/emojis/惊喜.gif），未命中的保留原文
  const emojiDir = path.join(os.homedir(), ".openclaw", "media", "emojis");
  const hasRealEmoji = fs.existsSync(path.join(emojiDir, "惊喜.gif"));
  const emojiIn = hasRealEmoji
    ? "给你看个表情\n[表情:惊喜]\n好看吗"
    : "给你看个表情\n[表情:不存在的表情]\n好看吗";
  const pe = pluginEmoji(emojiIn);
  const emojiHit = hasRealEmoji
    ? pe.paths.length === 1 && pe.paths[0].endsWith("惊喜.gif") && !pe.rest.includes("[表情:")
    : pe.paths.length === 0 && pe.rest.includes("[表情:");
  if (!emojiHit) {
    failed++;
    console.log(`  ✗ 表情提取: ${JSON.stringify(pe)} (realEmoji=${hasRealEmoji})`);
  } else {
    console.log(`  ✓ 表情提取 ${pe.paths.length} 个 → ${pe.paths[0] ?? "（未命中保留原文）"}，剩余文本 "${pe.rest}"`);
  }
  // 生图指令提取：半角/全角尖括号兼容、指令剔除、未命中保留原文
  const pluginGen = sandbox.__ocsExtractGenerateImage;
  const genCases = [
    ["给你画一张\n<生图:少女，长发，月光下>\n好看吗", "少女，长发，月光下", "给你画一张\n\n好看吗"],
    ["＜生图:全角测试＞好了", "全角测试", "好了"],
    ["<生图:第一个>和<生图:第二个>", "第一个", "和"],
    ["没有指令的文本", "", "没有指令的文本"],
  ];
  for (const [inp, expPrompt, expRest] of genCases) {
    const pg = pluginGen(inp);
    const ok = pg.prompt === expPrompt && pg.rest === expRest;
    if (!ok) {
      failed++;
      console.log(`  ✗ 生图提取: ${JSON.stringify(inp)} → ${JSON.stringify(pg)}（期望 prompt="${expPrompt}" rest="${expRest}"）`);
    } else {
      console.log(`  ✓ 生图提取 prompt="${pg.prompt || "（无）"}"，剩余文本 "${pg.rest}"`);
    }
  }
  if (failed) { console.log(`❌ 自检失败 ${failed} 项`); process.exit(1); }
  // 分支结构自检（防 v12 式回归：吞掉 ocsEmoji 声明 → 运行时 ReferenceError，语法检查查不出）
  const qqFull = fs.readFileSync(QQ_DIST, "utf8");
  const emojiDeclPos = qqFull.indexOf("const ocsEmoji = __ocsExtractEmojiTags(ocsMedia.rest);");
  const genUsePos = qqFull.indexOf("const ocsGen = __ocsExtractGenerateImage(ocsEmoji.rest);");
  if (emojiDeclPos < 0 || genUsePos < 0 || emojiDeclPos > genUsePos) {
    failed++;
    console.log(`  ✗ QQ 分支结构：ocsEmoji 声明(${emojiDeclPos}) 必须在 ocsGen 使用(${genUsePos}) 之前`);
  } else {
    console.log("  ✓ QQ 分支结构：ocsEmoji 声明在 ocsGen 使用之前（无 v12 回归）");
  }
  const wxFull = fs.readFileSync(WX_DIST, "utf8");
  const wxEmojiPos = wxFull.indexOf("const ocsEmoji = __ocsWxExtractEmojiTags(ocsMedia.rest);");
  const wxGenPos = wxFull.indexOf("const ocsGen = __ocsWxExtractGenerateImage(ocsEmoji.rest);");
  if (wxEmojiPos < 0 || wxGenPos < 0 || wxEmojiPos > wxGenPos) {
    failed++;
    console.log(`  ✗ 微信分支结构：ocsEmoji 声明(${wxEmojiPos}) 必须在 ocsGen 使用(${wxGenPos}) 之前`);
  } else {
    console.log("  ✓ 微信分支结构：ocsEmoji 声明在 ocsGen 使用之前（无 v12 回归）");
  }
  // 符号自检：所有 __ocs* 引用必须有定义（防"只有调用没有定义"的残缺形态，语法检查查不出）
  const qqMiss = symbolsMissing(qqFull);
  if (qqMiss.length) { failed++; console.log(`  ✗ QQ 符号自检：缺定义 ${qqMiss.join(", ")}`); }
  else console.log("  ✓ QQ 符号自检：全部 __ocs* 引用有定义");
  const wxMiss = symbolsMissing(wxFull);
  if (wxMiss.length) { failed++; console.log(`  ✗ 微信符号自检：缺定义 ${wxMiss.join(", ")}`); }
  else console.log("  ✓ 微信符号自检：全部 __ocs* 引用有定义");
  if (failed) { console.log(`❌ 自检失败 ${failed} 项`); process.exit(1); }
  console.log("✅ 插件补丁内嵌拆条与本地引擎一致，MEDIA/表情/生图提取正常，分支结构完好");
}

const [,, target] = process.argv;
if (target === "--selftest") {
  await selftest();
} else {
  const jobs = target === "qq" ? [["QQ", patchQQ]] : target === "wx" || target === "weixin" ? [["微信", patchWX]] : [["QQ", patchQQ], ["微信", patchWX]];
  let allOk = true;
  for (const [name, fn] of jobs) {
    const r = fn();
    console.log(`[${name}] ${r.ok ? "✅" : "❌"} ${r.reason}${r.file ? "\n      " + r.file : ""}`);
    if (r.ok) {
      const err = checkSyntax(r.file);
      if (err) { console.log(`      ⚠️ 语法检查失败: ${err}`); allOk = false; }
      else if (!r.reason.includes("跳过")) console.log("      语法检查通过");
    } else {
      allOk = false;
    }
  }
  process.exit(allOk ? 0 : 1);
}