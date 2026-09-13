import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFiles(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const filename = Buffer.from(name), data = deflateRawSync(bytes), checksum = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); header.copy(directory, 6, 4, 30); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); parts.push(header, filename, data); offset += header.length + filename.length + data.length;
  }
  const size = central.reduce((total, b) => total + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
export function packagePet({ source, license, output, name, learning = true, scene = true }) {
  if (!output.endsWith(".yuanyuan-pet")) throw new Error("输出文件必须使用 .yuanyuan-pet 扩展名。");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "pet-manifest.json"), "utf8"));
  manifest.schemaVersion = 1; manifest.assetLicense = "LICENSE.txt";
  const displayName = name ?? manifest.displayName;
  if (typeof displayName !== "string" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(displayName)) throw new Error("名称不能含换行或控制字符。");
  manifest.displayName = displayName.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  if (!manifest.displayName || Array.from(manifest.displayName).length > 24) throw new Error("名称需要 1–24 个字符。");
  const files = new Map([["LICENSE.txt", fs.readFileSync(license)]]);
  for (const [key, filename, include] of [["spritesheet", "spritesheet.webp", true], ["sleepSpritesheet", "sleep-atlas.webp", true], ["lifeSpritesheet", "life-atlas.webp", true], ["learningSpritesheet", "learning-atlas.webp", learning], ["sceneSpritesheet", "scene-atlas.webp", scene]]) {
    if (!include || !fs.existsSync(path.join(source, filename))) {
      if (!["learningSpritesheet", "sceneSpritesheet"].includes(key)) throw new Error(`缺少基础图集：${filename}`);
      delete manifest[key]; delete manifest[key === "learningSpritesheet" ? "learningRows" : "sceneRows"];
      for (const [action, def] of Object.entries(manifest.animations)) if (def.sheet === (key === "learningSpritesheet" ? "learning" : "scene")) delete manifest.animations[action];
      continue;
    }
    manifest[key] = filename; files.set(filename, fs.readFileSync(path.join(source, filename)));
  }
  for (const def of Object.values(manifest.animations)) def.staticFrame ??= def.frames[0];
  files.set("fallback.png", fs.readFileSync(path.join(source, "fallback.png")));
  files.set("pet-pack.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  if ([...files.values()].reduce((n, bytes) => n + bytes.length, 0) > 64 * 1024 * 1024) throw new Error("宠物包超过 64 MiB。");
  const bytes = zipFiles(files);
  if (bytes.length > 64 * 1024 * 1024) throw new Error("压缩包超过 64 MiB。");
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, bytes, { flag: "wx" });
  return { files: files.size, bytes: bytes.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = flag => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };
  if (!option("--source") || !option("--license") || !option("--output")) {
    console.log("node scripts/package_pet.mjs --source <素材目录> --license <许可文件> --output <形象.yuanyuan-pet> [--name 名称] [--without-learning] [--without-scene]");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(packagePet({ source: option("--source"), license: option("--license"), output: option("--output"), name: option("--name"), learning: !args.includes("--without-learning"), scene: !args.includes("--without-scene") })));
  }
}
