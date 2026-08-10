import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const captureSourcePaths = {
  qaSourceSha256: path.join(
    projectRoot,
    "src-tauri",
    "crates",
    "yuanyuan-ai",
    "src",
    "bin",
    "crash_privacy_qa.rs",
  ),
  aiMainSourceSha256: path.join(
    projectRoot,
    "src-tauri",
    "crates",
    "yuanyuan-ai",
    "src",
    "main.rs",
  ),
  crashPolicySourceSha256: path.join(
    projectRoot,
    "src-tauri",
    "crates",
    "yuanyuan-ai",
    "src",
    "crash_privacy.rs",
  ),
};

const CAPTURE_SCHEMA_VERSION = 1;
const CAPTURE_MODE = "actual_ai_support_sort_abnormal_termination_capture";
const CAPTURE_ATTESTATION = "isolated_windows_crash_privacy_capture_v1";
const FINAL_SCHEMA_VERSION = 1;
const FINAL_MODE = "offline_memory_backing_crash_privacy_scan";
const OFFLINE_ATTESTATION = "isolated_windows_offline_memory_acquisition_v1";
const CANARY_DERIVATION = "sha256_nonce_context_v1";
const CANARY_PREFIX = "YUANYUAN_CRASH_PRIVACY_CANARY_V1_";
const VALID_HIBERNATION_STATES = new Set(["disabled_at_crash", "artifact_supplied"]);
const VALID_SWAPFILE_STATES = new Set(["absent_at_crash", "artifact_supplied"]);
const MAX_ARTIFACTS = 16;

function upperSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function deriveCanary(nonceHex) {
  if (!/^[0-9A-F]{64}$/.test(nonceHex)) throw new Error("invalid canary nonce");
  const digest = createHash("sha256")
    .update(Buffer.from("yuanyuan-crash-privacy-canary-v1\0", "utf8"))
    .update(Buffer.from(nonceHex, "hex"))
    .digest("hex")
    .toUpperCase();
  return `${CANARY_PREFIX}${digest}`;
}

function passingScan(scan) {
  return (
    Number.isInteger(scan?.rootsScanned) &&
    scan.rootsScanned > 0 &&
    Number.isInteger(scan.filesScanned) &&
    scan.filesScanned >= 0 &&
    Number.isInteger(scan.bytesScanned) &&
    scan.bytesScanned >= 0 &&
    scan.unreadableFiles === 0 &&
    scan.reparsePointsRejected === 0 &&
    scan.utf8Matches === 0 &&
    scan.utf16LeMatches === 0
  );
}

export function validateCaptureReport(report, sourceHashes) {
  const canary = deriveCanary(report?.canaryNonceHex ?? "");
  const valid =
    report?.schemaVersion === CAPTURE_SCHEMA_VERSION &&
    report?.mode === CAPTURE_MODE &&
    report?.attestation === CAPTURE_ATTESTATION &&
    report?.binaryProfile === "release_with_crash_privacy_qa_feature" &&
    report?.qaSourceSha256 === sourceHashes.qaSourceSha256 &&
    report?.aiMainSourceSha256 === sourceHashes.aiMainSourceSha256 &&
    report?.crashPolicySourceSha256 === sourceHashes.crashPolicySourceSha256 &&
    /^[0-9A-F]{64}$/.test(report?.qaExecutableSha256 ?? "") &&
    /^[0-9A-F]{64}$/.test(report?.aiExecutableSha256 ?? "") &&
    report?.canaryDerivation === CANARY_DERIVATION &&
    report?.canarySha256 === upperSha256(Buffer.from(canary, "utf8")) &&
    report?.providerDescribed === true &&
    report?.oneUseAuthorizationIssued === true &&
    report?.canarySubmitTransportInterrupted === true &&
    report?.abnormalExitObserved === true &&
    typeof report?.abnormalExitCode === "string" &&
    report.abnormalExitCode !== "success" &&
    report?.standardOutputUtf8Matches === 0 &&
    report?.standardOutputUtf16LeMatches === 0 &&
    passingScan(report?.applicationDataScan) &&
    passingScan(report?.dumpRootScan) &&
    report?.readyForOfflineMemoryScan === true &&
    report?.outcome === "capture_passed";
  if (!valid) throw new Error("capture report is stale, incomplete, or inconsistent");
  return canary;
}

