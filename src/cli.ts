// CLI 入口：openclaw-shell 卡库管理
// 用法: npm run cli -- <command> [options]
import { CardStore, dataDir, newCardId, nowIso } from "./core/cardStore.js";
import { defaultCard, RELATION_ROLES } from "./core/schema.js";
import { validateCard } from "./core/validator.js";
import { compileCard } from "./core/compiler.js";
import path from "node:path";

function usage(): void {
  console.log(`openclaw-shell CLI (v0.1)

用法:
  npm run cli -- create  --name <名称> [--slug <slug>] [--role <角色>]
  npm run cli -- list
  npm run cli -- view   <slug>
  npm run cli -- validate <slug | path.json>
  npm run cli -- compile <slug> [--workspace <目录>]
  npm run cli -- rm     <slug>

角色: ${RELATION_ROLES.join(" | ")}
数据目录: ${process.env.OPENCLAW_SHELL_DATA ?? "<项目>/data"}（可用 OPENCLAW_SHELL_DATA 覆盖）
`);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] ?? "";
      i++;
    }
  }
  return flags;
}

async function cmdCreate(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const name = flags.name;
  if (!name) {
    console.error("缺少 --name");
    usage();
    process.exit(1);
  }
  let slug = flags.slug;
  if (!slug) {
    slug = /^[a-z0-9][a-z0-9-]*$/.test(name.toLowerCase()) ? name.toLowerCase() : `persona-${Date.now().toString(36)}`;
  }
  const role = (flags.role ?? "friend") as (typeof RELATION_ROLES)[number];
  if (!RELATION_ROLES.includes(role)) {
    console.error(`无效角色: ${role}，可选 ${RELATION_ROLES.join(" | ")}`);
    process.exit(1);
  }

  const store = new CardStore();
  const card = defaultCard(name, slug);
  card.id = newCardId();
  card.created_at = nowIso();
  card.updated_at = nowIso();
  card.identity.role = role;
  card.identity.relation = role === "self" ? "我自己" : name;

  const result = validateCard(card);
  if (!result.ok) {
    console.error("创建失败，卡片未通过校验:");
    for (const e of result.errors) console.error("  ✗ " + e);
    process.exit(1);
  }
  await store.save(card);
  console.log(`✓ 已创建人设卡: ${name} (${slug}) [${role}]`);
  for (const w of result.warnings) console.log("  ⚠ " + w);
}

async function cmdList(): Promise<void> {
  const store = new CardStore();
  const metas = await store.list();
  if (metas.length === 0) {
    console.log("卡库为空。用 `npm run cli -- create --name 名字` 创建一张。");
    return;
  }
  console.log(`共 ${metas.length} 张卡:`);
  for (const m of metas) {
    console.log(`  ${m.slug.padEnd(20)} ${m.name}  [${m.role}] v${m.version}  ${m.updated_at ?? ""}`);
  }
}

async function cmdView(slug: string): Promise<void> {
  const store = new CardStore();
  const card = await store.get(slug);
  console.log(JSON.stringify(card, null, 2));
}

async function cmdValidate(target: string): Promise<void> {
  let input: unknown;
  if (target.endsWith(".json") || target.includes("/") || target.includes("\\") || target.endsWith(".JSON")) {
    const { promises: fs } = await import("node:fs");
    input = JSON.parse(await fs.readFile(target, "utf8"));
  } else {
    const store = new CardStore();
    input = await store.get(target);
  }
  const result = validateCard(input);
  if (result.ok) {
    console.log("✓ 校验通过");
  } else {
    console.log("✗ 校验失败:");
    for (const e of result.errors) console.log("  ✗ " + e);
  }
  for (const w of result.warnings) console.log("  ⚠ " + w);
  if (!result.ok) process.exitCode = 1;
}

async function cmdCompile(args: string[]): Promise<void> {
  const slug = args[0];
  const flags = parseFlags(args);
  if (!slug) {
    console.error("缺少 slug");
    usage();
    process.exit(1);
  }
  const store = new CardStore();
  const card = await store.get(slug);
  const workspace = flags.workspace ?? path.join(dataDir(), "workspace");
  const result = validateCard(card);
  if (!result.ok) {
    console.error("卡片未通过校验，拒绝编译:");
    for (const e of result.errors) console.error("  ✗ " + e);
    process.exit(1);
  }
  const out = await compileCard(card, workspace);
  console.log(`✓ 已编译 ${slug} → ${out.workspace}`);
  for (const f of out.files) console.log("  " + f);
  for (const w of result.warnings) console.log("  ⚠ " + w);
}

async function cmdRm(slug: string): Promise<void> {
  const store = new CardStore();
  await store.remove(slug);
  console.log(`✓ 已删除: ${slug}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "create":
      await cmdCreate(rest);
      break;
    case "list":
      await cmdList();
      break;
    case "view":
      await cmdView(rest[0]);
      break;
    case "validate":
      await cmdValidate(rest[0]);
      break;
    case "compile":
      await cmdCompile(rest);
      break;
    case "rm":
      await cmdRm(rest[0]);
      break;
    default:
      usage();
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
