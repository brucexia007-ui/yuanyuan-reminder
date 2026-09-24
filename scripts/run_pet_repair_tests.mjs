import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
function run(binary, args, env = process.env) {
  const result = spawnSync(binary, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "pet-repair-tools", "--bin", "yuanyuan-pet-repair"]);
run("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--features", "pet-repair-tools", "--lib", "pet_packs::tests::repair_"]);
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(root, "src-tauri/target"));
run(process.execPath, ["--test", "scripts/pet_repair.node-test.mjs"], { ...process.env,
  YUANYUAN_PET_REPAIR_BIN: path.join(target, "debug", "yuanyuan-pet-repair" + (process.platform === "win32" ? ".exe" : "")) });