export function parseArguments(args) {
  const options = {
    captureReport: null,
    report: null,
    verifyReport: null,
    attestation: null,
    hibernationState: null,
    swapfileState: null,
    pagefiles: [],
    hiberfil: null,
    swapfile: null,
  };
  const take = (index, flag) => {
    if (index + 1 >= args.length) throw new Error(`${flag} requires a value`);
    return args[index + 1];
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--capture-report":
        if (options.captureReport) throw new Error("duplicate --capture-report");
        options.captureReport = take(index, argument);
        index += 1;
        break;
      case "--report":
        if (options.report || options.verifyReport) throw new Error("duplicate output mode");
        options.report = take(index, argument);
        index += 1;
        break;
      case "--verify-report":
        if (options.verifyReport || options.report) throw new Error("duplicate output mode");
        options.verifyReport = take(index, argument);
        index += 1;
        break;
      case "--pagefile-artifact":
        options.pagefiles.push(take(index, argument));
        index += 1;
        break;
      case "--hiberfil-artifact":
        if (options.hiberfil) throw new Error("duplicate --hiberfil-artifact");
        options.hiberfil = take(index, argument);
        index += 1;
        break;
      case "--swapfile-artifact":
        if (options.swapfile) throw new Error("duplicate --swapfile-artifact");
        options.swapfile = take(index, argument);
        index += 1;
        break;
      case "--hibernation-state":
        if (options.hibernationState) throw new Error("duplicate --hibernation-state");
        options.hibernationState = take(index, argument);
        index += 1;
        break;
      case "--swapfile-state":
        if (options.swapfileState) throw new Error("duplicate --swapfile-state");
        options.swapfileState = take(index, argument);
        index += 1;
        break;
      case "--attest-offline-acquisition":
        if (options.attestation) throw new Error("duplicate --attest-offline-acquisition");
        options.attestation = take(index, argument);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  if (!options.captureReport || (!options.report && !options.verifyReport)) {
    throw new Error("capture report and exactly one output mode are required");
  }
  if (options.attestation !== OFFLINE_ATTESTATION) {
    throw new Error("the exact offline-acquisition attestation is required");
  }
  if (options.pagefiles.length === 0) {
    throw new Error("at least one offline pagefile artifact is required");
  }
  if (options.pagefiles.length + Number(Boolean(options.hiberfil)) + Number(Boolean(options.swapfile)) > MAX_ARTIFACTS) {
    throw new Error("too many offline artifacts");
  }
  if (!VALID_HIBERNATION_STATES.has(options.hibernationState)) {
    throw new Error("hibernation state is incomplete");
  }
  if ((options.hibernationState === "artifact_supplied") !== Boolean(options.hiberfil)) {
    throw new Error("hiberfil artifact does not match the attested hibernation state");
  }
  if (!VALID_SWAPFILE_STATES.has(options.swapfileState)) {
    throw new Error("swapfile state is incomplete");
  }
  if ((options.swapfileState === "artifact_supplied") !== Boolean(options.swapfile)) {
    throw new Error("swapfile artifact does not match the attested swapfile state");
  }
  return options;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

async function validateOrdinaryFile(filePath, label) {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error(`${label} must be a non-empty ordinary file`);
  }
  return { canonicalPath: await realpath(filePath), size: metadata.size };
}

export async function scanArtifact(filePath, role, canary, chunkSize = 1024 * 1024) {
  const { canonicalPath, size } = await validateOrdinaryFile(filePath, role);
  const needles = [Buffer.from(canary, "utf8"), Buffer.from(canary, "utf16le")];
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
  let carry = Buffer.alloc(0);
  let utf8MatchObserved = false;
  let utf16LeMatchObserved = false;
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(canonicalPath, { highWaterMark: chunkSize });
    stream.on("data", (chunk) => {
      hash.update(chunk);
      const window = Buffer.concat([carry, chunk]);
      utf8MatchObserved ||= window.includes(needles[0]);
      utf16LeMatchObserved ||= window.includes(needles[1]);
      carry.fill(0);
      carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
      window.fill(0);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  carry.fill(0);
  return {
    role,
    sizeBytes: size,
    sha256: hash.digest("hex").toUpperCase(),
    utf8MatchObserved,
    utf16LeMatchObserved,
  };
}

function artifactInputs(options) {
  return [
    ...options.pagefiles.map((filePath, index) => ({
      role: `pagefile_${index + 1}`,
      filePath,
    })),
    ...(options.hiberfil ? [{ role: "hiberfil", filePath: options.hiberfil }] : []),
    ...(options.swapfile ? [{ role: "swapfile", filePath: options.swapfile }] : []),
  ];
}

async function currentSourceHashes() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(captureSourcePaths).map(async ([key, filePath]) => [key, await hashFile(filePath)]),
    ),
  );
}

