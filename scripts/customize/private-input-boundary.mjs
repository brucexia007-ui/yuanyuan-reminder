import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRepositoryPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function visibleRepositoryFiles(projectRoot) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout.toString("utf8").split("\0").filter(Boolean).map(normalizeRepositoryPath).sort();
}

export async function verifyPrivateInputBoundary({
  projectRoot,
  request,
  lockedPhotoHashes,
}) {
  const root = await realpath(projectRoot);
  if (
    !Array.isArray(request?.pet?.photoInputs)
    || !Array.isArray(request?.learning?.sourceInputs)
    || !Array.isArray(lockedPhotoHashes)
    || lockedPhotoHashes.length !== request.pet.photoInputs.length
    || lockedPhotoHashes.some((value) => typeof value !== "string" || !SHA256.test(value))
  ) {
    throw new Error("CUSTOMIZATION_PRIVATE_INPUT_INVALID: request and identity-lock photo counts or hashes disagree");
  }

  const privateHashes = new Set(lockedPhotoHashes);
  const privatePathMarkers = new Set();
  let availablePrivateInputCount = 0;
  const inputs = [
    ...request.pet.photoInputs.map((value, index) => ({ kind: "photo", value, expectedHash: lockedPhotoHashes[index] })),
    ...request.learning.sourceInputs.map((value) => ({ kind: "learning", value, expectedHash: null })),
  ];
  for (const input of inputs) {
    const absolute = path.resolve(root, input.value);
    if (within(root, absolute)) {
      const relative = normalizeRepositoryPath(path.relative(root, absolute));
      if (!relative.startsWith("work/")) {
        throw new Error("CUSTOMIZATION_PRIVATE_INPUT_INVALID: a private input resolves inside the source tree outside work/");
      }
    }
    privatePathMarkers.add(normalizeRepositoryPath(absolute).toLowerCase());
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CUSTOMIZATION_PRIVATE_INPUT_INVALID: a private input is not an ordinary file");
    }
    const bytes = await readFile(absolute);
    const digest = sha256(bytes);
    if (input.kind === "photo" && digest !== input.expectedHash) {
      throw new Error("CUSTOMIZATION_PRIVATE_INPUT_INVALID: a source photo changed after identity lock");
    }
    privateHashes.add(digest);
    availablePrivateInputCount += 1;
  }

  const files = await visibleRepositoryFiles(root);
  let repositoryHashMatchCount = 0;
  let repositoryPathReferenceMatchCount = 0;
  let visibleWorkPathCount = 0;
  for (const relativePath of files) {
    if (relativePath === "work" || relativePath.startsWith("work/")) {
      visibleWorkPathCount += 1;
      continue;
    }
    const absolutePath = path.resolve(root, relativePath);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`CUSTOMIZATION_PRIVATE_INPUT_INVALID: repository source is not an ordinary file: ${relativePath}`);
    }
    const bytes = await readFile(absolutePath);
    if (privateHashes.has(sha256(bytes))) repositoryHashMatchCount += 1;
    if (bytes.length <= 32 * 1024 * 1024 && privatePathMarkers.size > 0) {
      const normalizedText = bytes.toString("utf8").replaceAll("\\", "/").toLowerCase();
      if ([...privatePathMarkers].some((marker) => normalizedText.includes(marker))) {
        repositoryPathReferenceMatchCount += 1;
      }
    }
  }

  if (visibleWorkPathCount > 0) {
    throw new Error("CUSTOMIZATION_PRIVATE_INPUT_LEAK: work/ contains Git-visible files");
  }
  if (repositoryHashMatchCount > 0) {
    throw new Error("CUSTOMIZATION_PRIVATE_INPUT_LEAK: original private input bytes are Git-visible");
  }
  if (repositoryPathReferenceMatchCount > 0) {
    throw new Error("CUSTOMIZATION_PRIVATE_INPUT_LEAK: a private input path is Git-visible");
  }

  return {
    schemaVersion: 1,
    profile: "customization-private-input-boundary",
    repositoryVisibleFileCount: files.length,
    requestedPhotoCount: request.pet.photoInputs.length,
    requestedLearningSourceCount: request.learning.sourceInputs.length,
    lockedPhotoHashCount: lockedPhotoHashes.length,
    availablePrivateInputCount,
    privateHashCount: privateHashes.size,
    visibleWorkPathCount,
    repositoryHashMatchCount,
    repositoryPathReferenceMatchCount,
    passed: true,
  };
}
