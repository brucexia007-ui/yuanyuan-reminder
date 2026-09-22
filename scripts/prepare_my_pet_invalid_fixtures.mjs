// Inert negative inputs for native pet-import E2E; never execute or extract them.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { crc32, zipFiles } from "./package_pet.mjs";

const LIMIT = 64 * 1024 * 1024;
// Public, deliberately weak test password. Never use this helper for user data.
export const FIXTURE_PASSWORD = "inert-e2e-only";

function zipCryptoFixture(compressed, checksum) {
  let first = 0x12345678, second = 0x23456789, third = 0x34567890;
  function crcByte(state, byte) {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = (state >>> 1) ^ ((state & 1) ? 0xedb88320 : 0);
    return state >>> 0;
  }
  function update(byte) {
    first = crcByte(first, byte);
    second = (Math.imul((second + (first & 255)) >>> 0, 0x08088405) + 1) >>> 0;
    third = crcByte(third, second >>> 24);
  }
  for (const byte of Buffer.from(FIXTURE_PASSWORD)) update(byte);
  // Fixed non-secret header makes this negative fixture reproducible.
  const header = Buffer.alloc(12);
  header.write("INERT-E2E");
  header[11] = checksum >>> 24;
  const plain = Buffer.concat([header, compressed]), encrypted = Buffer.alloc(plain.length);
  for (let index = 0; index < plain.length; index++) {
    const temporary = (third & 0xffff) | 3;
    encrypted[index] = plain[index] ^ ((Math.imul(temporary, temporary ^ 1) >>> 8) & 255);
    update(plain[index]);
  }
  return encrypted;
}

// Special ZIP metadata stays in QA tooling, not the normal pet packer.
function specialZip(files, { target, encrypted = false, symlink = false, stored = false }) {
  const parts = [], central = []; let offset = 0;
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const special = name === target, filename = Buffer.from(name), checksum = crc32(bytes);
    const method = stored ? 0 : 8;
    let data = method === 0 ? bytes : deflateRawSync(bytes);
    if (special && encrypted) data = zipCryptoFixture(data, checksum);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800 | (special && encrypted ? 1 : 0), 6);
    header.writeUInt16LE(method, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(special && symlink ? 0x0314 : 20, 4);
    header.copy(directory, 6, 4, 30); directory.writeUInt32LE(offset, 42);
    if (special && symlink) directory.writeUInt32LE((0o120777 * 65536) >>> 0, 38);
    parts.push(header, filename, data); central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22), directorySize = central.reduce((sum, bytes) => sum + bytes.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// Accept only our deterministic packer's local-header layout, not arbitrary ZIPs.
export function readGeneratedPack(bytes) {
  if (bytes.length > LIMIT) throw new Error("Fixture source exceeds 64 MiB");
  const files = new Map();
  let offset = 0, total = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > bytes.length) throw new Error("Truncated source header");
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const original = bytes.readUInt32LE(offset + 22);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameSize + extraSize;
    if (flags !== 0x800 || method !== 8 || extraSize !== 0 || start + size > bytes.length) throw new Error("Not a generated source pack");
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString("utf8");
    if (!/^[a-zA-Z0-9.-]+$/u.test(name) || files.has(name)) throw new Error("Unexpected source entry");
    if (original > LIMIT - total) throw new Error("Expanded source exceeds 64 MiB");
    const content = inflateRawSync(bytes.subarray(start, start + size), { maxOutputLength: Math.max(1, original) });
    if (content.length !== original || crc32(content) !== bytes.readUInt32LE(offset + 14)) throw new Error("Source entry checksum mismatch");
    total += content.length;
    files.set(name, content);
    offset = start + size;
  }
  if (files.size === 0 || offset + 4 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Missing source central directory");
  return files;
}

function encodeEntries(entries) {
  return zipFiles({ size: entries.length, [Symbol.iterator]: () => entries[Symbol.iterator]() });
}

