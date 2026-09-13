import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, zipFiles } from "./package_pet.mjs";
import { inflateRawSync } from "node:zlib";
test("deterministic ZIP includes CRC, central offsets and original bytes", () => {
  const files = new Map([["LICENSE.txt", Buffer.from("许可\n")], ["pet-pack.json", Buffer.from('{"schemaVersion":1}')]]);
  const zip = zipFiles(files);
  assert.deepEqual(zip, zipFiles(new Map([...files].reverse())));
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  let offset = 0;
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26);
    assert.equal(zip.subarray(offset + 30, offset + 30 + nameLength).toString(), name);
    assert.deepEqual(inflateRawSync(zip.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size)), bytes);
    offset += 30 + nameLength + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 6), offset);
});
