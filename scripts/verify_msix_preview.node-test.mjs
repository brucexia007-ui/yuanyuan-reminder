import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { msixPreviewEvidenceMatches } from "./verify_msix_preview.mjs";

const NOW = new Date("2026-08-11T00:00:00.000Z");

function bytes(label) {
  return Buffer.from(label.repeat(32));
}

function fixture() {
  const packageBytes = bytes("package");
  const executableBytes = bytes("executable");
  const manifestBytes = bytes("manifest");
  const buildScriptBytes = bytes("script");
  const iconBytes = bytes("icon");
  const digest = (value) =>
    createHash("sha256").update(value).digest("hex").toUpperCase();
  return {
    report: {
      schemaVersion: 1,
      mode: "msix_preview_candidate",
      generatedAt: "2026-08-10T12:00:00.000Z",
      candidate: {
        version: "1.4.0.0",
        architecture: "x64",
        path: "src-tauri/target/msix-preview/YuanyuanReminder_1.4.0_x64-preview.msix",
        bytes: packageBytes.length,
        sha256: digest(packageBytes),
        signatureStatus: "NotSigned",
        structureReady: true,
        storeSubmissionReady: false,
      },
      policy: {
        strategy: "low_cost_staged",
        selectedChannel: "pending",
        previewArtifactPolicy: "unsigned_beta_with_sha256",
        plannedStableChannel: "microsoft_store",
      },
      sources: {
        executableBytes: executableBytes.length,
        executableSha256: digest(executableBytes),
        executableSignatureStatus: "NotSigned",
        manifestSha256: digest(manifestBytes),
        buildScriptSha256: digest(buildScriptBytes),
        iconSha256: digest(iconBytes),
        makeAppxVersion: "10.0.26100.0",
        makeAppxSha256: "A".repeat(64),
      },
      manifest: {
        identityName: "Yuanyuan.Reminder.Preview",
        identityPublisher:
          "CN=YuanyuanReminderPreview, OID.2.25.311729368913984317654407730594956997722=1",
        identityIsPreviewPlaceholder: true,
        applicationId: "YuanyuanReminder",
        executable: "yuanyuan-reminder.exe",
        runtimeBehavior: "packagedClassicApp",
        trustLevel: "mediumIL",
        targetDeviceFamily: "Windows.Desktop",
        minimumWindowsVersion: "10.0.19041.0",
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
        makeAppxPackPassed: true,
        makeAppxUnpackPassed: true,
        packageUnsignedByDesign: true,
        looseRegistration: "not_performed",
        applicationLaunch: "not_performed",
        storeIdentityReserved: false,
        storeCertification: "not_performed",
      },
      limitations: [
        "This is an unsigned local MSIX technical preview and cannot be submitted to the Store with its placeholder identity.",
        "Partner Center must provide the final package Name, Publisher, and PublisherDisplayName.",
        "Loose registration, packaged launch, autostart, notifications, single instance, WebView2, data migration, upgrade, uninstall, and Store certification remain separate tests.",
      ],
    },
    releasePolicy: {
      schemaVersion: 1,
      distribution: {
        strategy: "low_cost_staged",
        selectedChannel: "pending",
        previewChannel: "github_releases",
        previewArtifactPolicy: "unsigned_beta_with_sha256",
        plannedStableChannel: "microsoft_store",
      },
    },
    packageBytes,
    executableBytes,
    manifestBytes,
    buildScriptBytes,
    iconBytes,
    now: NOW,
  };
}

test("accepts an exact unsigned MSIX preview bound to the low-cost policy", () => {
  assert.equal(msixPreviewEvidenceMatches(fixture()), true);
});

test("rejects Store-readiness claims, identity drift, payload expansion, and stale sources", () => {
  const mutations = [
    (input) => {
      input.report.candidate.storeSubmissionReady = true;
    },
    (input) => {
      input.report.manifest.identityName = "Store.Assigned.Identity";
    },
    (input) => {
      input.report.payload.files.push("yuanyuan-ai.exe");
      input.report.payload.fileCount += 1;
    },
    (input) => {
      input.buildScriptBytes = Buffer.from("changed script");
    },
    (input) => {
      input.releasePolicy.distribution.selectedChannel = "microsoft_store";
    },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.equal(msixPreviewEvidenceMatches(input), false);
  }
});
