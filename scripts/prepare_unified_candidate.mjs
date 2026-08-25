import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNIFIED_CANDIDATE_CHECKSUMS,
  UNIFIED_CANDIDATE_MANIFEST,
  UNIFIED_CANDIDATE_MARKER,
  UNIFIED_CANDIDATE_MARKER_CONTENTS,
  UnifiedCandidateContractError,
  buildUnifiedCandidateManifest,
  renderUnifiedCandidateChecksums,
  unifiedInstallerFileName,
  validateUnifiedCandidateDirectory,
} from "./unified_candidate_contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new UnifiedCandidateContractError(message);
}

function gitText(argumentsList) {
  try {
    return execFileSync("git", argumentsList, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(`unable to inspect Git source state: ${error.stderr?.trim?.() || error.message}`);
  }
}

function collectSource() {
  return {
    commit: gitText(["rev-parse", "HEAD"]).toLowerCase(),
    branch: gitText(["branch", "--show-current"]),
    commitTimestamp: gitText(["show", "-s", "--format=%cI", "HEAD"]),
    worktreeClean:
      gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length === 0,
  };
}

export async function writeNewCandidate(directory, manifest, artifactBytes) {
  const resolved = path.resolve(directory);
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true });
  let created = false;
  try {
    await mkdir(resolved);
    created = true;
    await writeFile(
      path.join(resolved, UNIFIED_CANDIDATE_MARKER),
      UNIFIED_CANDIDATE_MARKER_CONTENTS,
      { flag: "wx" },
    );
    await writeFile(path.join(resolved, manifest.artifact.fileName), artifactBytes, {
      flag: "wx",
    });
    await writeFile(
      path.join(resolved, UNIFIED_CANDIDATE_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await writeFile(
      path.join(resolved, UNIFIED_CANDIDATE_CHECKSUMS),
      renderUnifiedCandidateChecksums(manifest),
      { flag: "wx" },
    );
    await validateUnifiedCandidateDirectory(resolved);
    return resolved;
  } catch (error) {
    if (created) {
      let markerMatches = false;
      try {
        markerMatches =
          (await readFile(path.join(resolved, UNIFIED_CANDIDATE_MARKER), "utf8")) ===
          UNIFIED_CANDIDATE_MARKER_CONTENTS;
      } catch {
        // A directory without the exact owned marker is never recursively removed.
      }
      if (markerMatches && path.dirname(resolved) === parent) {
        await rm(resolved, { recursive: true, force: true });
      }
    }
    if (error?.code === "EEXIST") {
      fail("candidate directory already exists; refusing to overwrite or merge stale files");
    }
    throw error;
  }
}

async function main() {
  const sourceBefore = collectSource();
  if (!sourceBefore.worktreeClean) fail("candidate freeze requires a clean worktree");
  if (!sourceBefore.branch) fail("candidate freeze requires a named Git branch");
  const productPath = path.join(projectRoot, "product-version.json");
  const productAuthorityBytes = await readFile(productPath);
  const authority = JSON.parse(productAuthorityBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const product = {
    name: authority.productName,
    version: authority.version,
    identifier: authority.identifier,
  };
  const installerName = unifiedInstallerFileName(product);
  const artifactBytes = await readFile(
    path.join(projectRoot, "src-tauri", "target", "release", "bundle", "nsis", installerName),
  );
  const [tauriConfigBytes, packageLockBytes, cargoLockBytes] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json")),
    readFile(path.join(projectRoot, "package-lock.json")),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.lock")),
  ]);
  const sourceAfter = collectSource();
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    fail("source changed while candidate inputs were collected");
  }
  const manifest = buildUnifiedCandidateManifest({
    product,
    source: sourceAfter,
    artifactBytes,
    productAuthorityBytes,
    tauriConfigBytes,
    packageLockBytes,
    cargoLockBytes,
  });
  const directory = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "unified-candidates",
    `v${product.version}`,
    manifest.candidateId,
  );
  const output = await writeNewCandidate(directory, manifest, artifactBytes);
  process.stdout.write(`Unified candidate frozen without overwrite: ${output}\n`);
  process.stdout.write(
    manifest.releaseStatus === "internal-only-non-main"
      ? "This is an internal non-main candidate and is not eligible for publication.\n"
      : "Candidate is not release-approved until signing and human release gates pass.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Unified candidate freeze stopped: ${error.message}\n`);
    process.exitCode = 2;
  });
}
