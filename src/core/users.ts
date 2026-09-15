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

export function setDeviceDisabled(id: string, disabled: boolean): boolean {
  if (!DEVICE_ID_RE.test(id)) return false;
  const reg = load();
  const rec = reg.devices.find((d) => d.id === id);
  if (!rec) return false;
  rec.disabled = disabled || undefined;
  save(reg);
  return true;
}
