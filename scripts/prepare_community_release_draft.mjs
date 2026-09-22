import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { communityProductFromBrand, validateCommunityStablePolicy } from "./community_release_contract.mjs";
import { validateCommunityStableAcceptance } from "./community_stable_acceptance_contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(relative) {
  return JSON.parse((await readFile(path.join(root, relative), "utf8")).replace(/^\uFEFF/u, ""));
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function main(args) {
  if (args.length !== 6 || args[0] !== "--tag" || args[2] !== "--commit" || args[4] !== "--output-dir") {
    throw new Error("usage: --tag <tag> --commit <commit> --output-dir <directory>");
  }
  const [, tag, , commit, , outputDirectory] = args;
  const [authority, brand, policy, acceptance] = await Promise.all([
    json("product-version.json"), json("product-brand.json"),
    json("docs/release/COMMUNITY_STABLE_RELEASE_POLICY_V2.json"),
    json("docs/release/COMMUNITY_STABLE_ACCEPTANCE_V2.json"),
  ]);
  const product = communityProductFromBrand(brand);
  validateCommunityStablePolicy(policy, product);
  if (tag !== `v${authority.version}` || git("rev-parse", "HEAD") !== commit || git("status", "--porcelain=v1")) {
    throw new Error("draft tag, version, or clean source commit is invalid");
  }
  if (!/^[0-9a-f]{40}$/u.test(acceptance?.candidate?.testedCommit ?? "")) {
    throw new Error("stable acceptance evidence is pending or invalid");
  }
  const changedPaths = git("diff", "--name-only", acceptance.candidate.testedCommit, commit, "--")
    .split(/\r?\n/u).filter(Boolean);
  validateCommunityStableAcceptance(acceptance, {
    authority, expectedProduct: product, releaseCommit: commit, changedPaths,
  });
  const output = path.resolve(root, outputDirectory);
  const relative = path.relative(root, output);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("draft output must stay inside the project");
  }
  const notes = [
    `# ${authority.productName} ${tag}`,
    "",
    "此版本的验收已经完成，附件仍须从已验收原始文件复制、逐项校验并在取得公开发布授权后附加。当前为草稿。",
    "",
    `验收安装器 SHA-256：\`${acceptance.candidate.installerSha256}\`。`,
    `源码提交：\`${commit}\`。`,
    "",
    "Windows 程序未签名，可能出现未知发布者或 SmartScreen 提示。数据库升级后回退必须同时恢复升级前完整数据目录。",
    "24 小时运行观察未覆盖系统睡眠恢复与锁屏解锁，两项已明确豁免，原始报告仍未通过。",
    "真实 1.3.2 用户历史数据未验证；官方 1.3.2 程序合成数据和真实 1.5.27 升级回退仅提供替代覆盖，不能证明真实历史记录兼容。",
    "饺饺宠物包原许可限制素材用途；仅依随附的权利人补充许可免费分发本次原字节包，不授予图片再利用权。",
    "",
  ].join("\n");
  await mkdir(output);
  await writeFile(path.join(output, "RELEASE_NOTES.md"), notes, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Community Release draft notes prepared: ${output}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Community Release draft stopped: ${error.message}\n`);
  process.exitCode = 1;
});
