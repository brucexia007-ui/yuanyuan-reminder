import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNIFIED_CANDIDATE_MANIFEST,
  UnifiedCandidateContractError,
  sha256,
  validateUnifiedCandidateDirectory,
} from "./unified_candidate_contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new UnifiedCandidateContractError(message);
}

function parseArguments(argumentsList) {
  let candidateDirectory;
  let requireCurrentSource = false;
  let requireMain = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--candidate-dir") {
      candidateDirectory = argumentsList[index + 1];
      if (!candidateDirectory || candidateDirectory.startsWith("--")) {
        fail("--candidate-dir requires one path");
      }
      index += 1;
    } else if (argument === "--require-current-source") {
      requireCurrentSource = true;
    } else if (argument === "--require-main") {
      requireMain = true;
    } else {
      fail(`unknown candidate verification option: ${argument}`);
    }
  }
  return { candidateDirectory, requireCurrentSource, requireMain };
}

function gitText(argumentsList) {
  return execFileSync("git", argumentsList, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function discoverOnlyCandidate() {
  const authority = JSON.parse(
    (await readFile(path.join(projectRoot, "product-version.json"), "utf8")).replace(
      /^\uFEFF/u,
      "",
    ),
  );
  const root = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "unified-candidates",
    `v${authority.version}`,
  );
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  if (entries.length !== 1) {
    fail("candidate root must contain exactly one immutable candidate or use --candidate-dir");
  }
  return path.join(root, entries[0].name);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const directory = options.candidateDirectory
    ? path.resolve(projectRoot, options.candidateDirectory)
    : await discoverOnlyCandidate();
  const manifest = await validateUnifiedCandidateDirectory(directory);
  if (options.requireMain && manifest.source.branch !== "main") {
    fail("publication candidate must be frozen from main");
  }
  if (options.requireCurrentSource) {
    const current = {
      commit: gitText(["rev-parse", "HEAD"]).toLowerCase(),
      branch: gitText(["branch", "--show-current"]),
      worktreeClean:
        gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length === 0,
    };
    if (
      current.commit !== manifest.source.commit ||
      current.branch !== manifest.source.branch ||
      !current.worktreeClean
    ) {
      fail("candidate is not bound to the current clean source state");
    }
    const [productAuthorityBytes, tauriConfigBytes, packageLockBytes, cargoLockBytes] =
      await Promise.all([
        readFile(path.join(projectRoot, "product-version.json")),
        readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json")),
        readFile(path.join(projectRoot, "package-lock.json")),
        readFile(path.join(projectRoot, "src-tauri", "Cargo.lock")),
      ]);
    const authority = JSON.parse(
      productAuthorityBytes.toString("utf8").replace(/^\uFEFF/u, ""),
    );
    if (
      authority.productName !== manifest.product.name ||
      authority.version !== manifest.product.version ||
      authority.identifier !== manifest.product.identifier ||
      sha256(productAuthorityBytes) !== manifest.bindings.productAuthoritySha256 ||
      sha256(tauriConfigBytes) !== manifest.bindings.tauriConfigSha256 ||
      sha256(packageLockBytes) !== manifest.bindings.packageLockSha256 ||
      sha256(cargoLockBytes) !== manifest.bindings.cargoLockSha256
    ) {
      fail("candidate configuration bindings do not match the current source files");
    }
    const currentBuildBytes = await readFile(path.join(projectRoot, manifest.artifact.buildPath));
    if (
      currentBuildBytes.length !== manifest.artifact.bytes ||
      sha256(currentBuildBytes) !== manifest.artifact.sha256
    ) {
      fail("candidate installer does not match the current fixed build output");
    }
  }
  process.stdout.write(
    `Unified candidate verified: ${manifest.product.version} ${manifest.candidateId} (${manifest.releaseStatus}).\n`,
  );
  process.stdout.write(`Manifest: ${path.join(directory, UNIFIED_CANDIDATE_MANIFEST)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Unified candidate verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
