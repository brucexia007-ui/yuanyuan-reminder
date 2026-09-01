import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAndValidateLearningPack } from "./learning-pack-validation.mjs";

const fixtures = path.resolve(import.meta.dirname, "interop-fixtures");

test("Codex, Kimi, and WorkBuddy conformance outputs share one final pack contract", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-learning-interop-"));
  try {
    const cases = [
      ["codex.learning-pack.json", (bytes) => bytes],
      ["kimi.learning-pack.json", (bytes) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
      ["workbuddy.learning-pack.json", (bytes) => Buffer.from(bytes.toString("utf8").replace(/\n/gu, "\r\n"), "utf8")],
    ];
    for (const [name, encode] of cases) {
      const input = await readFile(path.join(fixtures, name));
      const output = path.join(temporary, name);
      await writeFile(output, encode(input));
      const { pack, result } = await loadAndValidateLearningPack(output);
      assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.problems)}`);
      assert.match(pack.packId, /^interop\.(codex|kimi|workbuddy)$/u);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Unicode code-point ordering and safe-integer edges share the final hash contract", async () => {
  const { pack, result } = await loadAndValidateLearningPack(path.join(fixtures, "canonical-edge.learning-pack.json"));
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  assert.equal(pack.cards[0].extensions.canonicalEdge.version, 4_294_967_295);
});

test("invalid UTF-8 fails closed instead of being replaced during Node validation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-learning-invalid-utf8-"));
  try {
    const output = path.join(temporary, "invalid.learning-pack.json");
    await writeFile(output, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    const { pack, result } = await loadAndValidateLearningPack(output);
    assert.equal(pack, null);
    assert.equal(result.valid, false);
    assert.equal(result.problems[0].code, "malformed_json");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
