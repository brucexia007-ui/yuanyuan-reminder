import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeNewUnsignedBetaGithubReport } from "./capture_unsigned_beta_github_release.mjs";
import {
  captureUnsignedBetaGithubRelease,
  UNSIGNED_BETA_RELEASE_API_URL,
  UNSIGNED_BETA_REPOSITORY,
  UNSIGNED_BETA_TAG_REF_API_URL,
  UnsignedBetaGithubVerificationError,
  validateUnsignedBetaGithubReport,
} from "./verify_unsigned_beta_github_release.mjs";
import {
  buildUnsignedBetaFreezeReport,
  UNSIGNED_BETA_FILE_NAME,
  UNSIGNED_BETA_TAG,
} from "./verify_unsigned_beta_candidate.mjs";
import {
  buildV14ReleaseSourceScopeReport,
  defaultV14ReleaseSourceScopePath,
  defaultV14ReleaseSourceScopeVerifierPath,
} from "./verify_v1_4_release_source_scope.mjs";

const now = new Date();
const [sourceScopeContractBytes, sourceScopeVerifierBytes] = await Promise.all([
  readFile(defaultV14ReleaseSourceScopePath),
  readFile(defaultV14ReleaseSourceScopeVerifierPath),
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

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

function freezeFixture() {
  const candidateBytes = unsignedPe();
  const source = {
    commit: "a".repeat(40),
    branch: "main",
    commitTimestamp: "2026-08-10T12:00:00.000Z",
    worktreeClean: true,
  };
  const sourceScopeReport = buildV14ReleaseSourceScopeReport(
    {
      contractBytes: sourceScopeContractBytes,
      verifierBytes: sourceScopeVerifierBytes,
      source: {
        ...source,
        baselineTagCommit: "11841b88cf7b3e6d10502fd0158401e2c02167ae",
        baselineIsAncestor: true,
      },
      changedPaths: ["PRIVACY.md", "src-tauri/src/local_data_cleanup.rs"],
      runtimeFiles: [
        { path: "src-tauri/Cargo.toml", bytes: Buffer.from("[package]\nname = \"yuanyuan-reminder\"\n") },
        { path: "src-tauri/migrations/011_task_watch_attention_deferrals.sql", bytes: Buffer.from("PRAGMA user_version = 11;\n") },
        { path: "src-tauri/src/lib.rs", bytes: Buffer.from("pub fn run() {}\n") },
        { path: "src/main.tsx", bytes: Buffer.from("export const app = true;\n") },
        { path: "src/vite-env.d.ts", bytes: Buffer.from("/// <reference types=\"vite/client\" />\n") },
        { path: "vite.config.ts", bytes: Buffer.from("export default {};\n") },
      ],
    },
    { now },
  );
  const sourceScopeReportBytes = Buffer.from(
    `${JSON.stringify(sourceScopeReport, null, 2)}\n`,
    "utf8",
  );
  const policyBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      product: { identifier: "com.yuanyuan.reminder", name: "圆圆提醒" },
      distribution: {
        strategy: "low_cost_staged",
        selectedChannel: "pending",
        previewChannel: "github_releases",
        previewArtifactPolicy: "unsigned_beta_with_sha256",
        plannedStableChannel: "microsoft_store",
      },
    }),
    "utf8",
  );
  const releaseManifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      productName: "圆圆提醒",
      productVersion: "1.4.0",
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
          sha256: sha256(candidateBytes),
          bundleDisposition: "distribution_installer",
        },
      ],
    }),
    "utf8",
  );
  const built = buildUnsignedBetaFreezeReport(
    {
      source,
      candidateBytes,
      policyBytes,
      releaseManifestBytes,
      sourceScopeContractBytes,
      sourceScopeReportBytes,
      sourceScopeVerifierBytes,
      confirmedBy: "Release Maintainer",
    },
    { now },
  );
  return {
    ...built,
    reportBytes: Buffer.from(`${JSON.stringify(built.report, null, 2)}\n`, "utf8"),
    candidateBytes,
    policyBytes,
    releaseManifestBytes,
    sourceScopeContractBytes,
    sourceScopeReportBytes,
    sourceScopeVerifierBytes,
  };
}

function downloadUrl(fileName) {
  return `https://github.com/${UNSIGNED_BETA_REPOSITORY}/releases/download/${UNSIGNED_BETA_TAG}/${encodeURIComponent(fileName)}`;
}

