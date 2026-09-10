import { splitReply, describeSplit } from "../src/core/splitter.js";

// v7 定稿样本（2026-09-07）：换行必分 / chat 句号必切(!?…不切) / rich >100字括号外句号兜底

// 样本1（轻对话：问号句号混合 → 只按句号切，句号删除；!?…保留且不触发切分）
const s1 = "今天天气不错呢，要不要出去走走？我知道一家新开的咖啡店，听说他家的提拉米苏特别好吃。你要是感兴趣的话我们可以周末一起去，我请客。怎么样？给个准话呗～";
console.log("样本1（轻对话 max=5，问号句号混合）:");
const r1 = splitReply(s1, { style: "chat", max: 5, min: 1 });
r1.parts.forEach((p, i) => console.log(`  [${i + 1}](${p.length}字) ${p}`));
console.log("  =>", describeSplit(r1));

// 样本2（轻对话：AI 一行写多个句子 → 句号必切、句号全删）
const s2 = "第一句话。第二句话。第三句话。第四句话。第五句话。";
console.log("\n样本2（轻对话，句号必切、句号删除）:");
const r2 = splitReply(s2, { style: "chat", max: 5, min: 1 });
r2.parts.forEach((p, i) => console.log(`  [${i + 1}](${p.length}字) ${JSON.stringify(p)}`));
console.log("  =>", describeSplit(r2));

// 样本3（轻对话：无句号长行 → 整条保留，宁长不切）
const s3 = "我今天早上出门的时候遇到一件特别离谱的事情让我到现在都忘不掉想想都觉得好笑";
console.log("\n样本3（轻对话，无句号长行应整条保留）:");
const r3 = splitReply(s3, { style: "chat", max: 5, min: 1 });
r3.parts.forEach((p, i) => console.log(`  [${i + 1}](${p.length}字) ${p}`));
console.log("  =>", describeSplit(r3));

// 样本4（重描写：换行必分，一条内可多个句号；超 100 字找括号外句号兜底）
const s4 = "{倚在门框上，慢悠悠打量她}怕你？我连自己明天会变成什么样都不在乎，为什么要怕一个半夜给我发消息的人。\n{停顿片刻，声音压低}（心跳莫名快了一拍）你确定？我这个人，一旦靠太近，可就不只是说话了。另外这是一句很长很长的话一直说到超过一百个字都还没有停下来的意思，（括号里的句号。不应该被切断。）所以到这里才轮到真正的句号。";
console.log("\n样本4（重描写 max=7，换行必分 + 超100字括号外句号兜底）:");
const r4 = splitReply(s4, { style: "rich", max: 7, min: 1 });
r4.parts.forEach((p, i) => console.log(`  [${i + 1}](${p.length}字) ${p}`));
console.log("  =>", describeSplit(r4));