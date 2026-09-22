import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const petRoot = path.join(projectRoot, "public", "assets", "pet");
const manifestPath = path.join(petRoot, "pet-manifest.json");

const requiredAnimations = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "activity-jumping",
  "failed",
  "waiting",
  "running",
  "review",
  "sleep-enter",
  "sleeping",
  "wake-up",
  "grooming",
  "grooming-chest",
  "grooming-flank",
  "stretching",
  "yawning",
  "meowing",
  "belly-up",
  "belly-down",
  "focus-calm",
  "eating-food",
  "drinking-water",
  "treat-follow",
  "wand-play",
  "pet-nuzzle",
  "ball-bat",
  "wand-reach",
  "wand-swipe",
  "wand-return",
  "ball-pickup",
  "ball-carry",
  "ball-drop",
  "alert-glass-paws",
  "learning-study-sit",
  "learning-study-curious",
  "learning-press-correct",
  "learning-press-wrong",
  "spa-enter",
  "spa-loop",
  "spa-exit",
  "meal-alert",
  "meal-wait",
  "hydration-alert",
  "hydration-wait",
  "work-focus-loop",
  "work-fatigue-enter",
  "work-fatigue-loop",
  "work-recover",
  "warmup-alert",
  "warmup-loop",
  "study-focus-loop",
  "study-curious",
  "night-enter",
  "night-loop",
  "night-exit",
];

const requiredSceneRows = [
  "spa-enter", "spa-loop", "spa-exit", "meal-alert", "meal-wait",
  "hydration-alert", "hydration-wait", "work-focus-loop",
  "work-fatigue-enter", "work-fatigue-loop", "work-recover",
  "warmup-alert", "warmup-loop", "study-focus-loop", "study-curious",
  "night-enter", "night-loop", "night-exit",
];

const requiredLearningRows = [
  ["learning-study-sit", 0, [0, 1, 2, 4, 5, 6, 7], 0],
  ["learning-study-curious", 1, [0, 1, 2, 3, 4, 5, 6, 7], null],
  ["learning-press-correct", 2, [0, 1, 2, 3, 4, 5, 6, 7], null],
  ["learning-press-wrong", 3, [0, 1, 2, 3, 4, 5, 6, 7], null],
];

