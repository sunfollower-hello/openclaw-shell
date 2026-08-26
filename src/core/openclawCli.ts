// OpenClaw CLI 封装：网页后端在本机执行 openclaw 命令（登录/状态/配对）
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

export function openclawEntry(): string {
  if (process.env.OPENCLAW_ENTRY) return process.env.OPENCLAW_ENTRY;
  const appData = process.env.APPDATA ?? "";
  if (appData) return path.join(appData, "npm", "node_modules", "openclaw", "openclaw.mjs");
  return path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "openclaw", "openclaw.mjs");
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runOpenclaw(args: string[], opts: { timeoutMs?: number } = {}): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  return new Promise((resolve) => {
    const child = spawn("node", [openclawEntry(), ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
  });
}

// ---------- 通道扫码登录（长驻进程，输出轮询；channel 如 openclaw-weixin / qqbot） ----------
export interface ChannelLoginState {
  running: boolean;
  done: boolean;
  ok: boolean;
  output: string;
}

const logins: Record<string, ChannelLoginState> = {};
const loginProcs: Record<string, ChildProcess | null> = {};
const loginTimers: Record<string, NodeJS.Timeout | null> = {};

/** 扫码兜底超时：登录进程再久也不该常驻（微信侧自身等 480s，这里留点余量） */
const LOGIN_TIMEOUT_MS = 9 * 60 * 1000;

/** 统一 key：不带 accountId 时用 default，避免"通道页扫的码"和"机器人页扫的码"算成两条链各占一个进程 */
function loginKey(channel: string, accountId?: string): string {
  return `${channel}:${accountId || "default"}`;
}

function clearLoginTimer(key: string): void {
  const t = loginTimers[key];
  if (t) clearTimeout(t);
  loginTimers[key] = null;
}

/** 发起通道扫码登录；带 accountId 时登录到指定渠道账号（多机器人用），否则登录默认账号 */
export function startChannelLogin(channel: string, accountId?: string): ChannelLoginState {
  const key = loginKey(channel, accountId);
  const proc = loginProcs[key];
  if (proc && !proc.killed) return { ...logins[key] };
  logins[key] = { running: true, done: false, ok: false, output: "" };
  const args = ["channels", "login", "--channel", channel];
  if (accountId) args.push("--account", accountId);
  const child = spawn("node", [openclawEntry(), ...args], { windowsHide: true });
  loginProcs[key] = child;
  const append = (d: Buffer | string) => {
    const s = logins[key];
    s.output = (s.output + stripAnsi(d.toString())).slice(-16000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const finish = (ok: boolean, note?: string): void => {
    clearLoginTimer(key);
    const s = logins[key];
    if (!s) return;
    s.running = false;
    s.done = true;
    s.ok = ok;
    if (note) s.output = (s.output + "\n" + note).slice(-16000);
    loginProcs[key] = null;
  };
  child.on("close", (code) => finish(code === 0));
  child.on("error", () => finish(false));
  // 兜底：用户关掉扫码弹窗后进程会继续挂着（实测能占 200MB+），到点强杀
  loginTimers[key] = setTimeout(() => {
    if (loginProcs[key] && !loginProcs[key]!.killed) {
      try {
        loginProcs[key]!.kill();
      } catch {
        /* 已退出 */
      }
      finish(false, "（已超时，登录已取消，可重新扫码）");
    }
  }, LOGIN_TIMEOUT_MS);
  return { ...logins[key] };
}

/** 主动取消扫码：前端关掉弹窗/离开页面时调，立刻回收进程 */
export function cancelChannelLogin(channel: string, accountId?: string): boolean {
  const key = loginKey(channel, accountId);
  const proc = loginProcs[key];
  clearLoginTimer(key);
  if (!proc || proc.killed) return false;
  try {
    proc.kill();
  } catch {
    /* 已退出 */
  }
  loginProcs[key] = null;
  const s = logins[key];
  if (s) {
    s.running = false;
    s.done = true;
    s.ok = false;
  }
  return true;
}

export function getChannelLoginState(channel: string, accountId?: string): ChannelLoginState {
  const s = logins[loginKey(channel, accountId)];
  return s ? { ...s } : { running: false, done: false, ok: false, output: "" };
}

// 端口/进程存活检测由 scripts/start-stack.ps1 负责（PowerShell 侧），这里不再重复实现
