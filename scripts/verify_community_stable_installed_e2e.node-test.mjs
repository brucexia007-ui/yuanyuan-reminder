import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateInstalledE2eEvidence } from "./verify_community_stable_installed_e2e.mjs";

const A = "A".repeat(64);
const B = "B".repeat(64);
const C = "C".repeat(64);
const D = "D".repeat(64);
const E = "E".repeat(64);
const F = "F".repeat(64);
const commit = "a".repeat(40);
const producerScript = readFileSync(
  new URL("./run_community_stable_sandbox_data_probe.ps1", import.meta.url),
  "utf8",
);

function fixture() {
  const source = {
    schemaVersion: 1,
    capturedAt: "2026-08-27T00:00:00.000Z",
    branch: "feat/unified-v1-5",
    commit,
    dirty: false,
  };
  const observed = {
    source: { branch: source.branch, commit, dirty: false },
    sourceMetadataSha256: A,
    probeScriptSha256: B,
    hostScriptSha256: C,
    payloadScriptSha256: D,
    uninstallScriptSha256: E,
    stageVerifierSha256: C,
    candidateStageManifestSha256: D,
    candidateStageBindingSha256: E,
    payloadReportSha256: A,
    uninstallReportSha256: B,
    webViewMetadataSha256: C,
    configBindings: {
      productVersionSha256: A,
      productBrandSha256: B,
      tauriConfigSha256: C,
      packageJsonSha256: D,
    },
    licenseSourceSha256: {
      "ASSETS_LICENSE.md": A,
      "LICENSE.txt": B,
      "THIRD_PARTY_LICENSES.txt": C,
      "THIRD_PARTY_NOTICES.md": D,
    },
    sourceCoreSha256: F,
    helperSha256: A,
    installerSha256: B,
    installerBytes: 1234,
  };
  return {
    status: {
      schemaVersion: 2,
      generatedAt: "2026-08-27T00:01:00.000Z",
      profile: "community-stable-installed-e2e",
      sandboxUser: "WDAGUtilityAccount",
      interactiveSession: true,
      syntheticDataOnly: true,
      candidateUsesEmbeddedOnlineWebView2Bootstrapper: true,
      mappedMicrosoftWebView2RuntimeVerified: true,
      mappedMicrosoftWebView2RuntimeSha256: C,
      temporaryWebView2DetectionRegistration: true,
      candidateCopiedToSandboxDisk: true,
      payloadInspectionPassed: true,
      uninstallDataChoicePassed: true,
      functional: {
        installerSha256: B,
        installedCoreSha256: D,
        helperSha256: A,
        helperSeedExitCode: 0,
        helperAddOverdueNotifyExitCode: 0,
        helperAddMissedExitCode: 0,
        helperAutomaticBackupExitCode: 0,
        installExitCode: 0,
        scenarios: {
          installAndLaunch: true,
          snoozeThirtyMinutes: true,
          missedReminderNotify: true,
          missedReminderSkipOld: true,
          reminderDelivery: true,
          hideAndRestorePet: true,
          panelDrag: true,
          automaticBackup: true,
          backupAndRestore: true,
          restartPersistence: true,
          uninstallKeepsDataByDefault: true,
        },
        reminder: {
          reminderId: "123e4567-e89b-42d3-a456-426614174000",
          title: "E2E错过仍提醒-1234abcd",
          scheduledAt: "2026-08-26T23:44:30.000Z",
        },
        overdueNotifyEvidence: {
          reminderId: "123e4567-e89b-42d3-a456-426614174000",
          policyAccessibleName: "错过提醒策略，可选恢复后仍提醒、自动归入已跳过",
          selectedPolicy: "恢复后仍提醒",
          overdueMinutes: 16,
          observedAt: "2026-08-27T00:00:30.000Z",
          alertObserved: true,
          occurrenceStatus: "pending",
        },
        snoozedReminder: {
          reminderId: "123e4567-e89b-42d3-a456-426614174002",
          title: "E2E提醒-5678abcd",
          scheduledAt: "2026-08-27T00:00:20.000Z",
        },
        snoozeEvidence: {
          reminderId: "123e4567-e89b-42d3-a456-426614174002",
          accessibleName: "稍后提醒时长，可选 5、10、30、60 分钟",
          selectedMinutes: 30,
          selectedValue: "30 分钟",
          outcomeLabel: "提醒已延后；饺饺安静等候",
          occurrenceStatus: "snoozed",
          observedAt: "2026-08-27T00:00:32.000Z",
          snoozedUntil: "2026-08-27T00:30:30.000Z",
          remainingSeconds: 1798,
        },
        missedReminder: {
          reminderId: "123e4567-e89b-42d3-a456-426614174003",
          title: "E2E错过自动跳过-90abcdef",
          scheduledAt: "2026-08-26T23:44:30.000Z",
        },
        missedReminderEvidence: {
          reminderId: "123e4567-e89b-42d3-a456-426614174003",
          policyAccessibleName: "错过提醒策略，可选恢复后仍提醒、自动归入已跳过",
          selectedPolicy: "自动归入已跳过",
          graceAccessibleName: "错过提醒宽限，可选 15、30、60、120、240 分钟",
          selectedGrace: "15 分钟",
          overdueMinutes: 16,
          observedAt: "2026-08-27T00:00:30.000Z",
          alertObserved: false,
          occurrenceStatus: "skipped",
          resolutionReason: "missed",
        },
        automaticBackupEvidence: {
          uiLabel: "自动备份",
          firstLaunchStartedAt: "2026-08-27T00:00:18.000Z",
          fileName: "auto-2026-08-27.sqlite3",
          createdAt: "2026-08-27T00:00:25.000Z",
          sizeBytes: 32768,
          sha256: C,
          automatic: true,
          learningIncluded: false,
          databaseHealthy: true,
          reminderId: "123e4567-e89b-42d3-a456-426614174002",
          reminderPresent: true,
        },
        mutation: {
          reminderId: "123e4567-e89b-42d3-a456-426614174001",
          title: "E2E变更-1234abcd",
        },
        panelDragEvidence: {
          before: { left: 100, top: 100, right: 600, bottom: 800 },
          after: { left: 180, top: 160, right: 680, bottom: 860 },
          moved: true,
        },
        petIdentity: {
          displayName: "饺饺",
          observedWindowTitle: "饺饺",
          observedLaunchCount: 5,
        },
        formalUserDataUsed: false,
        cleanup: {
          applicationExited: true,
          installRootRemoved: true,
          dataRootRemoved: true,
          roamingDataRootAbsent: true,
          uninstallRegistrationRemoved: true,
          productRegistrationPersistedAfterUninstall: true,
          ownedProductRegistrationRemoved: true,
          shortcutsRemoved: true,
          sandboxShutdownRequested: true,
        },
      },
      reportsCopied: true,
      failureDiagnostics: null,
      source,
      sourceMetadataSha256: A,
      probeScriptSha256: B,
      hostScriptSha256: C,
      candidateStage: {
        manifestSha256: D,
        bindingSha256: E,
        stageVerifierSha256: C,
        applicationSha256: F,
        installerSha256: B,
      },
      evidenceFileBindings: {
        payloadReportSha256: A,
        uninstallReportSha256: B,
        webViewMetadataSha256: C,
      },
      ready: true,
      failure: null,
    },
    payload: {
      ready: true,
      mode: "nsis_installed_payload",
      bindings: {
        inspectionScriptSha256: D,
        sourceStableCoreSha256: F,
        installerSha256: B,
        installedCoreSha256: D,
      },
      candidate: {
        productVersion: "1.5.3",
        installedProductVersion: "1.5.3",
        bothUnsigned: true,
        exactUnsignedMarkerPatch: true,
      },
      installation: {
        installExitCode: 0,
        customTemporaryInstallRoot: true,
        preexistingApplicationProcessCount: 0,
        preexistingProductRegistration: false,
        preexistingShortcut: false,
        licenseFiles: [
          "ASSETS_LICENSE.md",
          "LICENSE.txt",
          "THIRD_PARTY_LICENSES.txt",
          "THIRD_PARTY_NOTICES.md",
        ],
        licenseFilesExact: true,
        licenseHashesMatch: true,
        licenseBindings: [
          { fileName: "ASSETS_LICENSE.md", sourceSha256: A, installedSha256: A, matches: true },
          { fileName: "LICENSE.txt", sourceSha256: B, installedSha256: B, matches: true },
          { fileName: "THIRD_PARTY_LICENSES.txt", sourceSha256: C, installedSha256: C, matches: true },
          { fileName: "THIRD_PARTY_NOTICES.md", sourceSha256: D, installedSha256: D, matches: true },
        ],
      },
      cleanup: {
        uninstallExitCode: 0,
        installRootRemoved: true,
        uninstallRegistrationRemoved: true,
        productRegistrationPersistedAfterUninstall: true,
        ownedProductRegistrationRemoved: true,
        desktopShortcutStatePreserved: true,
        startMenuShortcutStatePreserved: true,
        applicationProcessCount: 0,
      },
    },
    uninstall: {
      ready: true,
      mode: "release_uninstall_data_choice_probe",
      version: "1.5.3",
      bindings: {
        probeScriptSha256: E,
        candidateInstallerSha256: B,
        candidateInstalledCoreSha256: D,
        candidateInstallerBytes: 1234,
      },
      scenarios: {
        defaultPreserve: { installExitCode: 0, uninstallExitCode: 0, installedProductVersion: "1.5.3", installedCoreMatches: true, localDataSentinelPreserved: true, roamingDataSentinelPreserved: true },
        explicitDelete: { installExitCode: 0, installedProductVersion: "1.5.3", installedCoreMatches: true, checkboxFound: true, localDataRootRemoved: true, roamingDataRootRemoved: true, processTreeTimedOut: false },
      },
      dataBoundary: { syntheticSentinelsOnly: true, authenticUserDataUsed: false },
      cleanup: { ownedRegistrationRemoved: true, applicationProcessCount: 0, uninstallerProcessCount: 0 },
    },
    webView: {
      schemaVersion: 1,
      source: "installed-host-microsoft-webview2-runtime",
      bytes: 100,
      sha256: C,
      signatureStatus: "Valid",
      signerSubject: "CN=Microsoft Corporation, O=Microsoft Corporation, C=US",
      productVersion: "151.0.0.0",
    },
    sourceMetadata: source,
    candidateStageManifest: {
      schemaVersion: 1,
      createdAt: "2026-08-27T00:00:30.000Z",
      product: {
        name: "饺饺提醒",
        version: "1.5.3",
        identifier: "com.brucexia.jiaojiao",
        packageName: "jiaojiao-reminder",
      },
      source: { commit, branch: source.branch, dirty: false },
      build: { startedAt: "2026-08-27T00:00:00.000Z", installerWrittenAt: "2026-08-27T00:00:20.000Z" },
      sourceRelease: { versionMatchedInstallerNames: ["饺饺提醒_1.5.3_x64-setup.exe"], selectedInstallerFileName: "饺饺提醒_1.5.3_x64-setup.exe" },
      artifacts: {
        application: { fileName: "yuanyuan-reminder.exe", bytes: 4321, sha256: F },
        installer: { fileName: "饺饺提醒_1.5.3_x64-setup.exe", bytes: 1234, sha256: B },
      },
      configBindings: observed.configBindings,
    },
    candidateStageBinding: {
      schemaVersion: 1,
      verifiedAt: "2026-08-27T00:00:40.000Z",
      stageManifestSha256: D,
      stageVerifierSha256: C,
      application: { fileName: "yuanyuan-reminder.exe", bytes: 4321, sha256: F },
      installer: { fileName: "饺饺提醒_1.5.3_x64-setup.exe", bytes: 1234, sha256: B },
    },
    authority: {
      productName: "饺饺提醒",
      version: "1.5.3",
      identifier: "com.brucexia.jiaojiao",
    },
    brand: {
      pet: { displayName: "饺饺", sex: "female", breed: "英短金点", personality: "乖巧高冷" },
      application: { displayName: "饺饺提醒", identifier: "com.brucexia.jiaojiao" },
      artifacts: { installerBaseName: "饺饺提醒" },
    },
    tauriConfig: {
      productName: "饺饺提醒",
      version: "1.5.3",
      identifier: "com.brucexia.jiaojiao",
    },
    packageJson: { name: "jiaojiao-reminder", version: "1.5.3" },
    observed,
    requireClean: true,
  };
}

