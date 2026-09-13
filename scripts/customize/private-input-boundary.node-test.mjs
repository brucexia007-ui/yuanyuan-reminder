import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { verifyPrivateInputBoundary } from "./private-input-boundary.mjs";

const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "jiaojiao-private-boundary-"));
  const root = path.join(parent, "repository");
  const privateRoot = path.join(parent, "private");
  await Promise.all([mkdir(root), mkdir(privateRoot)]);
  const photo = path.join(privateRoot, "cat.jpg");
  const photoBytes = Buffer.from("synthetic-private-cat-photo");
  await writeFile(photo, photoBytes);
  await writeFile(path.join(root, ".gitignore"), "/work/\n");
  await writeFile(path.join(root, "safe.txt"), "public source\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["add", ".gitignore", "safe.txt"], { cwd: root });
  return {
    parent,
    root,
    projectRoot: root,
    photo,
    photoBytes,
    request: {
      pet: { photoInputs: [photo] },
      learning: { sourceInputs: [] },
    },
    lockedPhotoHashes: [sha256(photoBytes)],
  };
}

async function withFixture(callback) {
  const value = await fixture();
  try {
    await callback(value);
  } finally {
    await rm(value.parent, { recursive: true, force: true });
  }
}

test("accepts private inputs that remain outside Git-visible source", async () => {
  await withFixture(async (value) => {
    const report = await verifyPrivateInputBoundary(value);
    assert.equal(report.passed, true);
    assert.equal(report.requestedPhotoCount, 1);
    assert.equal(report.repositoryHashMatchCount, 0);
    assert.equal(report.repositoryPathReferenceMatchCount, 0);
    assert.equal(report.visibleWorkPathCount, 0);
  });
});

test("rejects exact original photo bytes copied under a public source path", async () => {
  await withFixture(async (value) => {
    await mkdir(path.join(value.root, "public"));
    await writeFile(path.join(value.root, "public", "original.jpg"), value.photoBytes);
    await assert.rejects(() => verifyPrivateInputBoundary(value), /original private input bytes/u);
  });
});

test("rejects a private absolute path copied into Git-visible text", async () => {
  await withFixture(async (value) => {
    await writeFile(path.join(value.root, "leak.txt"), `source=${value.photo}\n`);
    await assert.rejects(() => verifyPrivateInputBoundary(value), /private input path/u);
  });
});

test("rejects work artifacts made Git-visible even when their bytes differ", async () => {
  await withFixture(async (value) => {
    await mkdir(path.join(value.root, "work"));
    await writeFile(path.join(value.root, "work", "summary.txt"), "summary only\n");
    await execFileAsync("git", ["add", "--force", "work/summary.txt"], { cwd: value.root });
    await assert.rejects(() => verifyPrivateInputBoundary(value), /work\/ contains Git-visible files/u);
  });
});
