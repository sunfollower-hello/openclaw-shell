// 数据根目录与多租户作用域。
// 分发形态：每个设备一个随机 ID（App 首次启动生成，存本地 + cookie），服务端按 ID 分命名空间
// （data/users/<id>/...）。设备 ID 经 AsyncLocalStorage 在整条请求链路里传播，
// dataDir() 在作用域内自动返回该用户的根目录；管理员（Basic 认证）与 CLI 不带作用域 = 全局 data/。
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { existsSync } from "node:fs";
import { findProjectRoot } from "./cardStore.js";

export interface UserScope {
  deviceId: string;
  root: string; // data/users/<deviceId>
}

const als = new AsyncLocalStorage<UserScope>();

/** 设备 ID：32 位小写十六进制（16 字节随机），同时用作目录名，严格校验防路径穿越 */
export const DEVICE_ID_RE = /^[a-f0-9]{32}$/;

export function baseDataDir(): string {
  return process.env.OPENCLAW_SHELL_DATA ?? path.join(findProjectRoot(), "data");
}

/** 请求作用域内 = 该设备用户的根目录；管理员（Basic）/CLI/网关内部调用 = 全局 data/ */
export function dataDir(): string {
  const scope = als.getStore();
  return scope ? scope.root : baseDataDir();
}

/** 在某设备用户的作用域里执行整条下游中间件/处理链 */
export function runAsUser<T>(scope: UserScope, fn: () => T): T {
  return als.run(scope, fn);
}

/**
 * 当前请求属于哪台设备（管理员/CLI/启动期定时器返回 null）。
 * 用途：把「本机共享资源」里的标识也按设备隔离——agents.list 的 agentId、
 * openclaw.json 里的模型提供商名都是全局命名空间，不加设备前缀就会跨用户撞车
 * （两台设备各有一张同名卡 → 同一个 agentId → 互相顶掉）。见 botStore.deviceAgentId。
 */
export function currentDeviceId(): string | null {
  return als.getStore()?.deviceId ?? null;
}

/** 设备短码：给全局标识当命名空间前缀（8 位十六进制，够区分且不占宽度） */
export function devicePrefix(): string {
  const id = currentDeviceId();
  return id ? `u${id.slice(0, 8)}-` : "";
}

/** 用户根目录（确保存在） */
export function userRoot(deviceId: string): string {
  const root = path.join(baseDataDir(), "users", deviceId);
  if (!existsSync(root)) {
    // 目录懒创建：这里不强建，让第一次写数据的 store 自己 mkdir
    void root;
  }
  return root;
}
