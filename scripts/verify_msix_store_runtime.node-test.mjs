import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { msixStoreRuntimeEvidenceMatches } from "./verify_msix_store_runtime.mjs";

const packageBytes = Buffer.from("trusted-store-identity-msix");
const packageHash = createHash("sha256").update(packageBytes).digest("hex").toUpperCase();

function fixture() {
  const identity = {
    product: { storeId: "9N1234567890", reservedProductName: "Yuanyuan Reminder" },
    package: {
      identityName: "12345Yuanyuan.Reminder",
      publisher: "CN=12345678-1234-1234-1234-1234567890AB",
      publisherDisplayName: "Yuanyuan Project",
      packageFamilyName: "12345Yuanyuan.Reminder_abcdefghjkmnp",
    },
    platform: { version: "1.4.0.0" },
  };
  const storeReleaseManifestBytes = Buffer.from("Store release manifest bytes");
  const trustedPayloadArtifacts = {
    "AppxManifest.xml": Buffer.from("manifest payload"),
    "yuanyuan-reminder.exe": Buffer.from("application payload"),
  };
  const storeReleaseManifest = {
    schemaVersion: 1,
    mode: "msix_store_release_manifest",
    product: {
      storeId: identity.product.storeId,
      identityName: identity.package.identityName,
      packageFamilyName: identity.package.packageFamilyName,
      version: identity.platform.version,
    },
    candidate: { sha256: "F".repeat(64) },
    payload: {
      files: [
        { path: "AppxBlockMap.xml", bytes: 10, sha256: "E".repeat(64) },
        {
          path: "AppxManifest.xml",
          bytes: trustedPayloadArtifacts["AppxManifest.xml"].length,
          sha256: createHash("sha256")
            .update(trustedPayloadArtifacts["AppxManifest.xml"])
            .digest("hex")
            .toUpperCase(),
        },
        {
          path: "yuanyuan-reminder.exe",
          bytes: trustedPayloadArtifacts["yuanyuan-reminder.exe"].length,
          sha256: createHash("sha256")
            .update(trustedPayloadArtifacts["yuanyuan-reminder.exe"])
            .digest("hex")
            .toUpperCase(),
        },
      ],
    },
    boundary: {
      directDistributionAllowed: false,
      microsoftStoreResigningRequired: true,
      storeCertification: "pending",
    },
  };
  return {
    identity,
    packageBytes,
    storeReleaseManifest,
    storeReleaseManifestBytes,
    trustedPayloadArtifacts,
    now: new Date("2026-08-11T00:00:00.000Z"),
    report: {
      schemaVersion: 1,
      mode: "msix_store_runtime_test",
      testedAt: "2026-08-10T13:00:00.000Z",
      environment: {
        osVersion: "10.0.26100.1000",
        userInteractive: true,
        operatorConfirmedDisposableWindows11: true,
      },
      candidate: {
        sourcePath: "C:\\StoreFlight\\Yuanyuan.msix",
        sha256Before: packageHash,
        sha256After: packageHash,
        signatureStatus: "Valid",
        signatureOrigin: "disposable_test_certificate",
        signerSubject: identity.package.publisher,
        remainedUnmodified: true,
      },
      registration: {
        packageName: identity.package.identityName,
        packageFullName: `${identity.package.identityName}_1.4.0.0_x64__abcdefghjkmnp`,
        packageFamilyName: identity.package.packageFamilyName,
        version: "1.4.0.0",
        architecture: "X64",
        installed: true,
      },
      lineage: {
        storeReleaseManifestSha256: createHash("sha256")
          .update(storeReleaseManifestBytes)
          .digest("hex")
          .toUpperCase(),
        unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
        stablePayloadFileCount: 2,
        stablePayloadSha256: {
          "AppxManifest.xml": storeReleaseManifest.payload.files[1].sha256,
          "yuanyuan-reminder.exe": storeReleaseManifest.payload.files[2].sha256,
        },
        signatureMetadataFiles: ["AppxSignature.p7x"],
        allStablePayloadFilesMatched: true,
      },
      launch: {
        applicationId: "YuanyuanReminder",
        aumid: `${identity.package.packageFamilyName}!YuanyuanReminder`,
        processName: "yuanyuan-reminder",
        processCount: 1,
        processPaths: ["C:\\Program Files\\WindowsApps\\Yuanyuan\\yuanyuan-reminder.exe"],
        startedFromInstalledPackage: true,
        passed: true,
      },
      cleanup: {
        processesStopped: true,
        packageRemoved: true,
        candidatePreserved: true,
        certificateStoreModified: false,
        developerModeModified: false,
        passed: true,
      },
      limitations: [
        "This automated test proves package installation, process launch origin, uninstall, and cleanup only.",
        "The complete user-experience and migration matrix still requires human acceptance evidence.",
      ],
    },
  };
}

test("accepts disposable-test and Microsoft-Store signature origins", () => {
  assert.equal(msixStoreRuntimeEvidenceMatches(fixture()), true);
  const storeSigned = fixture();
  storeSigned.report.candidate.signatureOrigin = "microsoft_store";
  storeSigned.expectedSignatureOrigin = "microsoft_store";
  assert.equal(msixStoreRuntimeEvidenceMatches(storeSigned), true);
});

test("rejects an unsigned package or signer drift", () => {
  const unsigned = fixture();
  unsigned.report.candidate.signatureStatus = "NotSigned";
  assert.equal(msixStoreRuntimeEvidenceMatches(unsigned), false);
  const signerDrift = fixture();
  signerDrift.report.candidate.signerSubject = "CN=SomeoneElse";
  assert.equal(msixStoreRuntimeEvidenceMatches(signerDrift), false);
});

test("rejects non-disposable or downlevel environments", () => {
  const notDisposable = fixture();
  notDisposable.report.environment.operatorConfirmedDisposableWindows11 = false;
  assert.equal(msixStoreRuntimeEvidenceMatches(notDisposable), false);
  const windows10 = fixture();
  windows10.report.environment.osVersion = "10.0.19045.5000";
  assert.equal(msixStoreRuntimeEvidenceMatches(windows10), false);
});

test("rejects optimistic launch and cleanup claims", () => {
  const wrongOrigin = fixture();
  wrongOrigin.report.launch.startedFromInstalledPackage = false;
  assert.equal(msixStoreRuntimeEvidenceMatches(wrongOrigin), false);
  const residue = fixture();
  residue.report.cleanup.packageRemoved = false;
  residue.report.cleanup.passed = false;
  assert.equal(msixStoreRuntimeEvidenceMatches(residue), false);
});

test("rejects a Microsoft-signed package whose stable payload drifted from the uploaded candidate", () => {
  const executableDrift = fixture();
  executableDrift.trustedPayloadArtifacts["yuanyuan-reminder.exe"] = Buffer.from("other app");
  assert.equal(msixStoreRuntimeEvidenceMatches(executableDrift), false);

  const staleManifest = fixture();
  staleManifest.report.lineage.storeReleaseManifestSha256 = "A".repeat(64);
  assert.equal(msixStoreRuntimeEvidenceMatches(staleManifest), false);

  const extraMetadata = fixture();
  extraMetadata.report.lineage.signatureMetadataFiles.push("evil.exe");
  assert.equal(msixStoreRuntimeEvidenceMatches(extraMetadata), false);
});