export function buildFinalReport({
  capture,
  captureReportSha256,
  sourceHashes,
  artifacts,
  hibernationState,
  swapfileState,
  generatedAt = new Date().toISOString(),
}) {
  const canary = validateCaptureReport(capture, sourceHashes);
  const pagefileArtifacts = artifacts.filter((artifact) => artifact.role.startsWith("pagefile_"));
  const pagefileCount = pagefileArtifacts.length;
  const hiberfilCount = artifacts.filter((artifact) => artifact.role === "hiberfil").length;
  const swapfileCount = artifacts.filter((artifact) => artifact.role === "swapfile").length;
  const roles = artifacts.map((artifact) => artifact.role);
  const rolesValid =
    artifacts.length <= MAX_ARTIFACTS &&
    new Set(roles).size === roles.length &&
    pagefileArtifacts.every((artifact, index) => artifact.role === `pagefile_${index + 1}`) &&
    roles.every(
      (role) => role === "hiberfil" || role === "swapfile" || /^pagefile_[1-9][0-9]*$/.test(role),
    );
  const artifactSetComplete =
    VALID_HIBERNATION_STATES.has(hibernationState) &&
    VALID_SWAPFILE_STATES.has(swapfileState) &&
    rolesValid &&
    pagefileCount >= 1 &&
    (hibernationState === "artifact_supplied" ? hiberfilCount === 1 : hiberfilCount === 0) &&
    (swapfileState === "artifact_supplied" ? swapfileCount === 1 : swapfileCount === 0);
  const noCanaryObserved = artifacts.every(
    (artifact) =>
      artifact.sizeBytes > 0 &&
      /^[0-9A-F]{64}$/.test(artifact.sha256) &&
      artifact.utf8MatchObserved === false &&
      artifact.utf16LeMatchObserved === false,
  );
  const ready = artifactSetComplete && noCanaryObserved;
  if (!/^[0-9A-F]{64}$/.test(captureReportSha256)) {
    throw new Error("capture report hash is invalid");
  }
  const report = {
    schemaVersion: FINAL_SCHEMA_VERSION,
    mode: FINAL_MODE,
    generatedAt,
    attestation: OFFLINE_ATTESTATION,
    captureReportSha256,
    captureBinding: {
      qaSourceSha256: capture.qaSourceSha256,
      aiMainSourceSha256: capture.aiMainSourceSha256,
      crashPolicySourceSha256: capture.crashPolicySourceSha256,
      qaExecutableSha256: capture.qaExecutableSha256,
      aiExecutableSha256: capture.aiExecutableSha256,
      canaryDerivation: capture.canaryDerivation,
      canaryNonceHex: capture.canaryNonceHex,
      canarySha256: capture.canarySha256,
    },
    coverage: {
      pagefileArtifactCount: pagefileCount,
      hibernationState,
      swapfileState,
      artifactSetComplete,
    },
    artifacts,
    noCanaryObserved,
    ready,
    outcome: ready ? "passed" : "canary_or_coverage_failure",
  };
  if (JSON.stringify(report).includes(canary)) {
    throw new Error("final report must not contain the derived canary");
  }
  return report;
}

export function validateFinalReport(report, expected) {
  const valid =
    report?.schemaVersion === FINAL_SCHEMA_VERSION &&
    report?.mode === FINAL_MODE &&
    report?.attestation === OFFLINE_ATTESTATION &&
    report?.captureReportSha256 === expected.captureReportSha256 &&
    JSON.stringify(report?.captureBinding) === JSON.stringify(expected.captureBinding) &&
    JSON.stringify(report?.coverage) === JSON.stringify(expected.coverage) &&
    JSON.stringify(report?.artifacts) === JSON.stringify(expected.artifacts) &&
    report?.noCanaryObserved === expected.noCanaryObserved &&
    report?.ready === true &&
    report?.outcome === "passed";
  if (!valid) throw new Error("final crash privacy evidence is stale, incomplete, or inconsistent");
  return true;
}

async function readOrdinaryJson(filePath, label) {
  await validateOrdinaryFile(filePath, label);
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function validateNewReportPath(filePath) {
  if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== ".json") {
    throw new Error("report must be a new absolute .json path");
  }
  const parent = path.dirname(filePath);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("report parent must be an ordinary directory");
  }
  try {
    await lstat(filePath);
    throw new Error("report already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeNewReport(filePath, report) {
  await validateNewReportPath(filePath);
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function buildFromDisk(options) {
  const capturePath = (await validateOrdinaryFile(options.captureReport, "capture report")).canonicalPath;
  const captureBytes = await readFile(capturePath);
  const capture = JSON.parse(captureBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const sourceHashes = await currentSourceHashes();
  const canary = validateCaptureReport(capture, sourceHashes);
  const inputs = artifactInputs(options);
  const canonicalArtifacts = new Set();
  const artifacts = [];
  for (const input of inputs) {
    const metadata = await validateOrdinaryFile(input.filePath, input.role);
    if (canonicalArtifacts.has(metadata.canonicalPath)) {
      throw new Error("offline artifact paths must be distinct");
    }
    canonicalArtifacts.add(metadata.canonicalPath);
    artifacts.push(await scanArtifact(metadata.canonicalPath, input.role, canary));
  }
  const report = buildFinalReport({
    capture,
    captureReportSha256: upperSha256(captureBytes),
    sourceHashes,
    artifacts,
    hibernationState: options.hibernationState,
    swapfileState: options.swapfileState,
  });
  captureBytes.fill(0);
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const report = await buildFromDisk(options);
  if (options.verifyReport) {
    const existing = await readOrdinaryJson(options.verifyReport, "final evidence report");
    validateFinalReport(existing, report);
    console.log(`Crash privacy evidence passed: ${report.artifacts.length} offline artifacts rescanned.`);
    return existing;
  }
  await writeNewReport(options.report, report);
  console.log(
    report.ready
      ? `Crash privacy evidence finalized: ${report.artifacts.length} offline artifacts contain no canary.`
      : "Crash privacy evidence failed: a canary match or coverage gap remains.",
  );
  if (!report.ready) process.exitCode = 2;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
