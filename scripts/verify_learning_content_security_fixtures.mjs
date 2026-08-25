import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDirectory);
export const fixtureRoot = path.join(
  projectRoot,
  "src-tauri",
  "tests",
  "fixtures",
  "learning-content-security",
);

const REQUIRED_STRIDE = new Set([
  "spoofing",
  "tampering",
  "repudiation",
  "information_disclosure",
  "denial_of_service",
  "elevation_of_privilege",
]);

const FROZEN_BUDGETS = {
  maxPackageBytes: 25 * 1024 * 1024,
  maxCards: 20_000,
  maxJsonDepth: 8,
  maxPreviewTokens: 8,
  previewTtlSeconds: 600,
  unknownFields: "reject",
  remoteResources: "reject",
  executableContent: "reject",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateSecurityFixtureManifest(manifest, fixtureBytes) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.fixtureSet !== "local-content-pack-v1-preimplementation" ||
    manifest.syntheticOnly !== true ||
    !Array.isArray(manifest.fixtures) ||
    manifest.fixtures.length < 13
  ) {
    return false;
  }
  if (JSON.stringify(manifest.frozenBudgets) !== JSON.stringify(FROZEN_BUDGETS)) {
    return false;
  }

  const ids = new Set();
  const files = new Set();
  const coveredStride = new Set();
  let accepted = 0;
  for (const fixture of manifest.fixtures) {
    if (
      typeof fixture.id !== "string" ||
      !/^SEC-FIX-\d{3}$/.test(fixture.id) ||
      ids.has(fixture.id) ||
      typeof fixture.file !== "string" ||
      path.basename(fixture.file) !== fixture.file ||
      fixture.file === "manifest.json" ||
      files.has(fixture.file) ||
      !/^[a-z0-9][a-z0-9.-]+$/.test(fixture.file) ||
      typeof fixture.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(fixture.sha256) ||
      !fixtureBytes.has(fixture.file) ||
      sha256(fixtureBytes.get(fixture.file)) !== fixture.sha256 ||
      !["accept", "reject", "reject_second_use", "old_state_unchanged"].includes(
        fixture.expected,
      ) ||
      !Array.isArray(fixture.stride) ||
      fixture.stride.length === 0 ||
      fixture.stride.some((threat) => !REQUIRED_STRIDE.has(threat)) ||
      typeof fixture.control !== "string" ||
      fixture.control.length < 8 ||
      typeof fixture.owner !== "string" ||
      fixture.owner.length < 3
    ) {
      return false;
    }
    ids.add(fixture.id);
    files.add(fixture.file);
    fixture.stride.forEach((threat) => coveredStride.add(threat));
    if (fixture.expected === "accept") accepted += 1;
  }
  if (accepted !== 1 || coveredStride.size !== REQUIRED_STRIDE.size) return false;
  for (const threat of REQUIRED_STRIDE) {
    if (!coveredStride.has(threat)) return false;
  }
  return fixtureBytes.size === files.size;
}

export async function loadSecurityFixtureSet(root = fixtureRoot) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("learning content security fixture root must be an ordinary directory");
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error("learning content security fixture manifest must be an ordinary file");
  }
  const manifest = JSON.parse((await readFile(manifestPath)).toString("utf8"));
  const fixtureBytes = new Map();
  for (const name of await readdir(root)) {
    if (name === "manifest.json") continue;
    const fixturePath = path.join(root, name);
    const metadata = await lstat(fixturePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("learning content security fixtures must be ordinary files");
    }
    fixtureBytes.set(name, await readFile(fixturePath));
  }
  return { manifest, fixtureBytes };
}

export async function main() {
  const { manifest, fixtureBytes } = await loadSecurityFixtureSet();
  if (!validateSecurityFixtureManifest(manifest, fixtureBytes)) {
    throw new Error("learning content security fixture manifest is stale or incomplete");
  }
  console.log(
    `SEC-001 fixture set passed: ${manifest.fixtures.length} synthetic fixtures cover all six STRIDE categories.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
