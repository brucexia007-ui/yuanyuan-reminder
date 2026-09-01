import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectFirstStartDatabase } from "./capture_first_start_recovery_database.mjs";
import { productBrand } from "./product_brand_contract.mjs";

export const FIRST_START_RECOVERY_LIMITATIONS = [
  "This uses a byte-identical staged copy of the current NSIS-installed core and an empty synthetic formal data directory in an explicitly acknowledged disposable Windows account.",
  "It terminates a 1%-CPU-capped Windows Job immediately after observing a non-empty SQLite WAL, then verifies recovery by relaunching the same unmodified candidate and inspecting a canonical sidecar-free database fixture.",
  "It proves controlled process-termination recovery, not physical power loss or system restart, and uses no authentic historical or user-authored database.",
  "Signed-candidate identity, SmartScreen, security-software, default installer registration, and manual release signoff remain separate gates.",
];

const EXPECTED_TABLES = [
  "activity_tracking_state",
  "companion_attention_budget",
  "companion_proactive_attention",
  "focus_sessions",
  "occurrences",
  "pet_interactions",
  "reminders",
  "settings",
  "task_watch_attention_deferrals",
  "water_log",
];

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function parseJsonBytes(bytes) {
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();
}

function validHash(value) {
  return typeof value === "string" && /^[A-F0-9]{64}$/.test(value);
}

function healthMatchesShape(health) {
  return (
    hasExactKeys(health, [
      "quickCheck",
      "schemaVersion",
      "journalMode",
      "tables",
      "requiredTablesPresent",
      "settingsRows",
      "reminderRows",
    ]) &&
    exact(health.quickCheck, ["ok"]) &&
    health.schemaVersion === 11 &&
    typeof health.journalMode === "string" &&
    exact(health.tables, EXPECTED_TABLES) &&
    health.requiredTablesPresent === true &&
    health.settingsRows === 1 &&
    Number.isInteger(health.reminderRows) &&
    health.reminderRows >= 2
  );
}

function fileEvidenceMatches(value, required) {
  if (!hasExactKeys(value, ["present", "bytes", "sha256"])) return false;
  if (required) return value.present === true && value.bytes > 0 && validHash(value.sha256);
  return value.present
    ? Number.isInteger(value.bytes) && value.bytes > 0 && validHash(value.sha256)
    : value.bytes === 0 && value.sha256 === null;
}

function captureReportMatches(capture, fixtureFileName, fixtureBytes, fixtureSha256, fixtureHealth) {
  return (
    hasExactKeys(capture, [
      "schemaVersion",
      "generatedAt",
      "mode",
      "ready",
      "attestation",
      "source",
      "fixture",
      "privacy",
    ]) &&
    capture.schemaVersion === 1 &&
    Number.isFinite(Date.parse(capture.generatedAt)) &&
    capture.mode === "synthetic_first_start_recovery_database_capture" &&
    capture.ready === true &&
    capture.attestation === "synthetic_fresh_first_start" &&
    hasExactKeys(capture.source, ["fileName", "bytesBeforeCheckpoint", "healthBeforeCheckpoint"]) &&
    capture.source.fileName === productBrand.storage.mainDatabaseFile &&
    Number.isInteger(capture.source.bytesBeforeCheckpoint) &&
    capture.source.bytesBeforeCheckpoint > 0 &&
    healthMatchesShape(capture.source.healthBeforeCheckpoint) &&
    hasExactKeys(capture.fixture, ["fileName", "bytes", "sha256", "health", "sidecarCount"]) &&
    capture.fixture.fileName === fixtureFileName &&
    capture.fixture.bytes === fixtureBytes &&
    capture.fixture.sha256 === fixtureSha256 &&
    capture.fixture.sidecarCount === 0 &&
    capture.fixture.health.journalMode === "delete" &&
    healthMatchesShape(capture.fixture.health) &&
    exact(capture.fixture.health, fixtureHealth) &&
    capture.privacy ===
      "Synthetic fresh-profile defaults only; contains no imported, historical, or user-authored content and records no source path."
  );
}

