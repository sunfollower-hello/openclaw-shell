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

/** 发起通道扫码登录；带 accountId 时登录到指定渠道账号（多机器人用），否则登录默认账号（兼容旧通道页） */
export function startChannelLogin(channel: string, accountId?: string): ChannelLoginState {
  const key = accountId ? `${channel}:${accountId}` : channel;
  const proc = loginProcs[key];
  if (proc && !proc.killed) return { ...logins[key] };
  logins[key] = { running: true, done: false, ok: false, output: "" };
  const args = ["channels", "login", "--channel", channel];
  if (accountId) args.push("--account", accountId);
  loginProcs[key] = spawn("node", [openclawEntry(), ...args], {
    windowsHide: true,
  });
  const append = (d: Buffer | string) => {
    const s = logins[key];
    s.output = (s.output + stripAnsi(d.toString())).slice(-16000);
  };
  loginProcs[key]?.stdout?.on("data", append);
  loginProcs[key]?.stderr?.on("data", append);
  loginProcs[key]?.on("close", (code) => {
    const s = logins[key];
    s.running = false;
    s.done = true;
    s.ok = code === 0;
    loginProcs[key] = null;
  });
  loginProcs[key]?.on("error", () => {
    const s = logins[key];
    s.running = false;
    s.done = true;
    s.ok = false;
    loginProcs[key] = null;
  });
  return { ...logins[key] };
}

export function getChannelLoginState(channel: string, accountId?: string): ChannelLoginState {
  const key = accountId ? `${channel}:${accountId}` : channel;
  const s = logins[key];
  return s ? { ...s } : { running: false, done: false, ok: false, output: "" };
}

// 端口/进程存活检测由 scripts/start-stack.ps1 负责（PowerShell 侧），这里不再重复实现
