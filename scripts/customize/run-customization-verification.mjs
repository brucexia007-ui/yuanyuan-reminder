import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadRunState, nextRequiredStep, projectRoot, readJson, runStatePath, sha256 } from "./customization-state.mjs";
import { verifyPrivateInputBoundary } from "./private-input-boundary.mjs";
import { sourceSnapshot } from "./source-snapshot.mjs";

function runIdArgument() {
  const index = process.argv.indexOf("--run-id");
  if (index < 0 || !process.argv[index + 1]) throw new Error("usage: --run-id <run-id>");
  return process.argv[index + 1];
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const digest = createHash("sha256");
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    child.stdout.on("data", (chunk) => { process.stdout.write(chunk); digest.update("stdout\0"); digest.update(chunk); });
    child.stderr.on("data", (chunk) => { process.stderr.write(chunk); digest.update("stderr\0"); digest.update(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      command: [command, ...args].join(" "),
      exitCode,
      durationMs: Date.now() - started,
      outputSha256: digest.digest("hex"),
    }));
  });
}

async function main() {
  const runId = runIdArgument();
  const state = await loadRunState(runId);
  if (nextRequiredStep(state)?.id !== "verification") throw new Error("CUSTOMIZATION_STEP_ORDER: verification is not the current step");
  const functionalArtifact = state.artifacts.find((entry) => entry.role === "functional_regression_report");
  if (!functionalArtifact) throw new Error("CUSTOMIZATION_EVIDENCE_INVALID: functional regression report is missing");
  const functionalBytes = await readFile(path.join(projectRoot, functionalArtifact.path));
  if (functionalBytes.length !== functionalArtifact.bytes || sha256(functionalBytes) !== functionalArtifact.sha256) {
    throw new Error("CUSTOMIZATION_SOURCE_DRIFT: functional regression report changed after acceptance");
  }
  const functional = JSON.parse(functionalBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const identityLockArtifact = state.artifacts.find((entry) => entry.role === "identity_lock");
  if (!identityLockArtifact) throw new Error("CUSTOMIZATION_PRIVATE_INPUT_INVALID: identity lock is missing");
  const [request, identityLock] = await Promise.all([
    readJson(path.join(projectRoot, state.request.path)),
    readJson(path.join(projectRoot, identityLockArtifact.path)),
  ]);
  const privateInputBoundary = await verifyPrivateInputBoundary({
    projectRoot,
    request,
    lockedPhotoHashes: identityLock.sourcePhotoSha256,
  });
  const initialSnapshot = await sourceSnapshot(projectRoot, state.source.resolvedCommit);
  if (
    functional.sourceCommit !== state.source.resolvedCommit
    || functional.sourceSnapshotSha256 !== initialSnapshot.sha256
    || functional.sourceDiffBytes !== initialSnapshot.diffBytes
    || JSON.stringify(functional.untrackedSourceFiles) !== JSON.stringify(initialSnapshot.untrackedFiles)
  ) throw new Error("CUSTOMIZATION_SOURCE_DRIFT: source changed after functional acceptance");
  const startedAt = new Date().toISOString();
  const results = [];
  for (const [command, args, cwd] of [
    ["npm.cmd", ["run", "verify"], projectRoot],
    ["cargo", ["test", "--locked"], path.join(projectRoot, "src-tauri")],
    ["npm.cmd", ["run", "tauri", "build"], projectRoot],
  ]) {
    const result = await run(command, args, cwd);
    results.push(result);
    if (result.exitCode !== 0) throw new Error(`CUSTOMIZATION_VERIFICATION_FAILED: ${result.command}`);
  }
  const [version, brand, snapshot] = await Promise.all([
    readJson(path.join(projectRoot, "product-version.json")),
    readJson(path.join(projectRoot, "product-brand.json")),
    sourceSnapshot(projectRoot, state.source.resolvedCommit),
  ]);
  if (JSON.stringify(snapshot) !== JSON.stringify(initialSnapshot)) {
    throw new Error("CUSTOMIZATION_SOURCE_DRIFT: source changed during verification");
  }
  const report = {
    schemaVersion: 1,
    profile: "yuanyuan-customization-verification",
    runId,
    baselineCommit: state.source.resolvedCommit,
    sourceSnapshotSha256: snapshot.sha256,
    sourceDiffBytes: snapshot.diffBytes,
    untrackedSourceFiles: snapshot.untrackedFiles,
    productVersion: version.version,
    brandIdentifier: brand.application.identifier,
    brandSha256: sha256(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(projectRoot, "product-brand.json")))),
    privateInputBoundary,
    startedAt,
    completedAt: new Date().toISOString(),
    results,
    passed: true,
  };
  const output = path.join(path.dirname(runStatePath(runId)), "verification-report.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Customization verification report: ${path.relative(projectRoot, output).replaceAll("\\", "/")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
