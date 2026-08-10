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
const targetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const executionReportPath = path.join(targetRoot, "wack-execution-report.json");
const candidateReportPath = path.join(targetRoot, "msix-store-candidate-report.json");
const testSignedPackagePath = path.join(targetRoot, "wack-test-signed.msix");
const rawReportPath = path.join(targetRoot, "wack-report.xml");
const runtimeReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store-runtime",
  "msix-store-runtime-report.json",
);
const candidateVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_candidate.mjs");
const expectedAppCertPath = "C:\\Program Files (x86)\\Windows Kits\\10\\App Certification Kit\\appcert.exe";

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

function validText(value, minimum = 1, maximum = 2048) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

export function msixStoreWackEvidenceMatches({
  report,
  identity,
  candidateReport,
  uploadCandidateBytes,
  testSignedPackageBytes,
  rawReportBytes,
  runtimeReportBytes,
  appCertBytes,
  signToolBytes,
  currentCertificateAbsent,
  now = new Date(),
}) {
  if (
    !exactKeys(report, [
      "schemaVersion",
      "mode",
      "testedAt",
      "environment",
      "uploadCandidate",
      "disposableTestPackage",
      "temporaryTrust",
      "testEnvironmentCleanup",
      "tool",
      "execution",
    ]) ||
    report.schemaVersion !== 1 ||
    report.mode !== "msix_store_wack_execution"
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
    !exactKeys(report.environment, [
      "osVersion",
      "activeUserSession",
      "administrator",
      "operatorConfirmedDisposableWindows11",
    ]) ||
    !/^10\.0\.(?:2[2-9][0-9]{3}|[3-9][0-9]{4,})\.\d+$/.test(report.environment.osVersion) ||
    report.environment.activeUserSession !== true ||
    report.environment.administrator !== true ||
    report.environment.operatorConfirmedDisposableWindows11 !== true
  ) {
    return false;
  }
  if (
    !exactKeys(report.uploadCandidate, ["path", "sha256Before", "sha256After", "remainedUnsignedAndUnmodified"]) ||
    report.uploadCandidate.path !== candidateReport.candidate.path ||
    report.uploadCandidate.sha256Before !== candidateReport.candidate.sha256 ||
    report.uploadCandidate.sha256Before !== sha256(uploadCandidateBytes) ||
    report.uploadCandidate.sha256After !== report.uploadCandidate.sha256Before ||
    report.uploadCandidate.remainedUnsignedAndUnmodified !== true ||
    candidateReport.candidate.signatureStatus !== "NotSigned"
  ) {
    return false;
  }
  if (
    !exactKeys(report.disposableTestPackage, [
      "path",
      "sha256",
      "signatureStatusDuringTest",
      "signerSubject",
      "signerThumbprint",
      "certificatePrivateKeyExportable",
      "runtimeReportPath",
      "runtimeReportSha256",
    ]) ||
    report.disposableTestPackage.path !== "src-tauri/target/msix-store/wack-test-signed.msix" ||
    report.disposableTestPackage.sha256 !== sha256(testSignedPackageBytes) ||
    report.disposableTestPackage.signatureStatusDuringTest !== "Valid" ||
    report.disposableTestPackage.signerSubject !== identity.package.publisher ||
    !/^[A-F0-9]{40}$/.test(report.disposableTestPackage.signerThumbprint) ||
    report.disposableTestPackage.certificatePrivateKeyExportable !== false ||
    report.disposableTestPackage.runtimeReportPath !== "src-tauri/target/msix-store-runtime/msix-store-runtime-report.json" ||
    report.disposableTestPackage.runtimeReportSha256 !== sha256(runtimeReportBytes)
  ) {
    return false;
  }
  if (
    !exact(report.temporaryTrust, {
      certificateStores: ["CurrentUser/My", "CurrentUser/TrustedPeople"],
      developerModeModified: false,
      certificateRemovedFromAllStores: true,
      certificateFileRemoved: true,
    }) ||
    currentCertificateAbsent !== true
  ) {
    return false;
  }
  if (
    !exact(report.testEnvironmentCleanup, {
      applicationProcessesStopped: true,
      packageRegistrationRemoved: true,
      passed: true,
    })
  ) {
    return false;
  }
  if (
    !exactKeys(report.tool, [
      "appCertPath",
      "appCertVersion",
      "appCertSha256",
      "signToolPath",
      "signToolVersion",
      "signToolSha256",
    ]) ||
    report.tool.appCertPath !== expectedAppCertPath ||
    !validText(report.tool.appCertVersion, 3, 120) ||
    report.tool.appCertSha256 !== sha256(appCertBytes) ||
    !/^C:\\Program Files \(x86\)\\Windows Kits\\10\\bin\\\d+\.\d+\.\d+\.\d+\\x64\\signtool\.exe$/i.test(
      report.tool.signToolPath,
    ) ||
    !validText(report.tool.signToolVersion, 3, 120) ||
    report.tool.signToolSha256 !== sha256(signToolBytes)
  ) {
    return false;
  }
  if (
    !exactKeys(report.execution, [
      "resetExitCode",
      "testExitCode",
      "rawReportPath",
      "rawReportSha256",
      "humanReview",
      "certificationGatePassed",
    ]) ||
    report.execution.resetExitCode !== 0 ||
    report.execution.testExitCode !== 0 ||
    report.execution.rawReportPath !== "src-tauri/target/msix-store/wack-report.xml" ||
    !canonicalHash(report.execution.rawReportSha256) ||
    report.execution.rawReportSha256 !== sha256(rawReportBytes) ||
    report.execution.humanReview !== "pending" ||
    report.execution.certificationGatePassed !== false
  ) {
    return false;
  }
  return true;
}

