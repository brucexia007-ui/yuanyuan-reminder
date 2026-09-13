import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyFileOrVerify,
  reusableManifestMatches,
  writeFileOrVerify,
} from "./package-customization.mjs";

test("delivery files resume only when existing bytes are identical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-package-resume-"));
  try {
    const source = path.join(root, "source.exe");
    const copied = path.join(root, "copied.exe");
    const generated = path.join(root, "SHA256SUMS.txt");
    await writeFile(source, Buffer.from([0x4d, 0x5a, 1, 2, 3]));

    assert.equal(await copyFileOrVerify(source, copied), "created");
    assert.equal(await copyFileOrVerify(source, copied), "reused");
    assert.deepEqual(await readFile(copied), await readFile(source));
    await writeFile(copied, Buffer.from([0x4d, 0x5a, 9]));
    await assert.rejects(() => copyFileOrVerify(source, copied), /CUSTOMIZATION_PACKAGE_DRIFT/u);

    assert.equal(await writeFileOrVerify(generated, "digest  file.exe\n"), "created");
    assert.equal(await writeFileOrVerify(generated, "digest  file.exe\n"), "reused");
    await assert.rejects(
      () => writeFileOrVerify(generated, "different  file.exe\n"),
      /CUSTOMIZATION_PACKAGE_DRIFT/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted package run reuses only the same delivery manifest", () => {
  const expected = {
    schemaVersion: 1,
    generatedAt: "2026-08-29T02:00:00.000Z",
    runId: "run-1",
    sourceSnapshotSha256: "a".repeat(64),
    artifacts: { installer: { sha256: "b".repeat(64) } },
  };
  assert.equal(reusableManifestMatches({ ...expected, generatedAt: "2026-08-29T02:01:00.000Z" }, expected), true);
  assert.equal(reusableManifestMatches({ ...expected, sourceSnapshotSha256: "c".repeat(64) }, expected), false);
  assert.equal(reusableManifestMatches({ ...expected, generatedAt: "not-a-date" }, expected), false);
});
