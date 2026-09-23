import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runRepair, affectedActions, validateAcceptance } from "./pet_repair.mjs";
import { frameAt, transitionAt, renderComparison } from "./pet_repair_preview.mjs";
import { zipFiles } from "./package_pet.mjs";

const root = path.resolve(import.meta.dirname, "..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const readJson = file => JSON.parse(fs.readFileSync(file));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

test("actual timing, repeated frame indices, loop prefix, static and transition", () => {
  const def = { frames: [3, 1, 3], durations: [100, 200, 50], loopStart: 1, staticFrame: 7 };
  assert.equal(frameAt(def, 99).column, 3);
  assert.equal(frameAt(def, 100).column, 1);
  assert.equal(frameAt(def, 350).column, 1);
  assert.equal(frameAt(def, 550).index, 2);
  assert.equal(frameAt(def, 600).index, 1);
  assert.equal(frameAt(def, 0, { still: true }).column, 7);
  assert.equal(frameAt(def, 350, { settle: true }).column, 7);
  assert.equal(frameAt({ ...def, loopStart: null }, 350).column, 3);
  assert.equal(frameAt(def, 50, { speed: 2 }).column, 1);
  assert.equal(frameAt({ ...def, durations: [0] }, 0), null);
  assert.equal(frameAt({ ...def, frames: [2], durations: [50], loopStart: null }, 1000).completed, false);
  const man = { animations: { idle: def, next: { ...def, frames: [6], durations: [40], loopStart: null } } };
  assert.equal(transitionAt(man, "idle", "next", 599).action, "idle");
  assert.equal(transitionAt(man, "idle", "next", 600).column, 6);
  assert.equal(transitionAt(man, "idle", "next", 600, { still: true }).action, "idle");
});

test("real CLI repair pipeline, boundaries and private outputs", { timeout: 240000 }, () => {
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  const work = fs.mkdtempSync(path.join(root, "work/repair-test-"));
  try {
    const fixture = path.join(work, "fixture");
    const generated = spawnSync(process.env.PET_REPAIR_PYTHON || "python", [path.join(root, "scripts/pet_repair_fixture.py"), fixture], { encoding: "utf8", windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr);
    const replacement = path.join(work, "replacement.png");
    fs.renameSync(path.join(fixture, "replacement.png"), replacement);
    const originalFiles = new Map(fs.readdirSync(fixture).map(name => [name, fs.readFileSync(path.join(fixture, name))]));
    const man = JSON.parse(originalFiles.get("pet-pack.json"));
    const original = path.join(work, "original.yuanyuan-pet");
    fs.writeFileSync(original, zipFiles(originalFiles));
    const task = path.join(work, "task");
    assert.equal(runRepair("inspect", { input: original, out: task }).valid, true);
    const originalHash = digest(fs.readFileSync(original));
    assert.throws(() => runRepair("inspect", { input: original, out: task }));
    const planFile = path.join(work, "plan.json"), candidate = path.join(work, "candidate");
    const ops = [
      { type: "set-animation", action: "idle", values: { frames: [2, 0, 1], durations: [70, 120, 90], loopStart: 1, staticFrame: 2 }, reason: "Explicit rhythm" },
      { type: "clear-hidden-rgb", file: "fallback.png", reason: "Invisible RGB" },
      { type: "translate-row", file: "spritesheet.webp", row: 0, dx: 1, dy: 2, reason: "Uniform baseline shift" },
      { type: "replace-row", file: "life-atlas.webp", row: 0, input: "replacement.png", sha256: digest(fs.readFileSync(replacement)), reason: "Complete row" },
    ];
    const plan = { schemaVersion: 1, baseSha256: originalHash, operations: ops };
    writeJson(planFile, { ...plan, baseSha256: "0".repeat(64) });
    assert.throws(() => runRepair("apply", { task, plan: planFile, out: candidate }), /PLAN_BASE/);
    writeJson(planFile, { ...plan, operations: [{ ...ops[2], dx: 100 }] });
    assert.throws(() => runRepair("apply", { task, plan: planFile, out: candidate }), /TRANSLATION_WOULD_CROP/);
    assert.equal(fs.existsSync(candidate), false);
    writeJson(planFile, { ...plan, operations: [{ ...ops[0], values: { row: 8 } }] });
    assert.throws(() => runRepair("apply", { task, plan: planFile, out: candidate }), /FIELD_NOT_ALLOWED/);
    writeJson(planFile, plan);
    const applied = runRepair("apply", { task, plan: planFile, out: candidate });
    assert.equal(applied.validation.valid, true);
    assert.deepEqual(affectedActions({ animations: { a: { row: 0 }, alias: { row: 0 }, b: { row: 1 } } }, [ops[2]]), ["a", "alias"]);
    const compare = runRepair("compare", { task, candidate, out: path.join(work, "compare") });
    assert.deepEqual(compare.changedRows["spritesheet.webp"], [0]);
    assert.deepEqual(compare.changedRows["life-atlas.webp"], [0]);
    assert.deepEqual(compare.changedRows["fallback.png"], []);
    const delivery = path.join(work, "delivery");
    const packaged = runRepair("package", { task, candidate, out: delivery });
    assert.equal(packaged.candidateOnly, true);
    const acceptance = readJson(path.join(delivery, "acceptance.json"));
    assert.equal(acceptance.nativePlayback, "pending");
    assert.throws(() => validateAcceptance({ ...acceptance, applicationVersion: "1.5.35", packageSha256: "bad" }, packaged.packageSha256));
    assert.throws(() => validateAcceptance({ ...acceptance, applicationVersion: "1.5.35", nativePlayback: "pass" }, packaged.packageSha256));
    assert.throws(() => validateAcceptance({ ...acceptance, applicationVersion: "1.5.35", evidence: ["C:/private/photo.png"] }, packaged.packageSha256));
    const receiptFile = path.join(candidate, "receipt.json"), receiptBytes = fs.readFileSync(receiptFile);
    const licenseFile = path.join(candidate, "assets/LICENSE.txt"), license = fs.readFileSync(licenseFile);
    fs.writeFileSync(licenseFile, "changed");
    assert.throws(() => runRepair("package", { task, candidate, out: path.join(work, "bad") }), /DRIFT/);
    const receipt = readJson(receiptFile); receipt.files["LICENSE.txt"] = digest(fs.readFileSync(licenseFile)); writeJson(receiptFile, receipt);
    assert.throws(() => runRepair("package", { task, candidate, out: path.join(work, "bad") }), /FILE_CHANGE_OUTSIDE_PLAN/);
    fs.writeFileSync(licenseFile, license); fs.writeFileSync(receiptFile, receiptBytes);
    const sheet = path.join(candidate, "assets/spritesheet.webp"), originalSheet = fs.readFileSync(sheet);
    // Deliberately alter an unapproved row and refresh its receipt to exercise scope enforcement.
    const py = spawnSync(process.env.PET_REPAIR_PYTHON || "python", ["-c", "from PIL import Image;import sys; p=sys.argv[1];im=Image.open(p).convert('RGBA');im.putpixel((70,300),(255,0,0,255));im.save(p,lossless=True,exact=True)", sheet], { windowsHide: true });
    assert.equal(py.status, 0);
    const driftReceipt = readJson(receiptFile); driftReceipt.files["spritesheet.webp"] = digest(fs.readFileSync(sheet)); writeJson(receiptFile, driftReceipt);
    assert.throws(() => runRepair("compare", { task, candidate, out: path.join(work, "bad") }), /PIXEL_CHANGE_OUTSIDE_PLAN/);
    fs.writeFileSync(sheet, originalSheet); fs.writeFileSync(receiptFile, receiptBytes);
    fs.appendFileSync(path.join(task, "original.yuanyuan-pet"), "drift");
    assert.throws(() => runRepair("package", { task, candidate, out: path.join(work, "bad") }), /BASELINE_DRIFT/);
    assert.equal(digest(fs.readFileSync(original)), originalHash);

    for (const kind of ["minimal", "static", "json", "missing", "decode", "traversal", "duplicate", "limit", "encrypted", "link"]) {
      const files = new Map(originalFiles), changed = structuredClone(man);
      if (kind === "minimal") for (const group of ["learning", "scene"]) {
        files.delete(`${group}-atlas.webp`); delete changed[`${group}Spritesheet`]; delete changed[`${group}Rows`];
        for (const [name, def] of Object.entries(changed.animations)) if (def.sheet === group) delete changed.animations[name];
      }
      if (kind === "static") delete changed.animations.idle.staticFrame;
      files.set("pet-pack.json", Buffer.from(kind === "json" ? "broken{" : JSON.stringify(changed)));
      if (kind === "missing") files.delete("fallback.png");
      if (kind === "decode") files.set("fallback.png", Buffer.from("bad png"));
      if (kind === "traversal") { files.delete("LICENSE.txt"); files.set("../LICENSE.txt", Buffer.from("MIT")); }
      if (kind === "limit") files.set("LICENSE.txt", Buffer.alloc(65537, 32));
      let bytes = zipFiles(files);
      const central = bytes.readUInt32LE(bytes.length - 6);
      if (kind === "encrypted") { bytes.writeUInt16LE(0x801, 6); bytes.writeUInt16LE(0x801, central + 8); }
      if (kind === "link") { bytes.writeUInt16LE(0x314, central + 4); bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38); }
      if (kind === "duplicate") {
        const end = bytes.length - 22, length = 46 + bytes.readUInt16LE(central + 28), footer = Buffer.from(bytes.subarray(end));
        footer.writeUInt16LE(files.size + 1, 8); footer.writeUInt16LE(files.size + 1, 10); footer.writeUInt32LE(end - central + length, 12);
        bytes = Buffer.concat([bytes.subarray(0, end), bytes.subarray(central, central + length), footer]);
      }
      const input = path.join(work, kind + ".yuanyuan-pet"), out = path.join(work, kind); fs.writeFileSync(input, bytes);
      if (["traversal", "duplicate", "limit", "encrypted", "link"].includes(kind)) { assert.throws(() => runRepair("inspect", { input, out })); assert.equal(fs.existsSync(out), false); }
      else {
        assert.equal(runRepair("inspect", { input, out }).valid, kind === "minimal", kind);
        if (kind === "static") {
          writeJson(planFile, { schemaVersion: 1, baseSha256: digest(bytes), operations: [{ type: "fill-static-frame", action: "idle", reason: "Missing static" }] });
          const repaired = path.join(work, "static-repaired");
          runRepair("apply", { task: out, plan: planFile, out: repaired });
          assert.equal(readJson(path.join(repaired, "assets/pet-pack.json")).animations.idle.staticFrame, changed.animations.idle.frames[0]);
        }
      }
      assert.equal(digest(fs.readFileSync(input)), digest(bytes));
    }
    const html = renderComparison(man, man, fixture, fixture, { value: "</script><script>alert(1)</script>" });
    assert.ok(!html.includes("</script><script>alert"));
    assert.ok(!html.includes(work));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
