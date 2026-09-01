import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { selectStableGeneratedAt } from "./release_manifest_stability.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const outputPath = path.join(releaseRoot, "release-manifest.json");

const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const tauriConfig = JSON.parse(
  await readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);
const productBrand = JSON.parse(
  await readFile(path.join(projectRoot, "product-brand.json"), "utf8"),
);

if (
  productBrand.application?.displayName !== tauriConfig.productName
  || productBrand.artifacts?.installerBaseName !== tauriConfig.productName
) {
  throw new Error("release manifest requires synchronized product brand and Tauri names");
}

const artifactDefinitions = [
  {
    id: "stable_core",
    relativePath: "yuanyuan-reminder.exe",
    bundleDisposition: "primary_application",
  },
  {
    id: "nsis_installed_core",
    relativePath: path.join("nsis-payload", "yuanyuan-reminder.exe"),
    bundleDisposition: "installer_payload",
  },
  {
    id: "bridge_prototype",
    relativePath: "yuanyuan-bridge.exe",
    bundleDisposition: "prototype_excluded",
  },
  {
    id: "ai_prototype",
    relativePath: "yuanyuan-ai.exe",
    bundleDisposition: "prototype_excluded",
  },
  {
    id: "nsis_installer",
    relativePath: path.join(
      "bundle",
      "nsis",
      `${productBrand.artifacts.installerBaseName}_${packageJson.version}_x64-setup.exe`,
    ),
    bundleDisposition: "distribution_installer",
  },
];

async function describeArtifact(definition) {
  const absolutePath = path.join(releaseRoot, definition.relativePath);
  const [contents, metadata] = await Promise.all([
    readFile(absolutePath),
    stat(absolutePath),
  ]);
  return {
    id: definition.id,
    path: definition.relativePath.replaceAll("\\", "/"),
    bytes: metadata.size,
    sha256: createHash("sha256").update(contents).digest("hex").toUpperCase(),
    bundleDisposition: definition.bundleDisposition,
  };
}

const bundle = tauriConfig.bundle ?? {};
const externalBin = bundle.externalBin ?? [];
const resources = bundle.resources ?? [];
const bundleDeclaration = JSON.stringify({ externalBin, resources }).toLowerCase();
if (
  bundleDeclaration.includes("yuanyuan-ai") ||
  bundleDeclaration.includes("yuanyuan-bridge") ||
  bundleDeclaration.includes("runtime-qa") ||
  bundleDeclaration.includes("yuanyuan-task-watch-fixture") ||
  bundleDeclaration.includes("migration-qa") ||
  bundleDeclaration.includes("yuanyuan-database-migration-qa") ||
  bundleDeclaration.includes("yuanyuan-pid-reuse-qa")
) {
  throw new Error("experimental sidecars must remain excluded from the installer");
}

const manifestMaterial = {
  schemaVersion: 1,
  productName: tauriConfig.productName,
  productVersion: packageJson.version,
  signatureVerification: "not_performed",
  installerBoundary: {
    externalBin,
    resources,
    experimentalSidecarsIncluded: false,
  },
  artifacts: await Promise.all(artifactDefinitions.map(describeArtifact)),
};

let existingManifest = null;
try {
  existingManifest = JSON.parse((await readFile(outputPath, "utf8")).replace(/^\uFEFF/, ""));
} catch {
  // A missing or malformed prior manifest cannot contribute stable identity.
}
const generatedAt = selectStableGeneratedAt(
  existingManifest,
  manifestMaterial,
  new Date().toISOString(),
);
const manifest = {
  schemaVersion: manifestMaterial.schemaVersion,
  productName: manifestMaterial.productName,
  productVersion: manifestMaterial.productVersion,
  generatedAt,
  signatureVerification: manifestMaterial.signatureVerification,
  installerBoundary: manifestMaterial.installerBoundary,
  artifacts: manifestMaterial.artifacts,
};

await mkdir(releaseRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Release manifest written: ${outputPath}`);
