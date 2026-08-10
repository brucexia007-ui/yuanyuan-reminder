import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseUnsignedBetaFreezeArguments,
  writeNewUnsignedBetaStage,
} from "./prepare_unsigned_beta_candidate.mjs";
import {
  buildUnsignedBetaFreezeReport,
  inspectPeAuthenticode,
  renderUnsignedBetaChecksum,
  renderUnsignedBetaReleaseNotes,
  UNSIGNED_BETA_FILE_NAME,
  UnsignedBetaCandidateVerificationError,
  validateUnsignedBetaFreezeIntent,
  validateUnsignedBetaFreezeReport,
} from "./verify_unsigned_beta_candidate.mjs";
import {
  buildV14ReleaseSourceScopeReport,
  defaultV14ReleaseSourceScopePath,
  defaultV14ReleaseSourceScopeVerifierPath,
  V14_RELEASE_SOURCE_SCOPE_FILE_NAME,
  V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME,
  V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME,
} from "./verify_v1_4_release_source_scope.mjs";

const now = new Date();
const [sourceScopeContractBytes, sourceScopeVerifierBytes] = await Promise.all([
  readFile(defaultV14ReleaseSourceScopePath),
  readFile(defaultV14ReleaseSourceScopeVerifierPath),
]);
const source = {
  commit: "a".repeat(40),
  branch: "main",
  commitTimestamp: "2026-08-10T12:00:00.000Z",
  worktreeClean: true,
};

function unsignedPe() {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(240, 0x80 + 20);
  const optionalOffset = 0x80 + 24;
  bytes.writeUInt16LE(0x20b, optionalOffset);
  bytes.writeUInt32LE(16, optionalOffset + 108);
  return bytes;
}

