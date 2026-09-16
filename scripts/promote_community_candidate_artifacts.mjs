import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { communityProductFromBrand, sha256 } from "./community_release_contract.mjs";
import { validateAcceptedArtifactManifest } from "./community_accepted_artifacts.mjs";
import { validateCommunityStableAcceptance } from "./community_stable_acceptance_contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`community candidate promotion rejected: ${message}`);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function json(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function ordinaryBytes(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) fail(`${path.basename(filePath)} is not an ordinary non-empty file`);
  return readFile(filePath);
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--candidate-dir" || !args[1]) {
    fail("usage: --candidate-dir <pending-candidate-directory>");
  }
  if (git("status", "--porcelain=v1")) fail("stable promotion source must be clean");
  const releaseCommit = git("rev-parse", "HEAD");
  const candidateDirectory = path.resolve(args[1]);
  const [authority, brand, acceptance, source, pending] = await Promise.all([
    json(path.join(root, "product-version.json")),
    json(path.join(root, "product-brand.json")),
    json(path.join(root, "docs/release/COMMUNITY_STABLE_ACCEPTANCE_V1.json")),
    json(path.join(root, "docs/pet-packs/JIAOJIAO_PACKAGE_SOURCE.json")),
    json(path.join(candidateDirectory, "accepted-artifacts.json")),
  ]);
  if (pending.status !== "PENDING" || pending.testedCommit !== acceptance.candidate?.testedCommit) {
    fail("pending candidate does not match the human-reviewed frozen commit");
  }
  const expectedProduct = communityProductFromBrand(brand);
  const changedPaths = git("diff", "--name-only", pending.testedCommit, releaseCommit, "--")
    .split(/\r?\n/u).filter(Boolean);
  validateCommunityStableAcceptance(acceptance, {
    authority, expectedProduct, releaseCommit, changedPaths,
  });
  const [portable, setup, pet, sourceLicense] = await Promise.all([
    ordinaryBytes(path.join(candidateDirectory, `圆圆提醒_${authority.version}_windows-x64-portable.exe`)),
    ordinaryBytes(path.join(candidateDirectory, `圆圆提醒_${authority.version}_x64-setup.exe`)),
    ordinaryBytes(path.join(candidateDirectory, "饺饺.yuanyuan-pet")),
    ordinaryBytes(path.join(root, source.sourceLicenseFile)),
  ]);
  for (const [entry, bytes] of pending.artifacts.map((entry, index) => [entry, [portable, setup, pet][index]])) {
    if (entry.sha256 !== sha256(bytes) || entry.bytes !== bytes.length) fail("pending artifact bytes changed after candidate freeze");
  }
  const accepted = { ...pending, status: "ACCEPTED_FOR_STABLE_RELEASE" };
  validateAcceptedArtifactManifest({
    manifest: accepted, acceptance, authority, source,
    files: { portable, setup, "jiaojiao-pet-pack": pet, sourceLicense },
  });
  const output = path.join(root, "src-tauri/target/accepted-community", `v${authority.version}`, pending.testedCommit);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  for (const [name, bytes] of [
    [accepted.artifacts[0].fileName, portable],
    [accepted.artifacts[1].fileName, setup],
    [accepted.artifacts[2].fileName, pet],
  ]) await writeFile(path.join(output, name), bytes, { flag: "wx" });
  await writeFile(path.join(output, "accepted-artifacts.json"), `${JSON.stringify(accepted, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Human-accepted original artifact bytes promoted: ${output}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
