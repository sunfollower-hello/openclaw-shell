// openclaw-shell 生图工具插件：让 QQ/微信里的机器人也能调用 image_gen 并把图片发出去
// 生图核心复用 openclaw-shell 的 dist/core/imageGen.js（同一份 data/imageConfig.json 配置）
// 图片保存到 ~/.openclaw/media（QQ 插件白名单目录；微信插件吃本地绝对路径）
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import os from "node:os";
import path from "node:path";

const MEDIA_DIR = path.join(os.homedir(), ".openclaw", "media");
// openclaw-shell 编译产物位置（本机固定；可用环境变量覆盖）
const SHELL_IMAGE_GEN_ENTRY =
  process.env.OPENCLAW_SHELL_IMAGE_GEN_ENTRY ??
  "file:///D:/ai_workspace/openclaw-shell/dist/core/imageGen.js";

export default definePluginEntry({
  id: "openclaw-shell-imagegen",
  name: "Openclaw Shell Imagegen",
  description:
    "openclaw-shell 生图工具：NovelAI / OpenAI 兼容 / 本地 SD WebUI，配置与网页端共用 data/imageConfig.json",
  register(api) {
    api.registerTool({
      name: "image_gen",
      label: "生图（AI 绘画）",
      description:
        "根据文字描述生成图片并发送给用户（需先在 openclaw-shell 网页「生图配置」页配置提供商与 Key）。参数 prompt 为绘画提示词（必须用英文 Danbooru 标签风格：逗号分隔、含角色/服饰/动作/场景/光线/画质词，不要用自然语言），negative 为负面词（可选），aspect 为比例（square 方图/portrait 竖图/landscape 横图，可选），seed 为随机种子（可选）。内容尺度：图片必须得体（SFW），即使对话氛围开放也绝不使用裸体/性相关标签（nude、nsfw、nipples、explicit 等），用完整衣着与含蓄描述表达。生成成功后图片会随你的回复发送出去。",
      parameters: Type.Object({
        prompt: Type.String({ description: "绘画提示词" }),
        negative: Type.Optional(Type.String({ description: "负面提示词（可选）" })),
        aspect: Type.Optional(
          Type.String({ description: "比例：square/portrait/landscape（方图/竖图/横图）" })
        ),
        seed: Type.Optional(Type.Number({ description: "随机种子（可选，固定可复现同一张图）" })),
      }),
      async execute(_id, params) {
        const { generateImage } = await import(/* @vite-ignore */ SHELL_IMAGE_GEN_ENTRY);
        const p = (params ?? {}) as { prompt?: unknown; negative?: unknown; aspect?: unknown; seed?: unknown };
        const res = await generateImage(
          {
            prompt: String(p.prompt ?? ""),
            negative: p.negative ? String(p.negative) : undefined,
            aspect: p.aspect ? String(p.aspect) : undefined,
            seed: typeof p.seed === "number" ? p.seed : undefined,
          },
          MEDIA_DIR
        );
        if (!res.ok) {
          return { content: [{ type: "text", text: `生图失败：${res.error ?? "未知错误"}` }] } as never;
        }
        const filePath = res.file ?? "";
        const name = filePath.split(/[\\/]/).pop() ?? "gen.png";
        const attachment = { type: "image", path: filePath, mimeType: res.mimeType ?? "image/png", name };
        // 双保险：文本带 MEDIA: 指令行（核心层解析）+ 结构化 mediaUrl/mediaUrls/attachments（自动投递）
        const text = `已生成图片：${filePath}\nMEDIA:${filePath}`;
        // 运行时允许携带 attachments/mediaUrls 等投递字段（内置 image_generate 同款结构）；
        // 编译期 AgentToolResult 类型较窄，这里按运行时协议返回
        return {
          content: [{ type: "text", text }],
          mediaUrl: filePath,
          mediaUrls: [filePath],
          attachments: [attachment],
          paths: [filePath],
          details: {
            media: { mediaUrls: [filePath], attachments: [attachment] },
            attachments: [attachment],
            paths: [filePath],
          },
        } as never;
      },
    });
  },
});
