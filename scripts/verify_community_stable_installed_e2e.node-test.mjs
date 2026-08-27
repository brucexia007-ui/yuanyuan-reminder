import assert from "node:assert/strict";
import test from "node:test";

import { validateInstalledE2eEvidence } from "./verify_community_stable_installed_e2e.mjs";

const A = "A".repeat(64);
const B = "B".repeat(64);
const C = "C".repeat(64);
const D = "D".repeat(64);
const E = "E".repeat(64);
const F = "F".repeat(64);
const commit = "a".repeat(40);

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
    sourceCoreSha256: F,
    helperSha256: A,
    installerSha256: B,
    installerBytes: 1234,
  };
  return {
    status: {
      schemaVersion: 1,
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
        installExitCode: 0,
        scenarios: {
          installAndLaunch: true,
          reminderDelivery: true,
          hideAndRestorePet: true,
          panelDrag: true,
          backupAndRestore: true,
          restartPersistence: true,
          uninstallKeepsDataByDefault: true,
        },
        reminder: {
          reminderId: "123e4567-e89b-42d3-a456-426614174000",
          title: "E2E提醒-1234abcd",
          scheduledAt: "2026-08-27T00:00:30.000Z",
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
    authority: { version: "1.5.3" },
    packageJson: { version: "1.5.3" },
    observed,
    requireClean: true,
  };
}

test("accepts a clean, cross-bound installed-candidate E2E report", () => {
  assert.doesNotThrow(() => validateInstalledE2eEvidence(fixture()));
});

test("rejects optimistic drag and scenario claims", () => {
  const optimistic = fixture();
  optimistic.status.functional.panelDragEvidence.moved = false;
  assert.throws(() => validateInstalledE2eEvidence(optimistic), /panel drag/u);

  const missing = fixture();
  delete missing.status.functional.scenarios.backupAndRestore;
  assert.throws(() => validateInstalledE2eEvidence(missing), /keys are not exact/u);
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