test("accepts a clean, cross-bound installed-candidate E2E report", () => {
  assert.doesNotThrow(() => validateInstalledE2eEvidence(fixture()));
});

test("rejects optimistic drag and scenario claims", () => {
  const notifyGuard = producerScript.indexOf("@($initialInspect.records).Count -ne 1");
  const notifyRead = producerScript.indexOf("$initialRecord = @($initialInspect.records)[0]");
  assert.ok(notifyGuard >= 0 && notifyGuard < notifyRead, "overdue-notify producer must validate one record before reading it");
  const restoreGuard = producerScript.indexOf("@($restoredInspect.records).Count -ne 2");
  const restoreRead = producerScript.indexOf("$restoredRecords = @($restoredInspect.records)");
  assert.ok(restoreGuard >= 0 && restoreGuard < restoreRead, "backup producer must validate two records before reading them");

  const optimistic = fixture();
  optimistic.status.functional.panelDragEvidence.moved = false;
  assert.throws(() => validateInstalledE2eEvidence(optimistic), /panel drag/u);

  const missing = fixture();
  delete missing.status.functional.scenarios.backupAndRestore;
  assert.throws(() => validateInstalledE2eEvidence(missing), /keys are not exact/u);

  const noAutomaticBackup = fixture();
  noAutomaticBackup.status.functional.scenarios.automaticBackup = false;
  assert.throws(() => validateInstalledE2eEvidence(noAutomaticBackup), /automaticBackup/u);

  const emptyAutomaticBackup = fixture();
  emptyAutomaticBackup.status.functional.automaticBackupEvidence.sizeBytes = 0;
  assert.throws(() => validateInstalledE2eEvidence(emptyAutomaticBackup), /automatic backup is empty/u);

  const reminderMissingFromBackup = fixture();
  reminderMissingFromBackup.status.functional.automaticBackupEvidence.reminderPresent = false;
  assert.throws(() => validateInstalledE2eEvidence(reminderMissingFromBackup), /omitted the seeded reminder/u);

  const unexpectedLearningDatabase = fixture();
  unexpectedLearningDatabase.status.functional.automaticBackupEvidence.learningIncluded = true;
  assert.throws(() => validateInstalledE2eEvidence(unexpectedLearningDatabase), /unexpectedly contains a learning database/u);

  const launchTimestamp = producerScript.indexOf("$firstLaunchStartedAt = [DateTimeOffset]::UtcNow");
  const firstLaunch = producerScript.indexOf("$candidateProcess = Start-InstalledCandidate $applicationPath $webView2RuntimeRoot", launchTimestamp);
  assert.ok(launchTimestamp >= 0 && firstLaunch > launchTimestamp, "automatic-backup producer must timestamp before first launch");
  assert.match(producerScript, /firstLaunchStartedAt = \$firstLaunchStartedAt\.ToString\("o"\)/u);

  const staleAutomaticBackup = fixture();
  staleAutomaticBackup.status.functional.automaticBackupEvidence.createdAt = "2026-08-27T00:00:17.000Z";
  assert.throws(() => validateInstalledE2eEvidence(staleAutomaticBackup), /first-launch window/u);

  const lateAutomaticBackup = fixture();
  lateAutomaticBackup.status.functional.automaticBackupEvidence.createdAt = "2026-08-27T00:00:33.000Z";
  assert.throws(() => validateInstalledE2eEvidence(lateAutomaticBackup), /first-launch window/u);
});

