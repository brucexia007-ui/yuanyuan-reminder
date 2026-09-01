import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import {
  aiDisabledEvidenceMatches,
  accessibilityAcceptanceCheck,
  check,
  coldStartEvidenceMatches,
  defaultUpgradeRollbackRegistrationEvidenceMatches,
  defaultUpgradeRollbackProbeEvidenceMatches,
  defaultRegistrationPendingDetail,
  defenderEvidenceMatches,
  installFailureRecoveryProbeEvidenceMatches,
  licenseBundleEvidenceMatches,
  licenseReviewCheck,
  nsisPayloadEvidenceMatches,
  resolveOwnedArtifact,
  rfc3161ProtocolCheck,
  smartScreenCheck,
  summarizeSignatureGate,
  thirdPartySecurityCheck,
  uninstallDataChoiceProbeEvidenceMatches,
  upgradeRollbackDrillCheck,
  upgradeRollbackProbeEvidenceMatches,
} from "./generate_release_preflight.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const productBrand = JSON.parse(await readFile(path.join(projectRoot, "product-brand.json"), "utf8"));
const assetLicenseSource = `../${productBrand.assets.licenseFile}`;

test("license bundle requires exact configured resources and NSIS install/uninstall lines", () => {
  const resources = {
    "../LICENSE": "licenses/LICENSE.txt",
    "../THIRD_PARTY_NOTICES.md": "licenses/THIRD_PARTY_NOTICES.md",
    "../THIRD_PARTY_LICENSES.txt": "licenses/THIRD_PARTY_LICENSES.txt",
    [assetLicenseSource]: "licenses/ASSETS_LICENSE.md",
  };
  const script = Object.entries(resources)
    .flatMap(([source, destination]) => {
      const target = destination.replaceAll("/", "\\");
      return [
        `File /a "/oname=${target}" "C:\\build\\${source.slice(3)}"`,
        `Delete "$INSTDIR\\${target}"`,
      ];
    })
    .join("\n");
  assert.equal(licenseBundleEvidenceMatches(resources, script), true);
  assert.equal(
    licenseBundleEvidenceMatches(resources, script.replace("THIRD_PARTY_LICENSES.txt", "missing.txt")),
    false,
  );
  assert.equal(licenseBundleEvidenceMatches({ ...resources, "../extra": "extra" }, script), false);
});

test("preflight detail describes the actual passed or pending state", () => {
  assert.deepEqual(check("gate", true, "已完成", true, "尚未完成"), {
    id: "gate",
    status: "passed",
    detail: "已完成",
  });
  assert.deepEqual(check("gate", false, "已完成", true, "尚未完成"), {
    id: "gate",
    status: "pending",
    detail: "尚未完成",
  });
  assert.match(defaultRegistrationPendingDetail(null, false), /尚未取得/u);
  assert.match(
    defaultRegistrationPendingDetail(
      { environment: { currentUserRegistry64Writable: false } },
      true,
    ),
    /无法写入64位HKCU/u,
  );
  assert.match(
    defaultRegistrationPendingDetail(
      { environment: { currentUserRegistry64Writable: true } },
      true,
    ),
    /可写64位HKCU/u,
  );
});

test("license review stays pending before signoff but a false success claim fails closed", () => {
  assert.equal(licenseReviewCheck(false, false, true).status, "pending");
  assert.equal(licenseReviewCheck(false, true, true).status, "failed");
  assert.equal(licenseReviewCheck(true, true, true).status, "passed");
});

test("external trust gates stay pending before testing and fail closed on unsupported claims", () => {
  assert.equal(smartScreenCheck(false, false, true).status, "pending");
  assert.equal(smartScreenCheck(false, true, true).status, "failed");
  assert.equal(smartScreenCheck(true, true, true).status, "passed");

  assert.equal(thirdPartySecurityCheck(false, false, 2, true).status, "pending");
  assert.equal(thirdPartySecurityCheck(false, true, 2, true).status, "failed");
  assert.equal(thirdPartySecurityCheck(true, true, 2, true).status, "passed");
});

test("RFC 3161 stays pending before signing and fails closed on a naked success claim", () => {
  assert.equal(rfc3161ProtocolCheck(false, false, true).status, "pending");
  assert.equal(rfc3161ProtocolCheck(false, true, true).status, "failed");
  assert.equal(rfc3161ProtocolCheck(true, true, true).status, "passed");
});

test("accessibility acceptance stays pending before human testing and fails closed on a naked claim", () => {
  assert.equal(accessibilityAcceptanceCheck(false, false, true).status, "pending");
  assert.equal(accessibilityAcceptanceCheck(false, true, true).status, "failed");
  assert.equal(accessibilityAcceptanceCheck(true, true, true).status, "passed");
});

