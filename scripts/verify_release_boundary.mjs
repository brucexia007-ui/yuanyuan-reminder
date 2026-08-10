import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");

const forbiddenDistMarkers = [
  "support-lab",
  "support-sort-boundary-lab",
  "expression-lab",
  "connector-disconnect-lab",
  "三路径基础陪伴",
  "让圆圆靠近",
  "只听不记",
  "帮我理一理",
  "带我缓一下",
  ".support-lab",
  ".sort-boundary-lab",
  "理一理数据去向实验台",
  ".expression-lab",
  ".connector-disconnect-lab",
  "pet-intent-bubble",
  "pet-bubble-detail",
  "圆圆会在",
  "圆圆已经把它从待处理里移开了",
  "做得好，圆圆陪你继续保持",
  "taskWatchDemo",
];

const requiredProductionMarkers = [
  "pet-system-card",
  "data-information-surface",
  "basic-support-card",
];
const requiredLicenseResources = new Map([
  ["../LICENSE", "licenses/LICENSE.txt"],
  ["../THIRD_PARTY_NOTICES.md", "licenses/THIRD_PARTY_NOTICES.md"],
  ["../THIRD_PARTY_LICENSES.txt", "licenses/THIRD_PARTY_LICENSES.txt"],
  ["../ASSETS_LICENSE.md", "licenses/ASSETS_LICENSE.md"],
]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
const bundle = tauriConfig.bundle ?? {};
const externalBin = bundle.externalBin ?? [];
const resources = bundle.resources ?? [];
const serializedBundle = JSON.stringify({ externalBin, resources }).toLowerCase();

if (
  resources === null ||
  typeof resources !== "object" ||
  Array.isArray(resources) ||
  resources instanceof Map ||
  Object.keys(resources).length !== requiredLicenseResources.size
) {
  throw new Error("release bundle must contain the exact license resource map");
}
for (const [source, destination] of requiredLicenseResources) {
  if (resources[source] !== destination) {
    throw new Error(`required license resource mapping is missing: ${source}`);
  }
  const sourcePath = path.resolve(path.dirname(tauriConfigPath), source);
  const metadata = await lstat(sourcePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`license resource must be an ordinary file: ${source}`);
  }
}

if (serializedBundle.includes("yuanyuan-ai") || serializedBundle.includes("yuanyuan-bridge")) {
  throw new Error("release bundle unexpectedly includes an experimental sidecar");
}

if (
  serializedBundle.includes("yuanyuan-task-watch-fixture") ||
  serializedBundle.includes("runtime-qa") ||
  serializedBundle.includes("migration-qa") ||
  serializedBundle.includes("yuanyuan-database-migration-qa") ||
  serializedBundle.includes("yuanyuan-pid-reuse-qa")
) {
  throw new Error("release bundle unexpectedly includes a non-production QA harness");
}

const productionFiles = await filesUnder(distRoot);
const foundRequiredMarkers = new Set();
for (const file of productionFiles) {
  const contents = await readFile(file, "utf8");
  for (const marker of forbiddenDistMarkers) {
    if (contents.includes(marker)) {
      throw new Error(
        `development-only marker ${JSON.stringify(marker)} found in ${path.relative(projectRoot, file)}`,
      );
    }
  }
  for (const marker of requiredProductionMarkers) {
    if (contents.includes(marker)) foundRequiredMarkers.add(marker);
  }
}

for (const marker of requiredProductionMarkers) {
  if (!foundRequiredMarkers.has(marker)) {
    throw new Error(`required production marker ${marker} is missing`);
  }
}

console.log(
  `Release boundary OK: ${productionFiles.length} production files and ${requiredLicenseResources.size} license resources; fixed basic support is present, with no deep-support labs, dialogue bubbles, task-watch fixtures, or experimental sidecars.`,
);
