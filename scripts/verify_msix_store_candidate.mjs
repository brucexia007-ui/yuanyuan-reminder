import { createHash } from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultStoreIdentityPath,
  readAndValidateStoreIdentity,
} from "./verify_msix_store_identity.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const reportPath = path.join(targetRoot, "msix-store-candidate-report.json");
const executablePath = path.join(
  targetRoot,
  "cargo-target",
  "release",
  "yuanyuan-reminder.exe",
);
const identityVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_identity.mjs");
const manifestTemplatePath = path.join(
  projectRoot,
  "src-tauri",
  "msix",
  "AppxManifest.store.xml",
);
const generatedManifestPath = path.join(targetRoot, "staging", "AppxManifest.xml");
const buildScriptPath = path.join(projectRoot, "scripts", "build_msix_store_candidate.ps1");
const iconPath = path.join(projectRoot, "src-tauri", "icons", "128x128@2x.png");
const releasePolicyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");

const EXPECTED_PAYLOAD_FILES = [
  "AppxBlockMap.xml",
  "AppxManifest.xml",
  "Assets/Square150x150Logo.png",
  "Assets/Square44x44Logo.png",
  "Assets/StoreLogo.png",
  "licenses/ASSETS_LICENSE.md",
  "licenses/LICENSE.txt",
  "licenses/THIRD_PARTY_LICENSES.txt",
  "licenses/THIRD_PARTY_NOTICES.md",
  "yuanyuan-reminder.exe",
];
const EXPECTED_LICENSE_FILES = [
  "ASSETS_LICENSE.md",
  "LICENSE.txt",
  "THIRD_PARTY_LICENSES.txt",
  "THIRD_PARTY_NOTICES.md",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exact(Object.keys(value).sort(), [...keys].sort())
  );
}

function canonicalHash(value) {
  return typeof value === "string" && /^[A-F0-9]{64}$/.test(value);
}

function validText(value, minimum = 1, maximum = 500) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

export function msixStoreCandidateEvidenceMatches({
  report,
  identity,
  releasePolicy,
  packageBytes,
  executableBytes,
  identityBytes,
  identityVerifierBytes,
  manifestTemplateBytes,
  generatedManifestBytes,
  buildScriptBytes,
  iconBytes,
  makeAppxBytes,
  worktreeClean,
  sourceCommitReachable,
  now = new Date(),
}) {
  if (
    !exactKeys(report, [
      "schemaVersion",
      "mode",
      "generatedAt",
      "candidate",
      "sourceControl",
      "policy",
      "sources",
      "manifest",
      "payload",
      "validation",
      "limitations",
    ]) ||
    report.schemaVersion !== 1 ||
    report.mode !== "msix_store_candidate"
  ) {
    return false;
  }
  const generatedAt = Date.parse(report.generatedAt);
  if (
    !Number.isFinite(generatedAt) ||
    generatedAt > now.getTime() + 5 * 60 * 1000 ||
    generatedAt < Date.parse("2026-08-10T00:00:00.000Z")
  ) {
    return false;
  }

  const expectedPackagePath = `src-tauri/target/msix-store/${identity.package.identityName}_${identity.platform.version}_x64-store.msix`;
  if (
    !exactKeys(report.candidate, [
      "version",
      "architecture",
      "path",
      "bytes",
      "sha256",
      "signatureStatus",
      "structureReady",
      "partnerCenterIdentityReady",
      "storeSubmissionReady",
    ]) ||
    report.candidate.version !== identity.platform.version ||
    report.candidate.architecture !== identity.platform.architecture ||
    report.candidate.path !== expectedPackagePath ||
    !Number.isInteger(report.candidate.bytes) ||
    report.candidate.bytes !== packageBytes.length ||
    report.candidate.bytes <= 0 ||
    !canonicalHash(report.candidate.sha256) ||
    report.candidate.sha256 !== sha256(packageBytes) ||
    report.candidate.signatureStatus !== "NotSigned" ||
    report.candidate.structureReady !== true ||
    report.candidate.partnerCenterIdentityReady !== true ||
    report.candidate.storeSubmissionReady !== false
  ) {
    return false;
  }

  if (
    !exactKeys(report.sourceControl, [
      "gitHead",
      "worktreeCleanBeforeBuild",
      "worktreeCleanAfterBuild",
    ]) ||
    !/^[0-9a-f]{40}$/.test(report.sourceControl.gitHead) ||
    report.sourceControl.worktreeCleanBeforeBuild !== true ||
    report.sourceControl.worktreeCleanAfterBuild !== true ||
    worktreeClean !== true ||
    sourceCommitReachable !== true
  ) {
    return false;
  }

  const distribution = releasePolicy?.distribution;
  if (
    releasePolicy?.schemaVersion !== 1 ||
    distribution?.strategy !== "low_cost_staged" ||
    distribution.selectedChannel !== "pending" ||
    distribution.plannedStableChannel !== "microsoft_store" ||
    !exact(report.policy, {
      strategy: distribution.strategy,
      selectedChannel: distribution.selectedChannel,
      plannedStableChannel: distribution.plannedStableChannel,
    })
  ) {
    return false;
  }

  if (
    !exactKeys(report.sources, [
      "executableBytes",
      "executableSha256",
      "executableSignatureStatus",
      "identitySha256",
      "identityVerifierSha256",
      "manifestTemplateSha256",
      "generatedManifestSha256",
      "buildScriptSha256",
      "iconSha256",
      "makeAppxVersion",
      "makeAppxSha256",
    ]) ||
    report.sources.executableBytes !== executableBytes.length ||
    report.sources.executableSha256 !== sha256(executableBytes) ||
    !validText(report.sources.executableSignatureStatus, 3, 80) ||
    report.sources.identitySha256 !== sha256(identityBytes) ||
    report.sources.identityVerifierSha256 !== sha256(identityVerifierBytes) ||
    report.sources.manifestTemplateSha256 !== sha256(manifestTemplateBytes) ||
    report.sources.generatedManifestSha256 !== sha256(generatedManifestBytes) ||
    report.sources.buildScriptSha256 !== sha256(buildScriptBytes) ||
    report.sources.iconSha256 !== sha256(iconBytes) ||
    !validText(report.sources.makeAppxVersion, 3, 120) ||
    report.sources.makeAppxSha256 !== sha256(makeAppxBytes)
  ) {
    return false;
  }

  if (
    !exact(report.manifest, {
      identityName: identity.package.identityName,
      identityPublisher: identity.package.publisher,
      publisherDisplayName: identity.package.publisherDisplayName,
      packageFamilyName: identity.package.packageFamilyName,
      storeId: identity.product.storeId,
      reservedProductName: identity.product.reservedProductName,
      applicationId: "YuanyuanReminder",
      executable: "yuanyuan-reminder.exe",
      runtimeBehavior: "packagedClassicApp",
      trustLevel: "mediumIL",
      targetDeviceFamily: identity.platform.targetDeviceFamily,
      minimumWindowsVersion: identity.platform.minVersion,
      maximumWindowsVersionTested: identity.platform.maxVersionTested,
      runFullTrust: true,
    })
  ) {
    return false;
  }

  if (
    !exactKeys(report.payload, [
      "fileCount",
      "files",
      "exactBoundaryVerified",
      "prototypeSidecarsExcluded",
      "nestedInstallerExcluded",
      "licenseFiles",
    ]) ||
    report.payload.fileCount !== EXPECTED_PAYLOAD_FILES.length ||
    !exact(report.payload.files, EXPECTED_PAYLOAD_FILES) ||
    report.payload.exactBoundaryVerified !== true ||
    report.payload.prototypeSidecarsExcluded !== true ||
    report.payload.nestedInstallerExcluded !== true ||
    !exact(report.payload.licenseFiles, EXPECTED_LICENSE_FILES)
  ) {
    return false;
  }

  if (
    !exact(report.validation, {
      partnerCenterIdentityConfirmedByHuman: true,
      identityVerifierPassed: true,
      sourceWorktreeClean: true,
      makeAppxPackPassed: true,
      makeAppxUnpackPassed: true,
      packageUnsignedForStoreResigning: true,
      cleanWindowsInstall: "not_performed",
      applicationLaunch: "not_performed",
      windowsAppCertificationKit: "not_performed",
      storeCertification: "not_performed",
    }) ||
    !Array.isArray(report.limitations) ||
    report.limitations.length !== 3 ||
    !report.limitations.every((item) => validText(item, 20, 700))
  ) {
    return false;
  }

  return true;
}

