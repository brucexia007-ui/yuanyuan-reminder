import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { zipFiles } from "./package_pet.mjs";
import { renderComparison } from "./pet_repair_preview.mjs";

const root = path.resolve(import.meta.dirname, "..");
const LIMIT = 64 * 1024 * 1024;
const names = ["pet-pack.json", "LICENSE.txt", "fallback.png", "spritesheet.webp", "sleep-atlas.webp", "life-atlas.webp", "learning-atlas.webp", "scene-atlas.webp"];
export const sheets = { standard: ["spritesheet.webp", 11], sleep: ["sleep-atlas.webp", 3], life: ["life-atlas.webp", 21], learning: ["learning-atlas.webp", 4], scene: ["scene-atlas.webp", 18] };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(message); };
const json = file => JSON.parse(read(file, 1024 * 1024).toString("utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function safePath(file, exists = true) {
  const resolved = path.resolve(file);
  let current = resolved;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("LINK_NOT_ALLOWED");
    const next = path.dirname(current); if (next === current) break; current = next;
  }
  if (exists && !fs.existsSync(resolved)) fail("INPUT_NOT_FOUND");
  return resolved;
}
function read(file, limit = LIMIT) {
  safePath(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) fail("INPUT_NOT_REGULAR_OR_TOO_LARGE");
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit) fail("INPUT_TOO_LARGE");
  return bytes;
}
function workspace(file) {
  const resolved = safePath(file, false), relative = path.relative(path.join(root, "work"), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("USE_A_NEW_DIRECTORY_UNDER_WORK");
  return resolved;
}
function fresh(file, action) {
  const output = workspace(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output); // Deliberately refuses an existing directory.
  try { return action(output); }
  catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
}
function fileHashes(directory) {
  safePath(directory);
  const result = {};
  for (const name of fs.readdirSync(directory).sort()) {
    if (!names.includes(name)) fail("UNEXPECTED_ASSET_FILE");
    result[name] = hash(read(path.join(directory, name), name === "pet-pack.json" ? 256 * 1024 : name === "LICENSE.txt" ? 64 * 1024 : LIMIT));
  }
  return result;
}
function copyAssets(source, output) {
  fs.mkdirSync(output);
  for (const name of Object.keys(fileHashes(source))) fs.writeFileSync(path.join(output, name), read(path.join(source, name)), { flag: "wx" });
}
function execute(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    // Do not forward compiler, filesystem or decoder messages with private input paths.
    const code = result.stderr?.match(/\b(?:[A-Z]+_){1,8}[A-Z]+\b/)?.[0];
    fail(code ?? "TOOL_FAILED_CHECK_RUST_PYTHON_AND_PILLOW");
  }
  return JSON.parse(result.stdout);
}
function native(command, source, destination) {
  const args = [command, source, ...(destination ? [destination] : [])];
  return process.env.YUANYUAN_PET_REPAIR_BIN
    ? execute(process.env.YUANYUAN_PET_REPAIR_BIN, args)
    : execute("cargo", ["run", "--quiet", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "pet-repair-tools", "--bin", "yuanyuan-pet-repair", "--", ...args]);
}
function pixels(command, ...args) {
  return execute(process.env.PET_REPAIR_PYTHON || "python", [path.join(root, "scripts/pet_repair_pixels.py"), command, ...args]);
}
function manifest(directory) {
  try { return JSON.parse(read(path.join(directory, "pet-pack.json"), 256 * 1024).toString("utf8")); }
  catch { return null; }
}
function base(task) {
  task = workspace(task);
  const record = json(path.join(task, "baseline.json")), archive = read(path.join(task, "original.yuanyuan-pet"));
  if (record.schemaVersion !== 1 || hash(archive) !== record.archiveSha256 || !equal(fileHashes(path.join(task, "baseline")), record.files)) fail("BASELINE_DRIFT");
  return { task, record, directory: path.join(task, "baseline") };
}
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !equal(Object.keys(value).sort(), [...keys].sort())) fail("INVALID_PLAN_FIELDS");
}
export function validatePlan(plan, baselineSha, sourceManifest) {
  exactKeys(plan, ["schemaVersion", "baseSha256", "operations"]);
  if (plan.schemaVersion !== 1 || plan.baseSha256 !== baselineSha || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 128) fail("PLAN_BASE_OR_OPERATIONS_INVALID");
  if (!sourceManifest?.animations || typeof sourceManifest.animations !== "object") fail("MANIFEST_UNREADABLE_REBUILD_FROM_SOURCE_PROJECT");
  for (const op of plan.operations) {
    const keys = {
      "fill-static-frame": ["type", "action", "reason"],
      "set-animation": ["type", "action", "values", "reason"],
      "clear-hidden-rgb": ["type", "file", "reason"],
      "translate-row": ["type", "file", "row", "dx", "dy", "reason"],
      "replace-row": ["type", "file", "row", "input", "sha256", "reason"],
    }[op?.type];
    if (!keys) fail("UNKNOWN_REPAIR_OPERATION");
    exactKeys(op, keys);
    if (typeof op.reason !== "string" || !op.reason.trim() || op.reason.length > 1000) fail("REPAIR_REASON_REQUIRED");
    if (op.action !== undefined) {
      if (!Object.hasOwn(sourceManifest.animations, op.action)) fail("UNKNOWN_ACTION");
      if (op.type === "set-animation") {
        if (!op.values || typeof op.values !== "object" || Array.isArray(op.values) || !Object.keys(op.values).length
          || Object.keys(op.values).some(key => !["frames", "durations", "loopStart", "staticFrame"].includes(key))) fail("ANIMATION_FIELD_NOT_ALLOWED");
      }
    } else {
      const rowCount = Object.values(sheets).find(([name]) => name === op.file)?.[1];
      if (!rowCount && op.file !== "fallback.png") fail("IMAGE_NOT_ALLOWED");
      if (op.type !== "clear-hidden-rgb" && (!Number.isInteger(op.row) || op.row < 0 || op.row >= (rowCount ?? 0))) fail("ROW_OUT_OF_RANGE");
      if (op.type === "translate-row" && (!Number.isInteger(op.dx) || !Number.isInteger(op.dy) || Math.abs(op.dx) >= 192 || Math.abs(op.dy) >= 208)) fail("INVALID_TRANSLATION");
      if (op.type === "replace-row" && (typeof op.input !== "string" || !/^[a-f0-9]{64}$/.test(op.sha256))) fail("INVALID_ROW_INPUT");
    }
  }
  return plan;
}
export function affectedActions(man, operations) {
  const actions = new Set(operations.filter(o => o.action).map(o => o.action));
  for (const op of operations.filter(o => o.file)) {
    for (const [name, def] of Object.entries(man.animations ?? {})) {
      if (sheets[def.sheet ?? "standard"]?.[0] === op.file && (op.type === "clear-hidden-rgb" || def.row === op.row)) actions.add(name);
    }
  }
  return [...actions].sort();
}
function inspect(options) {
  const source = read(options.input);
  if (!options.input.endsWith(".yuanyuan-pet")) fail("PET_PACKAGE_REQUIRED");
  return fresh(options.out, output => {
    fs.writeFileSync(path.join(output, "original.yuanyuan-pet"), source, { flag: "wx" });
    const record = native("extract", path.join(output, "original.yuanyuan-pet"), path.join(output, "baseline"));
    if (record.archiveSha256 !== hash(source)) fail("SOURCE_DRIFT");
    writeJson(path.join(output, "baseline.json"), record);
    fs.mkdirSync(path.join(output, "contacts"));
    const geometry = pixels("inspect", path.join(output, "baseline"), path.join(output, "contacts"));
    const man = manifest(path.join(output, "baseline"));
    writeJson(path.join(output, "diagnosis.json"), { schemaVersion: 1, archiveSha256: record.archiveSha256,
      validation: record.validation, geometry, actions: man?.animations ?? {},
      notes: ["Native structural validation is not identity or motion approval.", "Unreadable JSON or missing/corrupt source images require recovery from the private source project; do not invent identity."] });
    writeJson(path.join(output, "repair-plan.template.json"), { schemaVersion: 1, baseSha256: record.archiveSha256, operations: [] });
    return { task: path.relative(root, output), baseSha256: record.archiveSha256, valid: record.validation.valid };
  });
}
function apply(options) {
  const baseline = base(options.task), man = manifest(baseline.directory);
  const plan = validatePlan(json(options.plan), baseline.record.archiveSha256, man);
  return fresh(options.out, output => {
    const candidate = path.join(output, "assets"); copyAssets(baseline.directory, candidate);
    const storedPlan = structuredClone(plan), pixelOps = [];
    let changedManifest = false;
    for (let index = 0; index < plan.operations.length; index++) {
      const op = plan.operations[index];
      if (op.type === "fill-static-frame") {
        const def = man.animations[op.action];
        if (def.staticFrame !== undefined && def.staticFrame !== null) fail("STATIC_FRAME_ALREADY_PRESENT");
        if (!Array.isArray(def.frames) || !def.frames.length || def.frames.some(n => !Number.isInteger(n) || n < 0 || n > 7)) fail("INVALID_SOURCE_FRAMES");
        def.staticFrame = def.frames[0]; changedManifest = true;
      } else if (op.type === "set-animation") {
        Object.assign(man.animations[op.action], op.values); changedManifest = true;
      } else {
        const pixelOp = structuredClone(op);
        if (op.type === "replace-row") {
          const input = path.resolve(path.dirname(path.resolve(options.plan)), op.input), bytes = read(input);
          if (hash(bytes) !== op.sha256) fail("ROW_INPUT_DRIFT");
          const extension = path.extname(input).toLowerCase();
          if (![".png", ".webp"].includes(extension)) fail("ROW_IMAGE_FORMAT");
          fs.mkdirSync(path.join(output, "inputs"), { recursive: true });
          const relative = `inputs/row-${index}${extension}`;
          fs.writeFileSync(path.join(output, relative), bytes, { flag: "wx" });
          storedPlan.operations[index].input = relative;
          pixelOp.input = path.join(output, relative);
        }
        pixelOps.push(pixelOp);
      }
    }
    if (changedManifest) fs.writeFileSync(path.join(candidate, "pet-pack.json"), JSON.stringify(man, null, 2) + "\n");
    if (pixelOps.length) {
      const request = path.join(output, ".pixel-request.json");
      writeJson(request, { source: baseline.directory, destination: candidate, operations: pixelOps });
      try { pixels("apply", request); } finally { fs.rmSync(request, { force: true }); }
    }
    const validation = native("validate", candidate);
    if (!validation.valid) fail("CANDIDATE_INVALID_REPAIR_ALL_STRUCTURAL_ERRORS");
    const affected = affectedActions(man, storedPlan.operations);
    writeJson(path.join(output, "plan.json"), storedPlan);
    writeJson(path.join(output, "receipt.json"), { schemaVersion: 1, baseSha256: baseline.record.archiveSha256,
      planSha256: hash(read(path.join(output, "plan.json"))), files: fileHashes(candidate), affectedActions: affected, validation });
    base(options.task);
    return { candidate: path.relative(root, output), affectedActions: affected, validation };
  });
}
function checkedCandidate(options) {
  const baseline = base(options.task), candidateRoot = workspace(options.candidate), directory = path.join(candidateRoot, "assets");
  const receipt = json(path.join(candidateRoot, "receipt.json"));
  if (receipt.schemaVersion !== 1 || receipt.baseSha256 !== baseline.record.archiveSha256
    || receipt.planSha256 !== hash(read(path.join(candidateRoot, "plan.json"))) || !equal(receipt.files, fileHashes(directory))) fail("CANDIDATE_OR_PLAN_DRIFT");
  const man = manifest(baseline.directory), next = manifest(directory);
  const plan = validatePlan(json(path.join(candidateRoot, "plan.json")), baseline.record.archiveSha256, man);
  if (!equal(Object.keys(receipt.files), Object.keys(baseline.record.files))) fail("PACKAGE_CAPABILITIES_CHANGED");
  const expectedManifest = structuredClone(man);
  for (const op of plan.operations) {
    if (op.type === "fill-static-frame") expectedManifest.animations[op.action].staticFrame = expectedManifest.animations[op.action].frames[0];
    if (op.type === "set-animation") Object.assign(expectedManifest.animations[op.action], op.values);
    if (op.type === "replace-row") {
      if (!/^inputs\/row-\d+\.(png|webp)$/.test(op.input) || hash(read(path.join(candidateRoot, op.input))) !== op.sha256) fail("ROW_INPUT_DRIFT");
    }
  }
  if (!equal(expectedManifest, next)) fail("MANIFEST_CHANGE_OUTSIDE_PLAN");
  const allowedFiles = new Set(plan.operations.filter(o => o.file).map(o => o.file));
  if (plan.operations.some(o => o.action)) allowedFiles.add("pet-pack.json");
  for (const [name, sha] of Object.entries(baseline.record.files)) if (!allowedFiles.has(name) && receipt.files[name] !== sha) fail("FILE_CHANGE_OUTSIDE_PLAN");
  const pixelDiff = pixels("compare", baseline.directory, directory);
  if (pixelDiff.errors.length) fail("CANNOT_PROVE_UNCHANGED_ROWS");
  for (const [file, rows] of Object.entries(pixelDiff.changedRows)) {
    const allowedRows = new Set(plan.operations.filter(o => o.file === file && ["translate-row", "replace-row"].includes(o.type)).map(o => o.row));
    if (rows.some(row => !allowedRows.has(row))) fail("PIXEL_CHANGE_OUTSIDE_PLAN");
  }
  const validation = native("validate", directory);
  if (!validation.valid) fail("CANDIDATE_INVALID");
  return { baseline, directory, plan, man, next, receipt, pixelDiff, validation };
}
function compare(options) {
  const check = checkedCandidate(options);
  return fresh(options.out, output => {
    const changedFields = [];
    for (const name of Object.keys(check.man.animations)) for (const field of ["frames", "durations", "loopStart", "staticFrame"]) {
      if (!equal(check.man.animations[name][field], check.next.animations[name][field])) changedFields.push({ action: name, field, before: check.man.animations[name][field] ?? null, after: check.next.animations[name][field] });
    }
    const report = { schemaVersion: 1, baseSha256: check.baseline.record.archiveSha256, candidateFiles: check.receipt.files,
      changedFields, ...check.pixelDiff, affectedActions: affectedActions(check.next, check.plan.operations),
      structural: "pass", scope: "pass", visualReview: "pending", identityReview: "pending", nativePlayback: "pending" };
    writeJson(path.join(output, "comparison.json"), report);
    fs.writeFileSync(path.join(output, "comparison.html"), renderComparison(check.man, check.next, check.baseline.directory, check.directory, report), { flag: "wx" });
    return { comparison: path.relative(root, output), ...report };
  });
}
export function validateAcceptance(record, packageSha256) {
  exactKeys(record, ["schemaVersion", "packageSha256", "applicationVersion", "visualReview", "identityReview", "nativePlayback", "evidence"]);
  if (record.schemaVersion !== 1 || record.packageSha256 !== packageSha256
    || typeof record.applicationVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(record.applicationVersion)
    || !["pending", "pass", "fail"].includes(record.visualReview) || !["pending", "pass", "fail"].includes(record.nativePlayback)
    || !["pending", "unchanged", "confirmed"].includes(record.identityReview)
    || !Array.isArray(record.evidence) || record.evidence.some(x => typeof x !== "string" || !x || path.isAbsolute(x) || /^[A-Za-z]:|\\|\.\./.test(x))
    || ((record.visualReview === "pass" || record.nativePlayback === "pass" || record.identityReview === "confirmed") && !record.evidence.length)) fail("ACCEPTANCE_BINDING_INVALID");
  return record;
}
function packageCandidate(options) {
  const check = checkedCandidate(options);
  const files = new Map(Object.keys(check.receipt.files).map(name => [name, read(path.join(check.directory, name))]));
  if ([...files.values()].reduce((sum, b) => sum + b.length, 0) > LIMIT) fail("PACKAGE_TOO_LARGE");
  // Reuse the existing deterministic ZIP writer, without packagePet's implicit manifest edits.
  const bytes = zipFiles(files); if (bytes.length > LIMIT) fail("PACKAGE_TOO_LARGE");
  const packageSha256 = hash(bytes);
  const acceptance = options.acceptance ? validateAcceptance(json(options.acceptance), packageSha256) : {
    schemaVersion: 1, packageSha256, applicationVersion: "", visualReview: "pending", identityReview: "pending", nativePlayback: "pending", evidence: [],
  };
  return fresh(options.out, output => {
    const filename = "repaired.yuanyuan-pet";
    fs.writeFileSync(path.join(output, filename), bytes, { flag: "wx" });
    const verified = native("extract", path.join(output, filename), path.join(output, ".verification"));
    if (!verified.validation.valid || !equal(verified.files, check.receipt.files)) fail("PACKAGED_CONTENT_DRIFT");
    fs.rmSync(path.join(output, ".verification"), { recursive: true });
    fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), `${packageSha256}  ${filename}\n`, { flag: "wx" });
    fs.writeFileSync(path.join(output, "LICENSE.txt"), files.get("LICENSE.txt"), { flag: "wx" });
    writeJson(path.join(output, "acceptance.json"), acceptance);
    const report = { schemaVersion: 1, baseSha256: check.baseline.record.archiveSha256, packageSha256,
      originalPackId: check.baseline.record.validation.packId, repairedPackId: verified.validation.packId,
      candidateOnly: true, structural: "pass", scope: "pass", affectedActions: affectedActions(check.next, check.plan.operations),
      operations: check.plan.operations, acceptanceSource: options.acceptance ? "operator-supplied-not-automatically-verified" : "pending" };
    writeJson(path.join(output, "repair-report.json"), report);
    fs.writeFileSync(path.join(output, "IMPORT_AND_ROLLBACK.md"), "# 导入与回退\n\n这是修复候选包，结构和修改范围通过不代表视觉或原生播放通过。\n\n在“设置 → 我的宠物”导入 repaired.yuanyuan-pet，预览后选择使用。新内容作为新形象加入，不自动继承昵称，不替换旧版。保留原包与旧形象，检查动作、互动、切换和重启；不满意时切回旧形象。仅重新打包而内容未变时，应用会复用同一形象。\n\n请在 acceptance.json 中记录实际应用版本及私有证据。验收只适用于该文件绑定的包哈希，修改包后必须重新验收；不要把模板的 pending 改成未经实际观察的 pass。\n", { flag: "wx" });
    base(options.task);
    return { delivery: path.relative(root, output), packageSha256, candidateOnly: true };
  });
}
export function runRepair(command, options) {
  const commands = { inspect, apply, compare, package: packageCandidate };
  if (!Object.hasOwn(commands, command)) fail("UNKNOWN_COMMAND");
  return commands[command](options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === "--help") {
      console.log("pet:repair inspect --input PACK --out work/TASK\npet:repair apply --task work/TASK --plan PLAN.json --out work/CANDIDATE\npet:repair compare --task work/TASK --candidate work/CANDIDATE --out work/REVIEW\npet:repair package --task work/TASK --candidate work/CANDIDATE --out work/DELIVERY [--acceptance RECORD.json]\nRequires Rust and Python/Pillow; PET_REPAIR_PYTHON selects a Python executable.");
    } else {
      const allowed = { inspect: ["input", "out"], apply: ["task", "plan", "out"], compare: ["task", "candidate", "out"], package: ["task", "candidate", "out", "acceptance"] }[command];
      if (!allowed || args.length % 2) fail("INVALID_ARGUMENTS");
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i].slice(2);
        if (!args[i].startsWith("--") || !allowed.includes(key) || Object.hasOwn(options, key) || !args[i + 1]) fail("INVALID_ARGUMENTS");
        options[key] = args[i + 1];
      }
      if (allowed.filter(k => k !== "acceptance").some(k => !options[k])) fail("MISSING_ARGUMENTS");
      console.log(JSON.stringify(runRepair(command, options)));
    }
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : "PET_REPAIR_FAILED_CHECK_INPUTS_AND_NEW_OUTPUT_DIRECTORY");
    process.exitCode = 2;
  }
}
