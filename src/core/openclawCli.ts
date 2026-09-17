// OpenClaw CLI 封装：网页后端在本机执行 openclaw 命令（登录/状态/配对）
//
// 【CLI 入口怎么找】包管理器把 openclaw 装在「全局 node_modules」下，各平台路径不同：
//   Windows  %APPDATA%\npm\node_modules\openclaw\openclaw.mjs（nvm/npm 全局）
//   Linux    /usr/lib/node_modules/openclaw/openclaw.mjs（npm root -g，服务器实测就是这里）
//   macOS    /usr/local/lib/node_modules 或 /opt/homebrew/lib/node_modules
//   nvm/fnm  ~/.nvm/versions/node/<ver>/lib/node_modules/openclaw/openclaw.mjs
//
// **2026-09-17 修**：原来只认 Windows 的 APPDATA，且 Linux 上 APPDATA 为空时回退成
// `~/AppData/Roaming/npm/...`（= /root/AppData/...）→ 服务器上扫码登录直接
// `Cannot find module '/root/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs'`，
// 二维码永远出不来。现在按「显式环境变量 → 各平台常见全局根 → bin 软链真实目标 →
// `npm root -g`」依次解析，并缓存结果。装到别处可用 OPENCLAW_ENTRY 直接指定。
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logWarn } from "./logger.js";

let cachedEntry: string | null = null;

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 各平台可能的「全局 node_modules 根」 */
function globalRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    roots.push(path.join(appData, "npm", "node_modules"));
    const local = process.env.LOCALAPPDATA ?? "";
    if (local) roots.push(path.join(local, "npm", "node_modules"));
  } else {
    roots.push("/usr/lib/node_modules", "/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules");
    roots.push(path.join(home, ".npm-global", "lib", "node_modules"));
    roots.push(path.join(home, ".local", "lib", "node_modules"));
    // nvm / fnm：扫一层版本目录（装机方式千差万别，能扫到就省得用户配环境变量）
    for (const base of [
      path.join(home, ".nvm", "versions", "node"),
      path.join(home, ".local", "share", "fnm", "node-versions"),
    ]) {
      try {
        for (const v of fs.readdirSync(base)) {
          roots.push(path.join(base, v, "lib", "node_modules"));
          roots.push(path.join(base, v, "install", "lib", "node_modules"));
        }
      } catch {
        /* 没用 nvm/fnm */
      }
    }
  }
  return roots;
}

/** 从 PATH 里的 openclaw 可执行文件反查（bin 通常是指向 openclaw.mjs 的软链） */
function entryFromPathBin(): string | null {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("where", ["openclaw"], { encoding: "utf8", timeout: 5000, windowsHide: true })
        : execFileSync("/bin/sh", ["-c", "command -v openclaw"], { encoding: "utf8", timeout: 5000 });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      let real = p;
      try {
        real = fs.realpathSync(p);
      } catch {
        /* 用原路径试 */
      }
      if (real.endsWith("openclaw.mjs") && exists(real)) return real;
      // Windows 的 .cmd 包装脚本：同目录往上找 node_modules/openclaw/openclaw.mjs
      const near = path.join(path.dirname(real), "node_modules", "openclaw", "openclaw.mjs");
      if (exists(near)) return near;
    }
  } catch {
    /* 没装 / 不在 PATH */
  }
  return null;
}

export function openclawEntry(): string {
  if (process.env.OPENCLAW_ENTRY) return process.env.OPENCLAW_ENTRY;
  // 缓存失效会自动重解析：启动时没装、后来装上了也能用（不用重启服务）
  if (cachedEntry && exists(cachedEntry)) return cachedEntry;

  const cands = globalRoots().map((r) => path.join(r, "openclaw", "openclaw.mjs"));
  for (const c of cands) {
    if (exists(c)) {
      cachedEntry = c;
      return c;
    }
  }
  const viaBin = entryFromPathBin();
  if (viaBin) {
    cachedEntry = viaBin;
    return viaBin;
  }
  // 最后问 npm 自己（起进程慢，放最后）
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
    const p = path.join(root, "openclaw", "openclaw.mjs");
    if (exists(p)) {
      cachedEntry = p;
      return p;
    }
  } catch {
    /* 没有 npm */
  }
  // 都没找到：返回本平台最可能的路径，让上层报出可诊断的错误（而不是一个 Windows 路径）
  const fallback =
    process.platform === "win32"
      ? cands[0]
      : path.join("/usr", "lib", "node_modules", "openclaw", "openclaw.mjs");
  logWarn("openclawCli", `找不到 openclaw CLI（按 ${fallback} 试）；可用 OPENCLAW_ENTRY 指定入口`);
  cachedEntry = fallback;
  return fallback;
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

