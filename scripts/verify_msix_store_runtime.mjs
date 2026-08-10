import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultStoreIdentityPath,
  readAndValidateStoreIdentity,
} from "./verify_msix_store_identity.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preSubmissionReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "msix-store-runtime-report.json",
);
const certifiedReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "msix-store-certified-runtime-report.json",
);
const storeReleaseManifestPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-release-manifest.json",
);
const runtimeUnpackRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "unpacked",
);
const storeReleaseManifestVerifierPath = path.join(
  projectRoot,
  "scripts",
  "generate_msix_store_release_manifest.mjs",
);
const ALLOWED_SIGNATURE_METADATA = [
  "AppxMetadata/CodeIntegrity.cat",
  "AppxMetadata/ContentGroupMap.xml",
  "AppxSignature.p7x",
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

function validText(value, minimum = 1, maximum = 700) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

export function msixStoreRuntimeEvidenceMatches({
  report,
  identity,
  packageBytes,
  storeReleaseManifest,
  storeReleaseManifestBytes,
  trustedPayloadArtifacts,
  expectedSignatureOrigin = "disposable_test_certificate",
  now = new Date(),
}) {
  if (
    !exactKeys(report, [
      "schemaVersion",
      "mode",
      "testedAt",
      "environment",
      "candidate",
      "registration",
      "lineage",
      "launch",
      "cleanup",
      "limitations",
    ]) ||
    report.schemaVersion !== 1 ||
    report.mode !== "msix_store_runtime_test"
  ) {
    return false;
  }
  const testedAt = Date.parse(report.testedAt);
  if (
    !Number.isFinite(testedAt) ||
    testedAt > now.getTime() + 5 * 60 * 1000 ||
    testedAt < Date.parse("2026-08-10T00:00:00.000Z")
  ) {
    return false;
  }
  if (
    storeReleaseManifest?.schemaVersion !== 1 ||
    storeReleaseManifest.mode !== "msix_store_release_manifest" ||
    storeReleaseManifest.product?.storeId !== identity.product.storeId ||
    storeReleaseManifest.product?.identityName !== identity.package.identityName ||
    storeReleaseManifest.product?.packageFamilyName !== identity.package.packageFamilyName ||
    storeReleaseManifest.product?.version !== identity.platform.version ||
    storeReleaseManifest.boundary?.directDistributionAllowed !== false ||
    storeReleaseManifest.boundary?.microsoftStoreResigningRequired !== true ||
    storeReleaseManifest.boundary?.storeCertification !== "pending" ||
    !Buffer.isBuffer(storeReleaseManifestBytes)
  ) {
    return false;
  }
  const stablePayload = storeReleaseManifest.payload?.files?.filter(
    (item) => item.path !== "AppxBlockMap.xml",
  );
  if (
    !Array.isArray(stablePayload) ||
    stablePayload.length < 1 ||
    !exact(
      Object.keys(trustedPayloadArtifacts ?? {}).sort(),
      stablePayload.map((item) => item.path).sort(),
    )
  ) {
    return false;
  }
  const expectedStableHashes = {};
  for (const item of stablePayload) {
    const bytes = trustedPayloadArtifacts[item.path];
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== item.bytes ||
      sha256(bytes) !== item.sha256 ||
      !canonicalHash(item.sha256)
    ) {
      return false;
    }
    expectedStableHashes[item.path] = item.sha256;
  }
  if (
    !exactKeys(report.lineage, [
      "storeReleaseManifestSha256",
      "unsignedStoreCandidateSha256",
      "stablePayloadFileCount",
      "stablePayloadSha256",
      "signatureMetadataFiles",
      "allStablePayloadFilesMatched",
    ]) ||
    report.lineage.storeReleaseManifestSha256 !== sha256(storeReleaseManifestBytes) ||
    report.lineage.unsignedStoreCandidateSha256 !== storeReleaseManifest.candidate.sha256 ||
    report.lineage.stablePayloadFileCount !== stablePayload.length ||
    !exact(report.lineage.stablePayloadSha256, expectedStableHashes) ||
    !Array.isArray(report.lineage.signatureMetadataFiles) ||
    !report.lineage.signatureMetadataFiles.includes("AppxSignature.p7x") ||
    !report.lineage.signatureMetadataFiles.every((item) =>
      ALLOWED_SIGNATURE_METADATA.includes(item)
    ) ||
    !exact(
      report.lineage.signatureMetadataFiles,
      [...report.lineage.signatureMetadataFiles].sort(),
    ) ||
    report.lineage.allStablePayloadFilesMatched !== true
  ) {
    return false;
  }
  if (
    !exactKeys(report.environment, [
      "osVersion",
      "userInteractive",
      "operatorConfirmedDisposableWindows11",
    ]) ||
    !/^10\.0\.(?:2[2-9][0-9]{3}|[3-9][0-9]{4,})\.\d+$/.test(report.environment.osVersion) ||
    report.environment.userInteractive !== true ||
    report.environment.operatorConfirmedDisposableWindows11 !== true
  ) {
    return false;
  }
  if (
    !exactKeys(report.candidate, [
      "sourcePath",
      "sha256Before",
      "sha256After",
      "signatureStatus",
      "signatureOrigin",
      "signerSubject",
      "remainedUnmodified",
    ]) ||
    !validText(report.candidate.sourcePath, 4, 2048) ||
    !canonicalHash(report.candidate.sha256Before) ||
    report.candidate.sha256Before !== sha256(packageBytes) ||
    report.candidate.sha256After !== report.candidate.sha256Before ||
    report.candidate.signatureStatus !== "Valid" ||
    report.candidate.signatureOrigin !== expectedSignatureOrigin ||
    report.candidate.signerSubject !== identity.package.publisher ||
    report.candidate.remainedUnmodified !== true
  ) {
    return false;
  }
  if (
    !exactKeys(report.registration, [
      "packageName",
      "packageFullName",
      "packageFamilyName",
      "version",
      "architecture",
      "installed",
    ]) ||
    report.registration.packageName !== identity.package.identityName ||
    !validText(report.registration.packageFullName, 10, 300) ||
    report.registration.packageFamilyName !== identity.package.packageFamilyName ||
    report.registration.version !== identity.platform.version ||
    report.registration.architecture !== "X64" ||
    report.registration.installed !== true
  ) {
    return false;
  }
  const expectedAumid = `${identity.package.packageFamilyName}!YuanyuanReminder`;
  if (
    !exactKeys(report.launch, [
      "applicationId",
      "aumid",
      "processName",
      "processCount",
      "processPaths",
      "startedFromInstalledPackage",
      "passed",
    ]) ||
    report.launch.applicationId !== "YuanyuanReminder" ||
    report.launch.aumid !== expectedAumid ||
    report.launch.processName !== "yuanyuan-reminder" ||
    !Number.isInteger(report.launch.processCount) ||
    report.launch.processCount < 1 ||
    !Array.isArray(report.launch.processPaths) ||
    report.launch.processPaths.length !== report.launch.processCount ||
    !report.launch.processPaths.every((item) => validText(item, 4, 2048)) ||
    report.launch.startedFromInstalledPackage !== true ||
    report.launch.passed !== true
  ) {
    return false;
  }
  if (
    !exact(report.cleanup, {
      processesStopped: true,
      packageRemoved: true,
      candidatePreserved: true,
      certificateStoreModified: false,
      developerModeModified: false,
      passed: true,
    }) ||
    !Array.isArray(report.limitations) ||
    report.limitations.length !== 2 ||
    !report.limitations.every((item) => validText(item, 20, 700))
  ) {
    return false;
  }
  return true;
}

