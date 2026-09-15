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

/** 用户根目录（确保存在） */
export function userRoot(deviceId: string): string {
  const root = path.join(baseDataDir(), "users", deviceId);
  if (!existsSync(root)) {
    // 目录懒创建：这里不强建，让第一次写数据的 store 自己 mkdir
    void root;
  }
  return root;
}
