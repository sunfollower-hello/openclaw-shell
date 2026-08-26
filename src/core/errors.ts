// 把内部报错翻译成用户能看懂的话。
// 直接 String(e) 会把绝对路径、zod 字段路径、fetch failed、CLI 原始输出都糊到界面上，
// 用户既看不懂也无从下手；原文进运行日志（设置页可查），排查不受影响。
import { logError } from "./logger.js";
export function toUserError(e: unknown, fallback = "操作没成功，请再试一次", tag = "系统"): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (!raw) return fallback;
  // 原文进日志（设置页能直接看），返回给用户的是翻译后的人话
  logError(tag, raw.split("\n")[0].slice(0, 200), raw);

  const code = (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code ?? "";

  // 网络类
  if (/ENOTFOUND|EAI_AGAIN/i.test(code + raw)) return "连不上服务器，检查一下网络或地址是否填对";
  if (/ECONNREFUSED/i.test(code + raw)) return "对方服务没在运行（连接被拒绝）";
  if (/CONNECT_TIMEOUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code + raw)) return "连接超时，对方服务可能访问不了";
  if (/AbortError|The operation was aborted|timeout/i.test(raw)) return "等太久超时了，稍后再试";
  if (/fetch failed/i.test(raw)) return "网络请求失败，检查网络或对方服务是否可用";

  // 文件类：绝对路径不要给用户看
  if (/ENOENT/i.test(code + raw)) return "要找的文件不存在（可能已被删除或还没生成）";
  if (/EACCES|EPERM/i.test(code + raw)) return "没有权限读写这个文件";
  if (/EBUSY/i.test(code + raw)) return "文件正被占用，稍后再试";
  if (/ENOSPC/i.test(code + raw)) return "磁盘空间不足";

  // 上游返回的 HTTP 状态
  const status = raw.match(/\b(4\d\d|5\d\d)\b/)?.[1];
  if (status === "401" || /invalid api key|unauthorized/i.test(raw)) return "密钥无效或已过期，去对应页面重新填一下";
  if (status === "402" || /insufficient|quota|balance/i.test(raw)) return "账户余额或额度不够了";
  if (status === "403") return "对方拒绝了这次请求（可能是密钥权限不足）";
  if (status === "404" && /model/i.test(raw)) return "这个模型不存在，换一个再试";
  if (status === "429") return "请求太频繁被限流了，等一会儿再试";
  if (status && /^5/.test(status)) return "对方服务出错了（不是本机的问题），稍后再试";

  // zod 校验：把 a.b.c: Expected string, received null 这种翻成人话
  if (/Expected .*received|Required|Invalid input|invalid_type/i.test(raw)) {
    return "内容格式不对，可能是这张卡里有不合规的字段（换个文件或检查填写内容）";
  }
  if (/JSON|Unexpected token/i.test(raw)) return "文件内容不是合法格式，确认下选的文件对不对";

  // 已经是中文提示的（我们自己 throw 的），原样用
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw.replace(/^Error:\s*/, "").slice(0, 200);

  return fallback;
}