async function main() {
  const identity = readAndValidateStoreIdentity(defaultStoreIdentityPath);
  const manifestVerification = spawnSync(
    process.execPath,
    [storeReleaseManifestVerifierPath, "--check"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (manifestVerification.status !== 0) {
    throw new Error(manifestVerification.stderr.trim() || "store_release_manifest_verification_failed");
  }
  const certified = process.argv.includes("--certified");
  const reportPath = certified ? certifiedReportPath : preSubmissionReportPath;
  const expectedSignatureOrigin = certified ? "microsoft_store" : "disposable_test_certificate";
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const packageBytes = await readFile(path.resolve(report.candidate.sourcePath));
  const storeReleaseManifestBytes = await readFile(storeReleaseManifestPath);
  const storeReleaseManifest = JSON.parse(
    storeReleaseManifestBytes.toString("utf8").replace(/^\uFEFF/u, ""),
  );
  const stablePayload = storeReleaseManifest.payload.files.filter(
    (item) => item.path !== "AppxBlockMap.xml",
  );
  const trustedPayloadArtifacts = Object.fromEntries(
    await Promise.all(
      stablePayload.map(async (item) => [
        item.path,
        await readFile(path.join(runtimeUnpackRoot, ...item.path.split("/"))),
      ]),
    ),
  );
  if (!msixStoreRuntimeEvidenceMatches({
    report,
    identity,
    packageBytes,
    storeReleaseManifest,
    storeReleaseManifestBytes,
    trustedPayloadArtifacts,
    expectedSignatureOrigin,
  })) {
    throw new Error("msix_store_runtime_evidence_mismatch");
  }
  process.stdout.write(
    `MSIX Store runtime evidence verified: ${report.candidate.sha256Before}, origin=${expectedSignatureOrigin}, cleanup=true.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store runtime verification pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
