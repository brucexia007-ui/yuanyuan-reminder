import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildUnsignedBetaFreezeReport,
  defaultUnsignedBetaStageRoot,
  UNSIGNED_BETA_BUILD_COMMANDS,
  UNSIGNED_BETA_FILE_NAME,
  validateUnsignedBetaFreezeReport,
  validateUnsignedBetaFreezeIntent,
} from "./verify_unsigned_beta_candidate.mjs";
import {
  V14_RELEASE_SOURCE_SCOPE_FILE_NAME,
  V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME,
  V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME,
  collectCurrentV14ReleaseSourceScope,
} from "./verify_v1_4_release_source_scope.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidatePath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  UNSIGNED_BETA_FILE_NAME,
);
const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const releaseManifestPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "release-manifest.json",
);
const stageMarker = ".yuanyuan-unsigned-beta-stage-v1";
const stageMarkerContents = "yuanyuan-unsigned-beta-stage-v1\n";

export class UnsignedBetaCandidatePreparationError extends Error {}

function fail(message) {
  throw new UnsignedBetaCandidatePreparationError(message);
}

function usage() {
  return "usage: npm.cmd run release:unsigned-beta:freeze -- --confirmed-by <human> --attest-release-scope-reviewed --attest-unsigned-beta-only";
}

export function parseUnsignedBetaFreezeArguments(argumentsList) {
  if (!Array.isArray(argumentsList)) fail("freeze arguments must be an array");
  let confirmedBy;
  let releaseScopeReviewed = false;
  let unsignedBetaOnly = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--confirmed-by") {
      if (confirmedBy !== undefined) fail("duplicate --confirmed-by option");
      const value = argumentsList[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        fail("--confirmed-by requires one value");
      }
      confirmedBy = value;
      index += 1;
      continue;
    }
    if (argument === "--attest-release-scope-reviewed") {
      if (releaseScopeReviewed) fail("duplicate release-scope attestation");
      releaseScopeReviewed = true;
      continue;
    }
    if (argument === "--attest-unsigned-beta-only") {
      if (unsignedBetaOnly) fail("duplicate unsigned-beta attestation");
      unsignedBetaOnly = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") fail(usage());
    fail(`unknown unsigned beta freeze option: ${argument}`);
  }
  if (confirmedBy === undefined) fail("--confirmed-by is required");
  if (!releaseScopeReviewed || !unsignedBetaOnly) {
    fail(
      "both --attest-release-scope-reviewed and --attest-unsigned-beta-only are required",
    );
  }
  return { confirmedBy };
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

export function collectUnsignedBetaGitSource() {
  const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    commit: gitText(["rev-parse", "HEAD"]).toLowerCase(),
    branch: gitText(["branch", "--show-current"]),
    commitTimestamp: gitText(["show", "-s", "--format=%cI", "HEAD"]),
    worktreeClean: status.length === 0,
  };
}

function runRequiredBuildCommands() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const commands = [
    { command: npmCommand, args: ["run", "release:source-scope:verify"], cwd: projectRoot },
    { command: npmCommand, args: ["run", "verify"], cwd: projectRoot },
    { command: "cargo", args: ["test"], cwd: path.join(projectRoot, "src-tauri") },
    { command: npmCommand, args: ["run", "tauri", "build"], cwd: projectRoot },
    { command: npmCommand, args: ["run", "release:manifest"], cwd: projectRoot },
  ];
  for (let index = 0; index < commands.length; index += 1) {
    const item = commands[index];
    const result = spawnSync(item.command, item.args, { cwd: item.cwd, stdio: "inherit" });
    if (result.error) fail(`${UNSIGNED_BETA_BUILD_COMMANDS[index]} failed: ${result.error.message}`);
    if (result.status !== 0) {
      fail(`${UNSIGNED_BETA_BUILD_COMMANDS[index]} failed with exit code ${result.status}`);
    }
  }
}