test("complete upgrade drill stays pending before real evidence and fails closed on a naked claim", () => {
  assert.equal(upgradeRollbackDrillCheck(false, false, true).status, "pending");
  assert.equal(upgradeRollbackDrillCheck(false, true, true).status, "failed");
  assert.equal(upgradeRollbackDrillCheck(true, true, true).status, "passed");
});

test("cold-start evidence requires three clean candidate-bound fresh-profile samples", () => {
  const artifacts = [{ id: "nsis_installed_core", sha256: "A".repeat(64) }];
  const manifestSha256 = "B".repeat(64);
  const measureScriptSha256 = "C".repeat(64);
  const sample = (sequence, timing) => ({
    sequence,
    visibleWindowObserved: true,
    startupToVisibleWindowMilliseconds: timing,
    terminationMode: "forced_after_window_probe",
    ownedProcessCount: 4,
    aiChildProcessCount: 0,
    applicationErrorCount: 0,
    applicationErrorQueryAvailable: true,
    dataRootRemoved: true,
  });
  const report = {
    schemaVersion: 2,
    generatedAt: "2026-08-08T20:04:24.917Z",
    mode: "default_release_fresh_profile_cold_start",
    ready: true,
    failureCode: null,
    bindings: { measureScriptSha256 },
    candidate: {
      manifestSha256,
      stableCoreSha256: "A".repeat(64),
      stagedCopySha256: "A".repeat(64),
      byteIdenticalStagedCopy: true,
    },
    environment: {
      interactiveSession: true,
      freshTestAccountAcknowledged: true,
      preexistingDataRoot: false,
      preexistingApplicationProcessCount: 0,
      applicationErrorQueryAvailable: true,
      profileRegistryQueryAvailable: true,
      tokenProfilePathMatchesEnvironment: true,
    },
    summary: {
      sampleCount: 3,
      minimumMilliseconds: 100,
      p50Milliseconds: 120,
      p95Milliseconds: 140,
      maximumMilliseconds: 140,
    },
    samples: [sample(1, 100), sample(2, 120), sample(3, 140)],
    limitations: [
      "Measures a byte-identical staged copy of the default release executable, not NSIS installation time.",
      "Each sample uses a freshly created application data root but may benefit from operating-system and WebView2 file cache.",
      "The process tree is force-stopped after the visible-window observation; graceful shutdown is evaluated separately.",
    ],
  };
  const validate = (candidate, manifest = manifestSha256, script = measureScriptSha256) =>
    coldStartEvidenceMatches(candidate, artifacts, manifest, script);
  assert.equal(validate(report), true);
  assert.equal(
    validate({ ...report, ready: false }),
    false,
  );
  assert.equal(validate(report, "D".repeat(64)), false);
  assert.equal(validate(report, manifestSha256, "D".repeat(64)), false);
  assert.equal(
    validate({
      ...report,
      environment: { ...report.environment, tokenProfilePathMatchesEnvironment: false },
    }),
    false,
  );
  assert.equal(validate({ ...report, unexpected: true }), false);
  assert.equal(
    validate({ ...report, samples: report.samples.slice(0, 2) }),
    false,
  );
  assert.equal(
    validate({ ...report, summary: { ...report.summary, p95Milliseconds: 139 } }),
    false,
  );
  assert.equal(
    validate({
      ...report,
      samples: [sample(1, 100), sample(2, 120), { ...sample(3, 140), dataRootRemoved: false }],
    }),
    false,
  );
  for (const invalidSample of [
    { ...sample(3, 140), visibleWindowObserved: false },
    { ...sample(3, 140), ownedProcessCount: 0 },
    { ...sample(3, 140), aiChildProcessCount: 1 },
    { ...sample(3, 140), applicationErrorCount: 1 },
    { ...sample(3, 140), applicationErrorQueryAvailable: false },
  ]) {
    assert.equal(
      validate({ ...report, samples: [sample(1, 100), sample(2, 120), invalidSample] }),
      false,
    );
  }
});

