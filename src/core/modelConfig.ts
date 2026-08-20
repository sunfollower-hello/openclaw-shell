// 模型配置：读取/写入 ~/.openclaw/openclaw.json 的 models.providers + 默认模型
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function configPath(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

export interface ProviderInfo {
  name: string;
  baseUrl: string;
  apiKey: string; // 脱敏显示
  api: string;
  models: string[];
}

export interface ModelConfig {
  primary: string;
  providers: ProviderInfo[];
}

export async function getModelConfig(): Promise<ModelConfig> {
  const cfg = JSON.parse(await fs.readFile(configPath(), "utf8"));
  const providers = cfg.models?.providers ?? {};
  const list: ProviderInfo[] = Object.entries(providers).map(([name, pv]) => {
    const p = pv as { baseUrl?: string; apiKey?: string; api?: string; models?: { id?: string }[] };
    const key = p.apiKey ?? "";
    return {
      name,
      baseUrl: p.baseUrl ?? "",
      apiKey: key.startsWith("${") ? key : key ? key.slice(0, 6) + "…" : "",
      api: p.api ?? "",
      models: (p.models ?? []).map((m) => m.id ?? "").filter(Boolean),
    };
  });
  return { primary: cfg.agents?.defaults?.model?.primary ?? "", providers: list };
}

export async function saveModelConfig(input: {
  name: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  setDefault: boolean;
}): Promise<void> {
  const cfgPath = configPath();
  const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  cfg.models = cfg.models ?? {};
  cfg.models.providers = cfg.models.providers ?? {};
  const prev = cfg.models.providers[input.name];
  cfg.models.providers[input.name] = {
    baseUrl: input.baseUrl,
    api: "openai-completions",
    apiKey: input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : (prev?.apiKey ?? ""),
    models: [{ id: input.modelId, name: input.modelId }],
  };
  if (input.setDefault) {
    cfg.agents = cfg.agents ?? {};
    cfg.agents.defaults = cfg.agents.defaults ?? {};
    cfg.agents.defaults.model = { primary: `${input.name}/${input.modelId}` };
  }
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
}

export async function testModelEndpoint(
  baseUrl: string,
  apiKey: string,
  modelId: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    if (r.ok) return { ok: true, status: r.status };
    const body = await r.text().catch(() => "");
    return { ok: false, status: r.status, error: body.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 取默认模型提供商的完整凭证（蒸馏等后台任务用；apiKey 为明文） */
export interface ModelLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function getModelLLMConfig(): Promise<ModelLLMConfig | null> {
  try {
    const cfg = JSON.parse(await fs.readFile(configPath(), "utf8"));
    const providers = cfg.models?.providers ?? {};
    const primary: unknown = cfg.agents?.defaults?.model?.primary ?? "";
    const primaryStr = typeof primary === "string" ? primary : "";
    const [provName, modelId] = primaryStr.split("/");
    const p = providers[provName] ?? Object.values(providers)[0];
    if (!p) return null;
    const list = (p.models ?? []) as { id?: string }[];
    const m = list.find((x) => x.id === modelId) ?? list[0];
    return {
      baseUrl: p.baseUrl ?? "",
      apiKey: p.apiKey ?? "",
      model: m?.id ?? modelId ?? "",
    };
  } catch {
    return null;
  }
}
