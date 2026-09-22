import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const upgradeRoot = path.join(projectRoot, "src-tauri", "target", "windows-upgrade-e2e");
const baselineRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "windows-upgrade-baseline",
  "pre013-aaffe998e3bf-v1.5.7",
);
const expectedSourceCommit = "aaffe998e3bfe37e7c2dcd5a83a9bc69e9002b23";
const sha256Pattern = /^[0-9A-F]{64}$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function findCandidateInstaller() {
  const root = path.join(projectRoot, "src-tauri", "target", "release", "bundle", "nsis");
  const names = (await readdir(root)).filter((name) => /_1\.5\.8_x64-setup\.exe$/u.test(name));
  assert(names.length === 1, "current release must contain exactly one 1.5.8 NSIS installer");
  return path.join(root, names[0]);
}

async function latestReportPath() {
  const entries = await readdir(upgradeRoot, { withFileTypes: true });
  const runNames = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{9}Z$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  assert(runNames.length > 0, "no Windows upgrade E2E run was found");
  return path.join(upgradeRoot, runNames[0], "windows-upgrade-e2e-status.json");
}

function assertV12Inspection(inspection, label) {
  assert(inspection?.schemaVersion === 12, `${label} must remain at schema 12`);
  assert(inspection.reminderPreserved === true, `${label} lost the reminder fixture`);
  assert(inspection.occurrencePreserved === true, `${label} lost the occurrence fixture`);
  assert(inspection.foreignKeyViolations === 0, `${label} has foreign-key violations`);
  assert(inspection.mealRejectedAfterRollback === true, `${label} unexpectedly accepts meal`);
}

export function verifyUpgradeDocument(report) {
  assert(report?.schemaVersion === 1, "upgrade E2E report schema is unsupported");
  assert(report.profile === "windows-sandbox-v1.5.7-to-v1.5.8-upgrade-e2e", "profile mismatch");
  assert(report.sandboxUser === "WDAGUtilityAccount", "report did not run in Windows Sandbox");
  assert(report.interactiveSession === true, "Sandbox session was not interactive");
  assert(report.syntheticDataOnly === true, "report did not preserve the synthetic-data boundary");
  assert(report.ready === true && report.failure === null, "upgrade E2E report is not ready");

  assert(report.baseline?.version === "1.5.7" && report.baseline.launched === true, "baseline did not launch");
  assert(report.baseline.source?.commit === expectedSourceCommit, "baseline source commit drifted");
  assert(report.baseline.source.originalVersion === "1.5.5", "baseline original version drifted");
  assert(report.baseline.source.effectiveVersion === "1.5.7", "baseline version override drifted");
  assert(report.baseline.source.versionOverrideOnly === true, "baseline was not a version-only reconstruction");
  assert(report.baseline.source.maximumReminderSchema === 12, "baseline is not pre-013");
  assertV12Inspection(report.baseline.seedInspection, "baseline seed");
  assertV12Inspection(report.baseline.postLaunchInspection, "baseline post-launch database");

  assert(report.candidate?.version === "1.5.8" && report.candidate.launched === true, "candidate did not launch");
  assert(report.database?.beforeUpgradeSha256 === report.database.afterInstallerBeforeLaunchSha256, "installer changed the database before first launch");
  assert(report.database.afterUpgradeSha256 !== report.database.beforeUpgradeSha256, "candidate did not migrate the database");
  assert(report.database.seed?.schemaVersion === 12 && report.database.seed.mealRejectedBeforeUpgrade === true, "schema-12 seed is invalid");
  assert(report.database.inspection?.schemaVersion === 13, "candidate did not reach schema 13");
  assert(report.database.inspection.reminderPreserved === true, "candidate lost the reminder fixture");
  assert(report.database.inspection.occurrencePreserved === true, "candidate lost the occurrence fixture");
  assert(report.database.inspection.foreignKeyViolations === 0, "candidate has foreign-key violations");
  assert(report.database.inspection.requiredIndexesPresent === true, "candidate lost required indexes");
  assert(report.database.inspection.mealCategory === "meal", "candidate cannot create meal reminders");

  assert(report.rollback?.version === "1.5.7" && report.rollback.launched === true, "rollback did not launch");
  assert(report.rollback.installedCoreSha256 === report.baseline.installedCoreSha256, "rollback core differs from baseline");
  assert(report.rollback.snapshotSha256 === report.rollback.restoredDatabaseSha256, "rollback snapshot was not restored exactly");
  assert(report.rollback.restoredDatabaseSha256 === report.rollback.postLaunchDatabaseSha256, "rollback launch changed the restored database bytes");
  assert(report.rollback.inspectionExitCode === 0 && report.rollback.inspectionError === null, "rollback inspector failed");
  assert(report.rollback.markerPresentAfterLaunch === true, "rollback ownership marker disappeared");
  assertV12Inspection(report.rollback.preLaunchInspection, "rollback pre-launch database");
  assertV12Inspection(report.rollback.postLaunchInspection, "rollback post-launch database");

  assert(report.cleanup?.candidateUninstallExitCode === 0, "candidate uninstall failed");
  assert(report.cleanup.rollbackUninstallExitCode === 0, "rollback uninstall failed");
  assert(report.cleanup.installRootRemoved === true, "installed files remain after cleanup");
  assert(report.cleanup.upgradedDataPreservedByDefaultUninstall === true, "candidate uninstall lost data");
  assert(report.cleanup.restoredDataPreservedByRollbackUninstall === true, "rollback uninstall lost data");
  assert(report.cleanup.ownedSyntheticDataRemoved === true, "owned synthetic data was not cleaned");

  for (const [label, value] of Object.entries({
    baselineInstaller: report.baseline.installerSha256,
    baselineCore: report.baseline.installedCoreSha256,
    baselineMetadata: report.baseline.metadataSha256,
    candidateInstaller: report.candidate.installerSha256,
    candidateCore: report.candidate.installedCoreSha256,
    helper: report.evidence?.helperSha256,
    guestScript: report.evidence?.guestScriptSha256,
    hostScript: report.evidence?.hostScriptSha256,
  })) {
    assert(typeof value === "string" && sha256Pattern.test(value), `${label} SHA-256 is invalid`);
  }
}

