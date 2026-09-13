import { lstat, realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  completeRequiredStep,
  loadRunState,
  projectRoot,
  replaceRunState,
  sha256,
} from "./customization-state.mjs";
import {
  validateAssetLicenseEvidence,
  validateBrandEvidence,
  validateFunctionalRegressionEvidence,
  validateIdentityLockEvidence,
  validatePackagingEvidence,
  validatePetAssetEvidence,
  validateVerificationEvidence,
  validateVisualQaEvidence,
} from "./pet-evidence.mjs";

function oneArgument(argumentsList, name) {
  const matches = argumentsList.reduce((values, value, index) => (
    value === name && argumentsList[index + 1] ? [...values, argumentsList[index + 1]] : values
  ), []);
  if (matches.length !== 1) throw new Error(`usage: ${name} <value>`);
  return matches[0];
}

function artifactArguments(argumentsList) {
  const values = argumentsList.reduce((matches, value, index) => (
    value === "--artifact" && argumentsList[index + 1] ? [...matches, argumentsList[index + 1]] : matches
  ), []);
  if (values.length === 0) throw new Error("usage: --artifact <role=path> (repeat for each required role)");
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator < 2 || separator === value.length - 1) throw new Error("CUSTOMIZATION_ARTIFACT_INVALID: use role=path");
    return { role: value.slice(0, separator), inputPath: value.slice(separator + 1) };
  });
}

function insideProject(candidate) {
  const relative = path.relative(projectRoot, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function collectArtifact({ role, inputPath }) {
  const requested = path.resolve(projectRoot, inputPath);
  const requestedMetadata = await lstat(requested);
  if (requestedMetadata.isSymbolicLink()) throw new Error("CUSTOMIZATION_ARTIFACT_INVALID: symbolic links are not accepted as evidence");
  const resolved = await realpath(requested);
  if (!insideProject(resolved)) {
    throw new Error("CUSTOMIZATION_ARTIFACT_OUTSIDE_PROJECT: evidence must stay in the repository or ignored work directory");
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.size < 1) throw new Error("CUSTOMIZATION_ARTIFACT_INVALID: evidence must be a non-empty regular file");
  const bytes = await readFile(resolved);
  return {
    role,
    path: path.relative(projectRoot, resolved).replaceAll("\\", "/"),
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const runId = oneArgument(argumentsList, "--run-id");
  const stepId = oneArgument(argumentsList, "--step");
  const state = await loadRunState(runId);
  const artifacts = await Promise.all(artifactArguments(argumentsList).map(collectArtifact));
  completeRequiredStep(state, { stepId, artifacts });
  if (stepId === "brand") await validateBrandEvidence(artifacts, projectRoot, state);
  if (stepId === "identity_lock") await validateIdentityLockEvidence(artifacts, projectRoot, state);
  if (stepId === "pet_assets") await validatePetAssetEvidence(artifacts, projectRoot);
  if (stepId === "asset_license") await validateAssetLicenseEvidence(artifacts, projectRoot);
  if (stepId === "visual_qa") await validateVisualQaEvidence(artifacts, projectRoot, state);
  if (stepId === "functional_regression") await validateFunctionalRegressionEvidence(artifacts, projectRoot, state);
  if (stepId === "verification") await validateVerificationEvidence(artifacts, projectRoot, state);
  if (stepId === "packaging") await validatePackagingEvidence(artifacts, projectRoot, state);
  const outputPath = await replaceRunState(state);
  process.stdout.write(`${JSON.stringify({
    runId,
    completedStep: stepId,
    status: state.status,
    nextStep: state.steps.find((entry) => entry.status === "pending")?.id ?? null,
    recordedArtifacts: artifacts.map(({ role, path: artifactPath, sha256: hash }) => ({ role, path: artifactPath, sha256: hash })),
    stateFile: path.relative(projectRoot, outputPath).replaceAll("\\", "/"),
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