test("requires the installed pet window title on every candidate launch", () => {
  const wrongTitle = fixture();
  wrongTitle.status.functional.petIdentity.observedWindowTitle = "圆圆";
  assert.throws(() => validateInstalledE2eEvidence(wrongTitle), /native window title is stale/u);

  const missingLaunch = fixture();
  missingLaunch.status.functional.petIdentity.observedLaunchCount = 4;
  assert.throws(() => validateInstalledE2eEvidence(missingLaunch), /all launches/u);
});

test("requires a real 30-minute installed snooze", () => {
  const recordGuard = producerScript.indexOf("@($snoozeInspect.records).Count -ne 1");
  const recordRead = producerScript.indexOf("$snoozeRecord = @($snoozeInspect.records)[0]");
  assert.ok(recordGuard >= 0 && recordGuard < recordRead, "snooze producer must validate one record before reading it");

  const wrongReminder = fixture();
  wrongReminder.status.functional.snoozeEvidence.reminderId = wrongReminder.status.functional.reminder.reminderId;
  assert.throws(() => validateInstalledE2eEvidence(wrongReminder), /snooze reminder binding is stale/u);

  const wrongDuration = fixture();
  wrongDuration.status.functional.snoozeEvidence.selectedMinutes = 10;
  assert.throws(() => validateInstalledE2eEvidence(wrongDuration), /30-minute snooze selection/u);

  const notPersisted = fixture();
  notPersisted.status.functional.snoozeEvidence.occurrenceStatus = "pending";
  assert.throws(() => validateInstalledE2eEvidence(notPersisted), /was not snoozed/u);

  const implausibleDeadline = fixture();
  implausibleDeadline.status.functional.snoozeEvidence.remainingSeconds = 600;
  assert.throws(() => validateInstalledE2eEvidence(implausibleDeadline), /30-minute range/u);

  const contradictoryDeadline = fixture();
  contradictoryDeadline.status.functional.snoozeEvidence.snoozedUntil = "2026-08-27T00:25:30.000Z";
  assert.throws(() => validateInstalledE2eEvidence(contradictoryDeadline), /deadline and recorded duration disagree/u);
});

