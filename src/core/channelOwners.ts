// 渠道账号归属：**一张全局表**（不在任何设备命名空间里），记录「这个 QQ/微信账号是谁扫码绑的」。
//
// 为什么必须有这张表：一台服务器只有一个网关、一份 openclaw.json —— 所有人的渠道凭证都在里面，
// 而账号 id 是平台下发的（QQ 是登录时我们自己起的 qq-xxxx，微信是服务器下发的 xxx-im-bot）。
// 没有归属记录的话，"列出账号"就等于把别人（尤其是运营者自己）的账号摊给用户看，甚至能被删掉。
//
// 约定：
//   - 有记录 → 归那台设备（deviceId）；设备只能看见/操作自己的。
//   - 没记录 → 视为**运营者（管理员）的**（老账号都在这类里），设备看不见也动不了 —— 保守优先。
//   - 管理员作用域（currentDeviceId() 为空）不做任何过滤，照旧看全部。
//
// "扫码那一刻还不知道真实账号 id"的问题（微信是登录成功后才下发 id）用**待领取快照**解决：
// 设备点扫码时先记下"当前该通道已有哪些账号"，之后扫描时凡是**不在快照里的新账号**就归这台设备，
// 这样绝不会把管理员的老账号误判成用户新扫的。
import fs from "node:fs";
import path from "node:path";
import { baseDataDir } from "./dataRoot.js";

interface OwnersFile {
  /** "channel:accountId" → deviceId */
  owners: Record<string, string>;
  /** 待领取：channel → { deviceId, known:[已有的账号id], at } */
  claims: Record<string, { deviceId: string; known: string[]; at: number }>;
}

const CLAIM_TTL_MS = 30 * 60 * 1000; // 一次扫码流程最长认 30 分钟

let cache: { data: OwnersFile; at: number } | null = null;
const CACHE_MS = 2000;

function file(): string {
  return path.join(baseDataDir(), "channel-owners.json");
}

function load(): OwnersFile {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.data;
  let data: OwnersFile = { owners: {}, claims: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as OwnersFile;
    if (raw && typeof raw === "object") {
      data = { owners: raw.owners ?? {}, claims: raw.claims ?? {} };
    }
  } catch {
    /* 首次不存在 */
  }
  cache = { data, at: now };
  return data;
}

function save(data: OwnersFile): void {
  const p = file();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  cache = { data, at: Date.now() };
}

const key = (channel: string, accountId: string): string => `${channel}:${accountId}`;

/** 该账号归谁（null = 没有记录，按"运营者的老账号"对待） */
export function accountOwner(channel: string, accountId: string): string | null {
  return load().owners[key(channel, accountId)] ?? null;
}

/** 设归属（deviceId 传空表示收回归运营者） */
export function setAccountOwner(channel: string, accountId: string, deviceId: string | null): void {
  const d = load();
  if (!deviceId) delete d.owners[key(channel, accountId)];
  else d.owners[key(channel, accountId)] = deviceId;
  save(d);
}

/** 账号被彻底删除时清掉归属（槽位释放后 id 可能被复用） */
export function clearAccountOwner(channel: string, accountId: string): void {
  const d = load();
  delete d.owners[key(channel, accountId)];
  for (const [ch, c] of Object.entries(d.claims)) {
    if (ch !== channel) continue;
    c.known = c.known.filter((x) => x !== accountId);
  }
  save(d);
}

/** 账号改名/占位名换成真实 id 时搬归属 */
export function moveAccountOwner(channel: string, fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  const d = load();
  const owner = d.owners[key(channel, fromId)];
  if (owner) d.owners[key(channel, toId)] = owner;
  delete d.owners[key(channel, fromId)];
  save(d);
}

/** 该设备是否拥有这个账号（严格：必须有记录且就是它） */
export function ownsAccount(channel: string, accountId: string, deviceId: string | null): boolean {
  if (!deviceId) return true; // 管理员/单用户：不限制
  return accountOwner(channel, accountId) === deviceId;
}

/**
 * 设备开始一次扫码：记下当前该通道已有的账号 id 快照，之后出现的新账号才算它的。
 * known 由调用方（server）用全局扫描结果填。
 */
export function beginLoginClaim(channel: string, deviceId: string, knownNow: string[]): void {
  const d = load();
  d.claims[channel] = { deviceId, known: [...knownNow], at: Date.now() };
  save(d);
}

/** 扫码流程结束时清掉待领取（成功或用户放弃都调） */
export function endLoginClaim(channel: string, deviceId: string): void {
  const d = load();
  const c = d.claims[channel];
  if (c && c.deviceId === deviceId) {
    delete d.claims[channel];
    save(d);
  }
}

/**
 * 扫描到账号时调用：把"不在快照里的新账号"判给正在扫码的那台设备。
 * 返回本次新认领的账号 id 列表（供日志/调试）。
 */
export function claimNewAccounts(channel: string, currentIds: string[]): string[] {
  const d = load();
  const c = d.claims[channel];
  if (!c) return [];
  if (Date.now() - c.at > CLAIM_TTL_MS) {
    delete d.claims[channel];
    save(d);
    return [];
  }
  const claimed: string[] = [];
  for (const id of currentIds) {
    if (c.known.includes(id)) continue; // 老账号（含运营者的）永不认领
    if (d.owners[key(channel, id)]) continue; // 已有归属
    d.owners[key(channel, id)] = c.deviceId;
    claimed.push(id);
  }
  if (claimed.length) {
    c.known = [...c.known, ...claimed]; // 记进快照，避免重复"新账号"判定
    save(d);
  }
  return claimed;
}

/** 维护用：列出某台设备名下的账号 */
export function listOwnedAccounts(deviceId: string): string[] {
  return Object.entries(load().owners)
    .filter(([, dev]) => dev === deviceId)
    .map(([k]) => k);
}
