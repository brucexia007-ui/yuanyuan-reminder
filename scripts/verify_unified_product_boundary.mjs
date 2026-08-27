import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateProductManifest } from "./sync_unified_product_version.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const distRoot = path.join(projectRoot, "dist");

export function validateUnifiedCargoFeatures(cargoToml) {
  const features = /\[features\]([\s\S]*?)(?=\n\[|$)/u.exec(cargoToml)?.[1] ?? "";
  if (!/^default\s*=\s*\[\s*"learning"\s*\]\s*$/mu.test(features)) {
    throw new Error('Cargo default features must contain exactly "learning"');
  }
  const learningDependencies = /^learning\s*=\s*\[([^\]]*)\]\s*$/mu.exec(features)?.[1];
  if (learningDependencies === undefined) {
    throw new Error("Cargo must retain the generic learning capability feature");
  }
  const entries = [...learningDependencies.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (entries.length === 0 || entries.some((entry) => !entry.startsWith("dep:"))) {
    throw new Error("learning capability may enable only optional generic dependencies");
  }
}

export function validateUnifiedSourceContract({
  manifest,
  packageJson,
  cargoToml,
  libRs,
  tauriConfig,
  windowCapabilities,
  viteConfig,
  featureGate,
  initialLearningMigration,
  legacyPreviewConfigExists,
}) {
  validateProductManifest(manifest);
  validateUnifiedCargoFeatures(cargoToml);
  if (
    tauriConfig.productName !== manifest.productName ||
    tauriConfig.identifier !== manifest.identifier ||
    tauriConfig.version !== manifest.version
  ) {
    throw new Error("Tauri product identity must match the unified product manifest");
  }
  if (
    windowCapabilities?.identifier !== "default" ||
    !windowCapabilities.permissions?.includes("core:window:allow-start-dragging")
  ) {
    throw new Error("the frameless task panel must retain start-dragging permission");
  }
  const scripts = packageJson.scripts ?? {};
  for (const forbiddenName of [
    "learning-off:boundary:test",
    "learning-off:verify",
    "learning:desktop:build",
  ]) {
    if (Object.hasOwn(scripts, forbiddenName)) {
      throw new Error(`obsolete dual-product script remains: ${forbiddenName}`);
    }
  }
  const scriptText = Object.values(scripts).join("\n");
  if (/tauri\.learning-preview\.conf\.json|--mode\s+learning-preview|target[\\/]learning-preview/iu.test(scriptText)) {
    throw new Error("package scripts still expose a Learning Preview product build");
  }
  if (legacyPreviewConfigExists) {
    throw new Error("publishable Learning Preview Tauri config must be removed");
  }
  if (
    libRs.includes("LEARNING_EDITION_IDENTIFIER") ||
    libRs.includes("isolate_learning_edition_context") ||
    !libRs.includes("commands::get_learning_home")
  ) {
    throw new Error("runtime must use the base identity and register generic learning commands");
  }
  if (/VITE_FEATURE_LEARNING|learning-preview/iu.test(viteConfig)) {
    throw new Error("frontend must not depend on a preview-mode learning switch");
  }
  if (
    !featureGate.includes("yuanyuan-learning-integrated-ui") ||
    !/learningBuildEnabled\s*=\s*true/u.test(featureGate)
  ) {
    throw new Error("frontend learning capability must be integrated by default");
  }
  if (!/VALUES\s*\(1,\s*'manual_only'/u.test(initialLearningMigration)) {
    throw new Error("automatic learning invitations must remain default-off");
  }
}

export function validateUnifiedBundle(relativePaths, javascript) {
  if (!relativePaths.includes("dist/assets/pet/learning-atlas.webp")) {
    throw new Error("unified bundle is missing the generic learning pet asset");
  }
  for (const marker of ["get_learning_home", "preview_learning_import", "delete_learning_data"]) {
    if (!javascript.includes(marker)) {
      throw new Error(`unified bundle is missing ${marker}`);
    }
  }
  for (const marker of [
    "yuanyuan-learning-preview-ui",
    "com.yuanyuan.reminder.learning-preview",
    "com.yuanyuan.reminder.learning-personal",
  ]) {
    if (javascript.includes(marker)) {
      throw new Error(`unified bundle contains obsolete edition marker ${marker}`);
    }
  }
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function main() {
  const [
    manifest,
    packageJson,
    cargoToml,
    libRs,
    tauriConfig,
    windowCapabilities,
    viteConfig,
    featureGate,
    initialLearningMigration,
  ] = await Promise.all([
    readFile(path.join(projectRoot, "product-version.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "src", "lib.rs"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "capabilities", "default.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "vite.config.ts"), "utf8"),
    readFile(path.join(projectRoot, "src", "learning", "featureGate.ts"), "utf8"),
    readFile(
      path.join(projectRoot, "src-tauri", "src", "learning", "migrations", "001_initial.sql"),
      "utf8",
    ),
  ]);
  validateUnifiedSourceContract({
    manifest,
    packageJson,
    cargoToml,
    libRs,
    tauriConfig,
    windowCapabilities,
    viteConfig,
    featureGate,
    initialLearningMigration,
    legacyPreviewConfigExists: existsSync(
      path.join(projectRoot, "src-tauri", "tauri.learning-preview.conf.json"),
    ),
  });
  const files = await filesUnder(distRoot);
  const relativePaths = files.map((file) =>
    path.relative(projectRoot, file).replaceAll("\\", "/"),
  );
  const javascript = (
    await Promise.all(
      files
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFile(file, "utf8")),
    )
  ).join("\n");
  validateUnifiedBundle(relativePaths, javascript);
  console.log(
    `Unified product boundary OK: ${manifest.productName} ${manifest.version} uses ${manifest.identifier} with integrated manual learning.`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
