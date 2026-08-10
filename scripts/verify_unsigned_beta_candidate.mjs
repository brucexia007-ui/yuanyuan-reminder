import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  V14_RELEASE_SOURCE_SCOPE_FILE_NAME,
  V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME,
  V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME,
  validateV14ReleaseSourceScopeReport,
} from "./verify_v1_4_release_source_scope.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const UNSIGNED_BETA_VERSION = "1.4.0";
export const UNSIGNED_BETA_TAG = `v${UNSIGNED_BETA_VERSION}`;
export const UNSIGNED_BETA_FILE_NAME = `圆圆提醒_${UNSIGNED_BETA_VERSION}_x64-setup.exe`;
export const UNSIGNED_BETA_BUILD_COMMANDS = Object.freeze([
  "npm.cmd run release:source-scope:verify",
  "npm.cmd run verify",
  "cargo test (src-tauri)",
  "npm.cmd run tauri build",
  "npm.cmd run release:manifest",
]);
export const defaultUnsignedBetaStageRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "unsigned-beta",
  UNSIGNED_BETA_VERSION,
);
export const defaultUnsignedBetaFreezeReportPath = path.join(
  defaultUnsignedBetaStageRoot,
  "unsigned-beta-freeze-report.json",
);

export class UnsignedBetaCandidateVerificationError extends Error {}

function fail(message) {
  throw new UnsignedBetaCandidateVerificationError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields do not match the unsigned beta contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function humanName(value, label) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 2 || value.length > 128) {
    fail(`${label} must identify a human`);
  }
  if (/\b(?:ai|bot|automation|codex|chatgpt)\b/iu.test(value)) {
    fail(`${label} must identify a human`);
  }
}

function validTimestamp(value, label, now) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < Date.parse("2026-08-10T00:00:00.000Z") ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future ISO timestamp`);
  }
  return parsed;
}

export function inspectPeAuthenticode(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.readUInt16LE(0) !== 0x5a4d) {
    fail("unsigned beta candidate must be a complete Windows PE file");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset < 0x40 ||
    peOffset + 24 > bytes.length ||
    bytes.readUInt32LE(peOffset) !== 0x00004550
  ) {
    fail("unsigned beta candidate has an invalid PE header");
  }
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  if (optionalOffset + optionalHeaderSize > bytes.length) {
    fail("unsigned beta candidate has a truncated PE optional header");
  }
  const magic = bytes.readUInt16LE(optionalOffset);
  const dataDirectoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
  const numberOfDirectoriesOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : 0;
  if (dataDirectoryOffset === 0 || optionalHeaderSize < dataDirectoryOffset + 5 * 8) {
    fail("unsigned beta candidate uses an unsupported PE optional header");
  }
  const numberOfDirectories = bytes.readUInt32LE(optionalOffset + numberOfDirectoriesOffset);
  if (numberOfDirectories <= 4) fail("unsigned beta candidate omits the PE certificate directory");
  const certificateEntry = optionalOffset + dataDirectoryOffset + 4 * 8;
  const certificateOffset = bytes.readUInt32LE(certificateEntry);
  const certificateSize = bytes.readUInt32LE(certificateEntry + 4);
  if ((certificateOffset === 0) !== (certificateSize === 0)) {
    fail("unsigned beta candidate has an inconsistent PE certificate directory");
  }
  if (certificateOffset !== 0 || certificateSize !== 0) {
    fail("unsigned beta candidate must not contain an Authenticode certificate table");
  }
  return { format: "pe", authenticode: "not_signed" };
}

export function renderUnsignedBetaChecksum(candidateSha256) {
  canonicalHash(candidateSha256, "candidateSha256");
  return `${candidateSha256} *${UNSIGNED_BETA_FILE_NAME}\n`;
}

export function renderUnsignedBetaReleaseNotes(candidateSha256) {
  canonicalHash(candidateSha256, "candidateSha256");
  return `# 圆圆提醒 ${UNSIGNED_BETA_TAG} 未签名测试版

这是面向愿意帮助测试的用户提供的预发布版本，不是稳定正式版。

- 此安装包未进行 Authenticode 代码签名，Windows 可能显示“未知发布者”或 SmartScreen 信誉提示；
- 只从本项目官方 GitHub Releases 下载；
- 下载后请先核对随附的 \`SHA256SUMS.txt\`；
- SHA-256 只能确认文件字节一致，不能替代代码签名、安全审计或恶意软件检测；
- 正式稳定版计划通过 Microsoft Store MSIX 发布。

安装包：\`${UNSIGNED_BETA_FILE_NAME}\`

SHA-256：\`${candidateSha256}\`
`;
}

