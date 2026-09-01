import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  findForbiddenArtifactPaths,
  findForbiddenArtifactTextMarkers,
  normalizeRepositoryPath,
} from "./fragment_learning_boundary_policy.mjs";

export const UNIFIED_CANDIDATE_SCHEMA_VERSION = 1;
export const UNIFIED_CANDIDATE_MARKER = ".yuanyuan-unified-candidate-v1";
export const UNIFIED_CANDIDATE_MANIFEST = "candidate-manifest.json";
export const UNIFIED_CANDIDATE_CHECKSUMS = "SHA256SUMS.txt";
export const UNIFIED_CANDIDATE_MARKER_CONTENTS = "yuanyuan-unified-candidate-v1\n";

export class UnifiedCandidateContractError extends Error {}

function fail(message) {
  throw new UnifiedCandidateContractError(message);
}

export function sha256(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("SHA-256 input must be bytes");
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    fail(`${label} fields do not match the unified candidate contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function canonicalCommit(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    fail("source.commit must be a canonical lowercase Git commit ID");
  }
}

function validTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO timestamp`);
  }
}

export function unifiedInstallerFileName(product) {
  if (
    typeof product?.name !== "string" ||
    product.name.length < 1 ||
    product.name.length > 80 ||
    /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(product.name) ||
    typeof product?.identifier !== "string" ||
    !/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*){2,}$/u.test(product.identifier) ||
    typeof product?.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(product.version)
  ) {
    fail("product must identify a valid unified release train");
  }
  return `${product.name}_${product.version}_x64-setup.exe`;
}

export function unifiedCandidateId(sourceCommit, artifactSha256) {
  canonicalCommit(sourceCommit);
  canonicalHash(artifactSha256, "artifactSha256");
  return `${sourceCommit.slice(0, 12)}-${artifactSha256.slice(0, 12).toLowerCase()}`;
}

export function renderUnifiedCandidateChecksums(manifest) {
  validateUnifiedCandidateManifest(manifest);
  return `${manifest.artifact.sha256} *${manifest.artifact.fileName}\n`;
}

export function buildUnifiedCandidateManifest(
  {
    product,
    source,
    artifactBytes,
    productAuthorityBytes,
    tauriConfigBytes,
    packageLockBytes,
    cargoLockBytes,
  },
  { createdAt = new Date().toISOString() } = {},
) {
  if (
    !Buffer.isBuffer(artifactBytes) ||
    !Buffer.isBuffer(productAuthorityBytes) ||
    !Buffer.isBuffer(tauriConfigBytes) ||
    !Buffer.isBuffer(packageLockBytes) ||
    !Buffer.isBuffer(cargoLockBytes)
  ) {
    fail("candidate artifact and binding inputs must be bytes");
  }
  const fileName = unifiedInstallerFileName(product);
  const artifactSha256 = sha256(artifactBytes);
  const manifest = {
    schemaVersion: UNIFIED_CANDIDATE_SCHEMA_VERSION,
    candidateId: unifiedCandidateId(source?.commit, artifactSha256),
    createdAt,
    product: {
      name: product.name,
      version: product.version,
      identifier: product.identifier,
    },
    source: {
      commit: source.commit,
      branch: source.branch,
      commitTimestamp: source.commitTimestamp,
      worktreeClean: source.worktreeClean,
    },
    artifact: {
      fileName,
      buildPath: `src-tauri/target/release/bundle/nsis/${fileName}`,
      bytes: artifactBytes.length,
      sha256: artifactSha256,
      kind: "nsis-installer",
    },
    bindings: {
      productAuthoritySha256: sha256(productAuthorityBytes),
      tauriConfigSha256: sha256(tauriConfigBytes),
      packageLockSha256: sha256(packageLockBytes),
      cargoLockSha256: sha256(cargoLockBytes),
    },
    contentPolicy: {
      learning: "generic-only",
      bundledCorpus: "none",
      userOwnedLegacyData: "explicit-migration-only",
    },
    signature: {
      status: "not-checked",
    },
    releaseStatus: source.branch === "main" ? "candidate-not-approved" : "internal-only-non-main",
  };
  validateUnifiedCandidateManifest(manifest);
  return manifest;
}

