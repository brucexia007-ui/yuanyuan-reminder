import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sha256Pattern = /^[0-9A-F]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(message) {
  throw new Error(`installed-candidate E2E evidence rejected: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function exactKeys(value, expected, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireValue(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys are not exact`);
}

function allTrue(value, keys, label) {
  exactKeys(value, keys, label);
  for (const key of keys) requireValue(value[key] === true, `${label}.${key} must be true`);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function sha256(file) {
  const digest = createHash("sha256");
  digest.update(await readFile(file));
  return digest.digest("hex").toUpperCase();
}

function gitText(arguments_) {
  return execFileSync("git", ["-C", projectRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function currentSource() {
  return {
    branch: gitText(["branch", "--show-current"]),
    commit: gitText(["rev-parse", "HEAD"]),
    dirty: gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0,
  };
}

export function validateInstalledE2eEvidence({
  status,
  payload,
  uninstall,
  webView,
  sourceMetadata,
  candidateStageManifest,
  candidateStageBinding,
  authority,
  brand,
  tauriConfig,
  packageJson,
  observed,
  requireClean = true,
}) {
  exactKeys(status, [
    "schemaVersion",
    "generatedAt",
    "profile",
    "sandboxUser",
    "interactiveSession",
    "syntheticDataOnly",
    "candidateUsesEmbeddedOnlineWebView2Bootstrapper",
    "mappedMicrosoftWebView2RuntimeVerified",
    "mappedMicrosoftWebView2RuntimeSha256",
    "temporaryWebView2DetectionRegistration",
    "candidateCopiedToSandboxDisk",
    "payloadInspectionPassed",
    "uninstallDataChoicePassed",
    "functional",
    "reportsCopied",
    "failureDiagnostics",
    "source",
    "sourceMetadataSha256",
    "probeScriptSha256",
    "hostScriptSha256",
    "candidateStage",
    "evidenceFileBindings",
    "ready",
    "failure",
  ], "status");
  requireValue(status.schemaVersion === 2, "status schemaVersion must be 2");
  requireValue(status.profile === "community-stable-installed-e2e", "status profile is wrong");
  requireValue(status.sandboxUser === "WDAGUtilityAccount", "status was not captured in Windows Sandbox");
  for (const key of [
    "interactiveSession",
    "syntheticDataOnly",
    "candidateUsesEmbeddedOnlineWebView2Bootstrapper",
    "mappedMicrosoftWebView2RuntimeVerified",
    "temporaryWebView2DetectionRegistration",
    "candidateCopiedToSandboxDisk",
    "payloadInspectionPassed",
    "uninstallDataChoicePassed",
    "reportsCopied",
    "ready",
  ]) requireValue(status[key] === true, `status.${key} must be true`);
  requireValue(status.failure === null && status.failureDiagnostics === null, "status contains a failure");
  requireValue(Number.isFinite(Date.parse(status.generatedAt)), "status generatedAt is invalid");

  exactKeys(status.source, ["schemaVersion", "capturedAt", "branch", "commit", "dirty"], "status.source");
  requireValue(status.source.schemaVersion === 1, "source schemaVersion must be 1");
  requireValue(Number.isFinite(Date.parse(status.source.capturedAt)), "source capturedAt is invalid");
  requireValue(status.source.branch === observed.source.branch && status.source.branch.length > 0, "source branch does not match current checkout");
  requireValue(commitPattern.test(status.source.commit), "source commit is invalid");
  requireValue(status.source.commit === observed.source.commit, "source commit does not match current checkout");
  requireValue(status.source.dirty === observed.source.dirty, "source dirty state does not match current checkout");
  if (requireClean) requireValue(status.source.dirty === false, "formal evidence requires a clean source checkout");
  requireValue(JSON.stringify(status.source) === JSON.stringify(sourceMetadata), "source metadata file does not match status");

  exactKeys(status.candidateStage, [
    "manifestSha256",
    "bindingSha256",
    "stageVerifierSha256",
    "applicationSha256",
    "installerSha256",
  ], "status.candidateStage");
  exactKeys(candidateStageBinding, [
    "schemaVersion",
    "verifiedAt",
    "stageManifestSha256",
    "stageVerifierSha256",
    "application",
    "installer",
  ], "candidateStageBinding");
  requireValue(candidateStageBinding.schemaVersion === 1, "candidate stage binding schemaVersion must be 1");
  requireValue(Number.isFinite(Date.parse(candidateStageBinding.verifiedAt)), "candidate stage verifiedAt is invalid");
  exactKeys(candidateStageManifest, [
    "schemaVersion",
    "createdAt",
    "product",
    "source",
    "build",
    "sourceRelease",
    "artifacts",
    "configBindings",
  ], "candidateStageManifest");
  requireValue(candidateStageManifest.schemaVersion === 1, "candidate stage manifest schemaVersion must be 1");
  requireValue(Number.isFinite(Date.parse(candidateStageManifest.createdAt)), "candidate stage createdAt is invalid");
  exactKeys(candidateStageManifest.product, ["name", "version", "identifier", "packageName"], "candidateStageManifest.product");
  exactKeys(candidateStageManifest.source, ["commit", "branch", "dirty"], "candidateStageManifest.source");
  exactKeys(candidateStageManifest.build, ["startedAt", "installerWrittenAt"], "candidateStageManifest.build");
  exactKeys(
    candidateStageManifest.sourceRelease,
    ["versionMatchedInstallerNames", "selectedInstallerFileName"],
    "candidateStageManifest.sourceRelease",
  );
  exactKeys(candidateStageManifest.artifacts, ["application", "installer"], "candidateStageManifest.artifacts");
  exactKeys(candidateStageManifest.configBindings, [
    "productVersionSha256",
    "productBrandSha256",
    "tauriConfigSha256",
    "packageJsonSha256",
  ], "candidateStageManifest.configBindings");
  for (const label of ["application", "installer"]) {
    exactKeys(candidateStageManifest.artifacts[label], ["fileName", "bytes", "sha256"], `candidateStageManifest.${label}`);
    exactKeys(candidateStageBinding[label], ["fileName", "bytes", "sha256"], `candidateStageBinding.${label}`);
    requireValue(
      JSON.stringify(candidateStageManifest.artifacts[label]) === JSON.stringify(candidateStageBinding[label]),
      `candidate stage ${label} binding does not match its manifest`,
    );
    requireValue(Number.isSafeInteger(candidateStageBinding[label].bytes) && candidateStageBinding[label].bytes > 0, `candidate stage ${label} bytes are invalid`);
    requireValue(sha256Pattern.test(candidateStageBinding[label].sha256), `candidate stage ${label} SHA-256 is invalid`);
  }
  requireValue(candidateStageManifest.product.name === authority.productName, "candidate stage product name is stale");
  requireValue(candidateStageManifest.product.version === authority.version, "candidate stage version is stale");
  requireValue(candidateStageManifest.product.identifier === authority.identifier, "candidate stage identifier is stale");
  requireValue(candidateStageManifest.product.packageName === packageJson.name, "candidate stage package name is stale");
  requireValue(candidateStageManifest.product.name === brand.application?.displayName, "candidate stage brand name is stale");
  requireValue(candidateStageManifest.product.identifier === brand.application?.identifier, "candidate stage brand identifier is stale");
  requireValue(candidateStageManifest.product.identifier === tauriConfig.identifier, "candidate stage Tauri identifier is stale");
  requireValue(candidateStageManifest.product.name === tauriConfig.productName, "candidate stage Tauri product name is stale");
  requireValue(candidateStageManifest.product.version === tauriConfig.version, "candidate stage Tauri version is stale");
  const expectedInstallerName = `${brand.artifacts?.installerBaseName}_${authority.version}_x64-setup.exe`;
  requireValue(candidateStageBinding.application.fileName === "yuanyuan-reminder.exe", "candidate stage application file name is stale");
  requireValue(candidateStageBinding.installer.fileName === expectedInstallerName, "candidate stage installer file name is stale");
  requireValue(
    candidateStageManifest.sourceRelease.selectedInstallerFileName === expectedInstallerName &&
      Array.isArray(candidateStageManifest.sourceRelease.versionMatchedInstallerNames) &&
      candidateStageManifest.sourceRelease.versionMatchedInstallerNames.includes(expectedInstallerName),
    "candidate stage source installer inventory is stale",
  );
  requireValue(
    candidateStageManifest.source.branch === observed.source.branch &&
      candidateStageManifest.source.commit === observed.source.commit &&
      candidateStageManifest.source.dirty === observed.source.dirty,
    "candidate stage source does not match current checkout",
  );
  requireValue(
    JSON.stringify(candidateStageManifest.configBindings) === JSON.stringify(observed.configBindings),
    "candidate stage configuration binding is stale",
  );
  requireValue(candidateStageBinding.stageManifestSha256 === observed.candidateStageManifestSha256, "candidate stage manifest binding is stale");
  requireValue(candidateStageBinding.stageVerifierSha256 === observed.stageVerifierSha256, "candidate stage verifier binding is stale");
  requireValue(status.candidateStage.manifestSha256 === observed.candidateStageManifestSha256, "status candidate stage manifest binding is stale");
  requireValue(status.candidateStage.bindingSha256 === observed.candidateStageBindingSha256, "status candidate stage binding hash is stale");
  requireValue(status.candidateStage.stageVerifierSha256 === observed.stageVerifierSha256, "status candidate stage verifier binding is stale");
  requireValue(status.candidateStage.applicationSha256 === candidateStageBinding.application.sha256, "status candidate application binding is stale");
  requireValue(status.candidateStage.installerSha256 === candidateStageBinding.installer.sha256, "status candidate installer binding is stale");
  exactKeys(status.evidenceFileBindings, [
    "payloadReportSha256",
    "uninstallReportSha256",
    "webViewMetadataSha256",
  ], "status.evidenceFileBindings");
  for (const [label, actual, expected] of [
    ["payload report", status.evidenceFileBindings.payloadReportSha256, observed.payloadReportSha256],
    ["uninstall report", status.evidenceFileBindings.uninstallReportSha256, observed.uninstallReportSha256],
    ["WebView metadata", status.evidenceFileBindings.webViewMetadataSha256, observed.webViewMetadataSha256],
  ]) {
    requireValue(sha256Pattern.test(actual), `${label} evidence SHA-256 is invalid`);
    requireValue(actual === expected, `${label} evidence SHA-256 does not match`);
  }

  for (const [label, actual, expected] of [
    ["source metadata", status.sourceMetadataSha256, observed.sourceMetadataSha256],
    ["Sandbox probe script", status.probeScriptSha256, observed.probeScriptSha256],
    ["Sandbox host script", status.hostScriptSha256, observed.hostScriptSha256],
    ["mapped WebView2 runtime", status.mappedMicrosoftWebView2RuntimeSha256, webView.sha256],
  ]) {
    requireValue(sha256Pattern.test(actual), `${label} SHA-256 is invalid`);
    requireValue(actual === expected, `${label} SHA-256 does not match`);
  }

  requireValue(authority.version === packageJson.version, "product version authority and package disagree");
  requireValue(payload.ready === true && payload.mode === "nsis_installed_payload", "payload report is not ready");
  requireValue(payload.candidate.productVersion === authority.version, "payload product version is wrong");
  requireValue(payload.candidate.installedProductVersion === authority.version, "installed payload version is wrong");
  requireValue(payload.candidate.bothUnsigned === true, "community candidate unsigned disclosure changed");
  requireValue(payload.candidate.exactUnsignedMarkerPatch === true, "NSIS marker patch is not exact");
  exactKeys(payload.installation, [
    "installExitCode",
    "customTemporaryInstallRoot",
    "preexistingApplicationProcessCount",
    "preexistingProductRegistration",
    "preexistingShortcut",
    "licenseFiles",
    "licenseFilesExact",
    "licenseHashesMatch",
    "licenseBindings",
  ], "payload installation");
  requireValue(payload.installation.installExitCode === 0, "payload installation failed");
  requireValue(
    JSON.stringify(payload.installation.licenseFiles) === JSON.stringify([
      "ASSETS_LICENSE.md",
      "LICENSE.txt",
      "THIRD_PARTY_LICENSES.txt",
      "THIRD_PARTY_NOTICES.md",
    ]),
    "installed payload license file set is stale",
  );
  requireValue(payload.installation.licenseFilesExact === true, "installed payload license file set is not exact");
  requireValue(payload.installation.licenseHashesMatch === true, "installed payload license hashes do not match source materials");
  requireValue(
    Array.isArray(payload.installation.licenseBindings)
      && payload.installation.licenseBindings.length === payload.installation.licenseFiles.length,
    "installed payload license bindings are incomplete",
  );
  payload.installation.licenseBindings.forEach((binding, index) => {
    exactKeys(binding, ["fileName", "sourceSha256", "installedSha256", "matches"], `payload license binding ${index}`);
    const expectedFileName = payload.installation.licenseFiles[index];
    requireValue(binding.fileName === expectedFileName, "installed payload license binding order is stale");
    requireValue(sha256Pattern.test(binding.sourceSha256), "installed payload source license SHA-256 is invalid");
    requireValue(sha256Pattern.test(binding.installedSha256), "installed payload license SHA-256 is invalid");
    requireValue(binding.sourceSha256 === observed.licenseSourceSha256[expectedFileName], "installed payload source license binding is stale");
    requireValue(binding.installedSha256 === binding.sourceSha256, "installed payload license bytes differ from source materials");
    requireValue(binding.matches === true, "installed payload license binding is not matched");
  });
  requireValue(payload.bindings.inspectionScriptSha256 === observed.payloadScriptSha256, "payload inspector binding is stale");
  requireValue(payload.bindings.sourceStableCoreSha256 === observed.sourceCoreSha256, "source core binding is stale");
  requireValue(payload.bindings.installerSha256 === observed.installerSha256, "payload installer binding is stale");
  requireValue(payload.cleanup.uninstallExitCode === 0, "payload inspection uninstall failed");
  for (const key of [
    "installRootRemoved",
    "uninstallRegistrationRemoved",
    "productRegistrationPersistedAfterUninstall",
    "ownedProductRegistrationRemoved",
    "desktopShortcutStatePreserved",
    "startMenuShortcutStatePreserved",
  ]) requireValue(payload.cleanup[key] === true, `payload cleanup.${key} must be true`);
  requireValue(payload.cleanup.applicationProcessCount === 0, "payload cleanup left an application process");

  exactKeys(status.functional, [
    "installerSha256",
    "installedCoreSha256",
    "helperSha256",
    "helperSeedExitCode",
    "helperAddOverdueNotifyExitCode",
    "helperAddMissedExitCode",
    "helperAutomaticBackupExitCode",
    "installExitCode",
    "scenarios",
    "reminder",
    "overdueNotifyEvidence",
    "snoozedReminder",
    "snoozeEvidence",
    "missedReminder",
    "missedReminderEvidence",
    "automaticBackupEvidence",
    "mutation",
    "panelDragEvidence",
    "petIdentity",
    "formalUserDataUsed",
    "cleanup",
  ], "status.functional");
  requireValue(status.functional.installerSha256 === observed.installerSha256, "functional installer binding is stale");
  requireValue(status.functional.installedCoreSha256 === payload.bindings.installedCoreSha256, "functional installed core binding is stale");
  requireValue(status.functional.helperSha256 === observed.helperSha256, "functional helper binding is stale");
  requireValue(
    status.functional.helperSeedExitCode === 0
      && status.functional.helperAddOverdueNotifyExitCode === 0
      && status.functional.helperAddMissedExitCode === 0
      && status.functional.helperAutomaticBackupExitCode === 0
      && status.functional.installExitCode === 0,
    "installation or reminder setup exited unsuccessfully",
  );
  requireValue(status.functional.formalUserDataUsed === false, "functional E2E used formal user data");
  exactKeys(status.functional.petIdentity, [
    "displayName",
    "sex",
    "breed",
    "personality",
    "accessibleDescription",
    "observedLaunchCount",
  ], "status.functional.petIdentity");
  const expectedSexLabel = { female: "母猫", male: "公猫", unknown: "猫咪" }[brand.pet?.sex];
  requireValue(typeof expectedSexLabel === "string", "product brand pet sex is invalid");
  requireValue(status.functional.petIdentity.displayName === brand.pet.displayName, "installed pet display name is stale");
  requireValue(status.functional.petIdentity.sex === brand.pet.sex, "installed pet sex is stale");
  requireValue(status.functional.petIdentity.breed === brand.pet.breed, "installed pet breed is stale");
  requireValue(status.functional.petIdentity.personality === brand.pet.personality, "installed pet personality is stale");
  requireValue(
    status.functional.petIdentity.accessibleDescription
      === `${brand.pet.displayName}：${brand.pet.breed}${expectedSexLabel}，性格${brand.pet.personality}`,
    "installed pet accessible identity description is stale",
  );
  requireValue(status.functional.petIdentity.observedLaunchCount === 5, "installed pet identity was not observed on all launches");
  allTrue(status.functional.scenarios, [
    "installAndLaunch",
    "snoozeThirtyMinutes",
    "missedReminderNotify",
    "missedReminderSkipOld",
    "reminderDelivery",
    "hideAndRestorePet",
    "panelDrag",
    "automaticBackup",
    "backupAndRestore",
    "restartPersistence",
    "uninstallKeepsDataByDefault",
  ], "status.functional.scenarios");
  allTrue(status.functional.cleanup, [
    "applicationExited",
    "installRootRemoved",
    "dataRootRemoved",
    "roamingDataRootAbsent",
    "uninstallRegistrationRemoved",
    "productRegistrationPersistedAfterUninstall",
    "ownedProductRegistrationRemoved",
    "shortcutsRemoved",
    "sandboxShutdownRequested",
  ], "status.functional.cleanup");
  requireValue(uuidPattern.test(status.functional.reminder.reminderId), "seed reminder id is invalid");
  requireValue(uuidPattern.test(status.functional.snoozedReminder.reminderId), "snoozed reminder id is invalid");
  requireValue(uuidPattern.test(status.functional.missedReminder.reminderId), "missed reminder id is invalid");
  requireValue(uuidPattern.test(status.functional.mutation.reminderId), "mutation reminder id is invalid");
  requireValue(
    new Set([
      status.functional.reminder.reminderId,
      status.functional.snoozedReminder.reminderId,
      status.functional.missedReminder.reminderId,
      status.functional.mutation.reminderId,
    ]).size === 4,
    "functional reminder ids are not distinct",
  );
  requireValue(/^E2E错过仍提醒-[0-9a-f]{8}$/u.test(status.functional.reminder.title), "overdue notify reminder title is not synthetic");
  requireValue(/^E2E提醒-[0-9a-f]{8}$/u.test(status.functional.snoozedReminder.title), "snoozed reminder title is not synthetic");
  requireValue(/^E2E错过自动跳过-[0-9a-f]{8}$/u.test(status.functional.missedReminder.title), "missed reminder title is not synthetic");
  requireValue(/^E2E变更-[0-9a-f]{8}$/u.test(status.functional.mutation.title), "mutation title is not synthetic");
  requireValue(Number.isFinite(Date.parse(status.functional.reminder.scheduledAt)), "seed schedule is invalid");
  requireValue(Number.isFinite(Date.parse(status.functional.snoozedReminder.scheduledAt)), "snoozed reminder schedule is invalid");
  requireValue(Number.isFinite(Date.parse(status.functional.missedReminder.scheduledAt)), "missed reminder schedule is invalid");
  const overdueNotify = status.functional.overdueNotifyEvidence;
  exactKeys(overdueNotify, [
    "reminderId",
    "policyAccessibleName",
    "selectedPolicy",
    "overdueMinutes",
    "observedAt",
    "alertObserved",
    "occurrenceStatus",
  ], "overdueNotifyEvidence");
  requireValue(overdueNotify.reminderId === status.functional.reminder.reminderId, "installed overdue-notify reminder binding is stale");
  requireValue(
    overdueNotify.policyAccessibleName === "错过提醒策略，可选恢复后仍提醒、自动归入已跳过",
    "installed overdue-notify policy accessibility name is stale",
  );
  requireValue(overdueNotify.selectedPolicy === "恢复后仍提醒", "installed default overdue-notify policy is missing");
  requireValue(overdueNotify.overdueMinutes === 16, "installed overdue-notify reminder age is wrong");
  requireValue(Number.isFinite(Date.parse(overdueNotify.observedAt)), "installed overdue-notify observation time is invalid");
  const observedOverdueNotifyAgeMinutes = (
    Date.parse(overdueNotify.observedAt) - Date.parse(status.functional.reminder.scheduledAt)
  ) / 60_000;
  requireValue(
    observedOverdueNotifyAgeMinutes >= 16 && observedOverdueNotifyAgeMinutes <= 20,
    "installed overdue-notify schedule and recorded age disagree",
  );
  requireValue(overdueNotify.alertObserved === true, "installed default policy did not show the overdue reminder");
  requireValue(
    ["pending", "overdue"].includes(overdueNotify.occurrenceStatus),
    "installed overdue-notify occurrence is not active",
  );
  const automaticBackup = status.functional.automaticBackupEvidence;
  exactKeys(automaticBackup, [
    "uiLabel",
    "firstLaunchStartedAt",
    "fileName",
    "createdAt",
    "sizeBytes",
    "sha256",
    "automatic",
    "learningIncluded",
    "databaseHealthy",
    "reminderId",
    "reminderPresent",
  ], "automaticBackupEvidence");
  requireValue(automaticBackup.uiLabel === "自动备份", "installed automatic backup label is stale");
  requireValue(Number.isFinite(Date.parse(automaticBackup.firstLaunchStartedAt)), "installed automatic backup first-launch time is invalid");
  requireValue(/^auto-\d{4}-\d{2}-\d{2}\.sqlite3$/u.test(automaticBackup.fileName), "installed automatic backup file name is invalid");
  requireValue(Number.isFinite(Date.parse(automaticBackup.createdAt)), "installed automatic backup creation time is invalid");
  requireValue(
    Date.parse(automaticBackup.createdAt) >= Date.parse(automaticBackup.firstLaunchStartedAt)
      && Date.parse(automaticBackup.createdAt) <= Date.parse(status.functional.snoozeEvidence.observedAt),
    "installed automatic backup was not created during the first-launch window",
  );
  requireValue(Number.isSafeInteger(automaticBackup.sizeBytes) && automaticBackup.sizeBytes > 0, "installed automatic backup is empty");
  requireValue(sha256Pattern.test(automaticBackup.sha256), "installed automatic backup SHA-256 is invalid");
  requireValue(automaticBackup.automatic === true, "installed backup is not automatic");
  requireValue(automaticBackup.learningIncluded === false, "fresh installed automatic backup unexpectedly contains a learning database");
  requireValue(automaticBackup.databaseHealthy === true, "installed automatic backup database is unhealthy");
  requireValue(automaticBackup.reminderId === status.functional.snoozedReminder.reminderId, "installed automatic backup reminder binding is stale");
  requireValue(automaticBackup.reminderPresent === true, "installed automatic backup omitted the seeded reminder");
  const missedReminder = status.functional.missedReminderEvidence;
  exactKeys(missedReminder, [
    "reminderId",
    "policyAccessibleName",
    "selectedPolicy",
    "graceAccessibleName",
    "selectedGrace",
    "overdueMinutes",
    "observedAt",
    "alertObserved",
    "occurrenceStatus",
    "resolutionReason",
  ], "missedReminderEvidence");
  requireValue(missedReminder.reminderId === status.functional.missedReminder.reminderId, "installed missed-reminder binding is stale");
  requireValue(
    missedReminder.policyAccessibleName === "错过提醒策略，可选恢复后仍提醒、自动归入已跳过",
    "installed missed-reminder policy accessibility name is stale",
  );
  requireValue(missedReminder.selectedPolicy === "自动归入已跳过", "installed skip-old policy selection is missing");
  requireValue(
    missedReminder.graceAccessibleName === "错过提醒宽限，可选 15、30、60、120、240 分钟",
    "installed missed-reminder grace accessibility name is stale",
  );
  requireValue(missedReminder.selectedGrace === "15 分钟", "installed missed-reminder grace selection is missing");
  requireValue(missedReminder.overdueMinutes === 16, "installed missed reminder age is wrong");
  requireValue(Number.isFinite(Date.parse(missedReminder.observedAt)), "installed missed-reminder observation time is invalid");
  const observedMissedAgeMinutes = (
    Date.parse(missedReminder.observedAt) - Date.parse(status.functional.missedReminder.scheduledAt)
  ) / 60_000;
  requireValue(
    observedMissedAgeMinutes >= 16 && observedMissedAgeMinutes <= 18,
    "installed missed-reminder schedule and recorded age disagree",
  );
  requireValue(missedReminder.alertObserved === false, "installed skip-old reminder produced an alert");
  requireValue(missedReminder.occurrenceStatus === "skipped", "installed missed reminder was not skipped");
  requireValue(missedReminder.resolutionReason === "missed", "installed skipped reminder lacks the missed reason");
  const snooze = status.functional.snoozeEvidence;
  exactKeys(snooze, [
    "reminderId",
    "accessibleName",
    "selectedMinutes",
    "selectedValue",
    "outcomeLabel",
    "occurrenceStatus",
    "observedAt",
    "snoozedUntil",
    "remainingSeconds",
  ], "snoozeEvidence");
  requireValue(snooze.reminderId === status.functional.snoozedReminder.reminderId, "installed snooze reminder binding is stale");
  requireValue(
    snooze.accessibleName === "稍后提醒时长，可选 5、10、30、60 分钟",
    "installed snooze control accessibility name is stale",
  );
  requireValue(snooze.selectedMinutes === 30 && snooze.selectedValue === "30 分钟", "installed 30-minute snooze selection is missing");
  requireValue(snooze.outcomeLabel === `提醒已延后；${brand.pet.displayName}安静等候`, "installed snooze outcome is stale");
  requireValue(snooze.occurrenceStatus === "snoozed", "installed reminder was not snoozed");
  requireValue(Number.isFinite(Date.parse(snooze.observedAt)), "installed snooze observation time is invalid");
  requireValue(Number.isFinite(Date.parse(snooze.snoozedUntil)), "installed snooze deadline is invalid");
  requireValue(
    Number.isInteger(snooze.remainingSeconds)
      && snooze.remainingSeconds >= 1500
      && snooze.remainingSeconds <= 1900,
    "installed snooze duration is outside the 30-minute range",
  );
  const observedRemainingSeconds = Math.round(
    (Date.parse(snooze.snoozedUntil) - Date.parse(snooze.observedAt)) / 1000,
  );
  requireValue(
    Math.abs(observedRemainingSeconds - snooze.remainingSeconds) <= 2,
    "installed snooze deadline and recorded duration disagree",
  );
  const drag = status.functional.panelDragEvidence;
  exactKeys(drag, ["before", "after", "moved"], "panelDragEvidence");
  requireValue(drag.moved === true, "panel drag was not observed");
  const dx = Math.abs(drag.after.left - drag.before.left);
  const dy = Math.abs(drag.after.top - drag.before.top);
  requireValue(dx >= 40 && dy >= 40, "panel drag distance is below the physical threshold");
  requireValue(drag.before.right - drag.before.left === drag.after.right - drag.after.left, "panel width changed during drag");
  requireValue(drag.before.bottom - drag.before.top === drag.after.bottom - drag.after.top, "panel height changed during drag");

  requireValue(uninstall.ready === true && uninstall.mode === "release_uninstall_data_choice_probe", "uninstall report is not ready");
  requireValue(uninstall.version === authority.version, "uninstall report version is wrong");
  requireValue(uninstall.bindings.probeScriptSha256 === observed.uninstallScriptSha256, "uninstall probe binding is stale");
  requireValue(uninstall.bindings.candidateInstallerSha256 === observed.installerSha256, "uninstall installer binding is stale");
  requireValue(uninstall.bindings.candidateInstalledCoreSha256 === status.functional.installedCoreSha256, "uninstall core binding is stale");
  requireValue(uninstall.bindings.candidateInstallerBytes === observed.installerBytes, "uninstall installer byte binding is stale");
  requireValue(uninstall.scenarios.defaultPreserve.installExitCode === 0, "default-preserve install failed");
  requireValue(uninstall.scenarios.defaultPreserve.uninstallExitCode === 0, "default-preserve uninstall failed");
  requireValue(uninstall.scenarios.defaultPreserve.installedProductVersion === authority.version, "default-preserve version is wrong");
  requireValue(uninstall.scenarios.explicitDelete.installExitCode === 0, "explicit-delete install failed");
  requireValue(uninstall.scenarios.explicitDelete.installedProductVersion === authority.version, "explicit-delete version is wrong");
  for (const value of Object.values(uninstall.scenarios.defaultPreserve)) {
    if (typeof value === "boolean") requireValue(value === true, "default-preserve uninstall scenario is incomplete");
  }
  for (const [key, value] of Object.entries(uninstall.scenarios.explicitDelete)) {
    if (typeof value === "boolean" && key !== "processTreeTimedOut") requireValue(value === true, "explicit-delete uninstall scenario is incomplete");
  }
  requireValue(uninstall.scenarios.explicitDelete.processTreeTimedOut === false, "explicit-delete uninstall timed out");
  requireValue(uninstall.dataBoundary.syntheticSentinelsOnly === true && uninstall.dataBoundary.authenticUserDataUsed === false, "uninstall probe crossed the synthetic data boundary");
  for (const value of Object.values(uninstall.cleanup)) {
    if (typeof value === "boolean") requireValue(value === true, "uninstall cleanup is incomplete");
    if (typeof value === "number") requireValue(value === 0, "uninstall cleanup process count is nonzero");
  }

  requireValue(webView.schemaVersion === 1, "WebView2 metadata schema is wrong");
  requireValue(webView.source === "installed-host-microsoft-webview2-runtime", "WebView2 source is wrong");
  requireValue(webView.signatureStatus === "Valid", "mapped WebView2 signature is invalid");
  requireValue(webView.signerSubject.includes("O=Microsoft Corporation"), "mapped WebView2 signer is not Microsoft");
  requireValue(Number.isInteger(webView.bytes) && webView.bytes > 0, "mapped WebView2 byte count is invalid");
  requireValue(typeof webView.productVersion === "string" && webView.productVersion.length > 0, "mapped WebView2 version is missing");
}

function argumentValue(name) {
  const positions = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length !== 1 || !process.argv[positions[0] + 1]) fail(`${name} must be provided exactly once`);
  return process.argv[positions[0] + 1];
}

async function main() {
  const evidenceRoot = path.resolve(argumentValue("--evidence-root"));
  const allowedRoot = path.join(projectRoot, "src-tauri", "target", "community-stable-sandbox-data") + path.sep;
  requireValue(evidenceRoot.startsWith(allowedRoot), "evidence root is outside the generated Sandbox evidence area");
  const [
    status,
    payload,
    uninstall,
    webView,
    sourceMetadata,
    candidateStageManifest,
    candidateStageBinding,
    authority,
    brand,
    tauriConfig,
    packageJson,
  ] = await Promise.all([
    readJson(path.join(evidenceRoot, "sandbox-data-probe-status.json")),
    readJson(path.join(evidenceRoot, "nsis-installed-payload.json")),
    readJson(path.join(evidenceRoot, "release-uninstall-data-choice-probe.json")),
    readJson(path.join(evidenceRoot, "webview2-mapped-runtime.json")),
    readJson(path.join(evidenceRoot, "source-metadata.json")),
    readJson(path.join(evidenceRoot, "candidate-stage-manifest.json")),
    readJson(path.join(evidenceRoot, "candidate-stage-binding.json")),
    readJson(path.join(projectRoot, "product-version.json")),
    readJson(path.join(projectRoot, "product-brand.json")),
    readJson(path.join(projectRoot, "src-tauri", "tauri.conf.json")),
    readJson(path.join(projectRoot, "package.json")),
  ]);
  requireValue(brand.application?.displayName === authority.productName, "brand application name is stale");
  requireValue(brand.artifacts?.installerBaseName === authority.productName, "brand installer base name is stale");
  const installerName = `${brand.artifacts.installerBaseName}_${authority.version}_x64-setup.exe`;
  requireValue(candidateStageBinding.installer?.fileName === installerName, "candidate stage installer name is stale");
  const observed = {
    source: currentSource(),
    sourceMetadataSha256: await sha256(path.join(evidenceRoot, "source-metadata.json")),
    probeScriptSha256: await sha256(path.join(projectRoot, "scripts", "run_community_stable_sandbox_data_probe.ps1")),
    hostScriptSha256: await sha256(path.join(projectRoot, "scripts", "run_community_stable_sandbox_data_probe_host.ps1")),
    payloadScriptSha256: await sha256(path.join(projectRoot, "scripts", "inspect_nsis_payload.ps1")),
    uninstallScriptSha256: await sha256(path.join(projectRoot, "scripts", "probe_release_uninstall_data_choice.ps1")),
    stageVerifierSha256: await sha256(path.join(projectRoot, "scripts", "verify_community_stable_e2e_stage.mjs")),
    candidateStageManifestSha256: await sha256(path.join(evidenceRoot, "candidate-stage-manifest.json")),
    candidateStageBindingSha256: await sha256(path.join(evidenceRoot, "candidate-stage-binding.json")),
    payloadReportSha256: await sha256(path.join(evidenceRoot, "nsis-installed-payload.json")),
    uninstallReportSha256: await sha256(path.join(evidenceRoot, "release-uninstall-data-choice-probe.json")),
    webViewMetadataSha256: await sha256(path.join(evidenceRoot, "webview2-mapped-runtime.json")),
    configBindings: {
      productVersionSha256: await sha256(path.join(projectRoot, "product-version.json")),
      productBrandSha256: await sha256(path.join(projectRoot, "product-brand.json")),
      tauriConfigSha256: await sha256(path.join(projectRoot, "src-tauri", "tauri.conf.json")),
      packageJsonSha256: await sha256(path.join(projectRoot, "package.json")),
    },
    licenseSourceSha256: {
      "ASSETS_LICENSE.md": await sha256(path.join(projectRoot, brand.assets.licenseFile)),
      "LICENSE.txt": await sha256(path.join(projectRoot, "LICENSE")),
      "THIRD_PARTY_LICENSES.txt": await sha256(path.join(projectRoot, "THIRD_PARTY_LICENSES.txt")),
      "THIRD_PARTY_NOTICES.md": await sha256(path.join(projectRoot, "THIRD_PARTY_NOTICES.md")),
    },
    sourceCoreSha256: candidateStageBinding.application.sha256,
    helperSha256: await sha256(path.join(projectRoot, "src-tauri", "target", "release", "yuanyuan-installed-candidate-qa.exe")),
    installerSha256: candidateStageBinding.installer.sha256,
    installerBytes: candidateStageBinding.installer.bytes,
  };
  validateInstalledE2eEvidence({
    status,
    payload,
    uninstall,
    webView,
    sourceMetadata,
    candidateStageManifest,
    candidateStageBinding,
    authority,
    brand,
    tauriConfig,
    packageJson,
    observed,
    requireClean: !process.argv.includes("--allow-dirty"),
  });
  requireValue(
    await readFile(path.join(evidenceRoot, "sandbox-data-probe.complete"), "utf8") ===
      "YUANYUAN_WINDOWS_SANDBOX_DATA_PROBE_COMPLETE_V1\n",
    "completion marker is invalid",
  );
  requireValue(
    await readFile(path.join(evidenceRoot, "sandbox-logon-command.started"), "utf8") ===
      "YUANYUAN_WINDOWS_SANDBOX_LOGON_STARTED_V1\n",
    "Sandbox logon marker is invalid",
  );
  const progress = await readFile(path.join(evidenceRoot, "sandbox-data-probe-progress.log"), "utf8");
  requireValue(progress.includes(" result:ready\n") && progress.trimEnd().endsWith("result:writing-status"), "progress log did not reach the final ready state");
  console.log(`Installed-candidate E2E evidence verified: ${evidenceRoot}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