function validateReleasePolicy(policy) {
  if (
    policy?.schemaVersion !== 1 ||
    policy?.product?.identifier !== "com.yuanyuan.reminder" ||
    policy?.product?.name !== "圆圆提醒" ||
    policy?.distribution?.strategy !== "low_cost_staged" ||
    policy?.distribution?.selectedChannel !== "pending" ||
    policy?.distribution?.previewChannel !== "github_releases" ||
    policy?.distribution?.previewArtifactPolicy !== "unsigned_beta_with_sha256" ||
    policy?.distribution?.plannedStableChannel !== "microsoft_store"
  ) {
    fail("release policy does not authorize the low-cost unsigned-beta/Store route");
  }
}

function validateReleaseManifest(manifest, candidateBytes) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.productName !== "圆圆提醒" ||
    manifest?.productVersion !== UNSIGNED_BETA_VERSION ||
    manifest?.signatureVerification !== "not_performed" ||
    manifest?.installerBoundary?.experimentalSidecarsIncluded !== false ||
    !Array.isArray(manifest?.artifacts)
  ) {
    fail("release manifest does not describe the exact unsigned v1.4.0 boundary");
  }
  const installer = manifest.artifacts.find((artifact) => artifact?.id === "nsis_installer");
  if (
    installer?.path !== `bundle/nsis/${UNSIGNED_BETA_FILE_NAME}` ||
    installer?.bundleDisposition !== "distribution_installer" ||
    installer?.bytes !== candidateBytes.length ||
    installer?.sha256 !== sha256(candidateBytes)
  ) {
    fail("release manifest is stale relative to the NSIS candidate bytes");
  }
  const ids = manifest.artifacts.map((artifact) => artifact?.id);
  if (
    !exact(ids, [
      "stable_core",
      "nsis_installed_core",
      "bridge_prototype",
      "ai_prototype",
      "nsis_installer",
    ]) ||
    manifest.artifacts.find((artifact) => artifact.id === "bridge_prototype")
      ?.bundleDisposition !== "prototype_excluded" ||
    manifest.artifacts.find((artifact) => artifact.id === "ai_prototype")
      ?.bundleDisposition !== "prototype_excluded"
  ) {
    fail("release manifest artifact roles drifted from the reviewed boundary");
  }
  return installer;
}

export function validateUnsignedBetaFreezeIntent(source, confirmedBy, { now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("now must be a valid date");
  exactKeys(source, ["commit", "branch", "commitTimestamp", "worktreeClean"], "source");
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(source.commit)) {
    fail("source.commit must be a canonical Git commit ID");
  }
  if (source.branch !== "main") fail("unsigned beta candidate must be frozen from main");
  if (source.worktreeClean !== true) fail("unsigned beta candidate requires a clean worktree");
  const commitTime = validTimestamp(source.commitTimestamp, "source.commitTimestamp", now);
  humanName(confirmedBy, "confirmedBy");
  if (now.getTime() < commitTime) fail("confirmation cannot predate the source commit");
  return source;
}

