// splitter 边界自测：node 直接跑（tsx），无外部依赖
// v7 定稿规则（2026-09-07）：换行必分 / chat 句号必切（!?…不切）/ rich >100字括号外句号兜底
import { splitReply, RICH_FALLBACK_AT, describeSplit } from "../src/core/splitter.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

console.log("== 轻对话 chat (max=5) ==");
{
  const r = splitReply("在干嘛呢", { style: "chat", max: 5 });
  check("短句单条", r.count === 1 && r.parts[0] === "在干嘛呢", JSON.stringify(r));
}
{
  // 公共规则 1：换行必分——单个换行也是分段，不再只认空行
  const r = splitReply("在干嘛\n吃了吗", { style: "chat", max: 5 });
  check("单换行必分 2 条", r.count === 2, describeSplit(r) + JSON.stringify(r.parts));
}
{
  const r = splitReply("在干嘛\n\n\n吃了吗", { style: "chat", max: 5 });
  check("连续换行也分 2 条", r.count === 2, describeSplit(r) + JSON.stringify(r.parts));
}
{
  // 公共规则 3 + chat：句号必切、切分点句号删除
  const r = splitReply("第一段话。这里还有一句。", { style: "chat", max: 5 });
  check("句号必切 2 条且句号已删", r.count === 2 && r.parts[0] === "第一段话" && r.parts[1] === "这里还有一句", JSON.stringify(r.parts));
}
{
  // chat：问号/叹号/省略号不触发切分（靠 AI 语义分段），整行保留
  const r = splitReply("在吗？出来玩啊！真的不来？", { style: "chat", max: 5 });
  check("!?_ 不切（整行一条）", r.count === 1, describeSplit(r) + JSON.stringify(r.parts));
}
{
  const r = splitReply("嗯……让我想想……算了", { style: "chat", max: 5 });
  check("省略号不切（整行一条）", r.count === 1, describeSplit(r) + JSON.stringify(r.parts));
}
{
  // 句号切点后紧跟的 !?… 并入本条（「真好。！」→「真好！」）
  const r = splitReply("真好。！你说呢", { style: "chat", max: 5 });
  check("句号后吞并 ! 再切", r.count === 2 && r.parts[0] === "真好！", JSON.stringify(r.parts));
}
{
  const r = splitReply("真好。……你说呢", { style: "chat", max: 5 });
  check("句号后吞并 … 再切", r.count === 2 && r.parts[0] === "真好……", JSON.stringify(r.parts));
}
{
  // 公共规则 2：逗号再多也不切（切了不连贯）——整句保留
  const r = splitReply("我早上吃了面包，喝了咖啡，看了会书，然后就出门了，路上还遇到老同学，站着聊了好一会儿才走，差点迟到", { style: "chat", max: 5 });
  check("逗号处不切（整句保留）", r.count === 1, describeSplit(r));
}
{
  // 无句号超长 → 整条保留（宁长不切，不在非标点处切断）
  const long = "啊".repeat(70);
  const r = splitReply(long, { style: "chat", max: 5 });
  check("无标点整条保留", r.count === 1 && r.parts[0].length === 70, describeSplit(r));
}
{
  // 超条数：10 个句 → 合并到 5 条
  const text = Array.from({ length: 10 }, (_, i) => `这是第${i + 1}句话`).join("。") + "。";
  const r = splitReply(text, { style: "chat", max: 5 });
  check("超条数收敛到 5", r.count === 5, describeSplit(r) + " parts=" + r.count);
}
{
  // 收敛合并不得引入换行（换行=分段是硬规则，气泡内不应出现 \n）
  const text = Array.from({ length: 10 }, (_, i) => `第${i + 1}句`).join("。") + "。";
  const r = splitReply(text, { style: "chat", max: 3 });
  check("收敛后气泡内无换行", r.parts.every((p) => !p.includes("\n")), JSON.stringify(r.parts));
}
{
  // v7：无总字数限制——内容完整保留，不砍任何字
  const r = splitReply("你好吗".repeat(40), { style: "chat", max: 5 });
  const total = r.parts.reduce((n, c) => n + c.replace(/\s/g, "").length, 0);
  check("总字数不限制内容完整", total === 120, `total=${total}`);
  check("内容完整无截断", !r.truncated, describeSplit(r));
}
{
  // min 软下限：内容很短不硬凑
  const r = splitReply("嗯", { style: "chat", max: 7, min: 3 });
  check("min 不强凑", r.count === 1, describeSplit(r));
}

