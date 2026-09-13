import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  loadRunState,
  nextRequiredStep,
  projectRoot,
  sha256,
  validateRequest,
} from "./customization-state.mjs";
import { verifyPrivateInputBoundary } from "./private-input-boundary.mjs";

const execFileAsync = promisify(execFile);

function runArgument(argumentsList) {
  const index = argumentsList.indexOf("--run-id");
  if (index < 0 || !argumentsList[index + 1]) throw new Error("usage: --run-id <run-id>");
  return argumentsList[index + 1];
}

async function main() {
  const state = await loadRunState(runArgument(process.argv.slice(2)));
  const canonicalRoot = await realpath(projectRoot);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const currentCommit = stdout.trim();
  if (currentCommit !== state.source.resolvedCommit) {
    throw new Error("CUSTOMIZATION_SOURCE_DRIFT: checked-out source no longer matches the locked commit");
  }
  const requestPath = path.resolve(projectRoot, state.request.path);
  const requestMetadata = await lstat(requestPath);
  if (!requestMetadata.isFile() || requestMetadata.isSymbolicLink()) {
    throw new Error("CUSTOMIZATION_REQUEST_DRIFT: request snapshot is not an ordinary file");
  }
  const requestBytes = await readFile(requestPath);
  if (sha256(requestBytes) !== state.request.sha256) {
    throw new Error("CUSTOMIZATION_REQUEST_DRIFT: request changed after the run was prepared");
  }
  const request = JSON.parse(requestBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  validateRequest(request);
  const productVersion = JSON.parse(await readFile(path.join(projectRoot, "product-version.json"), "utf8"));
  if (compareVersions(productVersion.version, state.source.minimumVersion) < 0) {
    throw new Error("CUSTOMIZATION_SOURCE_TOO_OLD: current product version is below the locked minimumVersion");
  }
  for (const artifact of state.artifacts) {
    const artifactPath = path.resolve(canonicalRoot, artifact.path);
    const relative = path.relative(canonicalRoot, artifactPath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("CUSTOMIZATION_ARTIFACT_DRIFT: recorded artifact escaped the project root");
    }
    let bytes;
    try {
      const metadata = await lstat(artifactPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not an ordinary file");
      const canonicalArtifact = await realpath(artifactPath);
      const canonicalRelative = path.relative(canonicalRoot, canonicalArtifact);
      if (!canonicalRelative || canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
        throw new Error("resolved outside project");
      }
      bytes = await readFile(canonicalArtifact);
    } catch {
      throw new Error(`CUSTOMIZATION_ARTIFACT_DRIFT: missing ${artifact.path}`);
    }
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`CUSTOMIZATION_ARTIFACT_DRIFT: changed ${artifact.path}`);
    }
  }
  const identityLockArtifact = state.artifacts.find((entry) => entry.role === "identity_lock");
  let privateInputs = null;
  if (identityLockArtifact) {
    const identityLock = JSON.parse(
      await readFile(path.join(projectRoot, identityLockArtifact.path), "utf8"),
    );
    privateInputs = await verifyPrivateInputBoundary({
      projectRoot,
      request,
      lockedPhotoHashes: identityLock.sourcePhotoSha256,
    });
  }
  const nextStep = nextRequiredStep(state);
  process.stdout.write(`${JSON.stringify({
    runId: state.runId,
    status: nextStep ? "ready" : "complete",
    nextStep: nextStep?.id ?? null,
    sourceCommit: currentCommit,
    driftChecks: {
      source: "passed",
      request: "passed",
      artifacts: "passed",
      privateInputs: privateInputs ? "passed" : "not_applicable_before_identity_lock",
    },
    privateInputBoundary: privateInputs,
  })}\n`);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