export function buildUnsignedBetaFreezeReport(
  {
    source,
    candidateBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
    confirmedBy,
  },
  { now = new Date() } = {},
) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("now must be a valid date");
  if (
    !Buffer.isBuffer(candidateBytes) ||
    !Buffer.isBuffer(policyBytes) ||
    !Buffer.isBuffer(releaseManifestBytes) ||
    !Buffer.isBuffer(sourceScopeContractBytes) ||
    !Buffer.isBuffer(sourceScopeReportBytes) ||
    !Buffer.isBuffer(sourceScopeVerifierBytes)
  ) {
    fail("candidate, policy, manifest, and source-scope inputs must be bytes");
  }
  validateUnsignedBetaFreezeIntent(source, confirmedBy, { now });
  const confirmedAt = now.toISOString();

  let policy;
  let manifest;
  let sourceScopeReport;
  try {
    policy = JSON.parse(policyBytes.toString("utf8").replace(/^\uFEFF/u, ""));
    manifest = JSON.parse(releaseManifestBytes.toString("utf8").replace(/^\uFEFF/u, ""));
    sourceScopeReport = JSON.parse(sourceScopeReportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`release policy, manifest, or source-scope report JSON is invalid: ${error.message}`);
  }
  validateReleasePolicy(policy);
  validateReleaseManifest(manifest, candidateBytes);
  validateV14ReleaseSourceScopeReport(sourceScopeReport, {
    contractBytes: sourceScopeContractBytes,
    verifierBytes: sourceScopeVerifierBytes,
    now,
  });
  if (sourceScopeReport.source.commit !== source.commit) {
    fail("source-scope report is not bound to the unsigned beta source commit");
  }
  inspectPeAuthenticode(candidateBytes);

  const candidateSha256 = sha256(candidateBytes);
  const checksumBytes = Buffer.from(renderUnsignedBetaChecksum(candidateSha256), "utf8");
  const releaseNotesBytes = Buffer.from(renderUnsignedBetaReleaseNotes(candidateSha256), "utf8");
  const report = {
    schemaVersion: 1,
    status: "frozen_unsigned_beta_candidate",
    product: {
      name: "圆圆提醒",
      version: UNSIGNED_BETA_VERSION,
      tag: UNSIGNED_BETA_TAG,
      releaseKind: "github_prerelease_unsigned_beta",
    },
    source: {
      commit: source.commit,
      branch: source.branch,
      commitTimestamp: source.commitTimestamp,
      worktreeClean: true,
      confirmedBy,
      confirmedAt,
    },
    sourceScope: {
      policyPath: V14_RELEASE_SOURCE_SCOPE_FILE_NAME,
      policySha256: sha256(sourceScopeContractBytes),
      reportPath: V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME,
      reportSha256: sha256(sourceScopeReportBytes),
      verifierPath: V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME,
      verifierSha256: sha256(sourceScopeVerifierBytes),
      baselineCommit: sourceScopeReport.baseline.commit,
      learningPreviewExcluded: true,
    },
    policy: {
      path: "RELEASE_POLICY_V1.json",
      sha256: sha256(policyBytes),
      strategy: "low_cost_staged",
      previewChannel: "github_releases",
      plannedStableChannel: "microsoft_store",
    },
    build: {
      commands: [...UNSIGNED_BETA_BUILD_COMMANDS],
      releaseManifestPath: "release-manifest.json",
      releaseManifestSha256: sha256(releaseManifestBytes),
    },
    artifacts: {
      candidate: {
        fileName: UNSIGNED_BETA_FILE_NAME,
        path: UNSIGNED_BETA_FILE_NAME,
        bytes: candidateBytes.length,
        sha256: candidateSha256,
        authenticode: "not_signed",
      },
      checksums: {
        fileName: "SHA256SUMS.txt",
        path: "SHA256SUMS.txt",
        bytes: checksumBytes.length,
        sha256: sha256(checksumBytes),
      },
      releaseNotes: {
        fileName: "RELEASE_NOTES.md",
        path: "RELEASE_NOTES.md",
        bytes: releaseNotesBytes.length,
        sha256: sha256(releaseNotesBytes),
      },
    },
    outcome: {
      candidateFrozen: true,
      readyForCandidateBoundBetaEvidence: true,
      readyForGitHubPublish: false,
    },
  };
  validateUnsignedBetaFreezeReport(report, {
    candidateBytes,
    checksumBytes,
    releaseNotesBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
    now,
  });
  return { report, checksumBytes, releaseNotesBytes };
}

