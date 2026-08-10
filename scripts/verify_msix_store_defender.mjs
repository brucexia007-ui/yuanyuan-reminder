import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const reportPath = path.join(targetRoot, "msix-store-defender-scan.json");
const releaseManifestPath = path.join(targetRoot, "msix-store-release-manifest.json");
const releaseManifestVerifierPath = path.join(
  projectRoot,
  "scripts",
  "generate_msix_store_release_manifest.mjs",
);
const scannerPath = path.join(projectRoot, "scripts", "scan_msix_store_with_defender.ps1");

export class StoreDefenderVerificationError extends Error {}

function fail(message) {
  throw new StoreDefenderVerificationError(message);
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
    fail(`${label} fields do not match the Store Defender contract`);
  }
}

function validVersion(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 120 && !/[\u0000-\u001F\u007F]/u.test(value);
}

export function validateMsixStoreDefenderReport(
  report,
  { storeReleaseManifest, storeReleaseManifestBytes, scannerBytes, now = new Date() } = {},
) {
  exactKeys(
    report,
    ["schemaVersion", "mode", "scannedAt", "environment", "bindings", "targets", "detections", "outcome"],
    "report",
  );
  if (report.schemaVersion !== 1 || report.mode !== "msix_store_defender_scan") {
    fail("report mode or schema is invalid");
  }
  const scannedAt = Date.parse(report.scannedAt);
  if (
    !Number.isFinite(scannedAt) ||
    scannedAt < Date.parse("2026-08-10T00:00:00.000Z") ||
    scannedAt > now.getTime() + 5 * 60 * 1000
  ) {
    fail("scannedAt must be a valid, non-future timestamp");
  }
  exactKeys(
    report.environment,
    [
      "antivirusEnabled",
      "serviceEnabled",
      "realTimeProtectionEnabled",
      "engineVersion",
      "productVersion",
      "signatureVersion",
      "signatureLastUpdated",
      "securityIntelligenceMaximumAgeHours",
    ],
    "environment",
  );
  const signatureUpdatedAt = Date.parse(report.environment.signatureLastUpdated);
  if (
    report.environment.antivirusEnabled !== true ||
    report.environment.serviceEnabled !== true ||
    report.environment.realTimeProtectionEnabled !== true ||
    !validVersion(report.environment.engineVersion) ||
    !validVersion(report.environment.productVersion) ||
    !validVersion(report.environment.signatureVersion) ||
    !Number.isFinite(signatureUpdatedAt) ||
    signatureUpdatedAt > scannedAt + 5 * 60 * 1000 ||
    scannedAt - signatureUpdatedAt > 48 * 60 * 60 * 1000 ||
    report.environment.securityIntelligenceMaximumAgeHours !== 48
  ) {
    fail("Defender was disabled or its security intelligence was stale");
  }
  exactKeys(
    report.bindings,
    ["storeReleaseManifestSha256", "unsignedStoreCandidateSha256", "scannerSha256"],
    "bindings",
  );
  if (
    report.bindings.storeReleaseManifestSha256 !== sha256(storeReleaseManifestBytes) ||
    report.bindings.unsignedStoreCandidateSha256 !== storeReleaseManifest?.candidate?.sha256 ||
    report.bindings.scannerSha256 !== sha256(scannerBytes)
  ) {
    fail("Defender evidence bindings drifted");
  }
  const expectedTargets = [
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
  ];
  if (!exact(report.targets, expectedTargets)) fail("Defender scan targets drifted from the Store manifest");
  if (!Array.isArray(report.detections) || report.detections.length !== 0) {
    fail("Defender reported one or more detections for the Store candidate");
  }
  if (
    !exact(report.outcome, {
      candidateScanCompleted: true,
      unpackedPayloadScanCompleted: true,
      zeroDetections: true,
      passed: true,
    })
  ) {
    fail("Defender scan outcome is incomplete");
  }
  return report;
}

async function main() {
  const manifestResult = spawnSync(process.execPath, [releaseManifestVerifierPath, "--check"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (manifestResult.status !== 0) fail(manifestResult.stderr.trim() || "Store release manifest failed");
  const [reportBytes, storeReleaseManifestBytes, scannerBytes] = await Promise.all([
    readFile(reportPath),
    readFile(releaseManifestPath),
    readFile(scannerPath),
  ]);
  const storeReleaseManifest = JSON.parse(
    storeReleaseManifestBytes.toString("utf8").replace(/^\uFEFF/u, ""),
  );
  const report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  validateMsixStoreDefenderReport(report, {
    storeReleaseManifest,
    storeReleaseManifestBytes,
    scannerBytes,
  });
  process.stdout.write(
    `MSIX Store Defender evidence verified: ${report.bindings.unsignedStoreCandidateSha256}, detections=0.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store Defender verification pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
