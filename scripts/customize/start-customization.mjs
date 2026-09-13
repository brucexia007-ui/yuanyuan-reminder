import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  canonicalRepositoryUrl,
  newRunState,
  persistRunState,
  projectRoot,
  readJson,
  sha256,
  validateRequest,
} from "./customization-state.mjs";

const execFileAsync = promisify(execFile);

function requestArgument(argumentsList) {
  const index = argumentsList.indexOf("--request");
  if (index < 0 || !argumentsList[index + 1]) throw new Error("usage: --request <request.json>");
  return path.resolve(projectRoot, argumentsList[index + 1]);
}

async function main() {
  const requestPath = requestArgument(process.argv.slice(2));
  const bytes = await readFile(requestPath);
  const request = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  validateRequest(request);
  const productVersion = await readJson(path.join(projectRoot, "product-version.json"));
  if (compareVersions(productVersion.version, request.source.minimumVersion) < 0) {
    throw new Error("CUSTOMIZATION_SOURCE_TOO_OLD: checked-out product version is below minimumVersion");
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd: projectRoot, encoding: "utf8" });
  const resolvedCommit = stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(resolvedCommit)) throw new Error("CUSTOMIZATION_SOURCE_INVALID: HEAD did not resolve to a commit");
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (status.trim()) {
    throw new Error("CUSTOMIZATION_SOURCE_DIRTY: start from an exact clean source commit");
  }
  const { stdout: origin } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: projectRoot, encoding: "utf8" });
  if (canonicalRepositoryUrl(origin.trim()) !== canonicalRepositoryUrl(request.source.repository)) {
    throw new Error("CUSTOMIZATION_SOURCE_DRIFT: origin does not match source.repository");
  }
  let requestedRefCommit;
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${request.source.ref}^{commit}`],
      { cwd: projectRoot, encoding: "utf8" },
    );
    requestedRefCommit = result.stdout.trim();
  } catch {
    throw new Error("CUSTOMIZATION_SOURCE_INVALID: source.ref is not available in the checked-out repository");
  }
  if (requestedRefCommit !== resolvedCommit) {
    throw new Error("CUSTOMIZATION_SOURCE_DRIFT: HEAD does not match the commit resolved from source.ref");
  }
  if (request.source.resolvedCommit && request.source.resolvedCommit !== resolvedCommit) {
    throw new Error("CUSTOMIZATION_SOURCE_DRIFT: request resolvedCommit does not match the checked-out source");
  }
  const state = newRunState({ request, requestSha256: sha256(bytes), resolvedCommit });
  const outputPath = await persistRunState(state, bytes);
  process.stdout.write(`${JSON.stringify({ runId: state.runId, resolvedCommit, stateFile: path.relative(projectRoot, outputPath).replaceAll("\\", "/") })}\n`);
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
