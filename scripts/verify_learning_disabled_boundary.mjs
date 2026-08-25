import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const distRoot = path.join(projectRoot, "dist");

export const forbiddenDefaultBundleMarkers = [
  "yuanyuan-learning-preview-ui",
  "get_learning_home",
  "start_manual_learning_session",
  "yuanyuan-learning.sqlite3",
];

export const forbiddenDefaultBundlePaths = [
  "dist/assets/pet/learning-atlas.webp",
];

export function validateLearningFeatureDeclaration(cargoToml) {
  const features = /\[features\]([\s\S]*?)(?=\n\[|$)/u.exec(cargoToml)?.[1] ?? "";
  if (!/^default\s*=\s*\[\s*\]\s*$/mu.test(features)) {
    throw new Error("Cargo default features must remain empty");
  }
  const learningDependencies = /^learning\s*=\s*\[([^\]]*)\]\s*$/mu.exec(features)?.[1];
  if (learningDependencies === undefined) {
    throw new Error("Cargo must declare an isolated learning feature");
  }
  const entries = [...learningDependencies.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (entries.some((entry) => !entry.startsWith("dep:"))) {
    throw new Error("learning feature may enable only optional learning dependencies");
  }
}

function validateLearningCommandRegistrations(libRs) {
  const lines = libRs.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/commands::[a-z_]*learning[a-z_]*/u.test(lines[index])) continue;
    let previous = index - 1;
    while (previous >= 0 && lines[previous].trim() === "") previous -= 1;
    if (previous < 0 || lines[previous].trim() !== '#[cfg(feature = "learning")]') {
      throw new Error("default Tauri handler unexpectedly registers a learning command");
    }
  }
}

export function validateSourceBoundary({ packageJson, cargoToml, libRs, tauriConfig }) {
  validateLearningFeatureDeclaration(cargoToml);
  const defaultCommands = [packageJson.scripts?.build, packageJson.scripts?.check]
    .filter(Boolean)
    .join("\n");
  if (/VITE_FEATURE_LEARNING\s*=\s*1/u.test(defaultCommands)) {
    throw new Error("default frontend commands must not enable learning");
  }
  validateLearningCommandRegistrations(libRs);
  const bundle = JSON.stringify(tauriConfig.bundle ?? {}).toLowerCase();
  if (bundle.includes("learning-content") || bundle.includes("yuanyuan-learning")) {
    throw new Error("default installer unexpectedly declares learning resources");
  }
}

export function validateDefaultBundle(relativePath, source) {
  if (forbiddenDefaultBundlePaths.includes(relativePath)) {
    throw new Error(`default bundle contains learning-only asset ${relativePath}`);
  }
  for (const marker of forbiddenDefaultBundleMarkers) {
    if (source.includes(marker)) {
      throw new Error(
        `default bundle contains disabled learning marker ${JSON.stringify(marker)} in ${relativePath}`,
      );
    }
  }
}

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

async function main() {
  const [packageJson, cargoToml, libRs, tauriConfig] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
  ]);
  validateSourceBoundary({ packageJson, cargoToml, libRs, tauriConfig });

  const files = await filesUnder(distRoot);
  for (const absolutePath of files) {
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
    validateDefaultBundle(relativePath, await readFile(absolutePath, "utf8"));
  }
  console.log(
    `Learning-disabled boundary OK: ${files.length} default bundle files contain no learning UI, commands, database name, or content resource.`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
