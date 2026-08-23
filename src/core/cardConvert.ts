// persona-card ↔ SillyTavern CCv2 双向转换（PNG/JSON 角色卡标准）
import type { PersonaCard } from "./schema.js";
import { defaultCard } from "./schema.js";
import { newCardId, nowIso } from "./cardStore.js";

function merge<T extends object>(base: T, extra?: Partial<T>): T {
  return extra ? { ...base, ...extra } : base;
}

/** persona 卡 → CCv2 JSON（本软件扩展数据放 extensions.openclaw_shell，保证导出导入不丢东西） */
export function cardToCCv2(card: PersonaCard): Record<string, unknown> {
  const st = card.sillytavern_v2 ?? {
    chara_card_v2: "0.0.1",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    alternate_greetings: [],
    regex_scripts: [],
    character_book: { entries: [] },
  };
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: card.name,
      description: st.description || card.identity.bio || "",
      personality: st.personality || card.personality.traits.join("、"),
      scenario: st.scenario || "",
      first_mes: st.first_mes || "",
      mes_example: st.mes_example || "",
      creator_notes: `由 openclaw-shell 导出（${card.slug}）`,
      system_prompt: "",
      post_history_instructions: "",
      tags: card.identity.tags ?? [],
      creator: "openclaw-shell",
      character_version: `v${card.version}`,
      alternate_greetings: st.alternate_greetings ?? [],
      extensions: {
        openclaw_shell: {
          slug: card.slug,
          schema: card.schema,
          voice: card.voice,
          personality: card.personality,
          memory: card.memory,
          knowledge: card.knowledge,
          presets: card.presets,
          tools: card.tools,
          chat: card.chat,
          variants: card.variants,
        },
        regex_scripts: st.regex_scripts ?? [],
      },
      character_book: st.character_book ?? { entries: [] },
    },
  };
}

/** CCv2 JSON（{data:{...}} 或平铺）→ persona 卡 */
export function ccv2ToCard(cc: unknown, avatarDataUrl?: string): PersonaCard {
  const root = (cc ?? {}) as {
    data?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
  const data = (root.data ?? root) as Record<string, unknown>;
  const exts = (data.extensions ?? {}) as Record<string, unknown>;
  const ours = (exts.openclaw_shell ?? {}) as Partial<PersonaCard>;

  const name = String(data.name ?? "导入角色").slice(0, 40);
  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const card = defaultCard(name, slugBase || `card-${Date.now().toString(36)}`);
  card.id = newCardId();
  card.created_at = nowIso();
  card.updated_at = nowIso();

  // 酒馆卡 description 是完整角色档案（可能很长）：一句话简介只放短文本，全长保留在 sillytavern_v2.description
  const fullDesc = String(data.description ?? "");
  if (fullDesc && fullDesc.length <= 500) {
    card.identity.bio = fullDesc;
  }
  if (Array.isArray(data.tags)) card.identity.tags = (data.tags as unknown[]).map(String).slice(0, 20);
  if (avatarDataUrl) card.identity.avatar = avatarDataUrl;
  card.identity.relation = name;

  // 本软件导出的卡：恢复扩展字段
  if (ours.voice) card.voice = merge(card.voice, ours.voice);
  if (ours.personality) card.personality = merge(card.personality, ours.personality);
  if (ours.memory) card.memory = merge(card.memory, ours.memory);
  if (ours.knowledge) card.knowledge = merge(card.knowledge, ours.knowledge);
  if (ours.presets) card.presets = merge(card.presets, ours.presets);
  if (ours.tools) card.tools = merge(card.tools, ours.tools);
  if (ours.chat) card.chat = merge(card.chat, ours.chat);
  if (ours.variants) card.variants = { ...card.variants, ...ours.variants };

  const book = data.character_book as { entries?: unknown[] } | undefined;
  card.sillytavern_v2 = {
    chara_card_v2: "0.0.1",
    description: String(data.description ?? ""),
    personality: String(data.personality ?? ""),
    scenario: String(data.scenario ?? ""),
    first_mes: String(data.first_mes ?? ""),
    mes_example: String(data.mes_example ?? ""),
    alternate_greetings: Array.isArray(data.alternate_greetings)
      ? (data.alternate_greetings as unknown[]).map(String)
      : [],
    regex_scripts: Array.isArray(exts.regex_scripts) ? (exts.regex_scripts as Record<string, unknown>[]) : [],
    character_book:
      book && Array.isArray(book.entries) ? { entries: book.entries as never[] } : { entries: [] },
  };
  card.source = { kind: "import", inputs: [{ platform: "other", scope: "角色卡导入" }], consent: { granted: false } };
  return card;
}
