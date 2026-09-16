// 一次性：微信 CDN GIF 上传实测（验证 ilinkai 服务端是否接受 gif 图片）
// 运行：node scripts/_wx-gif-test.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const accFile = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts", "<运营者的微信账号id>.json");
const acc = JSON.parse(await fs.readFile(accFile, "utf8"));
const dist = "C:/Users/followsun/.openclaw/npm/projects/tencent-weixin-openclaw-weixin-7783ac86ba/node_modules/@tencent-weixin/openclaw-weixin/dist";
const { uploadFileToWeixin } = await import(pathToFileURL(`${dist}/src/cdn/upload.js`));
const { UploadMediaType } = await import(pathToFileURL(`${dist}/src/api/types.js`));

const target = process.argv[2] || "C:/Users/followsun/.openclaw/media/emojis/惊喜.gif";
const stat = await fs.stat(target);
console.log(`测试文件: ${target} (${stat.size} 字节)`);

try {
  const r = await uploadFileToWeixin({
    filePath: target,
    toUserId: acc.userId,
    opts: { baseUrl: acc.baseUrl, token: acc.token },
    cdnBaseUrl: "",
  });
  console.log("✅ GIF 上传成功:", JSON.stringify({ filekey: r.filekey?.slice(0, 12) + "…", fileSize: r.fileSize }));
  console.log("   downloadEncryptedQueryParam 存在:", Boolean(r.downloadEncryptedQueryParam));
} catch (e) {
  console.log("❌ GIF 上传失败:", String(e?.message ?? e).slice(0, 500));
  process.exit(1);
}