console.log("== 重描写 rich (max=7) ==");
{
  // rich：行内不按句号切，一条可有多个句子多条句号；短行整条保留
  const s = "{倚在门框上，慢悠悠打量她}怕你？我连自己明天会变成什么样都不在乎。为什么要怕一个半夜给我发消息的人（语气放轻）倒是你，敢在这个点找我，胆子不小。";
  const r = splitReply(s, { style: "rich", max: 7 });
  check(`重描写 短行（≤${RICH_FALLBACK_AT}字）多句号整条一条`, r.count === 1, describeSplit(r));
}
{
  // rich：单换行必分
  const r = splitReply("{笑了笑}怕你？\n{压低声音}你确定？", { style: "rich", max: 7 });
  check("重描写 单换行必分 2 条", r.count === 2, describeSplit(r) + JSON.stringify(r.parts));
}
{
  // rich 兜底：>100 字且存在括号外句号 → 在下一个括号外句号处切，切点句号删除（括号内句号一律跳过）
  const long = "（心里想着。这件事不能提。）".repeat(7) + "他终于开口了。说了一句很长的话。";
  const r = splitReply(long, { style: "rich", max: 7 });
  check("重描写 超100字括号外句号兜底 ≥2 条", r.count >= 2, describeSplit(r));
  check("切在括号外句号处（括号内句号不切）", r.parts.some((p) => p.includes("他终于开口了")), JSON.stringify(r.parts));
}
{
  // rich 兜底宁长不切：>100 字但所有句号都在括号内 → 整条保留
  const long = "（第一句。第二句。第三句。）".repeat(8);
  const r = splitReply(long, { style: "rich", max: 7 });
  check("括号内句号全不切（宁长不切整条）", r.count === 1 && r.parts[0] === long, describeSplit(r));
}
{
  // rich 兜底：切分点句号删除，紧跟的 !?… 并入本条
  const long = "（这里是心理活动。里面句号不切。）".repeat(8) + "第二句来了。！后面还有一句。";
  const r = splitReply(long, { style: "rich", max: 7 });
  check("切分点句号删除且吞并 !", r.parts.length >= 2 && r.parts[0].endsWith("第二句来了！"), JSON.stringify(r.parts));
}

console.log("== 边界 ==");
{
  const r = splitReply("", { style: "chat", max: 5 });
  check("空输入", r.count === 0, describeSplit(r));
}
{
  const r = splitReply("   \n  ", { style: "chat", max: 5 });
  check("纯空白", r.count === 0, describeSplit(r));
}
{
  const r = splitReply("a。b。c。d。e。f。g。h。", { style: "chat", max: 99 });
  check("max 上限钳制到 7", r.count <= 7, describeSplit(r));
  const r2 = splitReply("测试", { style: "chat", max: 0 });
  check("max=0 钳制到 1", r2.count === 1, describeSplit(r2));
}
{
  // 半角句点/小数点不触发分段（只认中文「。」；URL 扩展名、数字、英文缩写不误伤）
  const r = splitReply("ok. fine. bye.", { style: "chat", max: 5 });
  check("半角句点不切（整条保留）", r.count === 1 && r.parts[0] === "ok. fine. bye.", describeSplit(r) + JSON.stringify(r.parts));
  const r2 = splitReply("要 3.5 元的那个。还有 2.0 版本", { style: "chat", max: 5 });
  check("数字小数点不切、中文句号照切", r2.count === 2, describeSplit(r2) + JSON.stringify(r2.parts));
}
{
  // URL/图片路径保护：路径里的 ".png" 不能被当句号切开（实锤 bug）
  const r = splitReply("你看这张\n/img/persona-mt9xijkd/gen-1788797255952.png", { style: "chat", max: 5 });
  const hasFullUrl = r.parts.some((p) => p.includes("/img/persona-mt9xijkd/gen-1788797255952.png"));
  check("图片路径完整保留不被切开", hasFullUrl, JSON.stringify(r.parts));
  const r2 = splitReply("图片：https://example.com/a/b.png 好看", { style: "chat", max: 5 });
  check("http 图片 URL 完整保留", r2.parts.some((p) => p.includes("https://example.com/a/b.png")), JSON.stringify(r2.parts));
}

console.log(failed ? `\n❌ ${failed} 项失败` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);