// ---------- 交互式命令（扫码登录）必须给 PTY ----------
// 【2026-09-17 实测】Linux 上直接 spawn `node openclaw.mjs channels login ...`：进程活着但
// **20 秒零字节输出**（stdout/stderr 都是空的），二维码永远等不到。套一层伪终端就正常：
//   script -qec "node .../openclaw.mjs channels login --channel qqbot" /dev/null
// 会打印 ASCII 二维码 + `QR 链接: https://q.qq.com/qqbot/openclaw/connect.html?task_id=...`。
// Windows 不需要（原行为可用），保持原样。
function ptyWrapper(): string | null {
  if (process.platform === "win32") return null;
  for (const p of ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"]) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

/** 拼一条安全的 shell 命令（参数全部单引号包裹） */
function shellJoin(parts: string[]): string {
  return parts.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

/**
 * 起一个「可能交互」的 openclaw 进程：Unix 套 PTY（否则扫码登录零输出），Windows 直起。
 * Unix 下用 detached 让子进程自成进程组，取消时能整组杀掉（不然 `script` 被杀、node 还挂着）。
 */
export function spawnOpenclawInteractive(args: string[]): ChildProcess {
  const entry = openclawEntry();
  if (process.platform === "win32") {
    return spawn("node", [entry, ...args], { windowsHide: true });
  }
  const wrap = ptyWrapper();
  if (!wrap) return spawn("node", [entry, ...args]); // 没有 script(1)：至少别崩，退回直起
  const cmd = shellJoin(["node", entry, ...args]);
  const opt = process.platform === "darwin" ? ["-q", "/dev/null", "node", entry, ...args] : ["-qec", cmd, "/dev/null"];
  return spawn(wrap, opt, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** 结束一个交互式进程（Unix 下连同进程组一起，避免 `script` 死了 node 还活着） */
export function killOpenclawInteractive(child: ChildProcess | null): void {
  if (!child) return;
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill();
  } catch {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }
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

/** 发起通道扫码登录的选项 */
export interface ChannelLoginOpts {
  /** 传给 CLI 的 --account 值。仅作用于本次进程，**不参与**登录状态的轮询键（前端轮询不带它）。
   *  微信设备登录传一次性 UUID：微信插件视其为"临时会话键"，不落持久别名、不做别名冲突检查，
   *  凭证最终落在真实 bot hash 名下——否则 CLI 会拿通道现有默认账号当请求 alias，与已有凭证必然冲突。 */
  cliAccount?: string;
  /** 登录状态轮询键的账号段（bot 级登录传 bot.accountId；通道页登录省略 → "default"） */
  keyAccount?: string;
  /** 发起设备（设备作用域登录时由路由传入；管理员/单用户为空 → 不做归属收尾） */
  deviceId?: string | null;
  /** CLI 进程成功退出（exit 0，凭证已落盘）后的宿主侧收尾：归属判定 / 他人残留清理 */
  onOk?: () => void | Promise<void>;
}

/** 发起通道扫码登录；带 accountId 时登录到指定渠道账号（多机器人用），否则登录默认账号 */
export function startChannelLogin(channel: string, accountIdOrOpts?: string | ChannelLoginOpts): ChannelLoginState {
  const opts: ChannelLoginOpts =
    typeof accountIdOrOpts === "string" ? { keyAccount: accountIdOrOpts, cliAccount: accountIdOrOpts } : accountIdOrOpts ?? {};
  const key = loginKey(channel, opts.keyAccount);
  const proc = loginProcs[key];
  if (proc && !proc.killed) return { ...logins[key] };
  logins[key] = { running: true, done: false, ok: false, output: "" };
  const args = ["channels", "login", "--channel", channel];
  if (opts.cliAccount) args.push("--account", opts.cliAccount);
  const child = spawnOpenclawInteractive(args);
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
    if (ok && opts.onOk) {
      // 归属/清理是宿主侧收尾（此刻凭证已落盘），异步执行、不阻塞登录状态返回
      void Promise.resolve()
        .then(opts.onOk)
        .catch((e) => console.error("[openclaw-cli] 登录成功收尾失败:", e instanceof Error ? e.message : String(e)));
    }
  };
  child.on("close", (code) => finish(code === 0));
  child.on("error", () => finish(false));
  // 兜底：用户关掉扫码弹窗后进程会继续挂着（实测能占 200MB+），到点强杀
  loginTimers[key] = setTimeout(() => {
    if (loginProcs[key] && !loginProcs[key]!.killed) {
      killOpenclawInteractive(loginProcs[key]);
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
  killOpenclawInteractive(proc);
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
