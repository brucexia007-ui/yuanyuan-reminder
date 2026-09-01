import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const projectRoot = path.resolve(import.meta.dirname, "../..");
const STEP_DEFINITIONS = [
  ["brand", ["brand_config"], false],
  ["identity_lock", ["identity_lock", "identity_reference"], true],
  ["pet_assets", ["standard_atlas", "sleep_atlas", "life_atlas", "learning_atlas", "fallback_image", "pet_manifest", "windows_icon"], true],
  ["asset_license", ["asset_license"], true],
  ["visual_qa", ["contact_sheet", "direction_sheet", "animation_preview", "direction_semantics", "qa_report"], true],
  ["learning_pack", ["learning_pack", "learning_pack_report"], true],
  ["functional_regression", ["functional_regression_report"], false],
  ["verification", ["verification_report"], false],
  ["packaging", ["installer", "portable", "checksums", "delivery_manifest"], false],
];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalRepositoryUrl(value) {
  let repository;
  try {
    repository = new URL(value);
  } catch {
    throw new Error("CUSTOMIZATION_SOURCE_INVALID: repository URL is invalid");
  }
  if (repository.protocol !== "https:" || repository.username || repository.password || repository.search || repository.hash) {
    throw new Error("CUSTOMIZATION_SOURCE_INVALID: repository must be a credential-free HTTPS URL");
  }
  repository.hostname = repository.hostname.toLowerCase();
  repository.pathname = repository.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
  if (!repository.pathname || repository.pathname === "/") {
    throw new Error("CUSTOMIZATION_SOURCE_INVALID: repository path is missing");
  }
  return repository.toString().replace(/\/$/u, "");
}

export async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

export function validateRequest(request) {
  const keys = Object.keys(request ?? {}).sort().join(",");
  if (keys !== "learning,pet,schemaVersion,source,target" || request.schemaVersion !== 1) {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: request fields do not match schema v1");
  }
  if (Object.keys(request.source ?? {}).sort().join(",") !== "minimumVersion,ref,repository,resolvedCommit") {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: source fields do not match schema v1");
  }
  try {
    canonicalRepositoryUrl(request.source.repository);
  } catch {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: source.repository must be a credential-free HTTPS URL");
  }
  if (request.source.repository.length > 2_048
      || typeof request.source.ref !== "string" || request.source.ref.length < 1 || request.source.ref.length > 200
      || /[\u0000-\u001f\u007f]/u.test(request.source.ref)
      || (request.source.resolvedCommit !== null && !/^[0-9a-f]{40}$/u.test(request.source.resolvedCommit))) {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: source identity is invalid");
  }
  const petKeys = Object.keys(request.pet ?? {}).sort().join(",");
  const extendedPetIdentity = petKeys === "breed,customize,displayName,personality,photoInputs,sex,stylePreset";
  if (!["customize,displayName,photoInputs,stylePreset", "breed,customize,displayName,personality,photoInputs,sex,stylePreset"].includes(petKeys)
      || typeof request.pet.customize !== "boolean"
      || (extendedPetIdentity && !["female", "male", "unknown"].includes(request.pet.sex))
      || !["auto", "soft-illustration", "pixel", "flat"].includes(request.pet.stylePreset)) {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: pet fields do not match schema v1");
  }
  if (Object.keys(request.learning ?? {}).sort().join(",") !== "agentAssistedPack,bundledContent,enabled,importMode,sourceInputs"
      || typeof request.learning.agentAssistedPack !== "boolean") {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: learning fields do not match schema v1");
  }
  if (Object.keys(request.target ?? {}).sort().join(",") !== "architecture,platform") {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: target fields do not match schema v1");
  }
  if (request.learning?.enabled !== true || request.learning?.bundledContent !== false || request.learning?.importMode !== "local-preview-confirm") {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: learning must stay integrated, local, and unbundled");
  }
  if (request.target?.platform !== "windows" || request.target?.architecture !== "x64") {
    const error = new Error("PLATFORM_NOT_IMPLEMENTED: only windows-x64 is implemented");
    error.code = "PLATFORM_NOT_IMPLEMENTED";
    throw error;
  }
  if (!/^\d+\.\d+\.\d+$/u.test(request.source?.minimumVersion ?? "")) {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: minimumVersion must be semantic");
  }
  if (typeof request.pet.displayName !== "string" || request.pet.displayName.trim().length === 0 || request.pet.displayName.length > 40) {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: pet.displayName is required");
  }
  if (extendedPetIdentity && (
    typeof request.pet.breed !== "string" || request.pet.breed.trim().length === 0 || request.pet.breed.length > 80
      || typeof request.pet.personality !== "string" || request.pet.personality.trim().length === 0 || request.pet.personality.length > 120
  )) {
    throw new Error("CUSTOMIZATION_REQUEST_INVALID: pet breed and personality are required");
  }
  for (const name of ["photoInputs", "sourceInputs"]) {
    const value = name === "photoInputs" ? request.pet[name] : request.learning[name];
    const maximumItems = name === "photoInputs" ? 16 : 64;
    if (!Array.isArray(value) || value.length > maximumItems
        || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 1_024)) {
      throw new Error(`CUSTOMIZATION_REQUEST_INVALID: ${name} must be a string array`);
    }
  }
}

