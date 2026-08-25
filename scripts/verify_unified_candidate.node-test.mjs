import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  UNIFIED_CANDIDATE_CHECKSUMS,
  UNIFIED_CANDIDATE_MANIFEST,
  UNIFIED_CANDIDATE_MARKER,
  UNIFIED_CANDIDATE_MARKER_CONTENTS,
  buildUnifiedCandidateManifest,
  renderUnifiedCandidateChecksums,
  validateUnifiedCandidateDirectory,
  validateUnifiedCandidateManifest,
} from "./unified_candidate_contract.mjs";
import { writeNewCandidate } from "./prepare_unified_candidate.mjs";

const product = {
  name: "圆圆提醒",
  version: "1.5.0",
  identifier: "com.yuanyuan.reminder",
};

function buildFixture(artifactBytes = Buffer.from("MZ unified fixture", "utf8"), branch = "main") {
  return buildUnifiedCandidateManifest(
    {
      product,
      source: {
        commit: "a".repeat(40),
        branch,
        commitTimestamp: "2026-08-25T00:00:00.000Z",
        worktreeClean: true,
      },
      artifactBytes,
      productAuthorityBytes: Buffer.from("authority"),
      tauriConfigBytes: Buffer.from("tauri"),
      packageLockBytes: Buffer.from("package-lock"),
      cargoLockBytes: Buffer.from("cargo-lock"),
    },
    { createdAt: "2026-08-25T01:00:00.000Z" },
  );
}

async function writeFixtureStage(artifactBytes, branch = "main") {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-unified-candidate-test-"));
  const manifest = buildFixture(artifactBytes, branch);
  const directory = path.join(root, manifest.candidateId);
  await mkdir(directory);
  await Promise.all([
    writeFile(path.join(directory, UNIFIED_CANDIDATE_MARKER), UNIFIED_CANDIDATE_MARKER_CONTENTS),
    writeFile(path.join(directory, manifest.artifact.fileName), artifactBytes),
    writeFile(
      path.join(directory, UNIFIED_CANDIDATE_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    writeFile(
      path.join(directory, UNIFIED_CANDIDATE_CHECKSUMS),
      renderUnifiedCandidateChecksums(manifest),
    ),
  ]);
  return { root, directory, manifest };
}

test("binds the immutable directory identity to source and installer bytes", () => {
  const main = buildFixture(Buffer.from("one"), "main");
  const feature = buildFixture(Buffer.from("one"), "feat/unified-v1-5");
  const changed = buildFixture(Buffer.from("two"), "main");
  assert.match(main.candidateId, /^a{12}-[0-9a-f]{12}$/u);
  assert.notEqual(main.candidateId, changed.candidateId);
  assert.equal(main.releaseStatus, "candidate-not-approved");
  assert.equal(feature.releaseStatus, "internal-only-non-main");
});

test("accepts exactly one installer with fixed metadata and verified checksums", async () => {
  const fixture = await writeFixtureStage(Buffer.from("MZ one candidate", "utf8"));
  try {
    const manifest = await validateUnifiedCandidateDirectory(fixture.directory);
    assert.equal(manifest.candidateId, fixture.manifest.candidateId);
    assert.equal(manifest.artifact.fileName, "圆圆提醒_1.5.0_x64-setup.exe");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects stale co-mingled executables and changed installer bytes", async () => {
  const fixture = await writeFixtureStage(Buffer.from("MZ original", "utf8"));
  try {
    await writeFile(path.join(fixture.directory, "stale-setup.exe"), Buffer.from("stale"));
    await assert.rejects(
      validateUnifiedCandidateDirectory(fixture.directory),
      /exactly one installer/u,
    );
    await rm(path.join(fixture.directory, "stale-setup.exe"));
    await writeFile(
      path.join(fixture.directory, fixture.manifest.artifact.fileName),
      Buffer.from("changed"),
    );
    await assert.rejects(
      validateUnifiedCandidateDirectory(fixture.directory),
      /installer bytes/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("freezes a new directory once and preserves existing candidate bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-unified-freeze-test-"));
  const artifactBytes = Buffer.from("MZ frozen candidate", "utf8");
  const manifest = buildFixture(artifactBytes);
  const directory = path.join(root, manifest.candidateId);
  try {
    await writeNewCandidate(directory, manifest, artifactBytes);
    await assert.rejects(
      writeNewCandidate(directory, manifest, Buffer.from("replacement")),
      /already exists/u,
    );
    assert.deepEqual(
      await readFile(path.join(directory, manifest.artifact.fileName)),
      artifactBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows the exact migration locator but rejects a derived edition marker", async () => {
  const allowedLocator = ["com.yuanyuan.reminder.learning", "personal"].join("-");
  const allowed = await writeFixtureStage(Buffer.from(`MZ ${allowedLocator}`, "latin1"));
  try {
    await validateUnifiedCandidateDirectory(allowed.directory);
  } finally {
    await rm(allowed.root, { recursive: true, force: true });
  }

  const forbiddenMarker = ["learning", "personal", "candidate"].join("-");
  const forbidden = await writeFixtureStage(Buffer.from(`MZ ${forbiddenMarker}`, "latin1"));
  try {
    await assert.rejects(
      validateUnifiedCandidateDirectory(forbidden.directory),
      /forbidden marker/u,
    );
  } finally {
    await rm(forbidden.root, { recursive: true, force: true });
  }
});

test("rejects optimistic signature or publication claims", () => {
  const manifest = buildFixture();
  assert.throws(
    () => validateUnifiedCandidateManifest({ ...manifest, signature: { status: "valid" } }),
    /signature state/u,
  );
  assert.throws(
    () => validateUnifiedCandidateManifest({ ...manifest, releaseStatus: "approved" }),
    /release status/u,
  );
});
