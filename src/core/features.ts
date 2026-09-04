// 功能开关：有争议或暂时难做好的能力整体关闭——不只是界面隐藏，后端也真的不启用。
// 前端有一份同名开关（web/app.js 里的 FEATURES），两边都关才算没启用。
// 将来要开：把对应项改 true（并同步前端），代码都还在。
export const FEATURES = {
  /** 工作区：关闭时沙箱读写与代码执行工具不可用、文件管理 API 拒绝 */
  workspace: false,
} as const;

/** 工作区关闭时要一并停用的工具（沙箱文件读写 + 代码执行） */
export const WORKSPACE_TOOL_IDS = [
  "code_exec",
  "sandbox_list",
  "sandbox_read",
  "sandbox_write",
  "sandbox_grep",
];

/** 过滤掉当前未启用的功能对应的工具 id */
export function filterDisabledTools(ids: string[]): string[] {
  if (FEATURES.workspace) return ids;
  return ids.filter((id) => !WORKSPACE_TOOL_IDS.includes(id));
}