export function validateUnsignedBetaFreezeReport(
  report,
  {
    candidateBytes,
    checksumBytes,
    releaseNotesBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
    now = new Date(),
  } = {},
) {
  exactKeys(
    report,
    ["schemaVersion", "status", "product", "source", "sourceScope", "policy", "build", "artifacts", "outcome"],
    "freeze report",
  );
  if (report.schemaVersion !== 1 || report.status !== "frozen_unsigned_beta_candidate") {
    fail("freeze report schema or status is invalid");
  }
  exactKeys(report.product, ["name", "version", "tag", "releaseKind"], "product");
  if (
    report.product.name !== "圆圆提醒" ||
    report.product.version !== UNSIGNED_BETA_VERSION ||
    report.product.tag !== UNSIGNED_BETA_TAG ||
    report.product.releaseKind !== "github_prerelease_unsigned_beta"
  ) {
    fail("freeze report product identity drifted");
  }
  exactKeys(
    report.source,
    ["commit", "branch", "commitTimestamp", "worktreeClean", "confirmedBy", "confirmedAt"],
    "source",
  );
  if (
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(report.source.commit) ||
    report.source.branch !== "main" ||
    report.source.worktreeClean !== true
  ) {
    fail("freeze report source is not a clean main commit");
  }
  const commitTime = validTimestamp(report.source.commitTimestamp, "source.commitTimestamp", now);
  const confirmedTime = validTimestamp(report.source.confirmedAt, "source.confirmedAt", now);
  humanName(report.source.confirmedBy, "source.confirmedBy");
  if (confirmedTime < commitTime) fail("source confirmation predates the commit");

  if (
    !Buffer.isBuffer(candidateBytes) ||
    !Buffer.isBuffer(checksumBytes) ||
    !Buffer.isBuffer(releaseNotesBytes) ||
    !Buffer.isBuffer(policyBytes) ||
    !Buffer.isBuffer(releaseManifestBytes) ||
    !Buffer.isBuffer(sourceScopeContractBytes) ||
    !Buffer.isBuffer(sourceScopeReportBytes) ||
    !Buffer.isBuffer(sourceScopeVerifierBytes)
  ) {
    fail("all staged unsigned beta artifacts must be supplied as bytes");
  }
  let sourceScopeReport;
  try {
    sourceScopeReport = JSON.parse(sourceScopeReportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`staged source-scope report JSON is invalid: ${error.message}`);
  }
  validateV14ReleaseSourceScopeReport(sourceScopeReport, {
    contractBytes: sourceScopeContractBytes,
    verifierBytes: sourceScopeVerifierBytes,
    now,
  });
  exactKeys(
    report.sourceScope,
    [
      "policyPath",
      "policySha256",
      "reportPath",
      "reportSha256",
      "verifierPath",
      "verifierSha256",
      "baselineCommit",
      "learningPreviewExcluded",
    ],
    "sourceScope",
  );
  canonicalHash(report.sourceScope.policySha256, "sourceScope.policySha256");
  canonicalHash(report.sourceScope.reportSha256, "sourceScope.reportSha256");
  canonicalHash(report.sourceScope.verifierSha256, "sourceScope.verifierSha256");
  if (
    report.sourceScope.policyPath !== V14_RELEASE_SOURCE_SCOPE_FILE_NAME ||
    report.sourceScope.policySha256 !== sha256(sourceScopeContractBytes) ||
    report.sourceScope.reportPath !== V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME ||
    report.sourceScope.reportSha256 !== sha256(sourceScopeReportBytes) ||
    report.sourceScope.verifierPath !== V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME ||
    report.sourceScope.verifierSha256 !== sha256(sourceScopeVerifierBytes) ||
    report.sourceScope.baselineCommit !== sourceScopeReport.baseline.commit ||
    report.sourceScope.learningPreviewExcluded !== true ||
    sourceScopeReport.source.commit !== report.source.commit
  ) {
    fail("freeze report source-scope binding drifted or includes Learning Preview");
  }
  inspectPeAuthenticode(candidateBytes);
  let policy;
  let manifest;
  try {
    policy = JSON.parse(policyBytes.toString("utf8").replace(/^\uFEFF/u, ""));
    manifest = JSON.parse(releaseManifestBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`staged policy or manifest JSON is invalid: ${error.message}`);
  }
  validateReleasePolicy(policy);
  validateReleaseManifest(manifest, candidateBytes);

  exactKeys(report.policy, ["path", "sha256", "strategy", "previewChannel", "plannedStableChannel"], "policy");
  canonicalHash(report.policy.sha256, "policy.sha256");
  if (
    report.policy.path !== "RELEASE_POLICY_V1.json" ||
    report.policy.sha256 !== sha256(policyBytes) ||
    report.policy.strategy !== "low_cost_staged" ||
    report.policy.previewChannel !== "github_releases" ||
    report.policy.plannedStableChannel !== "microsoft_store"
  ) {
    fail("freeze report policy binding drifted");
  }
  exactKeys(report.build, ["commands", "releaseManifestPath", "releaseManifestSha256"], "build");
  canonicalHash(report.build.releaseManifestSha256, "build.releaseManifestSha256");
  if (
    !exact(report.build.commands, UNSIGNED_BETA_BUILD_COMMANDS) ||
    report.build.releaseManifestPath !== "release-manifest.json" ||
    report.build.releaseManifestSha256 !== sha256(releaseManifestBytes)
  ) {
    fail("freeze report build evidence drifted");
  }

  exactKeys(report.artifacts, ["candidate", "checksums", "releaseNotes"], "artifacts");
  const expectedArtifacts = {
    candidate: {
      fileName: UNSIGNED_BETA_FILE_NAME,
      path: UNSIGNED_BETA_FILE_NAME,
      bytes: candidateBytes.length,
      sha256: sha256(candidateBytes),
      authenticode: "not_signed",
    },
    checksums: {
      fileName: "SHA256SUMS.txt",
      path: "SHA256SUMS.txt",
      bytes: checksumBytes.length,
      sha256: sha256(checksumBytes),
    },
    releaseNotes: {
      fileName: "RELEASE_NOTES.md",
      path: "RELEASE_NOTES.md",
      bytes: releaseNotesBytes.length,
      sha256: sha256(releaseNotesBytes),
    },
  };
  for (const [name, expected] of Object.entries(expectedArtifacts)) {
    exactKeys(report.artifacts[name], Object.keys(expected), `artifacts.${name}`);
    canonicalHash(report.artifacts[name].sha256, `artifacts.${name}.sha256`);
    if (!exact(report.artifacts[name], expected)) fail(`artifacts.${name} drifted from staged bytes`);
  }
  const candidateSha256 = expectedArtifacts.candidate.sha256;
  if (checksumBytes.toString("utf8") !== renderUnsignedBetaChecksum(candidateSha256)) {
    fail("staged SHA256SUMS.txt does not identify the exact candidate bytes");
  }
  if (releaseNotesBytes.toString("utf8") !== renderUnsignedBetaReleaseNotes(candidateSha256)) {
    fail("staged release notes do not contain the exact unsigned-beta disclosure and digest");
  }

  exactKeys(
    report.outcome,
    ["candidateFrozen", "readyForCandidateBoundBetaEvidence", "readyForGitHubPublish"],
    "outcome",
  );
  if (
    report.outcome.candidateFrozen !== true ||
    report.outcome.readyForCandidateBoundBetaEvidence !== true ||
    report.outcome.readyForGitHubPublish !== false
  ) {
    fail("freezing a candidate cannot claim GitHub publication readiness");
  }
  return report;
}

