// OpenClaw CLI 封装：网页后端在本机执行 openclaw 命令（登录/状态/配对）
import { spawn, execFile, type ChildProcess } from "node:child_process";
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

export function startChannelLogin(channel: string): ChannelLoginState {
  const proc = loginProcs[channel];
  if (proc && !proc.killed) return { ...logins[channel] };
  logins[channel] = { running: true, done: false, ok: false, output: "" };
  loginProcs[channel] = spawn("node", [openclawEntry(), "channels", "login", "--channel", channel], {
    windowsHide: true,
  });
  const append = (d: Buffer | string) => {
    const s = logins[channel];
    s.output = (s.output + stripAnsi(d.toString())).slice(-16000);
  };
  loginProcs[channel]?.stdout?.on("data", append);
  loginProcs[channel]?.stderr?.on("data", append);
  loginProcs[channel]?.on("close", (code) => {
    const s = logins[channel];
    s.running = false;
    s.done = true;
    s.ok = code === 0;
    loginProcs[channel] = null;
  });
  loginProcs[channel]?.on("error", () => {
    const s = logins[channel];
    s.running = false;
    s.done = true;
    s.ok = false;
    loginProcs[channel] = null;
  });
  return { ...logins[channel] };
}

export function getChannelLoginState(channel: string): ChannelLoginState {
  const s = logins[channel];
  return s ? { ...s } : { running: false, done: false, ok: false, output: "" };
}

/** 兼容旧名：微信登录 */
export function startWechatLogin(): ChannelLoginState {
  return startChannelLogin("openclaw-weixin");
}
export function getWechatLoginState(): ChannelLoginState {
  return getChannelLoginState("openclaw-weixin");
}

// ---------- 进程/端口检测 ----------
export function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", `$null -ne (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`],
      { windowsHide: true },
      (err, stdout) => resolve(!err && stdout.trim().toLowerCase() === "true")
    );
  });
}

export function processCount(match: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.Name -match '${match}' -or $_.CommandLine -match '${match}') } | Measure-Object).Count`,
      ],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(0);
        const n = parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(n) ? n : 0);
      }
    );
  });
}