export async function firstStartRecoveryEvidenceMatches({
  report,
  captureReport,
  fixturePath,
  manifest,
  manifestSha256,
  probeScriptSha256,
  captureHelperSha256,
  captureReportBytes,
  captureReportSha256,
}) {
  try {
    const fixtureMetadata = await lstat(fixturePath);
    if (!fixtureMetadata.isFile() || fixtureMetadata.isSymbolicLink() || fixtureMetadata.size <= 0) {
      return false;
    }
    const fixtureSha256 = await sha256(fixturePath);
    const fixtureHealth = inspectFirstStartDatabase(fixturePath);
    if (!healthMatchesShape(fixtureHealth) || fixtureHealth.journalMode !== "delete") return false;
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        await lstat(`${fixturePath}${suffix}`);
        return false;
      } catch (error) {
        if (error?.code !== "ENOENT") return false;
      }
    }

    const artifact = manifest?.artifacts?.find((item) => item.id === "nsis_installed_core");
    if (
      !hasExactKeys(report, [
        "schemaVersion",
        "generatedAt",
        "mode",
        "ready",
        "failureCode",
        "bindings",
        "environment",
        "interruption",
        "recovery",
        "cleanup",
        "limitations",
      ]) ||
      report.schemaVersion !== 1 ||
      !Number.isFinite(Date.parse(report.generatedAt)) ||
      report.mode !== "release_first_start_database_recovery_probe" ||
      report.ready !== true ||
      report.failureCode !== null ||
      !exact(report.limitations, FIRST_START_RECOVERY_LIMITATIONS) ||
      !hasExactKeys(report.bindings, [
        "probeScriptSha256",
        "captureHelperSha256",
        "manifestSha256",
        "candidateArtifactId",
        "candidateBytes",
        "candidateSha256",
        "stagedCandidateSha256",
        "databaseCaptureReportSha256",
        "databaseFixtureSha256",
      ]) ||
      report.bindings.probeScriptSha256 !== probeScriptSha256 ||
      report.bindings.captureHelperSha256 !== captureHelperSha256 ||
      report.bindings.manifestSha256 !== manifestSha256 ||
      report.bindings.candidateArtifactId !== "nsis_installed_core" ||
      report.bindings.candidateBytes !== artifact?.bytes ||
      report.bindings.candidateSha256 !== artifact?.sha256 ||
      report.bindings.stagedCandidateSha256 !== artifact?.sha256 ||
      report.bindings.databaseCaptureReportSha256 !== captureReportSha256 ||
      report.bindings.databaseFixtureSha256 !== fixtureSha256
    ) {
      return false;
    }

    const environment = report.environment;
    if (
      !hasExactKeys(environment, [
        "interactiveSession",
        "freshTestAccountAcknowledged",
        "profileRegistryQueryAvailable",
        "tokenProfilePathMatchesEnvironment",
        "localAppDataMatchesTokenProfile",
        "preexistingDataRoot",
        "preexistingApplicationProcessCount",
        "emptyFormalDataRootProvisionedByProbe",
      ]) ||
      environment.interactiveSession !== true ||
      environment.freshTestAccountAcknowledged !== true ||
      environment.profileRegistryQueryAvailable !== true ||
      environment.tokenProfilePathMatchesEnvironment !== true ||
      environment.localAppDataMatchesTokenProfile !== true ||
      environment.preexistingDataRoot !== false ||
      environment.preexistingApplicationProcessCount !== 0 ||
      environment.emptyFormalDataRootProvisionedByProbe !== true
    ) {
      return false;
    }

    const interruption = report.interruption;
    if (
      !hasExactKeys(interruption, [
        "method",
        "cpuHardCapPercent",
        "jobKillOnClose",
        "walWatcherArmed",
        "walChangeObserved",
        "walNonzeroObserved",
        "triggerMainDatabaseBytes",
        "triggerWalBytes",
        "ownedProcessCountBeforeTermination",
        "jobTerminationRequested",
        "rootExitCode",
        "processCountAfterTermination",
        "mainDatabaseAfterTermination",
        "walAfterTermination",
        "shmAfterTermination",
      ]) ||
      interruption.method !== "windows_job_cpu_hard_cap_then_terminate_after_nonzero_wal" ||
      interruption.cpuHardCapPercent !== 1 ||
      interruption.jobKillOnClose !== true ||
      interruption.walWatcherArmed !== true ||
      typeof interruption.walChangeObserved !== "boolean" ||
      interruption.walNonzeroObserved !== true ||
      !Number.isInteger(interruption.triggerMainDatabaseBytes) ||
      interruption.triggerMainDatabaseBytes <= 0 ||
      !Number.isInteger(interruption.triggerWalBytes) ||
      interruption.triggerWalBytes <= 0 ||
      !Number.isInteger(interruption.ownedProcessCountBeforeTermination) ||
      interruption.ownedProcessCountBeforeTermination < 1 ||
      interruption.jobTerminationRequested !== true ||
      interruption.rootExitCode !== 1 ||
      interruption.processCountAfterTermination !== 0 ||
      !fileEvidenceMatches(interruption.mainDatabaseAfterTermination, true) ||
      !fileEvidenceMatches(interruption.walAfterTermination, true) ||
      !fileEvidenceMatches(interruption.shmAfterTermination, false)
    ) {
      return false;
    }

    const recovery = report.recovery;
    if (
      !hasExactKeys(recovery, [
        "sameCandidateRelaunched",
        "visibleWindowObserved",
        "ownedProcessCount",
        "aiChildProcessCount",
        "applicationErrorQueryAvailable",
        "applicationErrorCount",
        "processCountAfterProbeStop",
        "databaseCapture",
      ]) ||
      recovery.sameCandidateRelaunched !== true ||
      recovery.visibleWindowObserved !== true ||
      !Number.isInteger(recovery.ownedProcessCount) ||
      recovery.ownedProcessCount < 1 ||
      recovery.aiChildProcessCount !== 0 ||
      recovery.applicationErrorQueryAvailable !== true ||
      recovery.applicationErrorCount !== 0 ||
      recovery.processCountAfterProbeStop !== 0 ||
      !hasExactKeys(recovery.databaseCapture, [
        "reportFileName",
        "reportBytes",
        "reportSha256",
        "fixtureFileName",
        "fixtureBytes",
        "fixtureSha256",
        "ready",
        "attestation",
        "sourceHealth",
        "fixtureHealth",
        "fixtureSidecarCount",
      ]) ||
      recovery.databaseCapture.reportFileName !== "release-first-start-recovery-database.json" ||
      recovery.databaseCapture.reportBytes !== captureReportBytes ||
      recovery.databaseCapture.reportSha256 !== captureReportSha256 ||
      recovery.databaseCapture.fixtureFileName !== path.basename(fixturePath) ||
      recovery.databaseCapture.fixtureBytes !== fixtureMetadata.size ||
      recovery.databaseCapture.fixtureSha256 !== fixtureSha256 ||
      recovery.databaseCapture.ready !== true ||
      recovery.databaseCapture.attestation !== "synthetic_fresh_first_start" ||
      !exact(recovery.databaseCapture.sourceHealth, captureReport.source.healthBeforeCheckpoint) ||
      !exact(recovery.databaseCapture.fixtureHealth, fixtureHealth) ||
      recovery.databaseCapture.fixtureSidecarCount !== 0 ||
      !captureReportMatches(
        captureReport,
        path.basename(fixturePath),
        fixtureMetadata.size,
        fixtureSha256,
        fixtureHealth,
      )
    ) {
      return false;
    }

    return (
      hasExactKeys(report.cleanup, [
        "formalDataRootRemoved",
        "stageRootRemoved",
        "evidenceTempRootRemoved",
        "applicationProcessCount",
      ]) &&
      report.cleanup.formalDataRootRemoved === true &&
      report.cleanup.stageRootRemoved === true &&
      report.cleanup.evidenceTempRootRemoved === true &&
      report.cleanup.applicationProcessCount === 0
    );
  } catch {
    return false;
  }
}