export async function readAndValidateUnsignedBetaFreezeReport(
  stageRoot = defaultUnsignedBetaStageRoot,
  { now = new Date() } = {},
) {
  const reportPath = path.join(stageRoot, "unsigned-beta-freeze-report.json");
  let reportBytes;
  let candidateBytes;
  let checksumBytes;
  let releaseNotesBytes;
  let policyBytes;
  let releaseManifestBytes;
  let sourceScopeContractBytes;
  let sourceScopeReportBytes;
  let sourceScopeVerifierBytes;
  try {
    [
      reportBytes,
      candidateBytes,
      checksumBytes,
      releaseNotesBytes,
      policyBytes,
      releaseManifestBytes,
      sourceScopeContractBytes,
      sourceScopeReportBytes,
      sourceScopeVerifierBytes,
    ] =
      await Promise.all([
        readFile(reportPath),
        readFile(path.join(stageRoot, UNSIGNED_BETA_FILE_NAME)),
        readFile(path.join(stageRoot, "SHA256SUMS.txt")),
        readFile(path.join(stageRoot, "RELEASE_NOTES.md")),
        readFile(path.join(stageRoot, "RELEASE_POLICY_V1.json")),
        readFile(path.join(stageRoot, "release-manifest.json")),
        readFile(path.join(stageRoot, V14_RELEASE_SOURCE_SCOPE_FILE_NAME)),
        readFile(path.join(stageRoot, V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME)),
        readFile(path.join(stageRoot, V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME)),
      ]);
  } catch (error) {
    fail(`unsigned beta stage is missing or unreadable: ${error.message}`);
  }
  let report;
  try {
    report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`unsigned beta freeze report JSON is invalid: ${error.message}`);
  }
  validateUnsignedBetaFreezeReport(report, {
    candidateBytes,
    checksumBytes,
    releaseNotesBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
    now,
  });
  return {
    report,
    reportBytes,
    candidateBytes,
    checksumBytes,
    releaseNotesBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readAndValidateUnsignedBetaFreezeReport()
    .then(({ report }) => {
      process.stdout.write(
        `Unsigned beta candidate verified: ${report.artifacts.candidate.sha256}; GitHub publication remains pending.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Unsigned beta candidate pending: ${error.message}\n`);
      process.exitCode = 2;
    });
}