export async function writeNewUnsignedBetaStage(
  stageRoot,
  {
    report,
    candidateBytes,
    checksumBytes,
    releaseNotesBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
  },
) {
  validateUnsignedBetaFreezeReport(report, {
    candidateBytes,
    checksumBytes,
    releaseNotesBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
  });
  const resolvedRoot = path.resolve(stageRoot);
  const resolvedParent = path.dirname(resolvedRoot);
  if (path.basename(resolvedRoot) !== "1.4.0" || path.basename(resolvedParent) !== "unsigned-beta") {
    fail("unsigned beta stage must end in unsigned-beta/1.4.0");
  }
  await mkdir(resolvedParent, { recursive: true });
  let created = false;
  try {
    await mkdir(resolvedRoot);
    created = true;
    await writeFile(path.join(resolvedRoot, stageMarker), stageMarkerContents, { flag: "wx" });
    const files = [
      [UNSIGNED_BETA_FILE_NAME, candidateBytes],
      ["SHA256SUMS.txt", checksumBytes],
      ["RELEASE_NOTES.md", releaseNotesBytes],
      ["RELEASE_POLICY_V1.json", policyBytes],
      ["release-manifest.json", releaseManifestBytes],
      [V14_RELEASE_SOURCE_SCOPE_FILE_NAME, sourceScopeContractBytes],
      [V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME, sourceScopeReportBytes],
      [V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME, sourceScopeVerifierBytes],
      ["unsigned-beta-freeze-report.json", Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")],
    ];
    for (const [name, bytes] of files) {
      await writeFile(path.join(resolvedRoot, name), bytes, { flag: "wx" });
    }
  } catch (error) {
    if (created) {
      let markerMatches = false;
      try {
        markerMatches = (await readFile(path.join(resolvedRoot, stageMarker), "utf8")) === stageMarkerContents;
      } catch {
        // An incomplete directory without the owned marker is never recursively removed.
      }
      if (markerMatches && path.dirname(resolvedRoot) === resolvedParent) {
        await rm(resolvedRoot, { recursive: true, force: true });
      }
    }
    if (error?.code === "EEXIST") {
      fail("unsigned beta stage already exists; refusing to overwrite or merge it");
    }
    fail(`unable to create the unsigned beta stage: ${error.message}`);
  }
  return resolvedRoot;
}

async function main() {
  fail(
    "v1.4.0 freeze is historical and disabled; use release:unified-candidate:freeze for v1.5",
  );
  const { confirmedBy } = parseUnsignedBetaFreezeArguments(process.argv.slice(2));
  const startedAt = new Date();
  const sourceBefore = collectUnsignedBetaGitSource();
  validateUnsignedBetaFreezeIntent(sourceBefore, confirmedBy, { now: startedAt });
  const sourceScopeBefore = await collectCurrentV14ReleaseSourceScope({ now: startedAt });
  runRequiredBuildCommands();
  const sourceAfter = collectUnsignedBetaGitSource();
  if (
    sourceAfter.commit !== sourceBefore.commit ||
    sourceAfter.branch !== sourceBefore.branch ||
    sourceAfter.commitTimestamp !== sourceBefore.commitTimestamp ||
    sourceAfter.worktreeClean !== true
  ) {
    fail("source changed or became dirty while the unsigned beta candidate was built");
  }
  const sourceScopeAfter = await collectCurrentV14ReleaseSourceScope({ now: startedAt });
  if (JSON.stringify(sourceScopeAfter.report) !== JSON.stringify(sourceScopeBefore.report)) {
    fail("v1.4.0 release source scope changed while the unsigned beta candidate was built");
  }
  const sourceScopeReportBytes = Buffer.from(
    `${JSON.stringify(sourceScopeAfter.report, null, 2)}\n`,
    "utf8",
  );

  const [candidateBytes, policyBytes, releaseManifestBytes] = await Promise.all([
    readFile(candidatePath),
    readFile(policyPath),
    readFile(releaseManifestPath),
  ]);
  const { report, checksumBytes, releaseNotesBytes } = buildUnsignedBetaFreezeReport(
    {
      source: sourceAfter,
      candidateBytes,
      policyBytes,
      releaseManifestBytes,
      sourceScopeContractBytes: sourceScopeAfter.contractBytes,
      sourceScopeReportBytes,
      sourceScopeVerifierBytes: sourceScopeAfter.verifierBytes,
      confirmedBy,
    },
    { now: new Date() },
  );
  const outputRoot = await writeNewUnsignedBetaStage(defaultUnsignedBetaStageRoot, {
    report,
    candidateBytes,
    checksumBytes,
    releaseNotesBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes: sourceScopeAfter.contractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes: sourceScopeAfter.verifierBytes,
  });
  process.stdout.write(`Unsigned beta candidate frozen without overwrite: ${outputRoot}\n`);
  process.stdout.write(
    "Candidate-bound security and human evidence still must pass before GitHub prerelease publication.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Unsigned beta freeze stopped: ${error.message}\n`);
    process.exitCode = 2;
  });
}