export function invalidFixtures(files) {
  const baseline = files.get("pet-pack.json");
  if (!baseline) throw new Error("Missing source manifest");
  const cases = new Map();
  function add(name, entries, reason) {
    cases.set(name, { bytes: encodeEntries(entries), reason });
  }
  function changeManifest(name, mutate, reason) {
    const manifest = JSON.parse(baseline.toString("utf8"));
    mutate(manifest);
    const copy = new Map(files);
    copy.set("pet-pack.json", Buffer.from(JSON.stringify(manifest)));
    add(name, [...copy], reason);
  }
  add("path-traversal", [...files, ["../escape.txt", Buffer.from("INERT E2E TEXT")]], "ZIP path traversal; no file may escape controlled staging");
  add("duplicate-entry", [...files, ["LICENSE.txt", Buffer.from("INERT DUPLICATE LICENSE")]], "Duplicate ZIP filename");
  add("extra-executable-name", [...files, ["payload.exe", Buffer.from("INERT TEXT, NOT AN EXECUTABLE")]], "Unlisted executable filename; payload is inert text");
  add("missing-life-atlas", [...files].filter(([name]) => name !== "life-atlas.webp"), "Missing required life atlas");
  changeManifest("external-resource", manifest => { manifest.spritesheet = "https://invalid.example/spritesheet.webp"; }, "External URL must be rejected without network access");
  changeManifest("invalid-static-frame", manifest => { manifest.animations[Object.keys(manifest.animations)[0]].staticFrame = 9999; }, "Out-of-range static frame");
  changeManifest("invalid-original-name", manifest => { manifest.displayName = "bad\nname"; }, "Control character in original name");
  for (const [group, filename] of [["learning", "learning-atlas.webp"], ["scene", "scene-atlas.webp"]]) {
    if (!files.has(filename)) throw new Error("Use a complete source pack for optional-atlas corruption cases");
    const copy = new Map(files);
    copy.set(filename, Buffer.from("INERT CORRUPT IMAGE"));
    add(`corrupt-declared-${group}`, [...copy], "Declared optional atlas fails real image decoding");
  }
  const normal = encodeEntries([...files]);
  cases.set("truncated-archive", { bytes: normal.subarray(0, normal.length - 12), reason: "Truncated ZIP end record" });
  return cases;
}

export function boundaryFixtures(files) {
  for (const name of ["LICENSE.txt", "scene-atlas.webp"]) if (!files.has(name)) throw new Error(`Missing source ${name}`);
  const cases = new Map();
  cases.set("encrypted-license", {
    bytes: specialZip(files, { target: "LICENSE.txt", encrypted: true }),
    reason: "Real ZipCrypto-encrypted LICENSE.txt; password is public test text, importer must reject without asking for it",
  });
  const linked = new Map(files);
  linked.set("LICENSE.txt", Buffer.from("spritesheet.webp"));
  cases.set("symlink-entry", {
    bytes: specialZip(linked, { target: "LICENSE.txt", symlink: true }),
    reason: "ZIP Unix symbolic-link metadata on an allowed filename; no real filesystem link is created",
  });
  const otherSize = [...files].reduce((sum, [name, bytes]) => sum + (name === "scene-atlas.webp" ? 0 : bytes.length), 0);
  if (otherSize < 1 || otherSize >= LIMIT - 1) throw new Error("Source does not leave room for bounded limit fixtures");
  const expanded = new Map(files);
  expanded.set("scene-atlas.webp", Buffer.alloc(LIMIT - otherSize + 1, 65));
  const expandedBytes = encodeEntries([...expanded]);
  if (expandedBytes.length > LIMIT) throw new Error("Expanded-limit fixture must fit the archive-size limit");
  cases.set("expanded-over-limit", {
    bytes: expandedBytes,
    reason: "ZIP is below 64 MiB; real expanded total is exactly 64 MiB + 1 byte, with every individual entry below 64 MiB",
  });
  const archive = new Map(files);
  archive.set("scene-atlas.webp", Buffer.alloc(LIMIT - otherSize - 1, 65));
  // Store every file so headers alone push the archive over the cap, while
  // its actual expanded payload stays at 64 MiB - 1 byte.
  const archiveBytes = specialZip(archive, { target: "scene-atlas.webp", stored: true });
  if (archiveBytes.length <= LIMIT) throw new Error("Stored fixture does not exceed the archive limit");
  cases.set("archive-over-limit", {
    bytes: archiveBytes,
    reason: "ZIP archive exceeds 64 MiB while actual expanded total is 64 MiB - 1 byte; reject before staging",
  });
  return cases;
}

