import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { zipFiles } from "./package_pet.mjs";
import { boundaryFixtures, invalidFixtures, nameBoundaryFixtures, readGeneratedPack } from "./prepare_my_pet_invalid_fixtures.mjs";

function source() {
  return new Map([
    ["pet-pack.json", Buffer.from(JSON.stringify({ displayName: "E2E", animations: { idle: { staticFrame: 0 } } }))],
    ...["spritesheet.webp", "sleep-atlas.webp", "life-atlas.webp", "learning-atlas.webp", "scene-atlas.webp", "fallback.png", "LICENSE.txt"].map(name => [name, Buffer.from(`inert ${name}`)]),
  ]);
}
function entries(bytes) {
  const result = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + length;
    result.push([bytes.subarray(offset + 30, start).toString(), inflateRawSync(bytes.subarray(start, start + size))]);
    offset = start + size;
  }
  return result;
}
test("fixture reader checks generated ZIP layout, CRC and duplicate source names", () => {
  const pack = zipFiles(source());
  assert.deepEqual(readGeneratedPack(pack), new Map([...source()].sort(([a], [b]) => a.localeCompare(b, "en"))));
  const bad = Buffer.from(pack); bad[14] ^= 1;
  assert.throws(() => readGeneratedPack(bad), /checksum/);
  assert.throws(() => readGeneratedPack(Buffer.from("not a zip")), /central/);
  assert.throws(() => readGeneratedPack(invalidFixtures(source()).get("duplicate-entry").bytes), /Unexpected source entry/);
});
test("negative cases have deterministic, isolated mutations and inert extra payloads", () => {
  const original = source(), before = zipFiles(original);
  const cases = invalidFixtures(original), again = invalidFixtures(original);
  assert.equal(cases.size, 10);
  assert.deepEqual(zipFiles(original), before);
  for (const [name, fixture] of cases) assert.deepEqual(fixture.bytes, again.get(name).bytes);
  assert.equal(entries(cases.get("duplicate-entry").bytes).filter(([name]) => name === "LICENSE.txt").length, 2);
  assert.equal(entries(cases.get("path-traversal").bytes).filter(([name]) => name === "../escape.txt").length, 1);
  assert.equal(new Map(entries(cases.get("extra-executable-name").bytes)).get("payload.exe").toString(), "INERT TEXT, NOT AN EXECUTABLE");
  assert.equal(new Map(entries(cases.get("missing-life-atlas").bytes)).has("life-atlas.webp"), false);
  for (const group of ["learning", "scene"]) assert.equal(new Map(entries(cases.get(`corrupt-declared-${group}`).bytes)).get(`${group}-atlas.webp`).toString(), "INERT CORRUPT IMAGE");
  const manifest = name => JSON.parse(new Map(entries(cases.get(name).bytes)).get("pet-pack.json"));
  assert.equal(manifest("external-resource").spritesheet, "https://invalid.example/spritesheet.webp");
  assert.equal(manifest("invalid-static-frame").animations.idle.staticFrame, 9999);
  assert.equal(manifest("invalid-original-name").displayName, "bad\nname");
  assert.equal(cases.get("truncated-archive").bytes.length, before.length - 12);
});

function directory(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let offset = bytes.readUInt32LE(end + 16);
  const result = new Map();
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString();
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt32LE(local + 18), bytes.readUInt32LE(offset + 20));
    assert.equal(bytes.readUInt32LE(local + 22), bytes.readUInt32LE(offset + 24));
    assert.equal(bytes.readUInt16LE(local + 6), bytes.readUInt16LE(offset + 8));
    result.set(name, {
      flags: bytes.readUInt16LE(offset + 8), method: bytes.readUInt16LE(offset + 10),
      size: bytes.readUInt32LE(offset + 24), compressedSize: bytes.readUInt32LE(offset + 20),
      host: bytes[offset + 5], mode: bytes.readUInt32LE(offset + 38) >>> 16,
      start: local + 30 + nameSize,
    });
    offset += 46 + nameSize + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  return result;
}

