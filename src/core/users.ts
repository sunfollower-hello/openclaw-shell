// 设备注册表：分发形态下没有账号体系，设备随机 ID 即身份。
// 注册表本身是全局的（在 baseDataDir()/users/registry.json，不在任何用户命名空间里），
// 管理员（Basic）可以列出/停用某个设备；被停用的设备请求按未认证处理。
import fs from "node:fs";
import path from "node:path";
import { baseDataDir, DEVICE_ID_RE } from "./dataRoot.js";

interface DeviceRecord {
  id: string;
  createdAt: string;
  label?: string;
  disabled?: boolean;
  /** 管理员设备：走全局 data/，能看到所有用户数据（运营者自己的设备用） */
  admin?: boolean;
  lastSeen?: string;
}

interface Registry {
  devices: DeviceRecord[];
}

let cache: { data: Registry; at: number } | null = null;
const CACHE_MS = 3000;

function registryPath(): string {
  return path.join(baseDataDir(), "users", "registry.json");
}

function load(): Registry {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.data;
  let data: Registry = { devices: [] };
  try {
    const raw = fs.readFileSync(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Registry;
    if (Array.isArray(parsed.devices)) data = parsed;
  } catch {
    /* 首次不存在 */
  }
  cache = { data, at: now };
  return data;
}

function save(data: Registry): void {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  cache = { data, at: Date.now() };
}

/** 校验并登记设备；返回是否可用（格式合法且未被停用）。不合法/被停用都返回 false */
export function ensureDevice(id: string): boolean {
  if (!DEVICE_ID_RE.test(id)) return false;
  const reg = load();
  let rec = reg.devices.find((d) => d.id === id);
  if (!rec) {
    rec = { id, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
    reg.devices.push(rec);
    save(reg);
    return true;
  }
  if (rec.disabled) return false;
  if (!rec.lastSeen || Date.now() - Date.parse(rec.lastSeen) > 3600_000) {
    rec.lastSeen = new Date().toISOString();
    save(reg);
  }
  return true;
}

export function deviceDisabled(id: string): boolean {
  if (!DEVICE_ID_RE.test(id)) return true;
  return !!load().devices.find((d) => d.id === id)?.disabled;
}

export function listDevices(): DeviceRecord[] {
  return load().devices.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export function isDeviceAdmin(id: string): boolean {
  if (!DEVICE_ID_RE.test(id)) return false;
  return !!load().devices.find((d) => d.id === id)?.admin;
}

export function setDeviceAdmin(id: string, admin: boolean): boolean {
  if (!DEVICE_ID_RE.test(id)) return false;
  const reg = load();
  const rec = reg.devices.find((d) => d.id === id);
  if (!rec) return false;
  rec.admin = admin || undefined;
  save(reg);
  return true;
}

export function setDeviceDisabled(id: string, disabled: boolean): boolean {
  if (!DEVICE_ID_RE.test(id)) return false;
  const reg = load();
  const rec = reg.devices.find((d) => d.id === id);
  if (!rec) return false;
  rec.disabled = disabled || undefined;
  save(reg);
  return true;
}

/**
 * 设备标记（管理员用的"昵称"，只为方便在列表里搜索；可为空 = 取消标记）。
 * 存在注册表里，而注册表只经 `/api/users`（管理员专属端点）返回 —— **设备端拿不到**，
 * 所以这个标记不会传给任何用户，也不会进仓库（data/ 在 .gitignore 里）。
 */
export function setDeviceLabel(id: string, label: string): boolean {
  if (!DEVICE_ID_RE.test(id)) return false;
  const reg = load();
  const rec = reg.devices.find((d) => d.id === id);
  if (!rec) return false;
  const v = String(label ?? "").trim().slice(0, 40);
  if (v) rec.label = v;
  else delete rec.label;
  save(reg);
  return true;
}