export function newRunState({ request, requestSha256, resolvedCommit, now = new Date() }) {
  const runId = `${now.toISOString().replace(/[-:.]/gu, "").replace("Z", "Z-")}${randomUUID().slice(0, 8)}`;
  return {
    schemaVersion: 1,
    runId,
    status: "prepared",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    source: {
      repository: request.source.repository,
      requestedRef: request.source.ref,
      minimumVersion: request.source.minimumVersion,
      resolvedCommit,
      driftLocked: true
    },
    request: {
      path: null,
      sha256: requestSha256,
      petDisplayName: request.pet.displayName,
      petSex: request.pet.sex ?? null,
      petBreed: request.pet.breed ?? null,
      petPersonality: request.pet.personality ?? null,
      petStylePreset: request.pet.stylePreset,
      photoInputCount: request.pet.photoInputs.length,
      learningSourceInputCount: request.learning.sourceInputs.length,
      agentAssistedPack: request.learning.agentAssistedPack,
      privateInputsCopiedIntoRepository: false
    },
    target: "windows-x64",
    steps: STEP_DEFINITIONS.map(([id, roles]) => step(
      id,
      id === "learning_pack" ? request.learning.agentAssistedPack : (["identity_lock", "pet_assets", "asset_license", "visual_qa"].includes(id) ? request.pet.customize : true),
      roles,
    )),
    artifacts: [],
    findings: []
  };
}

function step(id, required, requiredArtifactRoles) {
  return {
    id,
    status: required ? "pending" : "not_required",
    requiredArtifactRoles,
    completedAt: null,
    artifactRoles: [],
  };
}

export async function persistRunState(state, requestBytes) {
  const runDirectory = path.join(projectRoot, "work", "customization", state.runId);
  await mkdir(runDirectory, { recursive: true });
  const requestPath = path.join(runDirectory, "request.json");
  await writeFile(requestPath, requestBytes, { flag: "wx" });
  state.request.path = path.relative(projectRoot, requestPath).replaceAll("\\", "/");
  const outputPath = path.join(runDirectory, "run-state.json");
  await writeFile(outputPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return outputPath;
}

export function validateRunId(runId) {
  if (typeof runId !== "string" || !/^\d{8}T\d{9}Z-[0-9a-f]{8}$/u.test(runId)) {
    throw new Error("CUSTOMIZATION_RUN_INVALID: run id is malformed");
  }
  return runId;
}

export function runStatePath(runId) {
  return path.join(projectRoot, "work", "customization", validateRunId(runId), "run-state.json");
}

export async function loadRunState(runId) {
  const state = await readJson(runStatePath(runId));
  const expectedRequestPath = `work/customization/${runId}/request.json`;
  if (
    state?.schemaVersion !== 1
    || state.runId !== runId
    || !["prepared", "in_progress", "complete"].includes(state.status)
    || state.target !== "windows-x64"
    || state.source?.driftLocked !== true
    || !/^[a-f0-9]{40}$/u.test(state.source?.resolvedCommit ?? "")
    || typeof state.source?.repository !== "string"
    || typeof state.source?.requestedRef !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(state.source?.minimumVersion ?? "")
    || state.request?.path !== expectedRequestPath
    || !/^[a-f0-9]{64}$/u.test(state.request?.sha256 ?? "")
    || typeof state.request?.petDisplayName !== "string"
    || (state.request?.petSex != null && !["female", "male", "unknown"].includes(state.request.petSex))
    || (state.request?.petBreed != null && (
      typeof state.request.petBreed !== "string"
      || state.request.petBreed.trim().length < 1
      || state.request.petBreed.length > 80
    ))
    || (state.request?.petPersonality != null && (
      typeof state.request.petPersonality !== "string"
      || state.request.petPersonality.trim().length < 1
      || state.request.petPersonality.length > 120
    ))
    || !["auto", "soft-illustration", "pixel", "flat"].includes(state.request?.petStylePreset)
    || !Number.isSafeInteger(state.request?.photoInputCount)
    || state.request.photoInputCount < 0
    || !Number.isSafeInteger(state.request?.learningSourceInputCount)
    || state.request.learningSourceInputCount < 0
    || !Array.isArray(state.steps)
    || !Array.isArray(state.artifacts)
    || state.steps.length !== STEP_DEFINITIONS.length
    || state.steps.some((entry) => (
      !entry
      || typeof entry.id !== "string"
      || !["pending", "completed", "not_required"].includes(entry.status)
      || !Array.isArray(entry.requiredArtifactRoles)
      || !Array.isArray(entry.artifactRoles)
    ))
  ) {
    throw new Error("CUSTOMIZATION_RUN_INVALID: run-state contract is invalid");
  }
  let pendingSeen = false;
  const artifactsByStep = new Map();
  const paths = new Set();
  const roles = new Set();
  for (const artifact of state.artifacts) {
    if (
      !artifact
      || typeof artifact.path !== "string"
      || path.isAbsolute(artifact.path)
      || artifact.path.includes("\\")
      || artifact.path === ".."
      || artifact.path.startsWith("../")
      || artifact.path.includes("/../")
      || !/^[a-z][a-z0-9_]{1,63}$/u.test(artifact.role ?? "")
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1
      || paths.has(artifact.path)
      || roles.has(artifact.role)
    ) throw new Error("CUSTOMIZATION_RUN_INVALID: recorded artifact contract is invalid");
    paths.add(artifact.path);
    roles.add(artifact.role);
    const entries = artifactsByStep.get(artifact.stepId) ?? [];
    entries.push(artifact.role);
    artifactsByStep.set(artifact.stepId, entries);
  }
  state.steps.forEach((entry, index) => {
    const [expectedId, expectedRoles, optional] = STEP_DEFINITIONS[index];
    if (
      entry.id !== expectedId
      || JSON.stringify(entry.requiredArtifactRoles) !== JSON.stringify(expectedRoles)
      || (!optional && entry.status === "not_required")
    ) throw new Error("CUSTOMIZATION_RUN_INVALID: run step contract drifted");
    if (entry.status === "pending") pendingSeen = true;
    if (pendingSeen && entry.status === "completed") throw new Error("CUSTOMIZATION_RUN_INVALID: completed steps are out of order");
    const recordedRoles = (artifactsByStep.get(entry.id) ?? []).sort();
    const expectedRecorded = entry.status === "completed" ? [...expectedRoles].sort() : [];
    if (
      JSON.stringify([...entry.artifactRoles].sort()) !== JSON.stringify(expectedRecorded)
      || JSON.stringify(recordedRoles) !== JSON.stringify(expectedRecorded)
    ) throw new Error("CUSTOMIZATION_RUN_INVALID: step evidence does not match its status");
  });
  if ([...artifactsByStep.keys()].some((stepId) => !STEP_DEFINITIONS.some(([id]) => id === stepId))) {
    throw new Error("CUSTOMIZATION_RUN_INVALID: artifact references an unknown step");
  }
  const completed = state.steps.filter((entry) => entry.status === "completed").length;
  const pending = state.steps.filter((entry) => entry.status === "pending").length;
  if (
    (state.status === "prepared" && completed !== 0)
    || (state.status === "in_progress" && (completed === 0 || pending === 0))
    || (state.status === "complete" && pending !== 0)
  ) throw new Error("CUSTOMIZATION_RUN_INVALID: overall status does not match steps");
  return state;
}

export async function replaceRunState(state, now = new Date()) {
  validateRunId(state?.runId);
  const outputPath = runStatePath(state.runId);
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  state.updatedAt = now.toISOString();
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, outputPath);
  return outputPath;
}