export function validateUnifiedCandidateManifest(manifest) {
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "candidateId",
      "createdAt",
      "product",
      "source",
      "artifact",
      "bindings",
      "contentPolicy",
      "signature",
      "releaseStatus",
    ],
    "manifest",
  );
  if (manifest.schemaVersion !== UNIFIED_CANDIDATE_SCHEMA_VERSION) {
    fail("candidate manifest schema version is unsupported");
  }
  exactKeys(manifest.product, ["name", "version", "identifier"], "product");
  const expectedInstaller = unifiedInstallerFileName(manifest.product);
  exactKeys(
    manifest.source,
    ["commit", "branch", "commitTimestamp", "worktreeClean"],
    "source",
  );
  canonicalCommit(manifest.source.commit);
  if (
    typeof manifest.source.branch !== "string" ||
    manifest.source.branch.length === 0 ||
    manifest.source.worktreeClean !== true
  ) {
    fail("candidate source must have a named branch and a clean worktree");
  }
  validTimestamp(manifest.source.commitTimestamp, "source.commitTimestamp");
  validTimestamp(manifest.createdAt, "createdAt");
  exactKeys(
    manifest.artifact,
    ["fileName", "buildPath", "bytes", "sha256", "kind"],
    "artifact",
  );
  canonicalHash(manifest.artifact.sha256, "artifact.sha256");
  if (
    manifest.artifact.fileName !== expectedInstaller ||
    manifest.artifact.buildPath !==
      `src-tauri/target/release/bundle/nsis/${expectedInstaller}` ||
    !Number.isSafeInteger(manifest.artifact.bytes) ||
    manifest.artifact.bytes <= 0 ||
    manifest.artifact.kind !== "nsis-installer"
  ) {
    fail("candidate artifact does not match the unique NSIS installer contract");
  }
  if (
    manifest.candidateId !==
    unifiedCandidateId(manifest.source.commit, manifest.artifact.sha256)
  ) {
    fail("candidate directory identity is not bound to source and artifact bytes");
  }
  exactKeys(
    manifest.bindings,
    [
      "productAuthoritySha256",
      "tauriConfigSha256",
      "packageLockSha256",
      "cargoLockSha256",
    ],
    "bindings",
  );
  for (const [name, value] of Object.entries(manifest.bindings)) {
    canonicalHash(value, `bindings.${name}`);
  }
  exactKeys(
    manifest.contentPolicy,
    ["learning", "bundledCorpus", "userOwnedLegacyData"],
    "contentPolicy",
  );
  if (
    manifest.contentPolicy.learning !== "generic-only" ||
    manifest.contentPolicy.bundledCorpus !== "none" ||
    manifest.contentPolicy.userOwnedLegacyData !== "explicit-migration-only"
  ) {
    fail("candidate content policy is not the unified public policy");
  }
  exactKeys(manifest.signature, ["status"], "signature");
  if (manifest.signature.status !== "not-checked") {
    fail("candidate signature state must remain factual until a later signed-candidate gate");
  }
  const expectedReleaseStatus =
    manifest.source.branch === "main" ? "candidate-not-approved" : "internal-only-non-main";
  if (manifest.releaseStatus !== expectedReleaseStatus) {
    fail("candidate release status does not match its source branch");
  }
  return manifest;
}

export async function validateUnifiedCandidateDirectory(directory) {
  const resolved = path.resolve(directory);
  const entries = await readdir(resolved, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    fail("candidate directory may contain regular files only");
  }
  const names = entries.map((entry) => entry.name).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const manifestBytes = await readFile(path.join(resolved, UNIFIED_CANDIDATE_MANIFEST));
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`candidate manifest JSON is invalid: ${error.message}`);
  }
  validateUnifiedCandidateManifest(manifest);
  const expectedNames = [
    UNIFIED_CANDIDATE_MARKER,
    UNIFIED_CANDIDATE_MANIFEST,
    UNIFIED_CANDIDATE_CHECKSUMS,
    manifest.artifact.fileName,
  ].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail("candidate directory must contain exactly one installer and the three fixed metadata files");
  }
  if (path.basename(resolved) !== manifest.candidateId) {
    fail("candidate directory name does not match the immutable candidate identity");
  }
  for (const name of names) {
    const metadata = await lstat(path.join(resolved, name));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("candidate entries must be ordinary files, not links");
    }
  }
  const marker = await readFile(path.join(resolved, UNIFIED_CANDIDATE_MARKER), "utf8");
  if (marker !== UNIFIED_CANDIDATE_MARKER_CONTENTS) {
    fail("candidate ownership marker is invalid");
  }
  const artifactBytes = await readFile(path.join(resolved, manifest.artifact.fileName));
  if (
    artifactBytes.length !== manifest.artifact.bytes ||
    sha256(artifactBytes) !== manifest.artifact.sha256
  ) {
    fail("candidate installer bytes do not match the bound manifest");
  }
  const checksums = await readFile(path.join(resolved, UNIFIED_CANDIDATE_CHECKSUMS), "utf8");
  if (checksums !== renderUnifiedCandidateChecksums(manifest)) {
    fail("candidate checksum file is stale or ambiguous");
  }
  const artifactPaths = findForbiddenArtifactPaths(names.map(normalizeRepositoryPath));
  if (artifactPaths.length > 0) {
    fail(`candidate artifact path violates the public boundary: ${artifactPaths[0].path}`);
  }
  const forbiddenMarkers = findForbiddenArtifactTextMarkers(artifactBytes.toString("latin1"));
  if (forbiddenMarkers.length > 0) {
    fail(`candidate installer contains forbidden marker: ${forbiddenMarkers[0]}`);
  }
  return manifest;
}
