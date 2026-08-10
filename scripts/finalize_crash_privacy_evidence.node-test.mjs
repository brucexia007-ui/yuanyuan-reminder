import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFinalReport,
  deriveCanary,
  parseArguments,
  scanArtifact,
  validateCaptureReport,
  validateFinalReport,
} from "./finalize_crash_privacy_evidence.mjs";

const hashes = {
  qaSourceSha256: "A".repeat(64),
  aiMainSourceSha256: "B".repeat(64),
  crashPolicySourceSha256: "C".repeat(64),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function passingScan() {
  return {
    rootsScanned: 1,
    filesScanned: 1,
    bytesScanned: 10,
    unreadableFiles: 0,
    reparsePointsRejected: 0,
    utf8Matches: 0,
    utf16LeMatches: 0,
  };
}

function capture() {
  const nonce = "07".repeat(32);
  const canary = deriveCanary(nonce);
  return {
    schemaVersion: 1,
    mode: "actual_ai_support_sort_abnormal_termination_capture",
    attestation: "isolated_windows_crash_privacy_capture_v1",
    binaryProfile: "release_with_crash_privacy_qa_feature",
    ...hashes,
    qaExecutableSha256: "D".repeat(64),
    aiExecutableSha256: "E".repeat(64),
    canaryDerivation: "sha256_nonce_context_v1",
    canaryNonceHex: nonce,
    canarySha256: sha256(Buffer.from(canary, "utf8")),
    providerDescribed: true,
    oneUseAuthorizationIssued: true,
    canarySubmitTransportInterrupted: true,
    abnormalExitObserved: true,
    abnormalExitCode: "0xC0000409",
    standardOutputUtf8Matches: 0,
    standardOutputUtf16LeMatches: 0,
    applicationDataScan: passingScan(),
    dumpRootScan: passingScan(),
    readyForOfflineMemoryScan: true,
    outcome: "capture_passed",
  };
}

function cleanArtifact(role = "pagefile_1") {
  return {
    role,
    sizeBytes: 4096,
    sha256: "F".repeat(64),
    utf8MatchObserved: false,
    utf16LeMatchObserved: false,
  };
}

test("accepts only a source-bound completed crash capture", () => {
  assert.equal(validateCaptureReport(capture(), hashes), deriveCanary("07".repeat(32)));
  const stale = capture();
  stale.aiMainSourceSha256 = "0".repeat(64);
  assert.throws(() => validateCaptureReport(stale, hashes), /stale, incomplete/);
  const leaked = capture();
  leaked.dumpRootScan.utf8Matches = 1;
  assert.throws(() => validateCaptureReport(leaked, hashes), /stale, incomplete/);
});

test("requires explicit complete offline acquisition coverage", () => {
  const base = [
    "--capture-report",
    "F:\\qa\\capture.json",
    "--report",
    "F:\\qa\\final.json",
    "--pagefile-artifact",
    "F:\\offline\\pagefile.sys",
    "--hibernation-state",
    "disabled_at_crash",
    "--swapfile-state",
    "absent_at_crash",
    "--attest-offline-acquisition",
    "isolated_windows_offline_memory_acquisition_v1",
  ];
  assert.equal(parseArguments(base).pagefiles.length, 1);
  assert.throws(
    () => parseArguments(base.filter((value) => value !== "F:\\offline\\pagefile.sys")),
    /unknown argument|requires a value|pagefile/,
  );
  const mismatched = [...base];
  mismatched[mismatched.indexOf("disabled_at_crash")] = "artifact_supplied";
  assert.throws(() => parseArguments(mismatched), /hiberfil artifact/);
});

test("streaming artifact scan detects UTF-8 and UTF-16 canaries across chunks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-crash-scan-"));
  try {
    const canary = deriveCanary("08".repeat(32));
    const cleanPath = path.join(directory, "clean.bin");
    const leakedPath = path.join(directory, "leaked.bin");
    await writeFile(cleanPath, Buffer.alloc(500, 1));
    await writeFile(
      leakedPath,
      Buffer.concat([
        Buffer.alloc(61, 2),
        Buffer.from(canary, "utf8"),
        Buffer.alloc(17, 3),
        Buffer.from(canary, "utf16le"),
      ]),
    );
    const clean = await scanArtifact(cleanPath, "pagefile_1", canary, 64);
    assert.equal(clean.utf8MatchObserved, false);
    assert.equal(clean.utf16LeMatchObserved, false);
    const leaked = await scanArtifact(leakedPath, "pagefile_1", canary, 64);
    assert.equal(leaked.utf8MatchObserved, true);
    assert.equal(leaked.utf16LeMatchObserved, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("final evidence passes only with clean complete artifacts and re-verifies exactly", () => {
  const input = {
    capture: capture(),
    captureReportSha256: "9".repeat(64),
    sourceHashes: hashes,
    artifacts: [cleanArtifact()],
    hibernationState: "disabled_at_crash",
    swapfileState: "absent_at_crash",
    generatedAt: "2026-08-08T00:00:00.000Z",
  };
  const report = buildFinalReport(input);
  assert.equal(report.ready, true);
  assert.equal(validateFinalReport(report, report), true);

  const leakedInput = { ...input, artifacts: [{ ...cleanArtifact(), utf8MatchObserved: true }] };
  const leaked = buildFinalReport(leakedInput);
  assert.equal(leaked.ready, false);
  assert.throws(() => validateFinalReport(leaked, leaked), /stale, incomplete/);

  const missingHiber = buildFinalReport({
    ...input,
    hibernationState: "artifact_supplied",
  });
  assert.equal(missingHiber.ready, false);

  const unknownState = buildFinalReport({ ...input, swapfileState: "unknown" });
  assert.equal(unknownState.ready, false);
});