test("requires the installed skip-old missed-reminder path", () => {
  const recordGuard = producerScript.indexOf("@($missedInspect.records).Count -ne 1");
  const recordRead = producerScript.indexOf("$missedRecord = @($missedInspect.records)[0]");
  assert.ok(recordGuard >= 0 && recordGuard < recordRead, "missed-reminder producer must validate one record before reading it");
  const notifyAlertWait = producerScript.indexOf("[void](Wait-AppElement $candidateProcess ([string]$seed.title) $false $false 45)");
  const notifyTimestamp = producerScript.indexOf("$notifyAlertObservedAt = [DateTimeOffset]::UtcNow", notifyAlertWait);
  const laterPanelWork = producerScript.indexOf('Write-ProbeProgress "functional:panel-drag:start"', notifyAlertWait);
  assert.ok(
    notifyAlertWait >= 0 && notifyTimestamp > notifyAlertWait && notifyTimestamp < laterPanelWork,
    "overdue-notify timestamp must be frozen when the alert is observed",
  );
  assert.match(producerScript, /observedAt = \$notifyAlertObservedAt\.ToString\("o"\)/u);

  const wrongNotifyReminder = fixture();
  wrongNotifyReminder.status.functional.overdueNotifyEvidence.reminderId = wrongNotifyReminder.status.functional.missedReminder.reminderId;
  assert.throws(() => validateInstalledE2eEvidence(wrongNotifyReminder), /overdue-notify reminder binding is stale/u);

  const wrongMissedReminder = fixture();
  wrongMissedReminder.status.functional.missedReminderEvidence.reminderId = wrongMissedReminder.status.functional.reminder.reminderId;
  assert.throws(() => validateInstalledE2eEvidence(wrongMissedReminder), /missed-reminder binding is stale/u);

  const notifyAlertMissing = fixture();
  notifyAlertMissing.status.functional.overdueNotifyEvidence.alertObserved = false;
  assert.throws(() => validateInstalledE2eEvidence(notifyAlertMissing), /did not show the overdue reminder/u);

  const contradictoryNotifyAge = fixture();
  contradictoryNotifyAge.status.functional.overdueNotifyEvidence.observedAt = "2026-08-27T00:10:30.000Z";
  assert.throws(() => validateInstalledE2eEvidence(contradictoryNotifyAge), /overdue-notify schedule and recorded age disagree/u);

  const alertShown = fixture();
  alertShown.status.functional.missedReminderEvidence.alertObserved = true;
  assert.throws(() => validateInstalledE2eEvidence(alertShown), /produced an alert/u);

  const notSkipped = fixture();
  notSkipped.status.functional.missedReminderEvidence.occurrenceStatus = "pending";
  assert.throws(() => validateInstalledE2eEvidence(notSkipped), /was not skipped/u);

  const wrongReason = fixture();
  wrongReason.status.functional.missedReminderEvidence.resolutionReason = "manual";
  assert.throws(() => validateInstalledE2eEvidence(wrongReason), /lacks the missed reason/u);

  const contradictoryAge = fixture();
  contradictoryAge.status.functional.missedReminderEvidence.observedAt = "2026-08-27T00:10:30.000Z";
  assert.throws(() => validateInstalledE2eEvidence(contradictoryAge), /schedule and recorded age disagree/u);
});