export function nextRequiredStep(state) {
  return state.steps.find((step) => step.status === "pending" || step.status === "in_progress") ?? null;
}

export function completeRequiredStep(state, { stepId, artifacts, now = new Date() }) {
  const next = nextRequiredStep(state);
  if (!next || next.id !== stepId) {
    throw new Error(`CUSTOMIZATION_STEP_ORDER: expected ${next?.id ?? "no further step"}`);
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("CUSTOMIZATION_ARTIFACT_REQUIRED: at least one artifact is required");
  }
  const roles = new Set();
  for (const artifact of artifacts) {
    if (
      !artifact
      || typeof artifact.role !== "string"
      || !/^[a-z][a-z0-9_]{1,63}$/u.test(artifact.role)
      || roles.has(artifact.role)
      || typeof artifact.path !== "string"
      || artifact.path.length < 1
      || artifact.path.length > 512
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1
    ) {
      throw new Error("CUSTOMIZATION_ARTIFACT_INVALID: artifact evidence is malformed or duplicated");
    }
    roles.add(artifact.role);
  }
  const missing = next.requiredArtifactRoles.filter((role) => !roles.has(role));
  if (missing.length > 0) {
    throw new Error(`CUSTOMIZATION_ARTIFACT_REQUIRED: missing ${missing.join(", ")}`);
  }
  const extra = [...roles].filter((role) => !next.requiredArtifactRoles.includes(role));
  if (extra.length > 0) {
    throw new Error(`CUSTOMIZATION_ARTIFACT_INVALID: unexpected ${extra.join(", ")}`);
  }
  for (const artifact of artifacts) {
    if (state.artifacts.some((entry) => entry.path === artifact.path || entry.role === artifact.role)) {
      throw new Error("CUSTOMIZATION_ARTIFACT_INVALID: artifact path or role was already recorded");
    }
  }
  state.artifacts.push(...artifacts.map((artifact) => ({ ...artifact, stepId })));
  next.status = "completed";
  next.completedAt = now.toISOString();
  next.artifactRoles = [...roles].sort();
  state.status = nextRequiredStep(state) ? "in_progress" : "complete";
  return state;
}
