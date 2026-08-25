import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const paths = {
  manifest: path.join(projectRoot, "product-version.json"),
  packageJson: path.join(projectRoot, "package.json"),
  packageLock: path.join(projectRoot, "package-lock.json"),
  cargoToml: path.join(projectRoot, "src-tauri", "Cargo.toml"),
  cargoLock: path.join(projectRoot, "src-tauri", "Cargo.lock"),
  tauriConfig: path.join(projectRoot, "src-tauri", "tauri.conf.json"),
};

const semverPattern = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u;

export function validateProductManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.productName !== "圆圆提醒" ||
    manifest.identifier !== "com.yuanyuan.reminder" ||
    typeof manifest.version !== "string" ||
    !semverPattern.test(manifest.version) ||
    manifest.releaseTrain !== "unified-product" ||
    !["development", "alpha", "beta", "rc", "stable"].includes(manifest.channel) ||
    manifest.capabilities?.learningIntegrated !== true ||
    manifest.capabilities?.automaticLearningInvitationsDefault !== false ||
    manifest.capabilities?.bundledPersonalLearningContent !== false
  ) {
    throw new Error("product-version.json does not satisfy the unified product contract");
  }
  const legacy = manifest.legacyEditions;
  if (
    !Array.isArray(legacy) ||
    legacy.join("\n") !==
      [
        "com.yuanyuan.reminder.learning-preview",
        "com.yuanyuan.reminder.learning-personal",
      ].join("\n")
  ) {
    throw new Error("legacy edition identifiers must remain exact and ordered");
  }
}

function packageVersionFromCargo(cargoToml) {
  const packageSection = /\[package\]([\s\S]*?)(?=\n\[|$)/u.exec(cargoToml)?.[1] ?? "";
  return /^version\s*=\s*"([^"]+)"\s*$/mu.exec(packageSection)?.[1] ?? null;
}

function packageVersionFromCargoLock(cargoLock) {
  const entry = /\[\[package\]\]\s*\nname = "yuanyuan-reminder"\s*\nversion = "([^"]+)"/u.exec(
    cargoLock,
  );
  return entry?.[1] ?? null;
}

export function collectProductVersionDrift({
  manifest,
  packageJson,
  packageLock,
  cargoToml,
  cargoLock,
  tauriConfig,
}) {
  validateProductManifest(manifest);
  const expected = manifest.version;
  const observations = [
    ["package.json", packageJson.version],
    ["package-lock.json", packageLock.version],
    ["package-lock.json packages['']", packageLock.packages?.[""]?.version],
    ["src-tauri/Cargo.toml", packageVersionFromCargo(cargoToml)],
    ["src-tauri/Cargo.lock", packageVersionFromCargoLock(cargoLock)],
    ["src-tauri/tauri.conf.json", tauriConfig.version],
  ];
  const drift = observations
    .filter(([, actual]) => actual !== expected)
    .map(([source, actual]) => ({ source, expected, actual: actual ?? null }));
  if (packageJson.name !== "yuanyuan-reminder") {
    drift.push({ source: "package.json name", expected: "yuanyuan-reminder", actual: packageJson.name });
  }
  if (tauriConfig.productName !== manifest.productName) {
    drift.push({
      source: "src-tauri/tauri.conf.json productName",
      expected: manifest.productName,
      actual: tauriConfig.productName ?? null,
    });
  }
  if (tauriConfig.identifier !== manifest.identifier) {
    drift.push({
      source: "src-tauri/tauri.conf.json identifier",
      expected: manifest.identifier,
      actual: tauriConfig.identifier ?? null,
    });
  }
  return drift;
}

function replaceCargoPackageVersion(source, version) {
  let insidePackage = false;
  let replaced = false;
  const lines = source.split(/(?<=\n)/u).map((line) => {
    if (/^\[package\]\s*$/u.test(line.trimEnd())) {
      insidePackage = true;
      return line;
    }
    if (insidePackage && /^\[/u.test(line.trimStart())) insidePackage = false;
    if (insidePackage && !replaced && /^version\s*=\s*"[^"]+"/u.test(line)) {
      replaced = true;
      return line.replace(/"[^"]+"/u, `"${version}"`);
    }
    return line;
  });
  if (!replaced) throw new Error("Cargo.toml package version was not found");
  return lines.join("");
}

function replaceCargoLockVersion(source, version) {
  const pattern = /(\[\[package\]\]\s*\nname = "yuanyuan-reminder"\s*\nversion = ")[^"]+("\s*\n)/u;
  if (!pattern.test(source)) throw new Error("Cargo.lock yuanyuan-reminder entry was not found");
  return source.replace(pattern, `$1${version}$2`);
}

export function synchronizeProductVersionSources(sources) {
  validateProductManifest(sources.manifest);
  const version = sources.manifest.version;
  const packageJson = { ...sources.packageJson, version };
  const packageLock = {
    ...sources.packageLock,
    version,
    packages: {
      ...sources.packageLock.packages,
      "": { ...sources.packageLock.packages?.[""], version },
    },
  };
  const tauriConfig = {
    ...sources.tauriConfig,
    productName: sources.manifest.productName,
    version,
    identifier: sources.manifest.identifier,
  };
  return {
    packageJson,
    packageLock,
    cargoToml: replaceCargoPackageVersion(sources.cargoToml, version),
    cargoLock: replaceCargoLockVersion(sources.cargoLock, version),
    tauriConfig,
  };
}

async function readSources() {
  const [manifest, packageJson, packageLock, cargoToml, cargoLock, tauriConfig] =
    await Promise.all([
      readFile(paths.manifest, "utf8").then(JSON.parse),
      readFile(paths.packageJson, "utf8").then(JSON.parse),
      readFile(paths.packageLock, "utf8").then(JSON.parse),
      readFile(paths.cargoToml, "utf8"),
      readFile(paths.cargoLock, "utf8"),
      readFile(paths.tauriConfig, "utf8").then(JSON.parse),
    ]);
  return { manifest, packageJson, packageLock, cargoToml, cargoLock, tauriConfig };
}

async function main() {
  const write = process.argv.includes("--write");
  const sources = await readSources();
  if (write) {
    const synchronized = synchronizeProductVersionSources(sources);
    await Promise.all([
      writeFile(paths.packageJson, `${JSON.stringify(synchronized.packageJson, null, 2)}\n`),
      writeFile(paths.packageLock, `${JSON.stringify(synchronized.packageLock, null, 2)}\n`),
      writeFile(paths.cargoToml, synchronized.cargoToml),
      writeFile(paths.cargoLock, synchronized.cargoLock),
      writeFile(paths.tauriConfig, `${JSON.stringify(synchronized.tauriConfig, null, 2)}\n`),
    ]);
  }
  const checked = write ? await readSources() : sources;
  const drift = collectProductVersionDrift(checked);
  if (drift.length > 0) {
    for (const finding of drift) {
      console.error(
        `${finding.source}: expected ${JSON.stringify(finding.expected)}, found ${JSON.stringify(finding.actual)}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Unified product version OK: ${checked.manifest.productName} ${checked.manifest.version} (${checked.manifest.identifier}).`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
