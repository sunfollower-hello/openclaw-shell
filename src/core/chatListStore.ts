// 通讯录（会话列表）状态：置顶标记等「列表层」的配置。
// 与角色卡本身无关（卡是人设，这里是"聊天列表怎么排"），所以单独一份文件，
// 删卡不影响、导入导出卡片也不会把别人的置顶带过来。
// 文件：data/chat-list.json → { pinned: { "<slug>": "<ISO 置顶时间>" } }
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "./cardStore.js";

export interface ChatListState {
  /** slug → 置顶时间（ISO）；多个置顶按置顶时间倒序排 */
  pinned: Record<string, string>;
}

function statePath(): string {
  return path.join(dataDir(), "chat-list.json");
}

export async function readChatListState(): Promise<ChatListState> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(), "utf8")) as Partial<ChatListState>;
    const pinned: Record<string, string> = {};
    if (raw?.pinned && typeof raw.pinned === "object") {
      for (const [k, v] of Object.entries(raw.pinned)) {
        if (typeof k === "string" && k && typeof v === "string" && v) pinned[k] = v;
      }
    }
    return { pinned };
  } catch {
    return { pinned: {} };
  }
}

async function writeChatListState(state: ChatListState): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

/** 置顶 / 取消置顶；返回置顶后的状态（true=当前为置顶） */
export async function setPinned(slug: string, pinned: boolean): Promise<boolean> {
  const state = await readChatListState();
  if (pinned) state.pinned[slug] = new Date().toISOString();
  else delete state.pinned[slug];
  await writeChatListState(state);
  return pinned;
}

/** 删卡时清掉它的置顶记录（不然置顶表会残留已不存在的 slug） */
export async function forgetChatListEntry(slug: string): Promise<void> {
  const state = await readChatListState();
  if (state.pinned[slug] === undefined) return;
  delete state.pinned[slug];
  await writeChatListState(state);
}