function runCandidateVerifier() {
  const result = spawnSync(process.execPath, [candidateVerifierPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "candidate_verifier_failed");
}

function temporaryCertificateIsAbsent(thumbprint) {
  if (!/^[A-F0-9]{40}$/.test(thumbprint)) return false;
  const command = [
    "$thumbprint = $env:YUANYUAN_WACK_CERT_THUMBPRINT",
    "$matches = @()",
    "foreach ($store in @('Cert:\\CurrentUser\\My','Cert:\\CurrentUser\\TrustedPeople')) {",
    "  $matches += @(Get-ChildItem -Path $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -ceq $thumbprint })",
    "}",
    "Write-Output $matches.Count",
  ].join("\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, YUANYUAN_WACK_CERT_THUMBPRINT: thumbprint },
    },
  );
  return result.status === 0 && result.stdout.trim() === "0";
}

async function main() {
  const identity = readAndValidateStoreIdentity(defaultStoreIdentityPath);
  runCandidateVerifier();
  const [reportBytes, candidateReportBytes] = await Promise.all([
    readFile(executionReportPath),
    readFile(candidateReportPath),
  ]);
  const report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const candidateReport = JSON.parse(candidateReportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const uploadCandidatePath = path.resolve(projectRoot, candidateReport.candidate.path);
  const [
    uploadCandidateBytes,
    testSignedPackageBytes,
    rawReportBytes,
    runtimeReportBytes,
    appCertBytes,
    signToolBytes,
  ] = await Promise.all([
    readFile(uploadCandidatePath),
    readFile(testSignedPackagePath),
    readFile(rawReportPath),
    readFile(runtimeReportPath),
    readFile(expectedAppCertPath),
    readFile(report.tool.signToolPath),
  ]);
  const currentCertificateAbsent = temporaryCertificateIsAbsent(
    report.disposableTestPackage.signerThumbprint,
  );
  if (
    !msixStoreWackEvidenceMatches({
      report,
      identity,
      candidateReport,
      uploadCandidateBytes,
      testSignedPackageBytes,
      rawReportBytes,
      runtimeReportBytes,
      appCertBytes,
      signToolBytes,
      currentCertificateAbsent,
    })
  ) {
    throw new Error("msix_store_wack_evidence_mismatch");
  }
  process.stdout.write(
    `MSIX Store WACK execution evidence verified: ${report.execution.rawReportSha256}; human review remains pending.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store WACK verification pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
