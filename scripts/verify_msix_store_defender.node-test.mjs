import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  StoreDefenderVerificationError,
  validateMsixStoreDefenderReport,
} from "./verify_msix_store_defender.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

function fixture() {
  const storeReleaseManifestBytes = Buffer.from("Store release manifest");
  const scannerBytes = Buffer.from("Defender scanner");
  const storeReleaseManifest = {
    candidate: {
      path: "src-tauri/target/msix-store/Yuanyuan_1.4.0.0_x64-store.msix",
      bytes: 123456,
      sha256: "A".repeat(64),
    },
    payload: {
      files: [
        { path: "AppxManifest.xml", bytes: 1000, sha256: "B".repeat(64) },
        { path: "yuanyuan-reminder.exe", bytes: 2000, sha256: "C".repeat(64) },
      ],
    },
  };
  const report = {
    schemaVersion: 1,
    mode: "msix_store_defender_scan",
    scannedAt: "2026-08-10T13:00:00.000Z",
    environment: {
      antivirusEnabled: true,
      serviceEnabled: true,
      realTimeProtectionEnabled: true,
      engineVersion: "1.1.25070.1",
      productVersion: "4.18.25070.5",
      signatureVersion: "1.437.123.0",
      signatureLastUpdated: "2026-08-10T12:00:00.000Z",
      securityIntelligenceMaximumAgeHours: 48,
    },
    bindings: {
      storeReleaseManifestSha256: hash(storeReleaseManifestBytes),
      unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
      scannerSha256: hash(scannerBytes),
    },
    targets: [
      {
        id: "unsigned_store_candidate",
        path: storeReleaseManifest.candidate.path,
        bytes: storeReleaseManifest.candidate.bytes,
        sha256: storeReleaseManifest.candidate.sha256,
      },
      ...storeReleaseManifest.payload.files.map((payload) => ({
        id: `payload:${payload.path}`,
        path: `src-tauri/target/msix-store/unpacked/${payload.path}`,
        bytes: payload.bytes,
        sha256: payload.sha256,
      })),
    ],
    detections: [],
    outcome: {
      candidateScanCompleted: true,
      unpackedPayloadScanCompleted: true,
      zeroDetections: true,
      passed: true,
    },
  };
  return {
    report,
    storeReleaseManifest,
    storeReleaseManifestBytes,
    scannerBytes,
    now: new Date("2026-08-11T00:00:00.000Z"),
  };
}

function rejects(input, pattern) {
  assert.throws(
    () => validateMsixStoreDefenderReport(input.report, input),
    (error) => error instanceof StoreDefenderVerificationError && pattern.test(error.message),
  );
}

test("accepts a current zero-detection Defender scan bound to every Store payload", () => {
  const input = fixture();
  assert.equal(validateMsixStoreDefenderReport(input.report, input), input.report);
});

test("rejects disabled protection and stale security intelligence", () => {
  const disabled = fixture();
  disabled.report.environment.realTimeProtectionEnabled = false;
  rejects(disabled, /disabled or.*stale/u);

  const stale = fixture();
  stale.report.environment.signatureLastUpdated = "2026-08-07T12:00:00.000Z";
  rejects(stale, /disabled or.*stale/u);
});

test("rejects candidate, manifest, or scanner drift", () => {
  const target = fixture();
  target.report.targets[1].sha256 = "D".repeat(64);
  rejects(target, /targets drifted/u);

  const manifest = fixture();
  manifest.report.bindings.storeReleaseManifestSha256 = "E".repeat(64);
  rejects(manifest, /bindings drifted/u);

  const scanner = fixture();
  scanner.scannerBytes = Buffer.from("changed scanner");
  rejects(scanner, /bindings drifted/u);
});

test("rejects detections and optimistic completion flags", () => {
  const detection = fixture();
  detection.report.detections.push({ threatId: "123", actionSuccess: true });
  rejects(detection, /detections/u);

  const incomplete = fixture();
  incomplete.report.outcome.unpackedPayloadScanCompleted = false;
  rejects(incomplete, /outcome/u);
});