function response(status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    status,
    headers: new Headers(headers),
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function githubFixture(freezeEvidence) {
  const candidate = freezeEvidence.report.artifacts.candidate;
  const checksums = freezeEvidence.report.artifacts.checksums;
  const release = {
    id: 1400,
    tag_name: UNSIGNED_BETA_TAG,
    draft: false,
    prerelease: true,
    html_url: `https://github.com/${UNSIGNED_BETA_REPOSITORY}/releases/tag/${UNSIGNED_BETA_TAG}`,
    name: "圆圆提醒 v1.4.0 未签名测试版",
    body: freezeEvidence.releaseNotesBytes.toString("utf8"),
    assets: [
      {
        id: 1,
        name: UNSIGNED_BETA_FILE_NAME,
        state: "uploaded",
        size: candidate.bytes,
        digest: `sha256:${candidate.sha256.toLowerCase()}`,
        content_type: "application/x-msdownload",
        browser_download_url: downloadUrl(UNSIGNED_BETA_FILE_NAME),
      },
      {
        id: 2,
        name: "SHA256SUMS.txt",
        state: "uploaded",
        size: checksums.bytes,
        digest: `sha256:${checksums.sha256.toLowerCase()}`,
        content_type: "text/plain",
        browser_download_url: downloadUrl("SHA256SUMS.txt"),
      },
    ],
  };
  const responses = new Map([
    [
      UNSIGNED_BETA_RELEASE_API_URL,
      response(200, JSON.stringify(release), { "content-type": "application/json" }),
    ],
    [
      UNSIGNED_BETA_TAG_REF_API_URL,
      response(
        200,
        JSON.stringify({ object: { type: "commit", sha: freezeEvidence.report.source.commit } }),
        { "content-type": "application/json" },
      ),
    ],
    [
      downloadUrl(UNSIGNED_BETA_FILE_NAME),
      response(200, freezeEvidence.candidateBytes, {
        "content-type": "application/octet-stream",
      }),
    ],
    [
      downloadUrl("SHA256SUMS.txt"),
      response(200, freezeEvidence.checksumBytes, { "content-type": "text/plain" }),
    ],
  ]);
  return { release, responses };
}

function fetchFrom(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const value = responses.get(url);
    if (!value) throw new Error(`unexpected URL ${url}`);
    return value;
  };
}

async function validCapture() {
  const freezeEvidence = freezeFixture();
  const { responses } = githubFixture(freezeEvidence);
  const report = await captureUnsignedBetaGithubRelease({
    fetchImpl: fetchFrom(responses),
    freezeEvidence,
    now,
  });
  return { freezeEvidence, report };
}

test("accepts an exact anonymously downloadable GitHub prerelease", async () => {
  const freezeEvidence = freezeFixture();
  const { responses } = githubFixture(freezeEvidence);
  const calls = [];
  const report = await captureUnsignedBetaGithubRelease({
    fetchImpl: fetchFrom(responses, calls),
    freezeEvidence,
    now,
  });
  assert.equal(report.outcome.readyForUnsignedBetaDistribution, true);
  assert.equal(report.outcome.stableRelease, false);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "manual");
    assert.equal(Object.hasOwn(call.options.headers, "Authorization"), false);
    assert.equal(Object.hasOwn(call.options.headers, "Cookie"), false);
  }
});

test("rejects drafts, stable releases, or altered disclosure text", async () => {
  for (const mutate of [
    (release) => {
      release.draft = true;
    },
    (release) => {
      release.prerelease = false;
    },
    (release) => {
      release.body = "stable signed release";
    },
  ]) {
    const freezeEvidence = freezeFixture();
    const fixture = githubFixture(freezeEvidence);
    mutate(fixture.release);
    fixture.responses.set(
      UNSIGNED_BETA_RELEASE_API_URL,
      response(200, JSON.stringify(fixture.release), { "content-type": "application/json" }),
    );
    await assert.rejects(
      captureUnsignedBetaGithubRelease({
        fetchImpl: fetchFrom(fixture.responses),
        freezeEvidence,
        now,
      }),
      /exact public unsigned prerelease/,
    );
  }
});