test("rejects stale candidate bindings and dirty formal source", () => {
  const stale = fixture();
  stale.payload.bindings.installerSha256 = C;
  assert.throws(() => validateInstalledE2eEvidence(stale), /installer binding is stale/u);

  const dirty = fixture();
  dirty.status.source.dirty = true;
  dirty.sourceMetadata.dirty = true;
  dirty.observed.source.dirty = true;
  assert.throws(() => validateInstalledE2eEvidence(dirty), /clean source checkout/u);
});

test("requires the exact installed license set and source hashes", () => {
  const missingAssetsLicense = fixture();
  missingAssetsLicense.payload.installation.licenseFiles.shift();
  assert.throws(() => validateInstalledE2eEvidence(missingAssetsLicense), /license file set is stale/u);

  const unexpectedLicense = fixture();
  unexpectedLicense.payload.installation.licenseFiles.push("UNREVIEWED.txt");
  assert.throws(() => validateInstalledE2eEvidence(unexpectedLicense), /license file set is stale/u);

  const nonExactSet = fixture();
  nonExactSet.payload.installation.licenseFilesExact = false;
  assert.throws(() => validateInstalledE2eEvidence(nonExactSet), /license file set is not exact/u);

  const alteredLicense = fixture();
  alteredLicense.payload.installation.licenseHashesMatch = false;
  assert.throws(() => validateInstalledE2eEvidence(alteredLicense), /license hashes do not match/u);

  const staleSourceBinding = fixture();
  staleSourceBinding.payload.installation.licenseBindings[0].sourceSha256 = B;
  staleSourceBinding.payload.installation.licenseBindings[0].installedSha256 = B;
  assert.throws(() => validateInstalledE2eEvidence(staleSourceBinding), /source license binding is stale/u);

  const changedInstalledBytes = fixture();
  changedInstalledBytes.payload.installation.licenseBindings[0].installedSha256 = B;
  assert.throws(() => validateInstalledE2eEvidence(changedInstalledBytes), /license bytes differ/u);
});

test("rejects a tampered staged candidate manifest or evidence binding", () => {
  const manifest = fixture();
  manifest.candidateStageManifest.artifacts.installer.sha256 = C;
  assert.throws(() => validateInstalledE2eEvidence(manifest), /installer binding does not match/u);

  const binding = fixture();
  binding.status.candidateStage.bindingSha256 = A;
  assert.throws(() => validateInstalledE2eEvidence(binding), /binding hash is stale/u);

  const report = fixture();
  report.status.evidenceFileBindings.payloadReportSha256 = C;
  assert.throws(() => validateInstalledE2eEvidence(report), /payload report evidence SHA-256 does not match/u);
});