// Keep the original fourteen fixtures byte-for-byte stable. These additional
// cases start from a complete six-file basic pack, so an unwanted seventh
// entry must reach the name whitelist instead of the early 6..8 count gate.
export function nameBoundaryFixtures(files) {
  const required = ["pet-pack.json", "spritesheet.webp", "sleep-atlas.webp", "life-atlas.webp", "fallback.png", "LICENSE.txt"];
  for (const name of required) if (!files.has(name)) throw new Error(`Missing source ${name}`);
  const basic = new Map(required.map(name => [name, files.get(name)]));
  const manifest = JSON.parse(basic.get("pet-pack.json").toString("utf8"));
  for (const group of ["learning", "scene"]) {
    delete manifest[`${group}Spritesheet`];
    delete manifest[`${group}Rows`];
    for (const [name, definition] of Object.entries(manifest.animations)) {
      if (definition.sheet === group) delete manifest.animations[name];
    }
  }
  basic.set("pet-pack.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  return new Map([
    ["path-count-valid", {
      bytes: encodeEntries([...basic, ["../escape.txt", Buffer.from("INERT E2E TEXT")]]),
      reason: "Seven entries, all six mandatory files intact; path traversal must fail the filename whitelist, not file count",
      expectedError: "宠物包包含重复文件、链接或不允许的内容。",
    }],
    ["extra-count-valid", {
      bytes: encodeEntries([...basic, ["payload.exe", Buffer.from("INERT TEXT, NOT AN EXECUTABLE")]]),
      reason: "Seven entries, all six mandatory files intact; unlisted executable filename must fail the whitelist; payload is inert text",
      expectedError: "宠物包包含重复文件、链接或不允许的内容。",
    }],
  ]);
}

export function prepareInvalidFixtures({ base, output }) {
  if (fs.statSync(base).size > LIMIT) throw new Error("Fixture source exceeds 64 MiB");
  const source = fs.readFileSync(base);
  const files = readGeneratedPack(source);
  const cases = new Map([...invalidFixtures(files), ...boundaryFixtures(files), ...nameBoundaryFixtures(files)]);
  const directory = path.resolve(output);
  // A new dedicated directory is mandatory; never overwrite an earlier evidence set.
  fs.mkdirSync(directory);
  const evidence = { schemaVersion: 1, purpose: "inert native-import negative fixtures; not an acceptance result", sourceSha256: createHash("sha256").update(source).digest("hex"), cases: [] };
  for (const [name, fixture] of cases) {
    const filename = `${name}.yuanyuan-pet`;
    fs.writeFileSync(path.join(directory, filename), fixture.bytes, { flag: "wx" });
    evidence.cases.push({ filename, bytes: fixture.bytes.length, sha256: createHash("sha256").update(fixture.bytes).digest("hex"), expected: "reject", reason: fixture.reason, ...(fixture.expectedError ? { expectedError: fixture.expectedError } : {}) });
  }
  fs.writeFileSync(path.join(directory, "fixtures.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes("--base") || !args.includes("--output") || !value("--base") || !value("--output")) throw new Error("Required: --base <full generated pack> --output <new directory>");
  console.log(JSON.stringify(prepareInvalidFixtures({ base: value("--base"), output: value("--output") })));
}
