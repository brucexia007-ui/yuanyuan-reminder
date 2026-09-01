import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_STAGE_MARKER = ".community-stable-e2e-stage-v1";
export const E2E_STAGE_MARKER_CONTENTS = "COMMUNITY_STABLE_E2E_STAGE_V1\n";
export const E2E_STAGE_MANIFEST = "community-stable-e2e-stage.json";

const scriptProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fail(message) {
  throw new Error(`community stable E2E stage: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function readJson(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")),
  };
}

function assertInside(parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must be a new child of ${parent}`);
  }
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

function validateSourceMetadata(source) {
  if (!source || !/^[0-9a-f]{40}$/u.test(source.commit ?? "")) {
    fail("source commit must be a full lowercase Git hash");
  }
  if (typeof source.branch !== "string" || source.branch.length === 0) {
    fail("source branch is required");
  }
  if (typeof source.dirty !== "boolean") {
    fail("source dirty state is required");
  }
}

export async function prepareCommunityStableE2eStage({
  projectRoot = scriptProjectRoot,
  releaseRoot = path.join(projectRoot, "src-tauri", "target", "release"),
  stageRoot,
  sourceMetadata,
  buildStartedAt,
  createdAt = new Date().toISOString(),
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const targetRoot = path.join(resolvedProjectRoot, "src-tauri", "target");
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const releaseRelative = path.relative(targetRoot, resolvedReleaseRoot);
  if (
    !releaseRelative ||
    releaseRelative.startsWith("..") ||
    path.isAbsolute(releaseRelative)
  ) {
    fail("release root must stay inside src-tauri/target");
  }

  const [productVersion, productBrand, tauriConfig, packageJson] = await Promise.all([
    readJson(path.join(resolvedProjectRoot, "product-version.json")),
    readJson(path.join(resolvedProjectRoot, "product-brand.json")),
    readJson(path.join(resolvedProjectRoot, "src-tauri", "tauri.conf.json")),
    readJson(path.join(resolvedProjectRoot, "package.json")),
  ]);
  const product = productVersion.value;
  const brand = productBrand.value;
  const tauri = tauriConfig.value;
  const pkg = packageJson.value;
  if (
    product.version !== pkg.version ||
    product.version !== tauri.version ||
    product.productName !== tauri.productName ||
    product.productName !== brand.application?.displayName ||
    product.productName !== brand.artifacts?.installerBaseName ||
    product.identifier !== tauri.identifier ||
    product.identifier !== brand.application?.identifier ||
    pkg.name !== brand.application?.packageName
  ) {
    fail("product version, brand, package, and Tauri identity must match exactly");
  }

  const applicationFileName = "yuanyuan-reminder.exe";
  const installerFileName = `${brand.artifacts.installerBaseName}_${product.version}_x64-setup.exe`;
  const applicationPath = path.join(resolvedReleaseRoot, applicationFileName);
  const installerDirectory = path.join(resolvedReleaseRoot, "bundle", "nsis");
  const installerPath = path.join(installerDirectory, installerFileName);
  const parsedBuildStartedAt = Date.parse(buildStartedAt ?? "");
  if (!Number.isFinite(parsedBuildStartedAt)) {
    fail("a valid buildStartedAt timestamp from the controlled Tauri build is required");
  }
  const [applicationBytes, installerBytes, installerEntries, installerStat] = await Promise.all([
    readFile(applicationPath),
    readFile(installerPath),
    readdir(installerDirectory, { withFileTypes: true }),
    stat(installerPath),
  ]);
  if (installerStat.mtimeMs < parsedBuildStartedAt - 5_000) {
    fail("exact branded installer predates the controlled Tauri build");
  }
  const versionSuffix = `_${product.version}_x64-setup.exe`;
  const versionMatchedInstallerNames = installerEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(versionSuffix))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const source = sourceMetadata ?? collectGitSource(resolvedProjectRoot);
  validateSourceMetadata(source);
  const stageBase = path.join(targetRoot, "community-stable-e2e-stages");
  const defaultLeaf = `${createdAt.replace(/[^0-9]/gu, "").slice(0, 17)}-${sha256(installerBytes).slice(0, 12)}`;
  const resolvedStageRoot = path.resolve(stageRoot ?? path.join(stageBase, defaultLeaf));
  assertInside(stageBase, resolvedStageRoot, "stage root");

  const manifest = {
    schemaVersion: 1,
    createdAt,
    product: {
      name: product.productName,
      version: product.version,
      identifier: product.identifier,
      packageName: pkg.name,
    },
    source,
    build: {
      startedAt: new Date(parsedBuildStartedAt).toISOString(),
      installerWrittenAt: installerStat.mtime.toISOString(),
    },
    sourceRelease: {
      versionMatchedInstallerNames,
      selectedInstallerFileName: installerFileName,
    },
    artifacts: {
      application: {
        fileName: applicationFileName,
        bytes: applicationBytes.length,
        sha256: sha256(applicationBytes),
      },
      installer: {
        fileName: installerFileName,
        bytes: installerBytes.length,
        sha256: sha256(installerBytes),
      },
    },
    configBindings: {
      productVersionSha256: sha256(productVersion.bytes),
      productBrandSha256: sha256(productBrand.bytes),
      tauriConfigSha256: sha256(tauriConfig.bytes),
      packageJsonSha256: sha256(packageJson.bytes),
    },
  };

  let created = false;
  try {
    await mkdir(stageBase, { recursive: true });
    await mkdir(resolvedStageRoot);
    created = true;
    await writeFile(
      path.join(resolvedStageRoot, E2E_STAGE_MARKER),
      E2E_STAGE_MARKER_CONTENTS,
      { flag: "wx" },
    );
    await mkdir(path.join(resolvedStageRoot, "bundle", "nsis"), { recursive: true });
    await copyFile(applicationPath, path.join(resolvedStageRoot, applicationFileName));
    await copyFile(
      installerPath,
      path.join(resolvedStageRoot, "bundle", "nsis", installerFileName),
    );
    await writeFile(
      path.join(resolvedStageRoot, E2E_STAGE_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );

    const stagedInstallers = await readdir(
      path.join(resolvedStageRoot, "bundle", "nsis"),
    );
    if (stagedInstallers.length !== 1 || stagedInstallers[0] !== installerFileName) {
      fail("staged NSIS directory must contain only the exact branded installer");
    }
    const [stagedApplication, stagedInstaller] = await Promise.all([
      readFile(path.join(resolvedStageRoot, applicationFileName)),
      readFile(path.join(resolvedStageRoot, "bundle", "nsis", installerFileName)),
    ]);
    if (
      sha256(stagedApplication) !== manifest.artifacts.application.sha256 ||
      sha256(stagedInstaller) !== manifest.artifacts.installer.sha256
    ) {
      fail("staged artifact hash changed during copy");
    }
    return { stageRoot: resolvedStageRoot, manifest };
  } catch (error) {
    if (created) {
      try {
        const marker = await readFile(path.join(resolvedStageRoot, E2E_STAGE_MARKER), "utf8");
        if (marker === E2E_STAGE_MARKER_CONTENTS) {
          await rm(resolvedStageRoot, { recursive: true, force: true });
        }
      } catch {
        // Never recursively remove a directory without the exact owned marker.
      }
    }
    if (error?.code === "EEXIST") {
      fail("stage directory already exists; refusing to merge or overwrite it");
    }
    throw error;
  }
}

function parseArguments(argv) {
  const result = {};
  const allowed = new Map([
    ["--release-root", "releaseRoot"],
    ["--stage-root", "stageRoot"],
    ["--build-started-at", "buildStartedAt"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = allowed.get(argv[index]);
    const value = argv[index + 1];
    if (!key || !value || Object.hasOwn(result, key)) {
      fail("usage: node scripts/prepare_community_stable_e2e_stage.mjs --build-started-at <ISO timestamp> [--release-root <path>] [--stage-root <path>]");
    }
    result[key] = value;
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await prepareCommunityStableE2eStage(options);
  process.stdout.write(`Community stable E2E stage created: ${result.stageRoot}\n`);
  process.stdout.write(`Installer SHA-256: ${result.manifest.artifacts.installer.sha256}\n`);
  process.stdout.write(
    `Source: ${result.manifest.source.commit} (${result.manifest.source.dirty ? "dirty development candidate" : "clean formal candidate"})\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