test("AI-disabled evidence is accepted only for the exact manifest and release hashes", () => {
  const artifacts = [
    { id: "stable_core", sha256: "A".repeat(64) },
    { id: "nsis_installed_core", sha256: "D".repeat(64) },
    { id: "nsis_installer", sha256: "B".repeat(64) },
  ];
  const report = {
    schemaVersion: 1,
    mode: "ai_disabled",
    ready: true,
    sourceBoundary: { cspLocalOnly: true, directNetworkSdkCount: 0 },
    releaseBoundary: {
      manifestSha256: "C".repeat(64),
      stableCoreSha256: "A".repeat(64),
      nsisInstalledCoreSha256: "D".repeat(64),
      installerSha256: "B".repeat(64),
      aiPrototypeDisposition: "prototype_excluded",
      bridgePrototypeDisposition: "prototype_excluded",
      bundledFileCount: 1,
    },
  };
  assert.equal(aiDisabledEvidenceMatches(report, artifacts, "C".repeat(64)), true);
  assert.equal(aiDisabledEvidenceMatches(report, artifacts, "D".repeat(64)), false);
  assert.equal(
    aiDisabledEvidenceMatches(
      { ...report, ready: false },
      artifacts,
      "C".repeat(64),
    ),
    false,
  );
  assert.equal(
    aiDisabledEvidenceMatches(
      {
        ...report,
        releaseBoundary: { ...report.releaseBoundary, installerSha256: "D".repeat(64) },
      },
      artifacts,
      "C".repeat(64),
    ),
    false,
  );
});

test("NSIS payload evidence binds the installed executable and cleanup to the candidate", () => {
  const artifacts = [
    { id: "stable_core", sha256: "A".repeat(64) },
    { id: "nsis_installed_core", sha256: "B".repeat(64) },
    { id: "nsis_installer", sha256: "C".repeat(64) },
  ];
  const signature = {
    status: "NotSigned",
    signerSubject: null,
    signerThumbprint: null,
    timestampPresent: false,
    timestampSubject: null,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: "2026-08-08T21:30:00.000Z",
    mode: "nsis_installed_payload",
    ready: true,
    bindings: {
      inspectionScriptSha256: "D".repeat(64),
      sourceStableCoreSha256: "A".repeat(64),
      installerSha256: "C".repeat(64),
      installedCoreSha256: "B".repeat(64),
    },
    candidate: {
      productVersion: "1.4.0",
      installedProductVersion: "1.4.0",
      sourceBytes: 100,
      installedBytes: 100,
      sourceUnkMarkerCount: 1,
      sourceNssMarkerCount: 0,
      installedUnkMarkerCount: 0,
      installedNssMarkerCount: 1,
      bothUnsigned: true,
      expectedUnsignedInstalledCoreSha256: "B".repeat(64),
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
        {
          fileName: "ASSETS_LICENSE.md",
          sourceSha256: "E".repeat(64),
          installedSha256: "E".repeat(64),
          matches: true,
        },
        {
          fileName: "LICENSE.txt",
          sourceSha256: "F".repeat(64),
          installedSha256: "F".repeat(64),
          matches: true,
        },
        {
          fileName: "THIRD_PARTY_LICENSES.txt",
          sourceSha256: "A".repeat(64),
          installedSha256: "A".repeat(64),
          matches: true,
        },
        {
          fileName: "THIRD_PARTY_NOTICES.md",
          sourceSha256: "B".repeat(64),
          installedSha256: "B".repeat(64),
          matches: true,
        },
      ],
    },
    environment: {
      currentUserAuthenticated: true,
      profileRegistryQueryAvailable: true,
      tokenProfilePathMatchesEnvironment: true,
    },
    signatures: {
      sourceStableCore: signature,
      installedCore: signature,
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
    limitations: [
      "This extracts the exact NSIS-installed main executable through a disposable current-user installation; it does not approve an unsigned candidate.",
      "SmartScreen, security-software, upgrade interruption, authentic historical database migration, and default-path behavior remain separate gates.",
    ],
  };
  const licenseSourceSha256 = {
    "ASSETS_LICENSE.md": "E".repeat(64),
    "LICENSE.txt": "F".repeat(64),
    "THIRD_PARTY_LICENSES.txt": "A".repeat(64),
    "THIRD_PARTY_NOTICES.md": "B".repeat(64),
  };
  const matches = (candidate) =>
    nsisPayloadEvidenceMatches(
      candidate,
      artifacts,
      "D".repeat(64),
      "1.4.0",
      licenseSourceSha256,
    );
  assert.equal(matches(report), true);
  assert.equal(matches({ ...report, ready: false }), false);
  assert.equal(
    matches({
      ...report,
      bindings: { ...report.bindings, installedCoreSha256: "E".repeat(64) },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      candidate: { ...report.candidate, installedNssMarkerCount: 0 },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      cleanup: { ...report.cleanup, installRootRemoved: false },
    }),
    false,
  );
  assert.equal(matches({ ...report, optimistic: true }), false);
  assert.equal(
    matches({
      ...report,
      installation: {
        ...report.installation,
        licenseBindings: report.installation.licenseBindings.map((binding, index) =>
          index === 0 ? { ...binding, installedSha256: "F".repeat(64) } : binding),
      },
    }),
    false,
  );
  assert.equal(
    nsisPayloadEvidenceMatches(
      report,
      artifacts,
      "D".repeat(64),
      "1.4.0",
      { ...licenseSourceSha256, "ASSETS_LICENSE.md": "F".repeat(64) },
    ),
    false,
  );
});

