import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { msixStoreWackEvidenceMatches } from "./verify_msix_store_wack.mjs";

const bytes = (value) => Buffer.from(value);
const hash = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();

function fixture() {
  const identity = {
    package: { publisher: "CN=12345678-1234-1234-1234-1234567890AB" },
  };
  const uploadCandidateBytes = bytes("unsigned upload candidate");
  const testSignedPackageBytes = bytes("disposable signed clone");
  const rawReportBytes = bytes("wack xml report");
  const runtimeReportBytes = bytes("runtime report");
  const appCertBytes = bytes("appcert tool");
  const signToolBytes = bytes("signtool tool");
  const candidateReport = {
    candidate: {
      path: "src-tauri/target/msix-store/12345Yuanyuan.Reminder_1.4.0.0_x64-store.msix",
      sha256: hash(uploadCandidateBytes),
      signatureStatus: "NotSigned",
    },
  };
  return {
    identity,
    candidateReport,
    uploadCandidateBytes,
    testSignedPackageBytes,
    rawReportBytes,
    runtimeReportBytes,
    appCertBytes,
    signToolBytes,
    currentCertificateAbsent: true,
    now: new Date("2026-08-11T00:00:00.000Z"),
    report: {
      schemaVersion: 1,
      mode: "msix_store_wack_execution",
      testedAt: "2026-08-10T13:00:00.000Z",
      environment: {
        osVersion: "10.0.26100.1000",
        activeUserSession: true,
        administrator: true,
        operatorConfirmedDisposableWindows11: true,
      },
      uploadCandidate: {
        path: candidateReport.candidate.path,
        sha256Before: hash(uploadCandidateBytes),
        sha256After: hash(uploadCandidateBytes),
        remainedUnsignedAndUnmodified: true,
      },
      disposableTestPackage: {
        path: "src-tauri/target/msix-store/wack-test-signed.msix",
        sha256: hash(testSignedPackageBytes),
        signatureStatusDuringTest: "Valid",
        signerSubject: identity.package.publisher,
        signerThumbprint: "A".repeat(40),
        certificatePrivateKeyExportable: false,
        runtimeReportPath: "src-tauri/target/msix-store-runtime/msix-store-runtime-report.json",
        runtimeReportSha256: hash(runtimeReportBytes),
      },
      temporaryTrust: {
        certificateStores: ["CurrentUser/My", "CurrentUser/TrustedPeople"],
        developerModeModified: false,
        certificateRemovedFromAllStores: true,
        certificateFileRemoved: true,
      },
      testEnvironmentCleanup: {
        applicationProcessesStopped: true,
        packageRegistrationRemoved: true,
        passed: true,
      },
      tool: {
        appCertPath: "C:\\Program Files (x86)\\Windows Kits\\10\\App Certification Kit\\appcert.exe",
        appCertVersion: "10.0.26100.7705",
        appCertSha256: hash(appCertBytes),
        signToolPath: "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe",
        signToolVersion: "10.0.26100.7705",
        signToolSha256: hash(signToolBytes),
      },
      execution: {
        resetExitCode: 0,
        testExitCode: 0,
        rawReportPath: "src-tauri/target/msix-store/wack-report.xml",
        rawReportSha256: hash(rawReportBytes),
        humanReview: "pending",
        certificationGatePassed: false,
      },
    },
  };
}

test("accepts WACK evidence with an unchanged upload package and fully removed temporary trust", () => {
  assert.equal(msixStoreWackEvidenceMatches(fixture()), true);
});

test("rejects upload candidate mutation and signer drift", () => {
  const mutation = fixture();
  mutation.report.uploadCandidate.sha256After = "B".repeat(64);
  assert.equal(msixStoreWackEvidenceMatches(mutation), false);
  const signer = fixture();
  signer.report.disposableTestPackage.signerSubject = "CN=SomeoneElse";
  assert.equal(msixStoreWackEvidenceMatches(signer), false);
});

test("rejects certificate residue or developer mode changes", () => {
  const residue = fixture();
  residue.currentCertificateAbsent = false;
  assert.equal(msixStoreWackEvidenceMatches(residue), false);
  const developerMode = fixture();
  developerMode.report.temporaryTrust.developerModeModified = true;
  assert.equal(msixStoreWackEvidenceMatches(developerMode), false);
  const packageResidue = fixture();
  packageResidue.report.testEnvironmentCleanup.packageRegistrationRemoved = false;
  packageResidue.report.testEnvironmentCleanup.passed = false;
  assert.equal(msixStoreWackEvidenceMatches(packageResidue), false);
});

test("rejects optimistic WACK human review and certification claims", () => {
  const human = fixture();
  human.report.execution.humanReview = "passed";
  assert.equal(msixStoreWackEvidenceMatches(human), false);
  const certified = fixture();
  certified.report.execution.certificationGatePassed = true;
  assert.equal(msixStoreWackEvidenceMatches(certified), false);
});
