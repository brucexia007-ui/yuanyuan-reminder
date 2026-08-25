import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  findArtifactReferences,
  findPrivacyBoundaryViolations,
  inspectManifest,
  inspectPrototype,
  inspectSessionRecord,
  inspectSyntheticMaterial,
} from "./ux_research_001_materials_policy.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const kitRoot = path.join(projectRoot, "docs", "learning", "ux-research-001");
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

function relativeTo(directory, absolutePath) {
  return path.relative(directory, absolutePath).replaceAll("\\", "/");
}

function canonicalDigest(text) {
  return createHash("sha256").update(text.replace(/\r\n?/gu, "\n"), "utf8").digest("hex");
}

const manifestPath = path.join(kitRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const kitFiles = await filesUnder(kitRoot);
const kitPaths = kitFiles.map((file) => relativeTo(kitRoot, file));
const findings = inspectManifest(manifest, kitPaths);

for (const [relativePath, expectedDigest] of Object.entries(manifest.files || {})) {
  const absolutePath = path.join(kitRoot, relativePath);
  if (!existsSync(absolutePath)) continue;
  const text = await readFile(absolutePath, "utf8");
  const actualDigest = canonicalDigest(text);
  if (actualDigest !== expectedDigest) {
    findings.push({
      path: relativePath,
      rule: "file-digest-mismatch",
      detail: `${actualDigest} != ${expectedDigest}`,
    });
  }
  findings.push(...findPrivacyBoundaryViolations(relativePath, text));
}

for (const material of manifest.synthetic_materials || []) {
  const text = await readFile(path.join(kitRoot, material.path), "utf8");
  findings.push(...inspectSyntheticMaterial(material.path, text, material));
}

const prototypePath = "prototype.html";
findings.push(
  ...inspectPrototype(prototypePath, await readFile(path.join(kitRoot, prototypePath), "utf8")),
);

const sessionPath = "templates/session-record.template.json";
findings.push(
  ...inspectSessionRecord(
    sessionPath,
    JSON.parse(await readFile(path.join(kitRoot, sessionPath), "utf8")),
  ),
);

let artifactFileCount = 0;
if (artifactArgument) {
  const artifactDirectory = path.resolve(projectRoot, artifactArgument);
  if (!existsSync(artifactDirectory) || !(await stat(artifactDirectory)).isDirectory()) {
    throw new Error(`artifact directory does not exist: ${artifactDirectory}`);
  }
  const artifactFiles = await filesUnder(artifactDirectory);
  artifactFileCount = artifactFiles.length;
  for (const absolutePath of artifactFiles) {
    findings.push(
      ...findArtifactReferences(
        relativeTo(projectRoot, absolutePath),
        await readFile(absolutePath),
      ),
    );
  }
}

if (findings.length > 0) {
  console.error("UX-RESEARCH-001 material verification failed:");
  for (const item of findings) {
    console.error(`- ${item.path} (${item.rule}: ${item.detail})`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `UX-RESEARCH-001 materials passed: ${manifest.synthetic_materials.length} synthetic sets, ${kitFiles.length} controlled files; no participant content, file input, persistence, network, or Tauri capability.`,
  );
  if (artifactArgument) {
    console.log(
      `UX-RESEARCH-001 artifact isolation passed: ${artifactFileCount} files (${path.resolve(projectRoot, artifactArgument)}).`,
    );
  }
}