function policyBytes() {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      product: { identifier: "com.yuanyuan.reminder", name: "圆圆提醒" },
      distribution: {
        strategy: "low_cost_staged",
        selectedChannel: "pending",
        previewChannel: "github_releases",
        previewArtifactPolicy: "unsigned_beta_with_sha256",
        plannedStableChannel: "microsoft_store",
      },
    })}\n`,
    "utf8",
  );
}

function manifestBytes(candidateBytes) {
  const hash = sha256(candidateBytes);
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      productName: "圆圆提醒",
      productVersion: "1.4.0",
      generatedAt: "2026-08-10T13:00:00.000Z",
      signatureVerification: "not_performed",
      installerBoundary: { experimentalSidecarsIncluded: false },
      artifacts: [
        { id: "stable_core", bundleDisposition: "primary_application" },
        { id: "nsis_installed_core", bundleDisposition: "installer_payload" },
        { id: "bridge_prototype", bundleDisposition: "prototype_excluded" },
        { id: "ai_prototype", bundleDisposition: "prototype_excluded" },
        {
          id: "nsis_installer",
          path: `bundle/nsis/${UNSIGNED_BETA_FILE_NAME}`,
          bytes: candidateBytes.length,
          sha256: hash,
          bundleDisposition: "distribution_installer",
        },
      ],
    })}\n`,
    "utf8",
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function sourceScopeReportBytes() {
  const runtimeFiles = [
    { path: "src-tauri/Cargo.toml", bytes: Buffer.from("[package]\nname = \"yuanyuan-reminder\"\n") },
    { path: "src-tauri/migrations/011_task_watch_attention_deferrals.sql", bytes: Buffer.from("PRAGMA user_version = 11;\n") },
    { path: "src-tauri/src/lib.rs", bytes: Buffer.from("pub fn run() {}\n") },
    { path: "src/main.tsx", bytes: Buffer.from("export const app = true;\n") },
    { path: "src/vite-env.d.ts", bytes: Buffer.from("/// <reference types=\"vite/client\" />\n") },
    { path: "vite.config.ts", bytes: Buffer.from("export default {};\n") },
  ];
  const report = buildV14ReleaseSourceScopeReport(
    {
      contractBytes: sourceScopeContractBytes,
      verifierBytes: sourceScopeVerifierBytes,
      source: {
        ...source,
        baselineTagCommit: "11841b88cf7b3e6d10502fd0158401e2c02167ae",
        baselineIsAncestor: true,
      },
      changedPaths: ["PRIVACY.md", "src-tauri/src/local_data_cleanup.rs"],
      runtimeFiles,
    },
    { now },
  );
  return Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function fixture() {
  const candidateBytes = unsignedPe();
  const inputs = {
    source: structuredClone(source),
    candidateBytes,
    policyBytes: policyBytes(),
    releaseManifestBytes: manifestBytes(candidateBytes),
    sourceScopeContractBytes,
    sourceScopeReportBytes: sourceScopeReportBytes(),
    sourceScopeVerifierBytes,
    confirmedBy: "Release Maintainer",
  };
  const built = buildUnsignedBetaFreezeReport(inputs, { now });
  return { ...inputs, ...built };
}

test("builds and validates an exact clean-main unsigned beta freeze contract", () => {
  const value = fixture();
  assert.equal(value.report.status, "frozen_unsigned_beta_candidate");
  assert.equal(value.report.source.commit, source.commit);
  assert.equal(value.report.sourceScope.learningPreviewExcluded, true);
  assert.equal(value.report.artifacts.candidate.sha256, sha256(value.candidateBytes));
  assert.equal(value.report.outcome.readyForGitHubPublish, false);
  assert.equal(
    value.checksumBytes.toString("utf8"),
    renderUnsignedBetaChecksum(value.report.artifacts.candidate.sha256),
  );
  assert.equal(
    value.releaseNotesBytes.toString("utf8"),
    renderUnsignedBetaReleaseNotes(value.report.artifacts.candidate.sha256),
  );
});

test("requires both explicit attestations and one human confirmer", () => {
  assert.deepEqual(
    parseUnsignedBetaFreezeArguments([
      "--confirmed-by",
      "Release Maintainer",
      "--attest-release-scope-reviewed",
      "--attest-unsigned-beta-only",
    ]),
    { confirmedBy: "Release Maintainer" },
  );
  assert.throws(
    () => parseUnsignedBetaFreezeArguments(["--confirmed-by", "Release Maintainer"]),
    /both .* required/i,
  );
  assert.throws(
    () =>
      parseUnsignedBetaFreezeArguments([
        "--confirmed-by",
        "Release Maintainer",
        "--confirmed-by",
        "Second Maintainer",
        "--attest-release-scope-reviewed",
        "--attest-unsigned-beta-only",
      ]),
    /duplicate/,
  );
  assert.throws(() => parseUnsignedBetaFreezeArguments(["--unknown"]), /unknown/);
});

test("rejects dirty, non-main, malformed, or automated source confirmation", () => {
  assert.throws(
    () => validateUnsignedBetaFreezeIntent({ ...source, worktreeClean: false }, "Release Maintainer", { now }),
    /clean worktree/,
  );
  assert.throws(
    () => validateUnsignedBetaFreezeIntent({ ...source, branch: "feature/test" }, "Release Maintainer", { now }),
    /from main/,
  );
  assert.throws(
    () => validateUnsignedBetaFreezeIntent({ ...source, commit: "not-a-commit" }, "Release Maintainer", { now }),
    /commit ID/,
  );
  assert.throws(
    () => validateUnsignedBetaFreezeIntent(source, "Codex automation", { now }),
    /human/,
  );
});

test("accepts only a PE with no Authenticode certificate table", () => {
  assert.deepEqual(inspectPeAuthenticode(unsignedPe()), {
    format: "pe",
    authenticode: "not_signed",
  });
  const signed = unsignedPe();
  const optionalOffset = 0x80 + 24;
  signed.writeUInt32LE(480, optionalOffset + 112 + 4 * 8);
  signed.writeUInt32LE(32, optionalOffset + 112 + 4 * 8 + 4);
  assert.throws(() => inspectPeAuthenticode(signed), /must not contain/);
  assert.throws(() => inspectPeAuthenticode(Buffer.from("not a pe")), /complete Windows PE/);
});

test("rejects a stale manifest or a policy outside the low-cost route", () => {
  const value = fixture();
  const staleManifest = JSON.parse(value.releaseManifestBytes.toString("utf8"));
  staleManifest.artifacts.at(-1).sha256 = "B".repeat(64);
  assert.throws(
    () =>
      buildUnsignedBetaFreezeReport(
        { ...value, releaseManifestBytes: Buffer.from(JSON.stringify(staleManifest), "utf8") },
        { now },
      ),
    /stale/,
  );
  const wrongPolicy = JSON.parse(value.policyBytes.toString("utf8"));
  wrongPolicy.distribution.strategy = "traditional_ca";
  assert.throws(
    () =>
      buildUnsignedBetaFreezeReport(
        { ...value, policyBytes: Buffer.from(JSON.stringify(wrongPolicy), "utf8") },
        { now },
      ),
    /does not authorize/,
  );
});

test("rejects artifact drift and optimistic GitHub readiness", () => {
  const value = fixture();
  const optimistic = structuredClone(value.report);
  optimistic.outcome.readyForGitHubPublish = true;
  assert.throws(
    () => validateUnsignedBetaFreezeReport(optimistic, value),
    (error) =>
      error instanceof UnsignedBetaCandidateVerificationError && /cannot claim/.test(error.message),
  );
  const altered = Buffer.from(value.candidateBytes);
  altered[altered.length - 1] ^= 1;
  assert.throws(
    () => validateUnsignedBetaFreezeReport(value.report, { ...value, candidateBytes: altered }),
    /stale relative|drifted/,
  );
  const unknown = structuredClone(value.report);
  unknown.credentials = null;
  assert.throws(() => validateUnsignedBetaFreezeReport(unknown, value), /fields do not match/);
  const wrongScopeCommit = JSON.parse(value.sourceScopeReportBytes.toString("utf8"));
  wrongScopeCommit.source.commit = "b".repeat(40);
  assert.throws(
    () =>
      buildUnsignedBetaFreezeReport(
        {
          ...value,
          sourceScopeReportBytes: Buffer.from(`${JSON.stringify(wrongScopeCommit)}\n`, "utf8"),
        },
        { now },
      ),
    /source-scope|source commit|runtime source/u,
  );
});

test("rejects checksum or disclosure text that does not bind the candidate", () => {
  const value = fixture();
  assert.throws(
    () =>
      validateUnsignedBetaFreezeReport(value.report, {
        ...value,
        checksumBytes: Buffer.from("A".repeat(64) + " *wrong.exe\n", "utf8"),
      }),
    /checksums drifted|does not identify/,
  );
  assert.throws(
    () =>
      validateUnsignedBetaFreezeReport(value.report, {
        ...value,
        releaseNotesBytes: Buffer.from("stable signed release", "utf8"),
      }),
    /releaseNotes drifted|disclosure/,
  );
});

test("creates an isolated stage once and preserves existing bytes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-beta-stage-"));
  const stageRoot = path.join(temporaryRoot, "unsigned-beta", "1.4.0");
  try {
    const value = fixture();
    await writeNewUnsignedBetaStage(stageRoot, value);
    const reportPath = path.join(stageRoot, "unsigned-beta-freeze-report.json");
    const original = await readFile(reportPath);
    await assert.rejects(writeNewUnsignedBetaStage(stageRoot, value), /overwrite or merge/);
    assert.deepEqual(await readFile(reportPath), original);
    assert.deepEqual(
      await readFile(path.join(stageRoot, UNSIGNED_BETA_FILE_NAME)),
      value.candidateBytes,
    );
    assert.deepEqual(
      await readFile(path.join(stageRoot, V14_RELEASE_SOURCE_SCOPE_FILE_NAME)),
      value.sourceScopeContractBytes,
    );
    assert.deepEqual(
      await readFile(path.join(stageRoot, V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME)),
      value.sourceScopeReportBytes,
    );
    assert.deepEqual(
      await readFile(path.join(stageRoot, V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME)),
      value.sourceScopeVerifierBytes,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
