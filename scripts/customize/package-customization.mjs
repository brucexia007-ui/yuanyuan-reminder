import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRunState, nextRequiredStep, projectRoot, readJson, runStatePath, sha256 } from "./customization-state.mjs";
import { sourceSnapshot } from "./source-snapshot.mjs";

function runIdArgument() {
  const index = process.argv.indexOf("--run-id");
  if (index < 0 || !process.argv[index + 1]) throw new Error("usage: --run-id <run-id>");
  return process.argv[index + 1];
}

async function fileEvidence(filePath) {
  const bytes = await readFile(filePath);
  return { path: path.relative(projectRoot, filePath).replaceAll("\\", "/"), sha256: sha256(bytes), bytes: bytes.length };
}

async function ordinaryFileBytes(filePath) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`CUSTOMIZATION_PACKAGE_INVALID: expected an ordinary file at ${filePath}`);
  }
  return readFile(filePath);
}

export async function copyFileOrVerify(source, destination) {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    return "created";
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const [sourceBytes, destinationBytes] = await Promise.all([
    ordinaryFileBytes(source),
    ordinaryFileBytes(destination),
  ]);
  if (!sourceBytes.equals(destinationBytes)) {
    throw new Error(`CUSTOMIZATION_PACKAGE_DRIFT: existing delivery file differs at ${destination}`);
  }
  return "reused";
}

export async function writeFileOrVerify(destination, bytes) {
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try {
    await writeFile(destination, expected, { flag: "wx" });
    return "created";
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const existing = await ordinaryFileBytes(destination);
  if (!expected.equals(existing)) {
    throw new Error(`CUSTOMIZATION_PACKAGE_DRIFT: existing delivery file differs at ${destination}`);
  }
  return "reused";
}

export function reusableManifestMatches(existing, expected) {
  if (!Number.isFinite(Date.parse(existing?.generatedAt))) return false;
  return JSON.stringify({ ...existing, generatedAt: expected.generatedAt }) === JSON.stringify(expected);
}

async function main() {
  const runId = runIdArgument();
  const state = await loadRunState(runId);
  if (nextRequiredStep(state)?.id !== "packaging") throw new Error("CUSTOMIZATION_STEP_ORDER: packaging is not the current step");
  const verificationArtifact = state.artifacts.find((entry) => entry.role === "verification_report");
  if (!verificationArtifact) throw new Error("CUSTOMIZATION_EVIDENCE_INVALID: verification report is missing");
  const verificationPath = path.join(projectRoot, verificationArtifact.path);
  const [verificationBytes, version, brand, cargo] = await Promise.all([
    readFile(verificationPath),
    readJson(path.join(projectRoot, "product-version.json")),
    readJson(path.join(projectRoot, "product-brand.json")),
    readFile(path.join(projectRoot, "src-tauri", "Cargo.toml"), "utf8"),
  ]);
  if (verificationBytes.length !== verificationArtifact.bytes || sha256(verificationBytes) !== verificationArtifact.sha256) {
    throw new Error("CUSTOMIZATION_SOURCE_DRIFT: verification report changed before packaging");
  }
  const verification = JSON.parse(verificationBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const snapshot = await sourceSnapshot(projectRoot, state.source.resolvedCommit);
  if (snapshot.sha256 !== verification.sourceSnapshotSha256) throw new Error("CUSTOMIZATION_SOURCE_DRIFT: source changed after verification");
  const cargoName = cargo.match(/^name = "([a-z0-9-]+)"$/mu)?.[1];
  if (!cargoName) throw new Error("CUSTOMIZATION_PACKAGE_INVALID: Cargo package name was not found");
  const installerSource = path.join(projectRoot, "src-tauri", "target", "release", "bundle", "nsis", `${brand.application.displayName}_${version.version}_x64-setup.exe`);
  const portableSource = path.join(projectRoot, "src-tauri", "target", "release", `${cargoName}.exe`);
  for (const source of [installerSource, portableSource]) {
    const sourceLink = await lstat(source);
    if (sourceLink.isSymbolicLink() || !(await stat(source)).isFile()) throw new Error(`CUSTOMIZATION_PACKAGE_INVALID: missing ordinary file ${path.relative(projectRoot, source)}`);
  }
  const portableSourceBytes = await readFile(portableSource);
  if (
    portableSourceBytes.indexOf(Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii")) < 0
    || portableSourceBytes.indexOf(Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii")) >= 0
  ) throw new Error("CUSTOMIZATION_PACKAGE_INVALID: portable source does not have the Tauri UNK bundle identity");
  const deliveryRoot = path.join(path.dirname(runStatePath(runId)), "delivery");
  await mkdir(deliveryRoot, { recursive: true });
  const installer = path.join(deliveryRoot, `${brand.artifacts.installerBaseName}_${version.version}_x64-setup.exe`);
  const portable = path.join(deliveryRoot, `${brand.artifacts.portableBaseName}_${version.version}_windows-x64-portable.exe`);
  await copyFileOrVerify(installerSource, installer);
  await copyFileOrVerify(portableSource, portable);
  const [installerEvidence, portableEvidence] = await Promise.all([fileEvidence(installer), fileEvidence(portable)]);
  const checksums = path.join(deliveryRoot, "SHA256SUMS.txt");
  await writeFileOrVerify(
    checksums,
    `${installerEvidence.sha256}  ${path.basename(installer)}\n${portableEvidence.sha256}  ${path.basename(portable)}\n`,
  );
  const checksumsEvidence = await fileEvidence(checksums);
  const manifest = {
    schemaVersion: 1,
    profile: "yuanyuan-customization-delivery",
    generatedAt: new Date().toISOString(),
    runId,
    baselineCommit: state.source.resolvedCommit,
    sourceSnapshotSha256: snapshot.sha256,
    productVersion: version.version,
    brandIdentifier: brand.application.identifier,
    artifacts: { installer: installerEvidence, portable: portableEvidence, checksums: checksumsEvidence },
  };
  const manifestPath = path.join(deliveryRoot, "delivery-manifest.json");
  let recordedManifest = manifest;
  try {
    const existingBytes = await ordinaryFileBytes(manifestPath);
    recordedManifest = JSON.parse(existingBytes.toString("utf8").replace(/^\uFEFF/u, ""));
    if (!reusableManifestMatches(recordedManifest, manifest)) {
      throw new Error(`CUSTOMIZATION_PACKAGE_DRIFT: existing delivery manifest differs at ${manifestPath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFileOrVerify(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    runId,
    deliveryDirectory: path.relative(projectRoot, deliveryRoot).replaceAll("\\", "/"),
    completeStepArguments: [
      `--artifact installer=${installerEvidence.path}`,
      `--artifact portable=${portableEvidence.path}`,
      `--artifact checksums=${checksumsEvidence.path}`,
      `--artifact delivery_manifest=${path.relative(projectRoot, manifestPath).replaceAll("\\", "/")}`,
    ],
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