function fail(message) {
  throw new Error(message);
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpSize(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") {
    fail(`${path.basename(filePath)} is not a valid WebP container`);
  }

  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + length > data.length) fail(`${path.basename(filePath)} has a truncated ${type} chunk`);

    if (type === "VP8X" && length >= 10) {
      return {
        width: readUInt24LE(data, payload + 4) + 1,
        height: readUInt24LE(data, payload + 7) + 1,
      };
    }
    if (type === "VP8L" && length >= 5 && data[payload] === 0x2f) {
      const b0 = data[payload + 1];
      const b1 = data[payload + 2];
      const b2 = data[payload + 3];
      const b3 = data[payload + 4];
      return {
        width: 1 + b0 + ((b1 & 0x3f) << 8),
        height: 1 + ((b1 & 0xc0) >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
      };
    }
    if (type === "VP8 " && length >= 10 && data[payload + 3] === 0x9d && data[payload + 4] === 0x01 && data[payload + 5] === 0x2a) {
      return {
        width: data.readUInt16LE(payload + 6) & 0x3fff,
        height: data.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    offset = payload + length + (length % 2);
  }
  fail(`${path.basename(filePath)} does not contain a supported WebP image chunk`);
}

function expectSize(fileName, width, height) {
  const filePath = path.join(petRoot, fileName);
  if (!fs.existsSync(filePath)) fail(`missing pet asset: ${fileName}`);
  const actual = webpSize(filePath);
  if (actual.width !== width || actual.height !== height) {
    fail(`${fileName} must be ${width}x${height}, received ${actual.width}x${actual.height}`);
  }
  return actual;
}

if (!fs.existsSync(manifestPath)) fail("missing public/assets/pet/pet-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.spriteVersionNumber !== 2) fail("pet manifest must declare spriteVersionNumber 2");
if (manifest.cellWidth !== 192 || manifest.cellHeight !== 208) fail("pet cells must be 192x208");
if (manifest.columns !== 8 || manifest.rows !== 11) fail("the standard pet atlas must be 8 columns by 11 rows");
if (manifest.lifeRows !== 21) fail("the life atlas must declare 21 rows");
if (manifest.learningRows !== 4) fail("the learning atlas must declare 4 rows");
if (manifest.sceneRows !== 18) fail("the scene atlas must declare 18 rows");

const files = {
  standard: path.basename(manifest.spritesheet ?? ""),
  sleep: path.basename(manifest.sleepSpritesheet ?? ""),
  life: path.basename(manifest.lifeSpritesheet ?? ""),
  learning: path.basename(manifest.learningSpritesheet ?? ""),
  scene: path.basename(manifest.sceneSpritesheet ?? ""),
};
if (
  files.standard !== "spritesheet.webp" ||
  files.sleep !== "sleep-atlas.webp" ||
  files.life !== "life-atlas.webp" ||
  files.learning !== "learning-atlas.webp" ||
  files.scene !== "scene-atlas.webp"
) {
  fail("manifest must reference the standard, sleep, life, learning, and scene WebP atlases");
}

expectSize(files.standard, 1536, 2288);
expectSize(files.sleep, 1536, 624);
expectSize(files.life, 1536, 4368);
expectSize(files.learning, 1536, 832);
expectSize(files.scene, 1536, 3744);

const animations = manifest.animations ?? {};
for (const name of requiredAnimations) {
  const animation = animations[name];
  if (!animation) fail(`missing animation: ${name}`);
  const sheet = animation.sheet ?? "standard";
  const rowLimit =
    sheet === "standard"
      ? 11
      : sheet === "sleep"
        ? 3
        : sheet === "life"
          ? 21
          : sheet === "learning"
            ? 4
            : sheet === "scene"
              ? 18
            : 0;
  if (rowLimit === 0) fail(`${name} references unknown sheet: ${sheet}`);
  if (!Number.isInteger(animation.row) || animation.row < 0 || animation.row >= rowLimit) fail(`${name} has an invalid row`);
  if (!Array.isArray(animation.frames) || animation.frames.length === 0) fail(`${name} has no frames`);
  if (!Array.isArray(animation.durations) || animation.durations.length !== animation.frames.length) fail(`${name} durations must match its frames`);
  if (animation.frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= 8)) fail(`${name} contains a frame outside 0..7`);
  if (animation.durations.some((duration) => !Number.isInteger(duration) || duration < 40 || duration > 5000)) fail(`${name} contains an invalid frame duration`);
  if (animation.loopStart !== null && (!Number.isInteger(animation.loopStart) || animation.loopStart < 0 || animation.loopStart >= animation.frames.length)) fail(`${name} has an invalid loopStart`);
  if (!Number.isInteger(animation.staticFrame) || animation.staticFrame < 0 || animation.staticFrame >= 8) fail(`${name} must declare a staticFrame in 0..7`);
}

for (const [row, name] of requiredSceneRows.entries()) {
  const animation = animations[name];
  if (animation.sheet !== "scene" || animation.row !== row) {
    fail(`${name} must use scene row ${row}`);
  }
}

for (const [name, row, frames, loopStart] of requiredLearningRows) {
  const animation = animations[name];
  if (animation.sheet !== "learning") fail(`${name} must use the learning atlas`);
  if (animation.row !== row) fail(`${name} must use learning row ${row}`);
  if (JSON.stringify(animation.frames) !== JSON.stringify(frames)) {
    fail(`${name} has an invalid learning frame sequence`);
  }
  if (animation.loopStart !== loopStart) {
    fail(`${name} has an invalid learning loop policy`);
  }
}

console.log(`Pet pack OK: ${manifest.displayName ?? manifest.id ?? "unnamed pet"}`);
console.log(`Validated ${requiredAnimations.length} animations and 5 WebP atlases.`);