test("upgrade/rollback probe binds historical bytes, candidate transitions, and cleanup", () => {
  const artifacts = [
    { id: "nsis_installed_core", bytes: 221, sha256: "A".repeat(64) },
    { id: "nsis_installer", bytes: 333, sha256: "B".repeat(64) },
  ];
  const historicalStep = () => ({
    installExitCode: 0,
    installedProductVersion: "1.3.2",
    installedCoreBytes: 20_574_720,
    installedCoreSha256: "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF",
    installedCoreMatches: true,
    uninstallRootMatches: false,
    productRootMatches: false,
    displayVersionMatches: false,
    registrationDisposition: "absent",
    currentLicenseFilesAbsent: true,
    sentinelPreserved: true,
  });
  const postUninstall = () => ({
    uninstallExitCode: 0,
    installRootRemoved: true,
    uninstallRegistrationRemoved: true,
    productRegistrationPresent: false,
    productRootMatches: false,
    productRegistrationPreserved: false,
    registrationBoundaryConsistent: true,
    sentinelPreserved: true,
  });
  const signature = {
    status: "NotSigned",
    signerSubject: null,
    signerThumbprint: null,
    timestampPresent: false,
    timestampSubject: null,
  };
  const report = {
    schemaVersion: 2,
    generatedAt: "2026-08-08T22:30:00.000Z",
    mode: "release_upgrade_rollback_probe",
    ready: true,
    bindings: {
      probeScriptSha256: "C".repeat(64),
      historicalInstallerSha256:
        "FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1",
      historicalInstalledCoreSha256:
        "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF",
      candidateInstallerSha256: "B".repeat(64),
      candidateInstalledCoreSha256: "A".repeat(64),
    },
    versions: { historical: "1.3.2", candidate: "1.4.0" },
    installBoundary: {
      mode: "custom_temporary",
      cleanTestAccountAcknowledged: false,
      defaultInstallRootUsed: false,
      customTemporaryInstallRootUsed: true,
      registrationGatePassed: false,
    },
    environment: {
      currentUserAuthenticated: true,
      profileRegistryQueryAvailable: true,
      tokenProfilePathMatchesEnvironment: true,
      localAppDataMatchesTokenProfile: true,
      currentUserRegistry64Writable: false,
      preexistingApplicationProcessCount: 0,
      preexistingProductRegistration: false,
      preexistingDataRoot: false,
      preexistingDefaultInstallRoot: false,
      preexistingShortcut: false,
      preexistingRunValue: false,
    },
    steps: {
      historicalInstall: historicalStep(),
      candidateUpgrade: {
        installExitCode: 0,
        installedProductVersion: "1.4.0",
        installedCoreBytes: 221,
        installedCoreSha256: "A".repeat(64),
        installedCoreMatches: true,
        uninstallRootMatches: false,
        productRootMatches: false,
        displayVersionMatches: false,
        registrationDisposition: "absent",
        licenseFiles: [
          "ASSETS_LICENSE.md",
          "LICENSE.txt",
          "THIRD_PARTY_LICENSES.txt",
          "THIRD_PARTY_NOTICES.md",
        ],
        licenseFilesExact: true,
        licenseHashesMatch: true,
        sentinelPreserved: true,
      },
      candidateUninstallBeforeRollback: postUninstall(),
      historicalRollback: historicalStep(),
      historicalUninstall: postUninstall(),
    },
    dataBoundary: {
      defaultLocalDataDirectoryUsed: true,
      syntheticSentinelOnly: true,
      authenticHistoricalDatabaseUsed: false,
      sentinelSha256: "D".repeat(64),
      sentinelPreservedAtEveryStep: true,
    },
    signatures: {
      historicalInstaller: signature,
      candidateInstaller: signature,
    },
    cleanup: {
      ownedProductRegistrationRemoved: true,
      desktopShortcutStatePreserved: true,
      startMenuShortcutStatePreserved: true,
      dataRootRemoved: true,
      qaRootRemoved: true,
      applicationProcessCount: 0,
    },
    limitations: [
      "This probe uses official v1.3.2 installer bytes and the current candidate in an owned per-user temporary installation.",
      "It verifies installer file transitions and default data-directory preservation with a synthetic sentinel; it does not use or claim an authentic historical business database.",
      "Power loss, mid-file replacement interruption, signed-candidate identity, SmartScreen, security-software, and default-install-path behavior remain separate gates.",
    ],
  };
  const matches = (candidate, scriptSha256 = "C".repeat(64)) =>
    upgradeRollbackProbeEvidenceMatches(candidate, artifacts, scriptSha256, "1.4.0");
  assert.equal(matches(report), true);
  assert.equal(
    matches({
      ...report,
      environment: {
        ...report.environment,
        currentUserRegistry64Writable: undefined,
      },
    }),
    false,
  );
  assert.equal(matches(report, "E".repeat(64)), false);
  assert.equal(
    matches({
      ...report,
      bindings: { ...report.bindings, candidateInstalledCoreSha256: "E".repeat(64) },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      dataBoundary: { ...report.dataBoundary, authenticHistoricalDatabaseUsed: true },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      steps: {
        ...report.steps,
        candidateUninstallBeforeRollback: {
          ...report.steps.candidateUninstallBeforeRollback,
          registrationBoundaryConsistent: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({ ...report, cleanup: { ...report.cleanup, dataRootRemoved: false } }),
    false,
  );
  assert.equal(matches({ ...report, optimistic: true }), false);

  const ownedInstall = (step) => ({
    ...step,
    uninstallRootMatches: true,
    productRootMatches: true,
    displayVersionMatches: true,
    registrationDisposition: "owned",
  });
  const ownedPostUninstall = (step) => ({
    ...step,
    productRegistrationPresent: true,
    productRootMatches: true,
    productRegistrationPreserved: true,
  });
  const defaultReport = {
    ...report,
    mode: "release_default_upgrade_rollback_probe",
    installBoundary: {
      mode: "default_per_user",
      cleanTestAccountAcknowledged: true,
      defaultInstallRootUsed: true,
      customTemporaryInstallRootUsed: false,
      registrationGatePassed: true,
    },
    environment: {
      ...report.environment,
      currentUserRegistry64Writable: true,
    },
    steps: {
      historicalInstall: ownedInstall(report.steps.historicalInstall),
      candidateUpgrade: ownedInstall(report.steps.candidateUpgrade),
      candidateUninstallBeforeRollback: ownedPostUninstall(
        report.steps.candidateUninstallBeforeRollback,
      ),
      historicalRollback: ownedInstall(report.steps.historicalRollback),
      historicalUninstall: ownedPostUninstall(report.steps.historicalUninstall),
    },
    limitations: [
      "This probe uses official v1.3.2 installer bytes and the current candidate in the default per-user install directory of an explicitly acknowledged clean Windows test account.",
      "It verifies default-path installer file transitions and data-directory preservation with a synthetic sentinel; it records but does not claim control-panel registration or an authentic historical business database.",
      "Control-panel registration, power loss, mid-file replacement interruption, signed-candidate identity, SmartScreen, and security-software remain separate gates.",
    ],
  };
  assert.equal(
    defaultUpgradeRollbackProbeEvidenceMatches(
      defaultReport,
      artifacts,
      "C".repeat(64),
      "1.4.0",
    ),
    true,
  );
  assert.equal(
    defaultUpgradeRollbackProbeEvidenceMatches(
      {
        ...defaultReport,
        environment: {
          ...defaultReport.environment,
          currentUserRegistry64Writable: false,
        },
      },
      artifacts,
      "C".repeat(64),
      "1.4.0",
    ),
    false,
  );
  assert.equal(
    defaultUpgradeRollbackProbeEvidenceMatches(
      {
        ...defaultReport,
        installBoundary: {
          ...defaultReport.installBoundary,
          registrationGatePassed: false,
        },
        steps: report.steps,
      },
      artifacts,
      "C".repeat(64),
      "1.4.0",
    ),
    true,
  );
  assert.equal(
    defaultUpgradeRollbackProbeEvidenceMatches(
      {
        ...defaultReport,
        installBoundary: {
          ...defaultReport.installBoundary,
          registrationGatePassed: false,
        },
      },
      artifacts,
      "C".repeat(64),
      "1.4.0",
    ),
    false,
  );
  assert.equal(
    defaultUpgradeRollbackRegistrationEvidenceMatches(
      defaultReport,
      artifacts,
      "C".repeat(64),
      "1.4.0",
    ),
    true,
  );
  assert.equal(
    defaultUpgradeRollbackRegistrationEvidenceMatches(
      {
        ...defaultReport,
        installBoundary: {
          ...defaultReport.installBoundary,
          registrationGatePassed: false,
        },
        steps: report.steps,
      },
      artifacts,
      "C".repeat(64),
      "1.4.0",
    ),
    false,
  );
});

test("install-failure recovery probe binds corruption, obstruction, mid-write termination, recovery, and cleanup", () => {
  const artifacts = [
    { id: "nsis_installed_core", bytes: 221, sha256: "A".repeat(64) },
    { id: "nsis_installer", bytes: 334, sha256: "B".repeat(64) },
  ];
  const failedOldCore = (extra = {}) => ({
    ...extra,
    launchDisposition: "exited_nonzero",
    rootExitCode: 2,
    processTreeTimedOut: false,
    processTreeTerminatedByProbe: false,
    ownedProcessCountAfter: 0,
    maximumOwnedProcessCount: 1,
    startErrorType: null,
    installedProductVersion: "1.3.2",
    installedCoreBytes: 20_574_720,
    installedCoreSha256:
      "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF",
    oldCorePreserved: true,
    uninstallerPreserved: true,
    currentLicenseFilesAbsent: true,
    sentinelPreserved: true,
  });
  const report = {
    schemaVersion: 2,
    generatedAt: "2026-08-08T23:30:00.000Z",
    mode: "release_install_failure_recovery_probe",
    ready: true,
    bindings: {
      probeScriptSha256: "C".repeat(64),
      historicalInstallerSha256:
        "FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1",
      historicalInstalledCoreSha256:
        "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF",
      candidateInstallerSha256: "B".repeat(64),
      candidateInstalledCoreSha256: "A".repeat(64),
      candidateInstallerBytes: 334,
      corruptedCandidateSha256: "D".repeat(64),
      corruptedCandidateBytes: 167,
    },
    versions: { historical: "1.3.2", candidate: "1.4.0" },
    environment: {
      currentUserAuthenticated: true,
      profileRegistryQueryAvailable: true,
      tokenProfilePathMatchesEnvironment: true,
      localAppDataMatchesTokenProfile: true,
      preexistingApplicationProcessCount: 0,
      preexistingProductRegistration: false,
      preexistingDataRoot: false,
      preexistingDefaultInstallRoot: false,
      preexistingShortcut: false,
      preexistingRunValue: false,
      customTemporaryInstallRootUsed: true,
    },
    scenarios: {
      historicalBaseline: {
        installExitCode: 0,
        installedProductVersion: "1.3.2",
        installedCoreBytes: 20_574_720,
        installedCoreSha256:
          "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF",
        installedCoreMatches: true,
        uninstallerSha256:
          "941D0915C5CFE0F2C7F131A4CCE1700B202C669AE0825C1F7CF9C3A6B88AFF89",
        currentLicenseFilesAbsent: true,
        sentinelPreserved: true,
      },
      corruptedCandidate: failedOldCore(),
      fileReplacementObstruction: failedOldCore({
        exclusiveLockAcquired: true,
        rootExitCode: 32,
      }),
      successfulWriteTermination: {
        cpuHardCapPercent: 1,
        jobKillOnClose: true,
        writeBoundaryObserved: true,
        triggerMainExecutablePresent: true,
        triggerMainExecutableBytes: 64,
        triggerReadErrorType: null,
        rootExitCode: 1,
        processTreeTerminatedByProbe: true,
        ownedProcessCountBeforeTermination: 1,
        ownedProcessCountAfter: 0,
        maximumOwnedProcessCount: 1,
        installedProductVersion: "",
        installedCoreBytes: 128,
        installedCoreSha256: "F".repeat(64),
        candidateCoreMatches: false,
        oldCorePreserved: false,
        uninstallerPresent: true,
        uninstallerSha256:
          "941D0915C5CFE0F2C7F131A4CCE1700B202C669AE0825C1F7CF9C3A6B88AFF89",
        historicalUninstallerPreserved: true,
        licenseFiles: [],
        licenseFilesExact: false,
        licenseHashesMatch: false,
        interruptedFileSetChanged: true,
        interruptedFileSetIncomplete: true,
        sentinelPreserved: true,
      },
      candidateRecovery: {
        installExitCode: 0,
        installedProductVersion: "1.4.0",
        installedCoreBytes: 221,
        installedCoreSha256: "A".repeat(64),
        installedCoreMatches: true,
        licenseFiles: [
          "ASSETS_LICENSE.md",
          "LICENSE.txt",
          "THIRD_PARTY_LICENSES.txt",
          "THIRD_PARTY_NOTICES.md",
        ],
        licenseFilesExact: true,
        licenseHashesMatch: true,
        uninstallerSha256: "9".repeat(64),
        sentinelPreserved: true,
      },
      candidateUninstall: {
        uninstallExitCode: 0,
        installRootRemoved: true,
        sentinelPreserved: true,
      },
    },
    dataBoundary: {
      defaultLocalDataDirectoryUsed: true,
      syntheticSentinelOnly: true,
      authenticHistoricalDatabaseUsed: false,
      sentinelSha256: "E".repeat(64),
      sentinelPreservedAtEveryStep: true,
    },
    cleanup: {
      ownedRegistrationRemoved: true,
      unexpectedDefaultInstallRootAbsent: true,
      desktopShortcutRemoved: true,
      startMenuShortcutRemoved: true,
      dataRootRemoved: true,
      qaRootRemoved: true,
      applicationProcessCount: 0,
      installerProcessCount: 0,
    },
    limitations: [
      "This probe uses an owned temporary installation, a deterministic half-length copy of the current candidate, an exclusive lock on the historical main executable, and forced termination only after observing a changed main-executable write boundary.",
      "It verifies pre-install corruption containment, file-replacement obstruction containment, an incomplete file set after installer-process termination, synthetic data-sentinel preservation, and recovery by the unmodified current candidate.",
      "It does not simulate power loss or system restart, use an authentic historical business database, prove default-path registration, or replace signed-candidate, SmartScreen, and security-software matrices.",
    ],
  };
  const matches = (candidate, scriptSha256 = "C".repeat(64)) =>
    installFailureRecoveryProbeEvidenceMatches(
      candidate,
      artifacts,
      scriptSha256,
      "1.4.0",
      { bytes: 167, sha256: "D".repeat(64) },
    );
  assert.equal(matches(report), true);
  assert.equal(matches(report, "F".repeat(64)), false);
  assert.equal(
    matches({
      ...report,
      bindings: { ...report.bindings, corruptedCandidateSha256: "F".repeat(64) },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        fileReplacementObstruction: {
          ...report.scenarios.fileReplacementObstruction,
          rootExitCode: 0,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        corruptedCandidate: {
          ...report.scenarios.corruptedCandidate,
          uninstallerPreserved: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({ ...report, cleanup: { ...report.cleanup, installerProcessCount: 1 } }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        successfulWriteTermination: {
          ...report.scenarios.successfulWriteTermination,
          candidateCoreMatches: true,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        successfulWriteTermination: {
          ...report.scenarios.successfulWriteTermination,
          processTreeTerminatedByProbe: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      cleanup: { ...report.cleanup, unexpectedDefaultInstallRootAbsent: false },
    }),
    false,
  );
  assert.equal(matches({ ...report, optimistic: true }), false);
});

test("uninstall data-choice probe binds default preservation and explicit checkbox deletion", () => {
  const artifacts = [
    { id: "nsis_installed_core", bytes: 221, sha256: "A".repeat(64) },
    { id: "nsis_installer", bytes: 334, sha256: "B".repeat(64) },
  ];
  const installed = {
    installExitCode: 0,
    installedProductVersion: "1.4.0",
    installedCoreBytes: 221,
    installedCoreSha256: "A".repeat(64),
    installedCoreMatches: true,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: "2026-08-08T23:55:00.000Z",
    mode: "release_uninstall_data_choice_probe",
    ready: true,
    bindings: {
      probeScriptSha256: "C".repeat(64),
      candidateInstallerSha256: "B".repeat(64),
      candidateInstalledCoreSha256: "A".repeat(64),
      candidateInstallerBytes: 334,
    },
    version: "1.4.0",
    environment: {
      currentUserAuthenticated: true,
      interactiveSession: true,
      profileRegistryQueryAvailable: true,
      tokenProfilePathMatchesEnvironment: true,
      localAppDataMatchesTokenProfile: true,
      roamingAppDataMatchesTokenProfile: true,
      preexistingApplicationProcessCount: 0,
      preexistingProductRegistration: false,
      preexistingLocalDataRoot: false,
      preexistingRoamingDataRoot: false,
      preexistingDefaultInstallRoot: false,
      preexistingShortcut: false,
      preexistingRunValue: false,
      customTemporaryInstallRootUsed: true,
    },
    scenarios: {
      defaultPreserve: {
        ...installed,
        uninstallExitCode: 0,
        installRootRemoved: true,
        localDataSentinelPreserved: true,
        roamingDataSentinelPreserved: true,
      },
      explicitDelete: {
        ...installed,
        checkboxFound: true,
        checkboxInitiallyOff: true,
        checkboxToggledOn: true,
        uninstallButtonInvoked: true,
        completionButtonInvoked: true,
        processTreeTimedOut: false,
        ownedProcessCountAfter: 0,
        observedButtonNames: [],
        installRootRemoved: true,
        localDataRootRemoved: true,
        roamingDataRootRemoved: true,
      },
    },
    dataBoundary: {
      syntheticSentinelsOnly: true,
      authenticUserDataUsed: false,
      localSentinelSha256: "D".repeat(64),
      roamingSentinelSha256: "E".repeat(64),
    },
    cleanup: {
      ownedRegistrationRemoved: true,
      desktopShortcutRemoved: true,
      startMenuShortcutRemoved: true,
      localDataRootRemoved: true,
      roamingDataRootRemoved: true,
      qaRootRemoved: true,
      applicationProcessCount: 0,
      uninstallerProcessCount: 0,
    },
    limitations: [
      "This probe uses only synthetic sentinels in owned LocalAppData and RoamingAppData roots of a clean interactive Windows test account.",
      "It verifies that silent/default uninstall preserves both data roots and that explicitly toggling the real NSIS delete-data checkbox removes both roots.",
      "It does not use authentic user data, prove control-panel registration, exercise per-machine installation, or replace signed-candidate and accessibility review.",
    ],
  };
  const matches = (candidate, scriptSha256 = "C".repeat(64)) =>
    uninstallDataChoiceProbeEvidenceMatches(
      candidate,
      artifacts,
      scriptSha256,
      "1.4.0",
    );
  assert.equal(matches(report), true);
  assert.equal(matches(report, "F".repeat(64)), false);
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        defaultPreserve: {
          ...report.scenarios.defaultPreserve,
          localDataSentinelPreserved: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        explicitDelete: {
          ...report.scenarios.explicitDelete,
          checkboxInitiallyOff: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        explicitDelete: {
          ...report.scenarios.explicitDelete,
          roamingDataRootRemoved: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    matches({
      ...report,
      scenarios: {
        ...report.scenarios,
        explicitDelete: {
          ...report.scenarios.explicitDelete,
          observedButtonNames: ["Unexpected"],
        },
      },
    }),
    false,
  );
  assert.equal(matches({ ...report, optimistic: true }), false);
});

test("release artifacts cannot escape the owned release directory", () => {
  const root = path.resolve("owned-release-root");
  assert.equal(resolveOwnedArtifact(root, "bundle/app.exe"), path.join(root, "bundle", "app.exe"));
  assert.throws(() => resolveOwnedArtifact(root, "../outside.exe"), /escapes/);
  assert.throws(() => resolveOwnedArtifact(root, path.resolve("outside.exe")), /relative path/);
});

test("unsigned artifacts never satisfy a frozen publisher policy", () => {
  const gate = summarizeSignatureGate(
    [
      { id: "stable_core", status: "NotSigned", timestampPresent: false },
      { id: "nsis_installer", status: "NotSigned", timestampPresent: false },
    ],
    ["stable_core", "nsis_installer"],
    "CN=Yuanyuan",
  );
  assert.deepEqual(gate, {
    signed: false,
    timestamped: false,
    sameCertificate: false,
    identityFrozen: true,
    publisherMatches: false,
  });
});

test("all release artifacts must share the exact frozen signer and certificate", () => {
  const records = [
    {
      id: "stable_core",
      status: "Valid",
      signerSubject: "CN=Yuanyuan",
      signerThumbprint: "A1",
      timestampPresent: true,
    },
    {
      id: "nsis_installer",
      status: "Valid",
      signerSubject: "CN=Yuanyuan",
      signerThumbprint: "A1",
      timestampPresent: true,
    },
  ];
  assert.deepEqual(
    summarizeSignatureGate(records, ["stable_core", "nsis_installer"], "CN=Yuanyuan"),
    {
      signed: true,
      timestamped: true,
      sameCertificate: true,
      identityFrozen: true,
      publisherMatches: true,
    },
  );
  records[1].signerThumbprint = "B2";
  assert.equal(
    summarizeSignatureGate(records, ["stable_core", "nsis_installer"], "CN=Yuanyuan")
      .sameCertificate,
    false,
  );
});

test("Defender evidence is accepted only for the exact release artifact hashes", () => {
  const artifacts = [
    { id: "stable_core", sha256: "AA" },
    { id: "nsis_installer", sha256: "BB" },
  ];
  const report = {
    schemaVersion: 1,
    verified: true,
    detections: [],
    artifacts: [
      { id: "stable_core", sha256: "AA" },
      { id: "nsis_installer", sha256: "BB" },
    ],
  };
  assert.equal(
    defenderEvidenceMatches(report, artifacts, ["stable_core", "nsis_installer"]),
    true,
  );
  report.artifacts[1].sha256 = "CHANGED";
  assert.equal(
    defenderEvidenceMatches(report, artifacts, ["stable_core", "nsis_installer"]),
    false,
  );
});