test("rejects a prerelease tag that does not resolve to the frozen commit", async () => {
  const freezeEvidence = freezeFixture();
  const fixture = githubFixture(freezeEvidence);
  fixture.responses.set(
    UNSIGNED_BETA_TAG_REF_API_URL,
    response(200, JSON.stringify({ object: { type: "commit", sha: "b".repeat(40) } }), {
      "content-type": "application/json",
    }),
  );
  await assert.rejects(
    captureUnsignedBetaGithubRelease({
      fetchImpl: fetchFrom(fixture.responses),
      freezeEvidence,
      now,
    }),
    /does not resolve/,
  );
});

test("rejects extra assets and API digest or size drift", async () => {
  const freezeEvidence = freezeFixture();
  const fixture = githubFixture(freezeEvidence);
  fixture.release.assets.push({ name: "extra.zip" });
  fixture.responses.set(
    UNSIGNED_BETA_RELEASE_API_URL,
    response(200, JSON.stringify(fixture.release), { "content-type": "application/json" }),
  );
  await assert.rejects(
    captureUnsignedBetaGithubRelease({
      fetchImpl: fetchFrom(fixture.responses),
      freezeEvidence,
      now,
    }),
    /exactly the installer/,
  );

  const second = githubFixture(freezeEvidence);
  second.release.assets[0].digest = `sha256:${"b".repeat(64)}`;
  second.responses.set(
    UNSIGNED_BETA_RELEASE_API_URL,
    response(200, JSON.stringify(second.release), { "content-type": "application/json" }),
  );
  await assert.rejects(
    captureUnsignedBetaGithubRelease({
      fetchImpl: fetchFrom(second.responses),
      freezeEvidence,
      now,
    }),
    /metadata drifted/,
  );
});

test("rejects anonymously downloaded bytes that differ from the frozen stage", async () => {
  const freezeEvidence = freezeFixture();
  const fixture = githubFixture(freezeEvidence);
  const altered = Buffer.from(freezeEvidence.candidateBytes);
  altered[altered.length - 1] ^= 1;
  fixture.responses.set(
    downloadUrl(UNSIGNED_BETA_FILE_NAME),
    response(200, altered, { "content-type": "application/octet-stream" }),
  );
  await assert.rejects(
    captureUnsignedBetaGithubRelease({
      fetchImpl: fetchFrom(fixture.responses),
      freezeEvidence,
      now,
    }),
    /differs from the frozen candidate/,
  );
});

test("rejects asset redirects outside GitHub-owned HTTPS origins", async () => {
  const freezeEvidence = freezeFixture();
  const fixture = githubFixture(freezeEvidence);
  fixture.responses.set(
    downloadUrl(UNSIGNED_BETA_FILE_NAME),
    response(302, "", { location: "https://example.com/installer.exe" }),
  );
  await assert.rejects(
    captureUnsignedBetaGithubRelease({
      fetchImpl: fetchFrom(fixture.responses),
      freezeEvidence,
      now,
    }),
    /escaped the fixed GitHub HTTPS origins/,
  );
});

test("rejects future, unknown, or stable-promotion report claims", async () => {
  const { freezeEvidence, report } = await validCapture();
  const future = structuredClone(report);
  future.verifiedAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  assert.throws(
    () =>
      validateUnsignedBetaGithubReport(future, {
        freezeEvidence,
        now,
      }),
    /non-future/,
  );
  const unknown = structuredClone(report);
  unknown.credentials = null;
  assert.throws(
    () => validateUnsignedBetaGithubReport(unknown, { freezeEvidence, now }),
    /fields do not match/,
  );
  const promoted = structuredClone(report);
  promoted.outcome.stableRelease = true;
  assert.throws(
    () => validateUnsignedBetaGithubReport(promoted, { freezeEvidence, now }),
    /cannot promote/,
  );
});

test("creates GitHub publication evidence once and preserves existing bytes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-beta-github-"));
  const outputPath = path.join(temporaryRoot, "report.json");
  try {
    const { freezeEvidence, report } = await validCapture();
    await writeNewUnsignedBetaGithubReport(outputPath, report, { freezeEvidence, now });
    const original = await readFile(outputPath);
    await assert.rejects(
      writeNewUnsignedBetaGithubReport(outputPath, report, { freezeEvidence, now }),
      /refusing to overwrite/,
    );
    assert.deepEqual(await readFile(outputPath), original);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
