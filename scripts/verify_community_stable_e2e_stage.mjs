import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  E2E_STAGE_MANIFEST,
  E2E_STAGE_MARKER,
  E2E_STAGE_MARKER_CONTENTS,
} from "./prepare_community_stable_e2e_stage.mjs";

const scriptProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fail(message) {
  throw new Error(`community stable E2E stage verification: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields must be exact`);
  }
}

async function readJson(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")),
  };
}

function collectGitSource(projectRoot) {
  function git(args) {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  return {
    commit: git(["rev-parse", "HEAD"]).toLowerCase(),
    branch: git(["branch", "--show-current"]),
    dirty: git(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0,
  };
}

function assertExactEntries(actual, expected, label) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    fail(`${label} contains unexpected or missing files`);
  }
}

export async function verifyCommunityStableE2eStage({
  projectRoot = scriptProjectRoot,
  stageRoot,
  sourceMetadata,
} = {}) {
  if (!stageRoot) fail("stageRoot is required");
  const resolvedProjectRoot = path.resolve(projectRoot);
  const stageBase = path.join(
    resolvedProjectRoot,
    "src-tauri",
    "target",
    "community-stable-e2e-stages",
  );
  const resolvedStageRoot = path.resolve(stageRoot);
  const stageRelative = path.relative(stageBase, resolvedStageRoot);
  if (!stageRelative || stageRelative.startsWith("..") || path.isAbsolute(stageRelative)) {
    fail("stage root must be a child of the owned E2E stage directory");
  }

  const [marker, manifestDocument, productVersion, productBrand, tauriConfig, packageJson] =
    await Promise.all([
      readFile(path.join(resolvedStageRoot, E2E_STAGE_MARKER), "utf8"),
      readJson(path.join(resolvedStageRoot, E2E_STAGE_MANIFEST)),
      readJson(path.join(resolvedProjectRoot, "product-version.json")),
      readJson(path.join(resolvedProjectRoot, "product-brand.json")),
      readJson(path.join(resolvedProjectRoot, "src-tauri", "tauri.conf.json")),
      readJson(path.join(resolvedProjectRoot, "package.json")),
    ]);
  if (marker !== E2E_STAGE_MARKER_CONTENTS) fail("owned marker is missing or changed");

  const manifest = manifestDocument.value;
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "createdAt",
      "product",
      "source",
      "build",
      "sourceRelease",
      "artifacts",
      "configBindings",
    ],
    "manifest",
  );
  if (manifest.schemaVersion !== 1) fail("schemaVersion must equal 1");
  exactKeys(manifest.product, ["name", "version", "identifier", "packageName"], "product");
  exactKeys(manifest.source, ["commit", "branch", "dirty"], "source");
  exactKeys(manifest.build, ["startedAt", "installerWrittenAt"], "build");
  exactKeys(
    manifest.sourceRelease,
    ["versionMatchedInstallerNames", "selectedInstallerFileName"],
    "sourceRelease",
  );
  exactKeys(manifest.artifacts, ["application", "installer"], "artifacts");
  exactKeys(manifest.artifacts.application, ["fileName", "bytes", "sha256"], "application");
  exactKeys(manifest.artifacts.installer, ["fileName", "bytes", "sha256"], "installer");
  exactKeys(
    manifest.configBindings,
    [
      "productVersionSha256",
      "productBrandSha256",
      "tauriConfigSha256",
      "packageJsonSha256",
    ],
    "configBindings",
  );

  const product = productVersion.value;
  const brand = productBrand.value;
  const tauri = tauriConfig.value;
  const pkg = packageJson.value;
  const expectedProduct = {
    name: product.productName,
    version: product.version,
    identifier: product.identifier,
    packageName: pkg.name,
  };
  if (
    JSON.stringify(manifest.product) !== JSON.stringify(expectedProduct) ||
    product.version !== pkg.version ||
    product.version !== tauri.version ||
    product.productName !== tauri.productName ||
    product.productName !== brand.application?.displayName ||
    product.productName !== brand.artifacts?.installerBaseName ||
    product.identifier !== tauri.identifier ||
    product.identifier !== brand.application?.identifier ||
    pkg.name !== brand.application?.packageName
  ) {
    fail("product identity or current configuration binding drifted");
  }

  const expectedBindings = {
    productVersionSha256: sha256(productVersion.bytes),
    productBrandSha256: sha256(productBrand.bytes),
    tauriConfigSha256: sha256(tauriConfig.bytes),
    packageJsonSha256: sha256(packageJson.bytes),
  };
  if (JSON.stringify(manifest.configBindings) !== JSON.stringify(expectedBindings)) {
    fail("configuration bytes changed after staging");
  }

  const currentSource = sourceMetadata ?? collectGitSource(resolvedProjectRoot);
  if (JSON.stringify(manifest.source) !== JSON.stringify(currentSource)) {
    fail("Git source state changed after staging");
  }
  if (
    !/^[0-9a-f]{40}$/u.test(manifest.source.commit) ||
    typeof manifest.source.branch !== "string" ||
    manifest.source.branch.length === 0 ||
    typeof manifest.source.dirty !== "boolean"
  ) {
    fail("source metadata is invalid");
  }

  const createdAt = Date.parse(manifest.createdAt);
  const buildStartedAt = Date.parse(manifest.build.startedAt);
  const installerWrittenAt = Date.parse(manifest.build.installerWrittenAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(buildStartedAt) ||
    !Number.isFinite(installerWrittenAt) ||
    installerWrittenAt < buildStartedAt - 5_000 ||
    createdAt < buildStartedAt
  ) {
    fail("build receipt timestamps are invalid");
  }

  const applicationFileName = "yuanyuan-reminder.exe";
  const installerFileName = `${brand.artifacts.installerBaseName}_${product.version}_x64-setup.exe`;
  if (
    manifest.artifacts.application.fileName !== applicationFileName ||
    manifest.artifacts.installer.fileName !== installerFileName ||
    manifest.sourceRelease.selectedInstallerFileName !== installerFileName
  ) {
    fail("artifact file names do not match the exact branded candidate");
  }
  const versionNames = manifest.sourceRelease.versionMatchedInstallerNames;
  if (!Array.isArray(versionNames) || versionNames.length === 0) {
    fail("source installer inventory is required");
  }
  const sortedNames = [...versionNames].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    JSON.stringify(versionNames) !== JSON.stringify(sortedNames) ||
    new Set(versionNames).size !== versionNames.length ||
    !versionNames.includes(installerFileName) ||
    versionNames.some(
      (name) =>
        typeof name !== "string" ||
        !name.endsWith(`_${product.version}_x64-setup.exe`) ||
        path.basename(name) !== name,
    )
  ) {
    fail("source installer inventory is malformed");
  }

  const [applicationBytes, installerBytes, rootEntries, bundleEntries, nsisEntries] =
    await Promise.all([
      readFile(path.join(resolvedStageRoot, applicationFileName)),
      readFile(path.join(resolvedStageRoot, "bundle", "nsis", installerFileName)),
      readdir(resolvedStageRoot),
      readdir(path.join(resolvedStageRoot, "bundle")),
      readdir(path.join(resolvedStageRoot, "bundle", "nsis")),
    ]);
  assertExactEntries(
    rootEntries,
    [E2E_STAGE_MARKER, E2E_STAGE_MANIFEST, applicationFileName, "bundle"],
    "stage root",
  );
  assertExactEntries(bundleEntries, ["nsis"], "stage bundle directory");
  assertExactEntries(nsisEntries, [installerFileName], "stage NSIS directory");
  for (const [label, bytes, record] of [
    ["application", applicationBytes, manifest.artifacts.application],
    ["installer", installerBytes, manifest.artifacts.installer],
  ]) {
    if (
      !Number.isSafeInteger(record.bytes) ||
      record.bytes <= 0 ||
      record.bytes !== bytes.length ||
      !/^[A-F0-9]{64}$/u.test(record.sha256) ||
      record.sha256 !== sha256(bytes)
    ) {
      fail(`${label} bytes or SHA-256 changed after staging`);
    }
  }

  return {
    stageRoot: resolvedStageRoot,
    manifest,
    manifestSha256: sha256(manifestDocument.bytes),
  };
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--stage-root" || !argv[1]) {
    fail("usage: node scripts/verify_community_stable_e2e_stage.mjs --stage-root <path>");
  }
  return { stageRoot: argv[1] };
}

async function main() {
  const result = await verifyCommunityStableE2eStage(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Community stable E2E stage verified: ${result.stageRoot}\n`);
  process.stdout.write(`Stage manifest SHA-256: ${result.manifestSha256}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
