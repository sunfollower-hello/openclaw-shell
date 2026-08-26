// 临时补丁：封面改文件存储（/covers）+ 保存迁移 + compile 404
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/server.ts";
let s = readFileSync(p, "utf8");
const before = s;

// 1) 导入 covers
const impAnchor = 'import { getImageConfig, saveImageConfig, maskKey, testNovelaiKey, testOpenAIImageKey } from "./core/imageConfig.js";';
if (!s.includes(impAnchor)) {
  console.log("导入锚点未找到");
  process.exit(1);
}
s = s.replace(impAnchor, impAnchor + '\nimport { coversDir, saveCover, readCover, normalizeAvatar } from "./core/covers.js";');

// 2) /covers 静态服务（maxAge 0：封面固定名覆盖，避免浏览器缓存旧图）
const staticAnchor = 'app.use("/img", express.static(path.join(dataDir(), "images")));';
if (!s.includes(staticAnchor)) {
  console.log("静态服务锚点未找到");
  process.exit(1);
}
s = s.replace(staticAnchor, staticAnchor + '\napp.use("/covers", express.static(coversDir(), { etag: true, maxAge: 0 }));');

// 3) GET 单卡：返回前迁移 base64 头像 → 文件
const getAnchor = `    const card = await store.get(req.params.slug);
    res.json(card);`;
const getNew = `    const card = await store.get(req.params.slug);
    const migrated = await normalizeAvatar(card.identity?.avatar, card.slug);
    if (migrated !== card.identity?.avatar) {
      card.identity.avatar = migrated;
      await store.save(card).catch(() => {});
    }
    res.json(card);`;
if (!s.includes(getAnchor)) {
  console.log("GET 单卡锚点未找到");
  process.exit(1);
}
s = s.replace(getAnchor, getNew);

// 4) compile 接口：卡不存在 → 404（原来 ENOENT 会 walk 成 500 + [系统] 错误日志）
const compAnchor = `    const card = await store.get(req.params.slug);
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    const out = await compileForBot(card);`;
const compNew = `    const card = await store.get(req.params.slug).catch(() => null);
    if (!card) return res.status(404).json({ error: "找不到这张卡，可能已被删除" });
    const result = validateCard(card);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    const out = await compileForBot(card);`;
if (!s.includes(compAnchor)) {
  console.log("compile 锚点未找到");
  process.exit(1);
}
s = s.replace(compAnchor, compNew);

// 5) /api/cards/cover：生成后落盘文件返回 url（不再回传 dataUrl），slug 可带可不带
const coverOld = `    const { generateImage } = await import("./core/imageGen.js");
    const r = await generateImage({ prompt, aspect: "portrait" });
    if (!r.ok || !r.buffer) return res.json({ ok: false, error: r.error ?? "生成失败" });
    const mime = r.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
    res.json({ ok: true, dataUrl: \`data:\${mime};base64,\${r.buffer.toString("base64")}\` });`;
const coverNew = `    const { generateImage } = await import("./core/imageGen.js");
    const r = await generateImage({ prompt, aspect: "portrait" });
    if (!r.ok || !r.buffer) return res.json({ ok: false, error: r.error ?? "生成失败" });
    const coverSlug = String(req.body?.slug ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "cover";
    const url = await saveCover(coverSlug, r.buffer, r.mimeType);
    res.json({ ok: true, url });`;
if (!s.includes(coverOld)) {
  console.log("cover 接口锚点未找到");
  process.exit(1);
}
s = s.replace(coverOld, coverNew);

// 6) import 保存：data: 头像 → 落盘文件
const impSaveOld = `    await store.save(parsed.data);
    const tSave = Date.now();`;
const impSaveNew = `    if (parsed.data.identity?.avatar) {
      parsed.data.identity.avatar = await normalizeAvatar(parsed.data.identity.avatar, parsed.data.slug);
    }
    await store.save(parsed.data);
    const tSave = Date.now();`;
if (!s.includes(impSaveOld)) {
  // 可能埋点还没编译进去？按无埋点原样再试
  const impSaveOld2 = `    await store.save(parsed.data);
    res.json({ card: parsed.data });`;
  const impSaveNew2 = `    if (parsed.data.identity?.avatar) {
      parsed.data.identity.avatar = await normalizeAvatar(parsed.data.identity.avatar, parsed.data.slug);
    }
    await store.save(parsed.data);
    res.json({ card: parsed.data });`;
  if (s.includes(impSaveOld2)) {
    s = s.replace(impSaveOld2, impSaveNew2);
    console.log("import 保存迁移已加（无埋点版）");
  } else {
    console.log("import 保存锚点未找到");
    process.exit(1);
  }
} else {
  s = s.replace(impSaveOld, impSaveNew);
}

// 7) PUT 更新：data: 头像 → 落盘文件
const putOld = `    const result = validateCard(body);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    await store.save(body);`;
const putNew = `    const result = validateCard(body);
    if (!result.ok) return res.status(400).json({ error: result.errors.join("; ") });
    if (body.identity?.avatar) {
      body.identity.avatar = await normalizeAvatar(body.identity.avatar, body.slug);
    }
    await store.save(body);`;
if (!s.includes(putOld)) {
  console.log("PUT 锚点未找到");
  process.exit(1);
}
s = s.replace(putOld, putNew);

if (s === before) {
  console.log("无变化");
  process.exit(1);
}
writeFileSync(p, s, "utf8");
console.log("server.ts 补丁完成");