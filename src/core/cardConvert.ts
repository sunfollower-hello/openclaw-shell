// persona-card ↔ SillyTavern CCv2 双向转换（PNG/JSON 角色卡标准）
import type { PersonaCard } from "./schema.js";
import { defaultCard } from "./schema.js";
import { newCardId, nowIso } from "./cardStore.js";

function merge<T extends object>(base: T, extra?: Partial<T>): T {
  return extra ? { ...base, ...extra } : base;
}

// 酒馆 extensions.position 是插入位置枚举，与「深度」是两个不同字段
const ST_POSITION_ENUM: Record<number, string> = {
  0: "before_char",
  1: "after_char",
  2: "global_note",
  3: "global_note",
  4: "at_depth",
};
const ST_POSITION_TO_NUM: Record<string, number> = {
  before_char: 0,
  after_char: 1,
  global_note: 2,
  at_depth: 4,
};

/** 酒馆世界书条目归一化：把 ST 存在 extensions 里的位置/概率/深度提取到顶层，供表单编辑显示 */
function normalizeStEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const exts = (raw.extensions ?? {}) as Record<string, unknown>;
  // 位置：顶层字符串优先；否则从 extensions.position 的数字枚举翻译
  let position = typeof raw.position === "string" && raw.position ? raw.position : "";
  if (!position && typeof exts.position === "number") position = ST_POSITION_ENUM[exts.position] ?? "before_char";
  return {
    ...raw,
    position: position || "before_char",
    probability:
      typeof raw.probability === "number"
        ? raw.probability
        : typeof exts.probability === "number"
          ? exts.probability
          : 100,
    // 深度只认 depth 字段（extensions.position 是位置枚举，不是深度）
    depth: typeof raw.depth === "number" ? raw.depth : typeof exts.depth === "number" ? exts.depth : 4,
  };
}

/** 导出前把顶层位置/概率/深度写回 extensions（ST 兼容；以本软件顶层值为准，保证界面上改的能生效） */
function denormalizeStEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const exts = { ...((raw.extensions ?? {}) as Record<string, unknown>) };
  if (typeof raw.probability === "number") exts.probability = raw.probability;
  if (typeof raw.depth === "number") exts.depth = raw.depth;
  if (typeof raw.position === "string") {
    const n = ST_POSITION_TO_NUM[raw.position];
    if (n !== undefined) exts.position = n;
  }
  return { ...raw, extensions: exts };
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
  // avatar 不放导出 JSON：封面以 PNG 图面承载（参考 RP-Hub），避免产物被 base64 撑到 10MB
  const { avatar: _avatar, ...identityRest } = card.identity ?? ({} as PersonaCard["identity"]);
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
        // 本软件的完整卡片数据：导出再导入要能原样还原（缺字段就等于备份即丢数据）
        openclaw_shell: {
          slug: card.slug,
          schema: card.schema,
          version: card.version,
          license: card.license,
          created_at: card.created_at,
          identity: identityRest, // 含 role/relation/bio/tags（avatar 已在上面剥离）
          voice: card.voice,
          personality: card.personality,
          memory: card.memory,
          knowledge: card.knowledge,
          presets: card.presets,
          tools: card.tools,
          chat: card.chat,
          variants: card.variants,
          abilities: card.abilities,
          memoryConfig: card.memoryConfig,
          model: card.model,
          emojis: card.emojis, // 图片文件不随卡走，但保留清单以便提示用户重新上传
          ethics: card.ethics,
          source: card.source,
          ...(card.procedural ? { procedural: card.procedural } : {}),
        },
        regex_scripts: st.regex_scripts ?? [],
      },
      character_book: {
        entries: (st.character_book?.entries ?? []).map((e) => denormalizeStEntry(e as Record<string, unknown>) as never),
      },
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

  const name = String(data.name ?? "导入角色").slice(0, 40) || "导入角色";
  // slug：本软件导出的卡优先复用原 slug（保证"导出→导入"是更新同一张卡，而不是变成乱码新卡）
  const savedSlug = typeof ours.slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(ours.slug) ? ours.slug : "";
  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const card = defaultCard(name, savedSlug || slugBase || `card-${Date.now().toString(36)}`);
  card.id = newCardId();
  card.created_at = typeof ours.created_at === "string" ? ours.created_at : nowIso();
  card.updated_at = nowIso();
  if (typeof ours.license === "string" && ours.license) card.license = ours.license;

  // 酒馆卡 description 是完整角色档案（可能很长）：一句话简介只放短文本，全长保留在 sillytavern_v2.description
  const fullDesc = String(data.description ?? "");
  if (fullDesc && fullDesc.length <= 500) {
    card.identity.bio = fullDesc;
  }
  if (Array.isArray(data.tags)) card.identity.tags = (data.tags as unknown[]).map(String).slice(0, 20);
  if (avatarDataUrl) card.identity.avatar = avatarDataUrl;
  card.identity.relation = name; // 第三方卡的默认值；本软件导出的卡会在下面被扩展里的 identity 覆盖

  // 本软件导出的卡：恢复扩展字段
  if (ours.voice) card.voice = merge(card.voice, ours.voice);
  if (ours.personality) card.personality = merge(card.personality, ours.personality);
  if (ours.memory) card.memory = merge(card.memory, ours.memory);
  if (ours.knowledge) card.knowledge = merge(card.knowledge, ours.knowledge);
  if (ours.presets) card.presets = merge(card.presets, ours.presets);
  if (ours.tools) card.tools = merge(card.tools, ours.tools);
  if (ours.chat) card.chat = merge(card.chat, ours.chat);
  if (ours.variants) card.variants = { ...card.variants, ...ours.variants };
  // 本软件专有配置（漏了这些等于"导出备份再导入"就丢表情包/模型/能力开关）
  if (ours.abilities) card.abilities = merge(card.abilities, ours.abilities);
  if (ours.memoryConfig) card.memoryConfig = merge(card.memoryConfig, ours.memoryConfig);
  if (ours.model) card.model = merge(card.model, ours.model);
  if (Array.isArray(ours.emojis)) card.emojis = ours.emojis;
  if (ours.ethics) card.ethics = merge(card.ethics, ours.ethics);
  if (ours.procedural) card.procedural = ours.procedural;
  // identity：先用扩展里的完整身份（含 role/relation/tags），再让下面的头像/简介覆盖
  if (ours.identity) {
    card.identity = merge(card.identity, { ...ours.identity, avatar: card.identity.avatar });
  }

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
      book && Array.isArray(book.entries)
        ? { entries: book.entries.map((e) => normalizeStEntry((e ?? {}) as Record<string, unknown>) as never) }
        : { entries: [] },
  };
  // 来源：本软件导出的卡保留原始来源（蒸馏卡的授权与脱敏记录不能丢），第三方卡才标记为导入
  card.source = ours.source
    ? ours.source
    : { kind: "import", inputs: [{ platform: "other", scope: "角色卡导入" }], consent: { granted: false } };
  return card;
}
