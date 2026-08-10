import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { msixStoreCandidateEvidenceMatches } from "./verify_msix_store_candidate.mjs";

const bytes = (value) => Buffer.from(value);
const hash = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();

function fixture() {
  const identity = {
    schemaVersion: 1,
    status: "partner_center_confirmed",
    source: "partner_center_product_identity",
    confirmedBy: "Release Maintainer",
    confirmedAt: "2026-08-10T12:00:00.000Z",
    product: { reservedProductName: "Yuanyuan Reminder", storeId: "9N1234567890" },
    package: {
      identityName: "12345Yuanyuan.Reminder",
      publisher: "CN=12345678-1234-1234-1234-1234567890AB",
      publisherDisplayName: "Yuanyuan Project",
      packageFamilyName: "12345Yuanyuan.Reminder_abcdefghjkmnp",
    },
    platform: {
      version: "1.4.0.0",
      architecture: "x64",
      targetDeviceFamily: "Windows.Desktop",
      minVersion: "10.0.19041.0",
      maxVersionTested: "10.0.26100.0",
    },
  };
  const blobs = Object.fromEntries(
    [
      "packageBytes",
      "executableBytes",
      "identityBytes",
      "identityVerifierBytes",
      "manifestTemplateBytes",
      "generatedManifestBytes",
      "buildScriptBytes",
      "iconBytes",
      "makeAppxBytes",
    ].map((name) => [name, bytes(name)]),
  );
  const gitHead = "a".repeat(40);
  const report = {
    schemaVersion: 1,
    mode: "msix_store_candidate",
    generatedAt: "2026-08-10T13:00:00.000Z",
    candidate: {
      version: "1.4.0.0",
      architecture: "x64",
      path: "src-tauri/target/msix-store/12345Yuanyuan.Reminder_1.4.0.0_x64-store.msix",
      bytes: blobs.packageBytes.length,
      sha256: hash(blobs.packageBytes),
      signatureStatus: "NotSigned",
      structureReady: true,
      partnerCenterIdentityReady: true,
      storeSubmissionReady: false,
    },
    sourceControl: {
      gitHead,
      worktreeCleanBeforeBuild: true,
      worktreeCleanAfterBuild: true,
    },
    policy: {
      strategy: "low_cost_staged",
      selectedChannel: "pending",
      plannedStableChannel: "microsoft_store",
    },
    sources: {
      executableBytes: blobs.executableBytes.length,
      executableSha256: hash(blobs.executableBytes),
      executableSignatureStatus: "NotSigned",
      identitySha256: hash(blobs.identityBytes),
      identityVerifierSha256: hash(blobs.identityVerifierBytes),
      manifestTemplateSha256: hash(blobs.manifestTemplateBytes),
      generatedManifestSha256: hash(blobs.generatedManifestBytes),
      buildScriptSha256: hash(blobs.buildScriptBytes),
      iconSha256: hash(blobs.iconBytes),
      makeAppxVersion: "10.0.26100.7705",
      makeAppxSha256: hash(blobs.makeAppxBytes),
    },
    manifest: {
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
      targetDeviceFamily: "Windows.Desktop",
      minimumWindowsVersion: "10.0.19041.0",
      maximumWindowsVersionTested: "10.0.26100.0",
      runFullTrust: true,
    },
    payload: {
      fileCount: 10,
      files: [
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
      ],
      exactBoundaryVerified: true,
      prototypeSidecarsExcluded: true,
      nestedInstallerExcluded: true,
      licenseFiles: [
        "ASSETS_LICENSE.md",
        "LICENSE.txt",
        "THIRD_PARTY_LICENSES.txt",
        "THIRD_PARTY_NOTICES.md",
      ],
    },
    validation: {
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
    },
    limitations: ["Partner Center identity is ready but clean Windows runtime testing is still required.".repeat(1), "The unsigned package is only for Microsoft Store intake and must not be distributed directly.", "Store certification and the complete release acceptance matrix remain pending."],
  };
  return {
    report,
    identity,
    releasePolicy: {
      schemaVersion: 1,
      distribution: {
        strategy: "low_cost_staged",
        selectedChannel: "pending",
        plannedStableChannel: "microsoft_store",
      },
    },
    ...blobs,
    worktreeClean: true,
    sourceCommitReachable: true,
    now: new Date("2026-08-11T00:00:00.000Z"),
  };
}

test("accepts an exact clean-source Store candidate while keeping submission pending", () => {
  assert.equal(msixStoreCandidateEvidenceMatches(fixture()), true);
});

test("rejects identity drift and preview publisher reuse", () => {
  const input = fixture();
  input.report.manifest.identityName = "Yuanyuan.Reminder.Preview";
  assert.equal(msixStoreCandidateEvidenceMatches(input), false);
  const second = fixture();
  second.report.manifest.identityPublisher =
    "CN=Preview, OID.2.25.311729368913984317654407730594956997722=1";
  assert.equal(msixStoreCandidateEvidenceMatches(second), false);
});

test("rejects dirty sources and optimistic Store readiness", () => {
  const dirty = fixture();
  dirty.worktreeClean = false;
  assert.equal(msixStoreCandidateEvidenceMatches(dirty), false);
  const unreachable = fixture();
  unreachable.sourceCommitReachable = false;
  assert.equal(msixStoreCandidateEvidenceMatches(unreachable), false);
  const optimistic = fixture();
  optimistic.report.candidate.storeSubmissionReady = true;
  assert.equal(msixStoreCandidateEvidenceMatches(optimistic), false);
});

test("rejects payload expansion and stale source hashes", () => {
  const expanded = fixture();
  expanded.report.payload.files.push("yuanyuan-ai.exe");
  expanded.report.payload.fileCount += 1;
  assert.equal(msixStoreCandidateEvidenceMatches(expanded), false);
  const stale = fixture();
  stale.buildScriptBytes = bytes("changed builder");
  assert.equal(msixStoreCandidateEvidenceMatches(stale), false);
});
