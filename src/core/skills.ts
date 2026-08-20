// 内置技能库：给聊天测试追加的"附加能力"（系统提示词片段）
export interface BuiltinSkill {
  id: string;
  name: string;
  prompt: string;
}

export const SKILL_LIBRARY: BuiltinSkill[] = [
  {
    id: "code_expert",
    name: "代码专家",
    prompt:
      "【技能：代码专家】面对代码/技术问题：给出可直接运行的完整代码并解释关键点，考虑边界情况；涉及执行时用沙箱工具实际运行验证后再下结论。",
  },
  {
    id: "translator",
    name: "中英翻译",
    prompt:
      "【技能：翻译】用户要求翻译时：输出准确通顺的译文，保持原意与语气；中译英、英译中都自然，必要时给出两种版本。",
  },
  {
    id: "writing",
    name: "写作助手",
    prompt:
      "【技能：写作】帮用户写文案/文章/回复：先确认用途与受众，再产出结构清晰、符合人设语气的内容。",
  },
  {
    id: "companion",
    name: "情感陪伴",
    prompt:
      "【技能：情感陪伴】用户倾诉烦恼或情绪低落时：先共情倾听，不急于给建议；表达关心，语气符合人设。",
  },
];
