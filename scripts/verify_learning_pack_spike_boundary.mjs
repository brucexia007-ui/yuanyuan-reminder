import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  findArtifactReferences,
  findForbiddenCrateCapabilities,
  findRuntimeReferences,
  inspectWorkspaceMetadata,
} from "./learning_pack_spike_boundary_policy.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const spikeRoot = path.join(tauriRoot, "crates", "learning-pack-spike");
const artifactFlagIndex = process.argv.indexOf("--artifact-dir");
const artifactArgument = artifactFlagIndex >= 0 ? process.argv[artifactFlagIndex + 1] : null;

if (artifactFlagIndex >= 0 && !artifactArgument) {
  throw new Error("--artifact-dir requires a directory path");
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function cargoMetadata() {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: tauriRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

async function inspectTextFiles(files, inspector) {
  const findings = [];
  for (const absolutePath of files) {
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
    findings.push(...inspector(relativePath, await readFile(absolutePath, "utf8")));
  }
  return findings;
}

async function runtimeFindings() {
  const sourceFiles = [
    ...(await filesUnder(path.join(projectRoot, "src"))),
    ...(await filesUnder(path.join(tauriRoot, "src"))),
  ].filter((file) => /\.(?:json|rs|ts|tsx)$/iu.test(file));
  const configFiles = [
    path.join(projectRoot, "vite.config.ts"),
    path.join(tauriRoot, "build.rs"),
    path.join(tauriRoot, "tauri.conf.json"),
    path.join(tauriRoot, "tauri.learning-preview.conf.json"),
    ...(await filesUnder(path.join(tauriRoot, "capabilities"))),
  ];
  return inspectTextFiles(
    [...sourceFiles, ...configFiles].filter((file) => existsSync(file)),
    findRuntimeReferences,
  );
}

async function crateFindings() {
  const files = (await filesUnder(spikeRoot)).filter((file) => /\.(?:rs|toml)$/iu.test(file));
  return inspectTextFiles(files, findForbiddenCrateCapabilities);
}

async function artifactFindings() {
  if (!artifactArgument) return { directory: null, files: [], findings: [] };
  const directory = path.resolve(projectRoot, artifactArgument);
  if (!existsSync(directory) || !(await stat(directory)).isDirectory()) {
    throw new Error(`artifact directory does not exist: ${directory}`);
  }
  const files = await filesUnder(directory);
  const findings = [];
  for (const absolutePath of files) {
    const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
    findings.push(...findArtifactReferences(relativePath, await readFile(absolutePath)));
  }
  return { directory, files, findings };
}

const metadata = cargoMetadata();
const metadataFindings = inspectWorkspaceMetadata(metadata).map((entry) => ({
  path: "src-tauri/Cargo.toml",
  ...entry,
}));
const [runtime, crate, artifacts] = await Promise.all([
  runtimeFindings(),
  crateFindings(),
  artifactFindings(),
]);
const findings = [...metadataFindings, ...runtime, ...crate, ...artifacts.findings];

if (findings.length > 0) {
  console.error("Pre-GEN parser isolation verification failed:");
  for (const finding of findings) {
    console.error(`- ${finding.path} (${finding.rule}: ${finding.detail})`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Pre-GEN parser isolation passed: excluded from ${metadata.workspace_default_members.length} default workspace members; no application, Tauri, SQLite, network, process-spawn, or publish capability.`,
  );
  if (artifacts.directory) {
    console.log(
      `Pre-GEN parser artifact isolation passed: ${artifacts.files.length} files (${artifacts.directory}).`,
    );
  }
}
