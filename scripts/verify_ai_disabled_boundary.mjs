import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const sourceOnly = process.argv.includes("--source-only");

const forbiddenFrontendTransports = [
  /\bWebSocket\s*\(/u,
  /\bEventSource\s*\(/u,
  /\bXMLHttpRequest\b/u,
  /\bsendBeacon\s*\(/u,
];
const forbiddenRustTransports = [
  /\bstd::net\b/u,
  /\bTcpStream\b/u,
  /\bTcpListener\b/u,
  /\bUdpSocket\b/u,
  /\breqwest::/u,
  /\bhyper::/u,
  /\bureq::/u,
  /tungstenite/u,
];
const forbiddenDirectDependencies = new Set([
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "axios",
  "openai",
  "reqwest",
  "ureq",
  "tungstenite",
  "tokio-tungstenite",
  "async-openai",
]);
const forbiddenBundleMarkers = [
  "yuanyuan-ai",
  "yuanyuan-bridge",
  "runtime-qa",
  "yuanyuan-task-watch-fixture",
  "yuanyuan-runtime-qa-fixture",
  "migration-qa",
  "yuanyuan-database-migration-qa",
  "store-data-lifecycle-qa",
  "yuanyuan-store-data-lifecycle-qa",
  "yuanyuan-pid-reuse-qa",
];
const requiredLicenseResources = {
  "../LICENSE": "licenses/LICENSE.txt",
  "../THIRD_PARTY_NOTICES.md": "licenses/THIRD_PARTY_NOTICES.md",
  "../THIRD_PARTY_LICENSES.txt": "licenses/THIRD_PARTY_LICENSES.txt",
  "../ASSETS_LICENSE.md": "licenses/ASSETS_LICENSE.md",
};

export function validateOfflineCsp(csp) {
  const match = /(?:^|;)\s*connect-src\s+([^;]+)/u.exec(csp ?? "");
  if (!match) throw new Error("production CSP must freeze connect-src");
  const tokens = new Set(match[1].trim().split(/\s+/u));
  const allowed = new Set(["ipc:", "http://ipc.localhost"]);
  for (const token of tokens) {
    if (!allowed.has(token)) {
      throw new Error(`production CSP permits a non-local connection target: ${token}`);
    }
  }
  for (const token of allowed) {
    if (!tokens.has(token)) {
      throw new Error(`production CSP is missing required local IPC target: ${token}`);
    }
  }
}

export function validateBundleDeclaration(bundle) {
  const externalBin = bundle?.externalBin ?? [];
  const resources = bundle?.resources;
  if (
    !Array.isArray(externalBin) ||
    resources === null ||
    typeof resources !== "object" ||
    Array.isArray(resources) ||
    JSON.stringify(Object.keys(resources).sort()) !==
      JSON.stringify(Object.keys(requiredLicenseResources).sort()) ||
    Object.entries(requiredLicenseResources).some(
      ([source, destination]) => resources[source] !== destination,
    )
  ) {
    throw new Error("Tauri bundle must declare only the exact license resource map");
  }
  const serialized = JSON.stringify({ externalBin, resources }).toLowerCase();
  for (const marker of forbiddenBundleMarkers) {
    if (serialized.includes(marker)) {
      throw new Error(`production bundle declares disabled component ${marker}`);
    }
  }
  return { externalBin, resources };
}

export function validateFrontendTransport(relativePath, source) {
  let inspected = source;
  if (relativePath === "src/pet/manifest.ts") {
    inspected = inspected.replace(
      'fetch("/assets/pet/pet-manifest.json")',
      "LOCAL_ASSET_READ",
    );
  }
  if (/\bfetch\s*\(/u.test(inspected)) {
    throw new Error(`${relativePath} contains a production fetch outside the local pet asset`);
  }
  for (const pattern of forbiddenFrontendTransports) {
    if (pattern.test(inspected)) {
      throw new Error(`${relativePath} contains remote transport ${pattern}`);
    }
  }
}

export function validateRustTransport(relativePath, source) {
  for (const pattern of forbiddenRustTransports) {
    if (pattern.test(source)) {
      throw new Error(`${relativePath} contains network transport ${pattern}`);
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

async function sha256(absolutePath) {
  const contents = await readFile(absolutePath);
  return createHash("sha256").update(contents).digest("hex").toUpperCase();
}

async function verifySourceBoundary() {
  const [tauriConfig, packageJson, cargoToml] = await Promise.all([
    readFile(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8"),
  ]);
  const declaration = validateBundleDeclaration(tauriConfig.bundle);
  validateOfflineCsp(tauriConfig.app?.security?.csp);

  const frontendFiles = (await filesUnder(path.join(projectRoot, "src"))).filter(
    (file) =>
      /\.(ts|tsx)$/u.test(file) &&
      !/\.test\.(ts|tsx)$/u.test(file) &&
      !file.endsWith(`${path.sep}vite-env.d.ts`),
  );
  for (const absolutePath of frontendFiles) {
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
    validateFrontendTransport(relativePath, await readFile(absolutePath, "utf8"));
  }

  const stableCoreRoot = path.join(projectRoot, "src-tauri", "src");
  const rustFiles = (await filesUnder(stableCoreRoot)).filter(
    (file) =>
      file.endsWith(".rs") &&
      !file.includes(`${path.sep}bin${path.sep}`) &&
      !file.endsWith(`${path.sep}runtime_qa.rs`),
  );
  for (const absolutePath of rustFiles) {
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
    validateRustTransport(relativePath, await readFile(absolutePath, "utf8"));
  }

  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (forbiddenDirectDependencies.has(dependency)) {
      throw new Error(`production frontend directly depends on network SDK ${dependency}`);
    }
  }
  for (const dependency of forbiddenDirectDependencies) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`^${escaped}\\s*=`, "mu").test(cargoToml)) {
      throw new Error(`stable core directly depends on network SDK ${dependency}`);
    }
  }

  return {
    cspLocalOnly: true,
    externalBinCount: declaration.externalBin.length,
    resourceCount: declaration.resources.length,
    frontendFilesScanned: frontendFiles.length,
    stableCoreRustFilesScanned: rustFiles.length,
    directNetworkSdkCount: 0,
  };
}

async function verifyReleaseBoundary(sourceEvidence) {
  const manifestPath = path.join(releaseRoot, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.installerBoundary?.experimentalSidecarsIncluded !== false
  ) {
    throw new Error("release manifest does not freeze the AI-disabled installer boundary");
  }
  validateBundleDeclaration(manifest.installerBoundary);

  const expectedArtifacts = new Map([
    ["stable_core", "primary_application"],
    ["nsis_installed_core", "installer_payload"],
    ["bridge_prototype", "prototype_excluded"],
    ["ai_prototype", "prototype_excluded"],
    ["nsis_installer", "distribution_installer"],
  ]);
  if (manifest.artifacts?.length !== expectedArtifacts.size) {
    throw new Error("release manifest artifact set is incomplete or expanded");
  }
  for (const artifact of manifest.artifacts) {
    if (expectedArtifacts.get(artifact.id) !== artifact.bundleDisposition) {
      throw new Error(`artifact ${artifact.id} has an invalid bundle disposition`);
    }
    const absolutePath = path.resolve(releaseRoot, artifact.path);
    if (
      absolutePath !== releaseRoot &&
      !absolutePath.startsWith(`${releaseRoot}${path.sep}`)
    ) {
      throw new Error(`artifact ${artifact.id} escapes the release root`);
    }
    if ((await sha256(absolutePath)) !== artifact.sha256) {
      throw new Error(`artifact ${artifact.id} no longer matches the release manifest`);
    }
    expectedArtifacts.delete(artifact.id);
  }
  if (expectedArtifacts.size !== 0) {
    throw new Error("release manifest is missing a required artifact");
  }

  const bundleRoot = path.join(releaseRoot, "bundle");
  const bundledFiles = await filesUnder(bundleRoot);
  const expectedInstaller = manifest.artifacts.find(
    (artifact) => artifact.id === "nsis_installer",
  );
  const expectedInstallerPath = path.resolve(releaseRoot, expectedInstaller.path);
  if (
    bundledFiles.length !== 1 ||
    path.resolve(bundledFiles[0]) !== expectedInstallerPath
  ) {
    throw new Error("release bundle directory contains an undeclared payload");
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "ai_disabled",
    ready: true,
    sourceBoundary: sourceEvidence,
    releaseBoundary: {
      manifestSha256: await sha256(manifestPath),
      stableCoreSha256: manifest.artifacts.find((item) => item.id === "stable_core").sha256,
      nsisInstalledCoreSha256: manifest.artifacts.find(
        (item) => item.id === "nsis_installed_core",
      ).sha256,
      installerSha256: expectedInstaller.sha256,
      aiPrototypeDisposition: "prototype_excluded",
      bridgePrototypeDisposition: "prototype_excluded",
      bundledFileCount: bundledFiles.length,
    },
    runtimeEvidenceRequired: [
      "ai_unavailable_keeps_full_offline_reminder_core_usable",
      "stays hidden when the optional AI binary is not installed",
      "browser backend reports unavailable without Tauri",
    ],
    limitations: [
      "This gate proves the current default installer boundary and offline fallback, not a future enabled AI provider.",
      "Authenticode, security-software, long-run, sleep-resume, and clean-machine evidence remain separate release gates.",
    ],
  };
  const reportPath = path.join(releaseRoot, "ai-disabled-regression.json");
  await mkdir(releaseRoot, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { reportPath, report };
}

async function main() {
  const sourceEvidence = await verifySourceBoundary();
  if (sourceOnly) {
    console.log(
      `AI-disabled source boundary OK: ${sourceEvidence.frontendFilesScanned} frontend and ${sourceEvidence.stableCoreRustFilesScanned} stable-core Rust files; local IPC only.`,
    );
    return;
  }
  const { reportPath } = await verifyReleaseBoundary(sourceEvidence);
  console.log(`AI-disabled release gate OK: ${reportPath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