test("name-boundary fixtures bypass the count gate with an otherwise complete basic pack", () => {
  const original = source();
  const manifest = JSON.parse(original.get("pet-pack.json"));
  manifest.learningSpritesheet = "learning-atlas.webp";
  manifest.learningRows = 4;
  manifest.sceneSpritesheet = "scene-atlas.webp";
  manifest.sceneRows = 18;
  manifest.animations.study = { sheet: "learning", staticFrame: 0 };
  manifest.animations.work = { sheet: "scene", staticFrame: 0 };
  original.set("pet-pack.json", Buffer.from(JSON.stringify(manifest)));
  const before = zipFiles(original), cases = nameBoundaryFixtures(original), again = nameBoundaryFixtures(original);
  assert.equal(cases.size, 2);
  assert.deepEqual(zipFiles(original), before);
  for (const [name, fixture] of cases) {
    assert.deepEqual(fixture.bytes, again.get(name).bytes);
    assert.ok(fixture.bytes.length < 64 * 1024 * 1024);
    const items = new Map(entries(fixture.bytes)), metadata = directory(fixture.bytes);
    assert.equal(items.size, 7);
    assert.equal(metadata.size, 7);
    assert.equal(fixture.bytes.readUInt16LE(fixture.bytes.length - 12), 7);
    const extra = name === "path-count-valid" ? "../escape.txt" : "payload.exe";
    assert.equal(items.get(extra).toString(), name === "path-count-valid" ? "INERT E2E TEXT" : "INERT TEXT, NOT AN EXECUTABLE");
    for (const required of ["spritesheet.webp", "sleep-atlas.webp", "life-atlas.webp", "fallback.png", "LICENSE.txt"]) {
      assert.deepEqual(items.get(required), original.get(required));
      assert.equal(metadata.get(required).size, original.get(required).length);
    }
    assert.equal(items.has("learning-atlas.webp"), false);
    assert.equal(items.has("scene-atlas.webp"), false);
    const basic = JSON.parse(items.get("pet-pack.json"));
    assert.equal(basic.displayName, manifest.displayName);
    assert.deepEqual(basic.animations, { idle: manifest.animations.idle });
    for (const key of ["learningSpritesheet", "learningRows", "sceneSpritesheet", "sceneRows"]) assert.equal(key in basic, false);
    assert.equal(fixture.expectedError, "宠物包包含重复文件、链接或不允许的内容。");
  }
  const missing = new Map(original); missing.delete("LICENSE.txt");
  assert.throws(() => nameBoundaryFixtures(missing), /Missing source LICENSE.txt/);
});

test("boundary fixtures use real encryption/link metadata and independent 64 MiB limits", () => {
  const limit = 64 * 1024 * 1024, original = source(), before = zipFiles(original);
  const cases = boundaryFixtures(original);
  assert.deepEqual(zipFiles(original), before);
  assert.equal(cases.size, 4);
  for (const fixture of cases.values()) assert.equal(directory(fixture.bytes).size, original.size);
  const encrypted = directory(cases.get("encrypted-license").bytes).get("LICENSE.txt");
  const baseline = directory(before).get("LICENSE.txt");
  assert.equal(encrypted.flags, 0x801);
  assert.equal(encrypted.compressedSize, baseline.compressedSize + 12);
  const link = directory(cases.get("symlink-entry").bytes).get("LICENSE.txt");
  assert.equal(link.host, 3);
  assert.equal(link.mode & 0o170000, 0o120000);
  assert.equal(inflateRawSync(cases.get("symlink-entry").bytes.subarray(link.start, link.start + link.compressedSize)).toString(), "spritesheet.webp");
  const expanded = cases.get("expanded-over-limit").bytes;
  assert.ok(expanded.length < limit);
  assert.equal([...directory(expanded).values()].reduce((sum, item) => sum + item.size, 0), limit + 1);
  assert.ok([...directory(expanded).values()].every(item => item.size < limit));
  // Decode the synthetic repeated-byte entry to prove the size isn't just a
  // fabricated ZIP header; never write its contents or create a link.
  const scene = directory(expanded).get("scene-atlas.webp");
  assert.equal(inflateRawSync(expanded.subarray(scene.start, scene.start + scene.compressedSize), { maxOutputLength: limit }).length, scene.size);
  const archive = cases.get("archive-over-limit").bytes;
  assert.ok(archive.length > limit);
  assert.equal([...directory(archive).values()].reduce((sum, item) => sum + item.size, 0), limit - 1);
  assert.ok([...directory(archive).values()].every(item => item.method === 0));
});
