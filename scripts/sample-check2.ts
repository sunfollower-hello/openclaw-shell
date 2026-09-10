import { splitReply, describeSplit } from "../src/core/splitter.js";
// 超过 60 字的无空行段落 → 按句号兜底切
const s = "第一句话是讲今天天气真的很好很适合出门走走看看风景。第二句话是讲街角那家咖啡店的老板人很热情手艺也不错。第三句话是讲周末要不要一起过去坐坐聊聊天什么的。第四句话是讲如果没空的话改天也行不着急的。第五句话是讲反正我随时都有时间等你消息就好。";
console.log("超60字无空行（max=5，应按句号兜底切）:");
const r = splitReply(s, { style: "chat", max: 5, min: 1 });
r.parts.forEach((p, i) => console.log(`  [${i + 1}](${p.length}字) ${p}`));
console.log("  =>", describeSplit(r));