function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--report") {
    return { reportPath: path.resolve(argv[1]) };
  }
  throw new Error("usage: node scripts/verify_first_start_recovery_evidence.mjs [--report path]");
}

export async function verifyFirstStartRecoveryFiles({ reportPath } = {}) {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
  const effectiveReportPath = reportPath ??
    path.join(releaseRoot, "release-first-start-recovery-probe.json");
  const evidenceRoot = path.dirname(effectiveReportPath);
  const captureReportPath = path.join(evidenceRoot, "release-first-start-recovery-database.json");
  const fixturePath = path.join(evidenceRoot, "release-first-start-recovery.sqlite3");
  const manifestPath = path.join(releaseRoot, "release-manifest.json");
  const probeScriptPath = path.join(projectRoot, "scripts", "probe_release_first_start_recovery.ps1");
  const captureHelperPath = path.join(
    projectRoot,
    "scripts",
    "capture_first_start_recovery_database.mjs",
  );
  const [reportBytes, captureBytes, manifestBytes] = await Promise.all([
    readFile(effectiveReportPath),
    readFile(captureReportPath),
    readFile(manifestPath),
  ]);
  const report = parseJsonBytes(reportBytes);
  const captureReport = parseJsonBytes(captureBytes);
  const manifest = parseJsonBytes(manifestBytes);
  const matches = await firstStartRecoveryEvidenceMatches({
    report,
    captureReport,
    fixturePath,
    manifest,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex").toUpperCase(),
    probeScriptSha256: await sha256(probeScriptPath),
    captureHelperSha256: await sha256(captureHelperPath),
    captureReportBytes: captureBytes.length,
    captureReportSha256: createHash("sha256")
      .update(captureBytes)
      .digest("hex")
      .toUpperCase(),
  });
  if (!matches) throw new Error("first_start_recovery_evidence_mismatch");
  return { report, fixturePath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyFirstStartRecoveryFiles(parseArguments(process.argv.slice(2)))
    .then(({ report }) => {
      process.stdout.write(
        `First-start recovery evidence verified: ${report.bindings.databaseFixtureSha256}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`First-start recovery evidence verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
