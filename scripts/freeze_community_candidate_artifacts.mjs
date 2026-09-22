import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./community_release_contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`community candidate freeze rejected: ${message}`);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function ordinaryBytes(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) fail(`${path.basename(filePath)} is not an ordinary non-empty file`);
  return readFile(filePath);
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--pet-pack" || !args[1]) {
    fail("usage: --pet-pack <original-verified-package-path>");
  }
  if (git("status", "--porcelain=v1")) fail("a clean frozen source commit is required");
  const commit = git("rev-parse", "HEAD");
  const authority = JSON.parse(await readFile(path.join(root, "product-version.json"), "utf8"));
  const source = JSON.parse(await readFile(path.join(root, "docs/pet-packs/JIAOJIAO_PACKAGE_SOURCE.json"), "utf8"));
  if (authority.channel !== "development" || authority.productName !== "圆圆提醒"
    || authority.identifier !== "com.yuanyuan.reminder") fail("candidate product identity or channel is invalid");
  const names = [
    ["portable", `圆圆提醒_${authority.version}_windows-x64-portable.exe`, path.join(root, "src-tauri/target/release/yuanyuan-reminder.exe")],
    ["setup", `圆圆提醒_${authority.version}_x64-setup.exe`, path.join(root, "src-tauri/target/release/bundle/nsis", `圆圆提醒_${authority.version}_x64-setup.exe`)],
    ["jiaojiao-pet-pack", source.packageFileName, path.resolve(args[1])],
  ];
  const contents = await Promise.all(names.map(([, , filePath]) => ordinaryBytes(filePath)));
  const originalLicense = await ordinaryBytes(path.join(root, source.sourceLicenseFile));
  if (sha256(contents[2]) !== source.packageSha256
    || sha256(originalLicense) !== source.embeddedLicenseSha256) {
    fail("original pet package or its source license does not match the frozen provenance");
  }
  if (git("status", "--porcelain=v1") || git("rev-parse", "HEAD") !== commit) {
    fail("source changed while candidate bytes were collected");
  }
  const manifest = {
    schemaVersion: 1,
    status: "PENDING",
    product: { name: authority.productName, identifier: authority.identifier, version: authority.version },
    testedCommit: commit,
    artifacts: names.map(([id, fileName], index) => ({
      id, fileName, bytes: contents[index].length, sha256: sha256(contents[index]),
    })),
  };
  const output = path.join(root, "src-tauri/target/community-candidates", `v${authority.version}`, commit);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  for (let index = 0; index < names.length; index += 1) {
    await writeFile(path.join(output, names[index][1]), contents[index], { flag: "wx" });
  }
  await writeFile(path.join(output, "accepted-artifacts.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Immutable pending community candidate: ${output}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