async function main() {
  const reportArgument = process.argv[2];
  const reportPath = reportArgument ? path.resolve(reportArgument) : await latestReportPath();
  const report = await readJson(reportPath);
  verifyUpgradeDocument(report);

  const baselineMetadataPath = path.join(baselineRoot, "artifacts", "baseline-metadata.json");
  const baselineMetadata = await readJson(baselineMetadataPath);
  const baselineInstallerPath = path.join(baselineRoot, "artifacts", baselineMetadata.installer.fileName);
  const candidateInstallerPath = await findCandidateInstaller();
  const artifacts = {
    baselineInstaller: [baselineInstallerPath, report.baseline.installerSha256],
    baselineMetadata: [baselineMetadataPath, report.baseline.metadataSha256],
    candidateInstaller: [candidateInstallerPath, report.candidate.installerSha256],
    helper: [
      path.join(projectRoot, "src-tauri", "target", "release", "yuanyuan-installed-candidate-qa.exe"),
      report.evidence.helperSha256,
    ],
    baselineBuilder: [
      path.join(projectRoot, "scripts", "build_windows_upgrade_baseline.ps1"),
      baselineMetadata.builderScriptSha256,
    ],
    guestScript: [
      path.join(projectRoot, "scripts", "run_windows_upgrade_e2e_sandbox.ps1"),
      report.evidence.guestScriptSha256,
    ],
    hostScript: [
      path.join(projectRoot, "scripts", "run_windows_upgrade_e2e_sandbox_host.ps1"),
      report.evidence.hostScriptSha256,
    ],
  };
  for (const [label, [filePath, expectedHash]] of Object.entries(artifacts)) {
    assert((await sha256(filePath)) === expectedHash, `${label} no longer matches the E2E report`);
  }
  assert(baselineMetadata.ready === true, "baseline metadata is not ready");
  assert(baselineMetadata.source.commit === expectedSourceCommit, "baseline metadata source drifted");
  assert(baselineMetadata.installedCore.sha256 === report.baseline.installedCoreSha256, "baseline installed-core binding drifted");

  process.stdout.write(`Windows upgrade E2E evidence verified: ${reportPath}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Windows upgrade E2E evidence verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
