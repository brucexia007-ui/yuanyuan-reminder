import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAndValidateLearningPack } from "./learning-pack-validation.mjs";

const input = process.argv[2];
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (!input) {
  process.stderr.write("usage: node generate-learning-pack-report.mjs <pack.json> [--output report.md]\n");
  process.exitCode = 1;
} else {
  loadAndValidateLearningPack(path.resolve(input)).then(async ({ pack, bytes, result }) => {
    const cards = Array.isArray(pack?.cards) ? pack.cards : [];
    const recall = cards.filter((card) => card.exerciseKind === "recall").length;
    const choice = cards.filter((card) => card.exerciseKind === "choice").length;
    const lines = [
      "# 本地知识包验证报告",
      "",
      `- 文件：${path.basename(input)}`,
      `- 结果：${result.valid ? "通过" : "未通过"}`,
      `- 包：${pack?.packId ?? "未知"} ${pack?.version ?? ""}`.trimEnd(),
      `- 卡片：${cards.length}（recall ${recall} / choice ${choice}）`,
      `- 字节：${bytes.length}`,
      `- 内容 SHA-256：${result.computedContentSha256 ?? "不可计算"}`,
      `- 权利基础：${pack?.rights?.basis ?? "未声明"}`,
      `- 可公开分发：${pack?.rights?.redistributable === true ? "是（仅记录用户声明）" : "否"}`,
      "",
      "本报告只记录用户提供的权利声明和结构验证结果，不构成版权法律结论。知识包应保留在用户本机，不进入应用源码或安装包。",
      "",
      "## 问题",
      "",
      ...(result.problems.length === 0 ? ["无。"] : result.problems.map((entry) => `- ${entry.location} [${entry.code}]：${entry.message}`)),
      ""
    ];
    const report = lines.join("\n");
    if (output) await writeFile(path.resolve(output), report, { encoding: "utf8", flag: "wx" });
    else process.stdout.write(report);
    if (!result.valid) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