function latestMakeAppxPath() {
  const sdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = fs
    .readdirSync(sdkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const a = left.split(".").map(Number);
      const b = right.split(".").map(Number);
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return b[index] - a[index];
      }
      return 0;
    });
  for (const version of versions) {
    const candidate = path.join(sdkRoot, version, "x64", "makeappx.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("makeappx_not_found");
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git_${args[0]}_failed`);
  return result.stdout.trim();
}

async function main() {
  const identity = readAndValidateStoreIdentity(defaultStoreIdentityPath);
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const expectedRelativePackagePath = `src-tauri/target/msix-store/${identity.package.identityName}_${identity.platform.version}_x64-store.msix`;
  if (report.candidate?.path !== expectedRelativePackagePath) {
    throw new Error("candidate_path_mismatch");
  }
  const packagePath = path.resolve(projectRoot, report.candidate.path);
  const ownedPrefix = `${path.resolve(targetRoot)}${path.sep}`.toLowerCase();
  if (!packagePath.toLowerCase().startsWith(ownedPrefix)) throw new Error("candidate_path_escape");
  const makeAppxPath = latestMakeAppxPath();
  const [
    releasePolicyBytes,
    packageBytes,
    executableBytes,
    identityBytes,
    identityVerifierBytes,
    manifestTemplateBytes,
    generatedManifestBytes,
    buildScriptBytes,
    iconBytes,
    makeAppxBytes,
  ] = await Promise.all([
    readFile(releasePolicyPath),
    readFile(packagePath),
    readFile(executablePath),
    readFile(defaultStoreIdentityPath),
    readFile(identityVerifierPath),
    readFile(manifestTemplatePath),
    readFile(generatedManifestPath),
    readFile(buildScriptPath),
    readFile(iconPath),
    readFile(makeAppxPath),
  ]);
  const releasePolicy = JSON.parse(releasePolicyBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const currentGitHead = gitOutput(["rev-parse", "HEAD"]);
  const worktreeClean = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]) === "";
  const ancestryCheck = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", report.sourceControl.gitHead, currentGitHead],
    { cwd: projectRoot, encoding: "utf8" },
  );
  const sourceCommitReachable = ancestryCheck.status === 0;
  if (
    !msixStoreCandidateEvidenceMatches({
      report,
      identity,
      releasePolicy,
      packageBytes,
      executableBytes,
      identityBytes,
      identityVerifierBytes,
      manifestTemplateBytes,
      generatedManifestBytes,
      buildScriptBytes,
      iconBytes,
      makeAppxBytes,
      worktreeClean,
      sourceCommitReachable,
    })
  ) {
    throw new Error("msix_store_candidate_evidence_mismatch");
  }
  process.stdout.write(
    `MSIX Store candidate evidence verified: ${report.candidate.sha256}, storeSubmissionReady=false.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store candidate verification pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
