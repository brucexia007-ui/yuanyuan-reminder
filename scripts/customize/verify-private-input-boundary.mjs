import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadRunState, projectRoot } from "./customization-state.mjs";
import { verifyPrivateInputBoundary } from "./private-input-boundary.mjs";

function runIdArgument(argumentsList) {
  const index = argumentsList.indexOf("--run-id");
  if (index < 0 || !argumentsList[index + 1] || argumentsList.length !== 2) {
    throw new Error("usage: --run-id <run-id>");
  }
  return argumentsList[index + 1];
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function main() {
  const state = await loadRunState(runIdArgument(process.argv.slice(2)));
  const identityLock = state.artifacts.find((entry) => entry.role === "identity_lock");
  if (!identityLock) throw new Error("CUSTOMIZATION_PRIVATE_INPUT_INVALID: identity lock is missing");
  const [request, lock] = await Promise.all([
    readJson(path.join(projectRoot, state.request.path)),
    readJson(path.join(projectRoot, identityLock.path)),
  ]);
  const report = await verifyPrivateInputBoundary({
    projectRoot,
    request,
    lockedPhotoHashes: lock.sourcePhotoSha256,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
