import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const identitySourcePath = path.join(
  projectRoot,
  "src-tauri",
  "crates",
  "yuanyuan-bridge",
  "src",
  "windows_named_pipe_server.rs",
);
const REQUIRED_ATTESTATION = "isolated_windows_pid_reuse_stress_v1";
const EXPECTED_KEYS = [
  "attestation",
  "completedIterations",
  "distinctProcessIds",
  "elapsedMilliseconds",
  "generatedAtUtc",
  "identityImplementationSha256",
  "mode",
  "outcome",
  "ready",
  "requestedIterations",
  "samePidDifferentCreationTimeObserved",
  "schemaVersion",
  "staleIdentityRejectedBeforePayloadRead",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function validatePidReuseEvidence(report, identitySourceSha256) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return false;
  if (JSON.stringify(Object.keys(report).sort()) !== JSON.stringify(EXPECTED_KEYS)) return false;
  const generatedAt = Date.parse(report.generatedAtUtc);
  return (
    report.schemaVersion === 1 &&
    report.mode === "windows_pid_reuse_named_pipe_identity" &&
    report.attestation === REQUIRED_ATTESTATION &&
    report.identityImplementationSha256 === identitySourceSha256 &&
    Number.isFinite(generatedAt) &&
    Number.isSafeInteger(report.requestedIterations) &&
    report.requestedIterations >= 2 &&
    report.requestedIterations <= 2_000_000 &&
    Number.isSafeInteger(report.completedIterations) &&
    report.completedIterations >= 2 &&
    report.completedIterations <= report.requestedIterations &&
    Number.isSafeInteger(report.distinctProcessIds) &&
    report.distinctProcessIds >= 1 &&
    report.distinctProcessIds < report.completedIterations &&
    report.samePidDifferentCreationTimeObserved === true &&
    report.staleIdentityRejectedBeforePayloadRead === true &&
    report.outcome === "passed" &&
    report.ready === true &&
    Number.isSafeInteger(report.elapsedMilliseconds) &&
    report.elapsedMilliseconds >= 0
  );
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length !== 2 || arguments_[0] !== "--report") {
    throw new Error("usage: node scripts/verify_pid_reuse_qa_evidence.mjs --report <absolute-json>");
  }
  const reportPath = arguments_[1];
  if (!path.isAbsolute(reportPath)) throw new Error("PID reuse report path must be absolute");
  const metadata = await lstat(reportPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("PID reuse report must be an ordinary file");
  }
  const [reportBytes, sourceBytes] = await Promise.all([
    readFile(reportPath),
    readFile(identitySourcePath),
  ]);
  let report;
  try {
    report = JSON.parse(reportBytes.toString("utf8"));
  } catch {
    throw new Error("PID reuse report is not valid JSON");
  }
  if (!validatePidReuseEvidence(report, sha256(sourceBytes))) {
    throw new Error("PID reuse report is pending, stale, or inconsistent");
  }
  console.log(
    `PID reuse evidence passed: stale identity rejected after ${report.completedIterations} process creations.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
