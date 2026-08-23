// 人设卡校验器：结构校验（zod）+ 业务规则校验
import { personaCardSchema, type PersonaCard } from "./schema.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateCard(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 结构校验
  const parsed = personaCardSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      errors.push(`${path}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }
  const card: PersonaCard = parsed.data;

  // 2. 业务规则校验
  if (card.source.kind === "distill") {
    if (!card.source.consent.granted) {
      warnings.push("蒸馏卡未记录知情同意（source.consent.granted = false），公开发布前请补全");
    }
    if (!card.ethics.redacted) {
      errors.push("蒸馏卡必须完成脱敏：ethics.redacted 应为 true");
    }
  }

  if (card.source.inputs.length === 0 && card.source.kind === "distill") {
    warnings.push("蒸馏卡缺少来源记录（source.inputs 为空）");
  }

  // 证据分级检查：impression 只允许出现在明确允许的维度
  const memoryItems = [
    ...card.memory.facts,
    ...card.memory.timeline,
    ...card.memory.relationships,
  ];
  if (memoryItems.some((m) => m.evidence === "impression")) {
    warnings.push("记忆库中存在 impression 级证据，对话时应降低确定性");
  }

  // 知识边界完整性
  if (card.knowledge.known.length === 0 && card.knowledge.unknown.length === 0) {
    warnings.push("知识边界未填写（known/unknown 都为空），AI 容易编造");
  }

  // 人格设定完整性：语音规则或世界书（人物形象/常驻条目）至少有一处承载人格
  const hasWorldbookProfile = Boolean(
    card.sillytavern_v2?.description?.trim() ||
      (card.sillytavern_v2?.character_book?.entries ?? []).some((e) => e.enabled !== false && String(e.content ?? "").trim())
  );
  if (card.voice.tone_rules.length === 0 && card.voice.catchphrases.length === 0 && !hasWorldbookProfile) {
    warnings.push("人格设定为空：语音规则和世界书都没有内容，这张卡会是空的（在世界书「人物形象」里写角色定义）");
  }

  // 语录样本的脱敏抽查：出现手机号/邮箱即报错
  const phoneRe = /1[3-9]\d{9}/;
  const emailRe = /[\w.-]+@[\w-]+(\.[\w-]+)+/;
  for (const q of card.voice.quotes) {
    if (phoneRe.test(q.text) || emailRe.test(q.text)) {
      errors.push(`语录样本疑似含未脱敏 PII：${q.text.slice(0, 30)}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
