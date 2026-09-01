import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { firstStartRecoveryEvidenceMatches } from "./verify_first_start_recovery_evidence.mjs";
import {
  buildReleaseLicenseReviewPacket,
  canonicalLicenseReviewPacketText,
} from "./generate_release_license_review_packet.mjs";
import { releaseLicenseReviewEvidenceMatches } from "./verify_release_license_review.mjs";
import {
  buildReleaseExternalTrustPacket,
  canonicalExternalTrustPacketText,
} from "./generate_release_external_trust_packet.mjs";
import {
  smartScreenExternalEvidenceMatches,
  thirdPartySecurityExternalEvidenceMatches,
} from "./verify_release_external_trust.mjs";
import {
  buildReleaseSigningProtocolPacket,
  canonicalSigningProtocolPacketText,
} from "./generate_release_signing_protocol_packet.mjs";
import { releaseSigningProtocolEvidenceMatches } from "./verify_release_signing_protocol.mjs";
import {
  buildReleaseAccessibilityAcceptancePacket,
  canonicalAccessibilityAcceptancePacketText,
} from "./generate_release_accessibility_acceptance_packet.mjs";
import { releaseAccessibilityAcceptanceEvidenceMatches } from "./verify_release_accessibility_acceptance.mjs";
import {
  buildReleaseUpgradeCompletionPacket,
  canonicalUpgradeCompletionPacketText,
} from "./generate_release_upgrade_completion_packet.mjs";
import { upgradeCompletionAttestationMatches } from "./verify_release_upgrade_completion.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const productBrand = JSON.parse(await readFile(path.join(projectRoot, "product-brand.json"), "utf8"));
const assetLicenseSource = `../${productBrand.assets.licenseFile}`;
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const manifestPath = path.join(releaseRoot, "release-manifest.json");
const reportPath = path.join(releaseRoot, "release-preflight.json");
const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const evidencePath = path.join(
  projectRoot,
  "docs",
  "release",
  "RELEASE_EVIDENCE_STATUS_V1.json",
);
const signatureScriptPath = path.join(projectRoot, "scripts", "inspect_release_signatures.ps1");
const sbomPath = path.join(releaseRoot, "sbom.cdx.json");
const licensePath = path.join(releaseRoot, "third-party-licenses.json");
const licenseReviewPacketPath = path.join(
  releaseRoot,
  "release-license-review-packet.json",
);
const licenseReviewAttestationPath = path.join(
  projectRoot,
  "docs",
  "release",
  "RELEASE_LICENSE_REVIEW_ATTESTATION_V1.json",
);
const externalTrustPacketPath = path.join(
  releaseRoot,
  "release-external-trust-test-packet.json",
);
const externalTrustAttestationPath = path.join(
  projectRoot,
  "docs",
  "release",
  "RELEASE_EXTERNAL_TRUST_ATTESTATION_V1.json",
);
const signingProtocolPacketPath = path.join(
  releaseRoot,
  "release-signing-protocol-packet.json",
);
const signingProtocolAttestationPath = path.join(
  projectRoot,
  "docs",
  "release",
  "RELEASE_SIGNING_PROTOCOL_ATTESTATION_V1.json",
);
const accessibilityAcceptancePacketPath = path.join(
  releaseRoot,
  "release-accessibility-acceptance-packet.json",
);
const accessibilityAcceptanceAttestationPath = path.join(
  projectRoot,
  "docs",
  "release",
  "RELEASE_ACCESSIBILITY_ACCEPTANCE_ATTESTATION_V1.json",
);
const upgradeCompletionPacketPath = path.join(
  releaseRoot,
  "release-upgrade-completion-packet.json",
);
const upgradeCompletionAttestationPath = path.join(
  projectRoot,
  "docs",
  "release",
  "RELEASE_UPGRADE_COMPLETION_ATTESTATION_V1.json",
);
const authenticV132MigrationReportPath = path.join(
  releaseRoot,
  "release-authentic-v132-database-migration.json",
);
const defenderScanPath = path.join(releaseRoot, "defender-scan.json");
const aiDisabledReportPath = path.join(releaseRoot, "ai-disabled-regression.json");
const releaseColdStartReportPath = path.join(releaseRoot, "release-cold-start.json");
const nsisPayloadReportPath = path.join(releaseRoot, "nsis-installed-payload.json");
const nsisPayloadScriptPath = path.join(projectRoot, "scripts", "inspect_nsis_payload.ps1");
const upgradeRollbackProbeReportPath = path.join(
  releaseRoot,
  "release-upgrade-rollback-probe.json",
);
const defaultUpgradeRollbackProbeReportPath = path.join(
  releaseRoot,
  "release-default-upgrade-rollback-probe.json",
);
const installFailureRecoveryProbeReportPath = path.join(
  releaseRoot,
  "release-install-failure-recovery-probe.json",
);
const firstStartRecoveryProbeReportPath = path.join(
  releaseRoot,
  "release-first-start-recovery-probe.json",
);
const firstStartRecoveryDatabaseReportPath = path.join(
  releaseRoot,
  "release-first-start-recovery-database.json",
);
const firstStartRecoveryFixturePath = path.join(
  releaseRoot,
  "release-first-start-recovery.sqlite3",
);
const uninstallDataChoiceProbeReportPath = path.join(
  releaseRoot,
  "release-uninstall-data-choice-probe.json",
);
const upgradeRollbackProbeScriptPath = path.join(
  projectRoot,
  "scripts",
  "probe_release_upgrade_rollback.ps1",
);
const installFailureRecoveryProbeScriptPath = path.join(
  projectRoot,
  "scripts",
  "probe_release_install_failure_recovery.ps1",
);
const firstStartRecoveryProbeScriptPath = path.join(
  projectRoot,
  "scripts",
  "probe_release_first_start_recovery.ps1",
);
const firstStartRecoveryCaptureHelperPath = path.join(
  projectRoot,
  "scripts",
  "capture_first_start_recovery_database.mjs",
);
const uninstallDataChoiceProbeScriptPath = path.join(
  projectRoot,
  "scripts",
  "probe_release_uninstall_data_choice.ps1",
);
const releaseColdStartScriptPath = path.join(
  projectRoot,
  "scripts",
  "measure_release_cold_start.ps1",
);
const nsisScriptPath = path.join(releaseRoot, "nsis", "x64", "installer.nsi");
const COLD_START_LIMITATIONS = [
  "Measures a byte-identical staged copy of the default release executable, not NSIS installation time.",
  "Each sample uses a freshly created application data root but may benefit from operating-system and WebView2 file cache.",
  "The process tree is force-stopped after the visible-window observation; graceful shutdown is evaluated separately.",
];
const NSIS_PAYLOAD_LIMITATIONS = [
  "This extracts the exact NSIS-installed main executable through a disposable current-user installation; it does not approve an unsigned candidate.",
  "SmartScreen, security-software, upgrade interruption, authentic historical database migration, and default-path behavior remain separate gates.",
];
const NSIS_PAYLOAD_LICENSE_FILES = [
  "ASSETS_LICENSE.md",
  "LICENSE.txt",
  "THIRD_PARTY_LICENSES.txt",
  "THIRD_PARTY_NOTICES.md",
];
const UPGRADE_ROLLBACK_PROBE_LIMITATIONS = [
  "This probe uses official v1.3.2 installer bytes and the current candidate in an owned per-user temporary installation.",
  "It verifies installer file transitions and default data-directory preservation with a synthetic sentinel; it does not use or claim an authentic historical business database.",
  "Power loss, mid-file replacement interruption, signed-candidate identity, SmartScreen, security-software, and default-install-path behavior remain separate gates.",
];
const DEFAULT_UPGRADE_ROLLBACK_PROBE_LIMITATIONS = [
  "This probe uses official v1.3.2 installer bytes and the current candidate in the default per-user install directory of an explicitly acknowledged clean Windows test account.",
  "It verifies default-path installer file transitions and data-directory preservation with a synthetic sentinel; it records but does not claim control-panel registration or an authentic historical business database.",
  "Control-panel registration, power loss, mid-file replacement interruption, signed-candidate identity, SmartScreen, and security-software remain separate gates.",
];
const INSTALL_FAILURE_RECOVERY_PROBE_LIMITATIONS = [
  "This probe uses an owned temporary installation, a deterministic half-length copy of the current candidate, an exclusive lock on the historical main executable, and forced termination only after observing a changed main-executable write boundary.",
  "It verifies pre-install corruption containment, file-replacement obstruction containment, an incomplete file set after installer-process termination, synthetic data-sentinel preservation, and recovery by the unmodified current candidate.",
  "It does not simulate power loss or system restart, use an authentic historical business database, prove default-path registration, or replace signed-candidate, SmartScreen, and security-software matrices.",
];
const UNINSTALL_DATA_CHOICE_PROBE_LIMITATIONS = [
  "This probe uses only synthetic sentinels in owned LocalAppData and RoamingAppData roots of a clean interactive Windows test account.",
  "It verifies that silent/default uninstall preserves both data roots and that explicitly toggling the real NSIS delete-data checkbox removes both roots.",
  "It does not use authentic user data, prove control-panel registration, exercise per-machine installation, or replace signed-candidate and accessibility review.",
];
const HISTORICAL_RELEASE = {
  version: "1.3.2",
  installerSha256: "FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1",
  installedCoreBytes: 20_574_720,
  installedCoreSha256: "864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF",
  installedUninstallerSha256:
    "941D0915C5CFE0F2C7F131A4CCE1700B202C669AE0825C1F7CF9C3A6B88AFF89",
};
const LICENSE_RESOURCES = {
  "../LICENSE": "licenses/LICENSE.txt",
  "../THIRD_PARTY_NOTICES.md": "licenses/THIRD_PARTY_NOTICES.md",
  "../THIRD_PARTY_LICENSES.txt": "licenses/THIRD_PARTY_LICENSES.txt",
  [assetLicenseSource]: "licenses/ASSETS_LICENSE.md",
};

const EXPECTED_ARTIFACTS = new Map([
  ["stable_core", "primary_application"],
  ["nsis_installed_core", "installer_payload"],
  ["bridge_prototype", "prototype_excluded"],
  ["ai_prototype", "prototype_excluded"],
  ["nsis_installer", "distribution_installer"],
]);

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

export function resolveOwnedArtifact(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("artifact path must be a non-empty relative path");
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("artifact path escapes the release directory");
  }
  return resolved;
}

export function summarizeSignatureGate(records, releaseArtifactIds, publisherSubject) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const required = releaseArtifactIds.map((id) => byId.get(id));
  const signed = required.every((record) => record?.status === "Valid");
  const timestamped = required.every((record) => record?.timestampPresent === true);
  const subjects = new Set(required.map((record) => record?.signerSubject).filter(Boolean));
  const thumbprints = new Set(required.map((record) => record?.signerThumbprint).filter(Boolean));
  const identityFrozen =
    typeof publisherSubject === "string" && publisherSubject.trim().length > 0;
  const publisherMatches =
    identityFrozen &&
    signed &&
    required.every((record) => record.signerSubject === publisherSubject);
  return {
    signed,
    timestamped,
    sameCertificate: signed && subjects.size === 1 && thumbprints.size === 1,
    identityFrozen,
    publisherMatches,
  };
}

export function defenderEvidenceMatches(report, manifestArtifacts, releaseArtifactIds) {
  if (report?.schemaVersion !== 1 || report?.verified !== true || report.detections?.length !== 0) {
    return false;
  }
  const expected = new Map(
    manifestArtifacts
      .filter((artifact) => releaseArtifactIds.includes(artifact.id))
      .map((artifact) => [artifact.id, artifact.sha256]),
  );
  if (expected.size !== releaseArtifactIds.length || report.artifacts?.length !== expected.size) {
    return false;
  }
  return report.artifacts.every(
    (artifact) => expected.get(artifact.id) === artifact.sha256,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function licenseBundleEvidenceMatches(resources, nsisScript) {
  if (
    resources === null ||
    typeof resources !== "object" ||
    Array.isArray(resources) ||
    JSON.stringify(Object.keys(resources).sort()) !==
      JSON.stringify(Object.keys(LICENSE_RESOURCES).sort()) ||
    typeof nsisScript !== "string"
  ) {
    return false;
  }
  return Object.entries(LICENSE_RESOURCES).every(([source, destination]) => {
    if (resources[source] !== destination) return false;
    const windowsDestination = destination.replaceAll("/", "\\");
    const install = new RegExp(
      `^\\s*File /a "/oname=${escapeRegExp(windowsDestination)}" ".+${escapeRegExp(path.basename(source))}"\\s*$`,
      "mi",
    );
    const remove = new RegExp(
      `^\\s*Delete "\\$INSTDIR\\\\${escapeRegExp(windowsDestination)}"\\s*$`,
      "mi",
    );
    return install.test(nsisScript) && remove.test(nsisScript);
  });
}

export function aiDisabledEvidenceMatches(report, manifestArtifacts, manifestSha256) {
  if (
    report?.schemaVersion !== 1 ||
    report?.mode !== "ai_disabled" ||
    report?.ready !== true ||
    report.sourceBoundary?.cspLocalOnly !== true ||
    report.sourceBoundary?.directNetworkSdkCount !== 0 ||
    report.releaseBoundary?.manifestSha256 !== manifestSha256 ||
    report.releaseBoundary?.aiPrototypeDisposition !== "prototype_excluded" ||
    report.releaseBoundary?.bridgePrototypeDisposition !== "prototype_excluded" ||
    report.releaseBoundary?.bundledFileCount !== 1
  ) {
    return false;
  }
  const artifacts = new Map(manifestArtifacts.map((artifact) => [artifact.id, artifact.sha256]));
  return (
    report.releaseBoundary.stableCoreSha256 === artifacts.get("stable_core") &&
    report.releaseBoundary.nsisInstalledCoreSha256 ===
      artifacts.get("nsis_installed_core") &&
    report.releaseBoundary.installerSha256 === artifacts.get("nsis_installer")
  );
}

function validSignatureRecord(record) {
  return (
    hasExactKeys(record, [
      "status",
      "signerSubject",
      "signerThumbprint",
      "timestampPresent",
      "timestampSubject",
    ]) &&
    typeof record.status === "string" &&
    (record.signerSubject === null || typeof record.signerSubject === "string") &&
    (record.signerThumbprint === null || typeof record.signerThumbprint === "string") &&
    typeof record.timestampPresent === "boolean" &&
    (record.timestampSubject === null || typeof record.timestampSubject === "string")
  );
}

export function nsisPayloadEvidenceMatches(
  report,
  manifestArtifacts,
  inspectionScriptSha256,
  productVersion,
  licenseSourceSha256,
) {
  const artifacts = new Map(manifestArtifacts.map((artifact) => [artifact.id, artifact.sha256]));
  if (
    !hasExactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "mode",
      "ready",
      "bindings",
      "candidate",
      "installation",
      "environment",
      "signatures",
      "cleanup",
      "limitations",
    ]) ||
    report.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    report.mode !== "nsis_installed_payload" ||
    report.ready !== true ||
    !hasExactKeys(report.bindings, [
      "inspectionScriptSha256",
      "sourceStableCoreSha256",
      "installerSha256",
      "installedCoreSha256",
    ]) ||
    report.bindings.inspectionScriptSha256 !== inspectionScriptSha256 ||
    report.bindings.sourceStableCoreSha256 !== artifacts.get("stable_core") ||
    report.bindings.installerSha256 !== artifacts.get("nsis_installer") ||
    report.bindings.installedCoreSha256 !== artifacts.get("nsis_installed_core") ||
    !hasExactKeys(report.candidate, [
      "productVersion",
      "installedProductVersion",
      "sourceBytes",
      "installedBytes",
      "sourceUnkMarkerCount",
      "sourceNssMarkerCount",
      "installedUnkMarkerCount",
      "installedNssMarkerCount",
      "bothUnsigned",
      "expectedUnsignedInstalledCoreSha256",
      "exactUnsignedMarkerPatch",
    ]) ||
    report.candidate.productVersion !== productVersion ||
    report.candidate.installedProductVersion !== productVersion ||
    !Number.isInteger(report.candidate.sourceBytes) ||
    report.candidate.sourceBytes <= 0 ||
    !Number.isInteger(report.candidate.installedBytes) ||
    report.candidate.installedBytes <= 0 ||
    report.candidate.sourceUnkMarkerCount !== 1 ||
    report.candidate.sourceNssMarkerCount !== 0 ||
    report.candidate.installedUnkMarkerCount !== 0 ||
    report.candidate.installedNssMarkerCount !== 1 ||
    typeof report.candidate.bothUnsigned !== "boolean" ||
    !/^[A-F0-9]{64}$/u.test(report.candidate.expectedUnsignedInstalledCoreSha256) ||
    typeof report.candidate.exactUnsignedMarkerPatch !== "boolean" ||
    (report.candidate.bothUnsigned &&
      (!report.candidate.exactUnsignedMarkerPatch ||
        report.candidate.expectedUnsignedInstalledCoreSha256 !==
          artifacts.get("nsis_installed_core"))) ||
    !hasExactKeys(report.installation, [
      "installExitCode",
      "customTemporaryInstallRoot",
      "preexistingApplicationProcessCount",
      "preexistingProductRegistration",
      "preexistingShortcut",
      "licenseFiles",
      "licenseFilesExact",
      "licenseHashesMatch",
      "licenseBindings",
    ]) ||
    report.installation.installExitCode !== 0 ||
    report.installation.customTemporaryInstallRoot !== true ||
    report.installation.preexistingApplicationProcessCount !== 0 ||
    report.installation.preexistingProductRegistration !== false ||
    typeof report.installation.preexistingShortcut !== "boolean" ||
    JSON.stringify(report.installation.licenseFiles) !==
      JSON.stringify(NSIS_PAYLOAD_LICENSE_FILES) ||
    report.installation.licenseFilesExact !== true ||
    report.installation.licenseHashesMatch !== true ||
    !hasExactKeys(licenseSourceSha256, NSIS_PAYLOAD_LICENSE_FILES) ||
    !Array.isArray(report.installation.licenseBindings) ||
    report.installation.licenseBindings.length !== NSIS_PAYLOAD_LICENSE_FILES.length ||
    report.installation.licenseBindings.some((binding, index) => {
      const fileName = NSIS_PAYLOAD_LICENSE_FILES[index];
      return (
        !hasExactKeys(binding, [
          "fileName",
          "sourceSha256",
          "installedSha256",
          "matches",
        ]) ||
        binding.fileName !== fileName ||
        !/^[A-F0-9]{64}$/u.test(binding.sourceSha256) ||
        !/^[A-F0-9]{64}$/u.test(binding.installedSha256) ||
        binding.sourceSha256 !== licenseSourceSha256[fileName] ||
        binding.installedSha256 !== binding.sourceSha256 ||
        binding.matches !== true
      );
    }) ||
    !hasExactKeys(report.environment, [
      "currentUserAuthenticated",
      "profileRegistryQueryAvailable",
      "tokenProfilePathMatchesEnvironment",
    ]) ||
    report.environment.currentUserAuthenticated !== true ||
    report.environment.profileRegistryQueryAvailable !== true ||
    report.environment.tokenProfilePathMatchesEnvironment !== true ||
    !hasExactKeys(report.signatures, ["sourceStableCore", "installedCore"]) ||
    !validSignatureRecord(report.signatures.sourceStableCore) ||
    !validSignatureRecord(report.signatures.installedCore) ||
    !hasExactKeys(report.cleanup, [
      "uninstallExitCode",
      "installRootRemoved",
      "uninstallRegistrationRemoved",
      "productRegistrationPersistedAfterUninstall",
      "ownedProductRegistrationRemoved",
      "desktopShortcutStatePreserved",
      "startMenuShortcutStatePreserved",
      "applicationProcessCount",
    ]) ||
    report.cleanup.uninstallExitCode !== 0 ||
    report.cleanup.installRootRemoved !== true ||
    report.cleanup.uninstallRegistrationRemoved !== true ||
    typeof report.cleanup.productRegistrationPersistedAfterUninstall !== "boolean" ||
    report.cleanup.ownedProductRegistrationRemoved !== true ||
    report.cleanup.desktopShortcutStatePreserved !== true ||
    report.cleanup.startMenuShortcutStatePreserved !== true ||
    report.cleanup.applicationProcessCount !== 0 ||
    JSON.stringify(report.limitations) !== JSON.stringify(NSIS_PAYLOAD_LIMITATIONS)
  ) {
    return false;
  }
  return true;
}

export function upgradeRollbackProbeEvidenceMatches(
  report,
  manifestArtifacts,
  probeScriptSha256,
  candidateVersion,
  installBoundaryMode = "custom_temporary",
) {
  if (!["custom_temporary", "default_per_user"].includes(installBoundaryMode)) {
    return false;
  }
  const defaultInstall = installBoundaryMode === "default_per_user";
  const expectedReportMode = defaultInstall
    ? "release_default_upgrade_rollback_probe"
    : "release_upgrade_rollback_probe";
  const expectedLimitations = defaultInstall
    ? DEFAULT_UPGRADE_ROLLBACK_PROBE_LIMITATIONS
    : UPGRADE_ROLLBACK_PROBE_LIMITATIONS;
  const artifacts = new Map(manifestArtifacts.map((artifact) => [artifact.id, artifact]));
  const candidateInstaller = artifacts.get("nsis_installer");
  const candidateCore = artifacts.get("nsis_installed_core");
  if (
    !hasExactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "mode",
      "ready",
      "bindings",
      "versions",
      "installBoundary",
      "environment",
      "steps",
      "dataBoundary",
      "signatures",
      "cleanup",
      "limitations",
    ]) ||
    report.schemaVersion !== 2 ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    report.mode !== expectedReportMode ||
    report.ready !== true ||
    !hasExactKeys(report.bindings, [
      "probeScriptSha256",
      "historicalInstallerSha256",
      "historicalInstalledCoreSha256",
      "candidateInstallerSha256",
      "candidateInstalledCoreSha256",
    ]) ||
    report.bindings.probeScriptSha256 !== probeScriptSha256 ||
    report.bindings.historicalInstallerSha256 !== HISTORICAL_RELEASE.installerSha256 ||
    report.bindings.historicalInstalledCoreSha256 !==
      HISTORICAL_RELEASE.installedCoreSha256 ||
    report.bindings.candidateInstallerSha256 !== candidateInstaller?.sha256 ||
    report.bindings.candidateInstalledCoreSha256 !== candidateCore?.sha256 ||
    !hasExactKeys(report.versions, ["historical", "candidate"]) ||
    report.versions.historical !== HISTORICAL_RELEASE.version ||
    report.versions.candidate !== candidateVersion ||
    !hasExactKeys(report.installBoundary, [
      "mode",
      "cleanTestAccountAcknowledged",
      "defaultInstallRootUsed",
      "customTemporaryInstallRootUsed",
      "registrationGatePassed",
    ]) ||
    report.installBoundary.mode !== installBoundaryMode ||
    report.installBoundary.cleanTestAccountAcknowledged !== defaultInstall ||
    report.installBoundary.defaultInstallRootUsed !== defaultInstall ||
    report.installBoundary.customTemporaryInstallRootUsed !== !defaultInstall ||
    typeof report.installBoundary.registrationGatePassed !== "boolean" ||
    !hasExactKeys(report.environment, [
      "currentUserAuthenticated",
      "profileRegistryQueryAvailable",
      "tokenProfilePathMatchesEnvironment",
      "localAppDataMatchesTokenProfile",
      "currentUserRegistry64Writable",
      "preexistingApplicationProcessCount",
      "preexistingProductRegistration",
      "preexistingDataRoot",
      "preexistingDefaultInstallRoot",
      "preexistingShortcut",
      "preexistingRunValue",
    ]) ||
    report.environment.currentUserAuthenticated !== true ||
    report.environment.profileRegistryQueryAvailable !== true ||
    report.environment.tokenProfilePathMatchesEnvironment !== true ||
    report.environment.localAppDataMatchesTokenProfile !== true ||
    typeof report.environment.currentUserRegistry64Writable !== "boolean" ||
    report.environment.preexistingApplicationProcessCount !== 0 ||
    report.environment.preexistingProductRegistration !== false ||
    report.environment.preexistingDataRoot !== false ||
    report.environment.preexistingDefaultInstallRoot !== false ||
    report.environment.preexistingShortcut !== false ||
    report.environment.preexistingRunValue !== false ||
    !hasExactKeys(report.steps, [
      "historicalInstall",
      "candidateUpgrade",
      "candidateUninstallBeforeRollback",
      "historicalRollback",
      "historicalUninstall",
    ]) ||
    !Number.isInteger(candidateCore?.bytes) ||
    candidateCore.bytes <= 0
  ) {
    return false;
  }

  const validRegistrationDisposition = (step) => {
    if (!["owned", "absent"].includes(step.registrationDisposition)) return false;
    const expected = step.registrationDisposition === "owned";
    return (
      step.uninstallRootMatches === expected &&
      step.productRootMatches === expected &&
      step.displayVersionMatches === expected
    );
  };
  const validHistoricalInstall = (step) =>
    hasExactKeys(step, [
      "installExitCode",
      "installedProductVersion",
      "installedCoreBytes",
      "installedCoreSha256",
      "installedCoreMatches",
      "uninstallRootMatches",
      "productRootMatches",
      "displayVersionMatches",
      "registrationDisposition",
      "currentLicenseFilesAbsent",
      "sentinelPreserved",
    ]) &&
    step.installExitCode === 0 &&
    step.installedProductVersion === HISTORICAL_RELEASE.version &&
    step.installedCoreBytes === HISTORICAL_RELEASE.installedCoreBytes &&
    step.installedCoreSha256 === HISTORICAL_RELEASE.installedCoreSha256 &&
    step.installedCoreMatches === true &&
    validRegistrationDisposition(step) &&
    step.currentLicenseFilesAbsent === true &&
    step.sentinelPreserved === true;
  const validCandidateUpgrade = (step) =>
    hasExactKeys(step, [
      "installExitCode",
      "installedProductVersion",
      "installedCoreBytes",
      "installedCoreSha256",
      "installedCoreMatches",
      "uninstallRootMatches",
      "productRootMatches",
      "displayVersionMatches",
      "registrationDisposition",
      "licenseFiles",
      "licenseFilesExact",
      "licenseHashesMatch",
      "sentinelPreserved",
    ]) &&
    step.installExitCode === 0 &&
    step.installedProductVersion === candidateVersion &&
    step.installedCoreBytes === candidateCore.bytes &&
    step.installedCoreSha256 === candidateCore.sha256 &&
    step.installedCoreMatches === true &&
    validRegistrationDisposition(step) &&
    JSON.stringify(step.licenseFiles) === JSON.stringify(NSIS_PAYLOAD_LICENSE_FILES) &&
    step.licenseFilesExact === true &&
    step.licenseHashesMatch === true &&
    step.sentinelPreserved === true;
  const validPostUninstall = (step, registrationDisposition) => {
    if (
      !hasExactKeys(step, [
        "uninstallExitCode",
        "installRootRemoved",
        "uninstallRegistrationRemoved",
        "productRegistrationPresent",
        "productRootMatches",
        "productRegistrationPreserved",
        "registrationBoundaryConsistent",
        "sentinelPreserved",
      ])
    ) {
      return false;
    }
    const expectedRegistration = registrationDisposition === "owned";
    return (
      step.uninstallExitCode === 0 &&
      step.installRootRemoved === true &&
      step.uninstallRegistrationRemoved === true &&
      step.productRegistrationPresent === expectedRegistration &&
      step.productRootMatches === expectedRegistration &&
      step.productRegistrationPreserved === expectedRegistration &&
      step.registrationBoundaryConsistent === true &&
      step.sentinelPreserved === true
    );
  };

  const historicalInstall = report.steps.historicalInstall;
  const candidateUpgrade = report.steps.candidateUpgrade;
  const candidateUninstall = report.steps.candidateUninstallBeforeRollback;
  const historicalRollback = report.steps.historicalRollback;
  const historicalUninstall = report.steps.historicalUninstall;
  const expectedRegistrationGate =
    report.environment.currentUserRegistry64Writable === true &&
    historicalInstall.registrationDisposition === "owned" &&
    candidateUpgrade.registrationDisposition === "owned" &&
    historicalRollback.registrationDisposition === "owned" &&
    candidateUninstall.registrationBoundaryConsistent === true &&
    historicalUninstall.registrationBoundaryConsistent === true;
  if (
    !validHistoricalInstall(historicalInstall) ||
    !validCandidateUpgrade(candidateUpgrade) ||
    !validPostUninstall(candidateUninstall, candidateUpgrade.registrationDisposition) ||
    !validHistoricalInstall(historicalRollback) ||
    !validPostUninstall(historicalUninstall, historicalRollback.registrationDisposition) ||
    historicalInstall.registrationDisposition !== candidateUpgrade.registrationDisposition ||
    historicalInstall.registrationDisposition !== historicalRollback.registrationDisposition ||
    report.installBoundary.registrationGatePassed !== expectedRegistrationGate ||
    !hasExactKeys(report.dataBoundary, [
      "defaultLocalDataDirectoryUsed",
      "syntheticSentinelOnly",
      "authenticHistoricalDatabaseUsed",
      "sentinelSha256",
      "sentinelPreservedAtEveryStep",
    ]) ||
    report.dataBoundary.defaultLocalDataDirectoryUsed !== true ||
    report.dataBoundary.syntheticSentinelOnly !== true ||
    report.dataBoundary.authenticHistoricalDatabaseUsed !== false ||
    !/^[A-F0-9]{64}$/u.test(report.dataBoundary.sentinelSha256) ||
    report.dataBoundary.sentinelPreservedAtEveryStep !== true ||
    !hasExactKeys(report.signatures, ["historicalInstaller", "candidateInstaller"]) ||
    !validSignatureRecord(report.signatures.historicalInstaller) ||
    !validSignatureRecord(report.signatures.candidateInstaller) ||
    !hasExactKeys(report.cleanup, [
      "ownedProductRegistrationRemoved",
      "desktopShortcutStatePreserved",
      "startMenuShortcutStatePreserved",
      "dataRootRemoved",
      "qaRootRemoved",
      "applicationProcessCount",
    ]) ||
    report.cleanup.ownedProductRegistrationRemoved !== true ||
    report.cleanup.desktopShortcutStatePreserved !== true ||
    report.cleanup.startMenuShortcutStatePreserved !== true ||
    report.cleanup.dataRootRemoved !== true ||
    report.cleanup.qaRootRemoved !== true ||
    report.cleanup.applicationProcessCount !== 0 ||
    JSON.stringify(report.limitations) !== JSON.stringify(expectedLimitations)
  ) {
    return false;
  }
  return true;
}

export function defaultUpgradeRollbackProbeEvidenceMatches(
  report,
  manifestArtifacts,
  probeScriptSha256,
  candidateVersion,
) {
  return upgradeRollbackProbeEvidenceMatches(
    report,
    manifestArtifacts,
    probeScriptSha256,
    candidateVersion,
    "default_per_user",
  );
}

export function defaultUpgradeRollbackRegistrationEvidenceMatches(
  report,
  manifestArtifacts,
  probeScriptSha256,
  candidateVersion,
) {
  return (
    defaultUpgradeRollbackProbeEvidenceMatches(
      report,
      manifestArtifacts,
      probeScriptSha256,
      candidateVersion,
    ) && report.installBoundary.registrationGatePassed === true
  );
}

export function installFailureRecoveryProbeEvidenceMatches(
  report,
  manifestArtifacts,
  probeScriptSha256,
  candidateVersion,
  expectedCorruptedCandidate,
) {
  const artifacts = new Map(manifestArtifacts.map((artifact) => [artifact.id, artifact]));
  const candidateInstaller = artifacts.get("nsis_installer");
  const candidateCore = artifacts.get("nsis_installed_core");
  if (
    !hasExactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "mode",
      "ready",
      "bindings",
      "versions",
      "environment",
      "scenarios",
      "dataBoundary",
      "cleanup",
      "limitations",
    ]) ||
    report.schemaVersion !== 2 ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    report.mode !== "release_install_failure_recovery_probe" ||
    report.ready !== true ||
    !hasExactKeys(report.bindings, [
      "probeScriptSha256",
      "historicalInstallerSha256",
      "historicalInstalledCoreSha256",
      "candidateInstallerSha256",
      "candidateInstalledCoreSha256",
      "candidateInstallerBytes",
      "corruptedCandidateSha256",
      "corruptedCandidateBytes",
    ]) ||
    report.bindings.probeScriptSha256 !== probeScriptSha256 ||
    report.bindings.historicalInstallerSha256 !== HISTORICAL_RELEASE.installerSha256 ||
    report.bindings.historicalInstalledCoreSha256 !==
      HISTORICAL_RELEASE.installedCoreSha256 ||
    report.bindings.candidateInstallerSha256 !== candidateInstaller?.sha256 ||
    report.bindings.candidateInstalledCoreSha256 !== candidateCore?.sha256 ||
    report.bindings.candidateInstallerBytes !== candidateInstaller?.bytes ||
    report.bindings.corruptedCandidateSha256 !== expectedCorruptedCandidate?.sha256 ||
    report.bindings.corruptedCandidateBytes !== expectedCorruptedCandidate?.bytes ||
    !hasExactKeys(report.versions, ["historical", "candidate"]) ||
    report.versions.historical !== HISTORICAL_RELEASE.version ||
    report.versions.candidate !== candidateVersion ||
    !hasExactKeys(report.environment, [
      "currentUserAuthenticated",
      "profileRegistryQueryAvailable",
      "tokenProfilePathMatchesEnvironment",
      "localAppDataMatchesTokenProfile",
      "preexistingApplicationProcessCount",
      "preexistingProductRegistration",
      "preexistingDataRoot",
      "preexistingDefaultInstallRoot",
      "preexistingShortcut",
      "preexistingRunValue",
      "customTemporaryInstallRootUsed",
    ]) ||
    report.environment.currentUserAuthenticated !== true ||
    report.environment.profileRegistryQueryAvailable !== true ||
    report.environment.tokenProfilePathMatchesEnvironment !== true ||
    report.environment.localAppDataMatchesTokenProfile !== true ||
    report.environment.preexistingApplicationProcessCount !== 0 ||
    report.environment.preexistingProductRegistration !== false ||
    report.environment.preexistingDataRoot !== false ||
    report.environment.preexistingDefaultInstallRoot !== false ||
    report.environment.preexistingShortcut !== false ||
    report.environment.preexistingRunValue !== false ||
    report.environment.customTemporaryInstallRootUsed !== true ||
    !hasExactKeys(report.scenarios, [
      "historicalBaseline",
      "corruptedCandidate",
      "fileReplacementObstruction",
      "successfulWriteTermination",
      "candidateRecovery",
      "candidateUninstall",
    ]) ||
    !Number.isInteger(candidateInstaller?.bytes) ||
    candidateInstaller.bytes <= 0 ||
    !Number.isInteger(candidateCore?.bytes) ||
    candidateCore.bytes <= 0
  ) {
    return false;
  }

  const baseline = report.scenarios.historicalBaseline;
  if (
    !hasExactKeys(baseline, [
      "installExitCode",
      "installedProductVersion",
      "installedCoreBytes",
      "installedCoreSha256",
      "installedCoreMatches",
      "uninstallerSha256",
      "currentLicenseFilesAbsent",
      "sentinelPreserved",
    ]) ||
    baseline.installExitCode !== 0 ||
    baseline.installedProductVersion !== HISTORICAL_RELEASE.version ||
    baseline.installedCoreBytes !== HISTORICAL_RELEASE.installedCoreBytes ||
    baseline.installedCoreSha256 !== HISTORICAL_RELEASE.installedCoreSha256 ||
    baseline.installedCoreMatches !== true ||
    baseline.uninstallerSha256 !== HISTORICAL_RELEASE.installedUninstallerSha256 ||
    baseline.currentLicenseFilesAbsent !== true ||
    baseline.sentinelPreserved !== true
  ) {
    return false;
  }

  const validFailureLaunch = (step, extraKeys = []) => {
    if (
      !hasExactKeys(step, [
        ...extraKeys,
        "launchDisposition",
        "rootExitCode",
        "processTreeTimedOut",
        "processTreeTerminatedByProbe",
        "ownedProcessCountAfter",
        "maximumOwnedProcessCount",
        "startErrorType",
        "installedProductVersion",
        "installedCoreBytes",
        "installedCoreSha256",
        "oldCorePreserved",
        "uninstallerPreserved",
        "currentLicenseFilesAbsent",
        "sentinelPreserved",
      ]) ||
      !["start_rejected", "exited_nonzero", "terminated_after_timeout"].includes(
        step.launchDisposition,
      ) ||
      step.ownedProcessCountAfter !== 0 ||
      !Number.isInteger(step.maximumOwnedProcessCount) ||
      step.maximumOwnedProcessCount < 0 ||
      step.installedProductVersion !== HISTORICAL_RELEASE.version ||
      step.installedCoreBytes !== HISTORICAL_RELEASE.installedCoreBytes ||
      step.installedCoreSha256 !== HISTORICAL_RELEASE.installedCoreSha256 ||
      step.oldCorePreserved !== true ||
      step.uninstallerPreserved !== true ||
      step.currentLicenseFilesAbsent !== true ||
      step.sentinelPreserved !== true
    ) {
      return false;
    }
    if (step.launchDisposition === "start_rejected") {
      return (
        step.rootExitCode === null &&
        step.processTreeTimedOut === false &&
        step.processTreeTerminatedByProbe === false &&
        step.maximumOwnedProcessCount === 0 &&
        typeof step.startErrorType === "string" &&
        step.startErrorType.length > 0
      );
    }
    if (step.launchDisposition === "exited_nonzero") {
      return (
        Number.isInteger(step.rootExitCode) &&
        step.rootExitCode !== 0 &&
        step.processTreeTimedOut === false &&
        step.processTreeTerminatedByProbe === false &&
        step.maximumOwnedProcessCount >= 1 &&
        step.startErrorType === null
      );
    }
    return (
      (step.rootExitCode === null || Number.isInteger(step.rootExitCode)) &&
      step.processTreeTimedOut === true &&
      step.processTreeTerminatedByProbe === true &&
      step.maximumOwnedProcessCount >= 1 &&
      step.startErrorType === null
    );
  };

  const corrupted = report.scenarios.corruptedCandidate;
  const obstruction = report.scenarios.fileReplacementObstruction;
  if (
    !validFailureLaunch(corrupted) ||
    !validFailureLaunch(obstruction, ["exclusiveLockAcquired"]) ||
    obstruction.exclusiveLockAcquired !== true
  ) {
    return false;
  }

  const writeTermination = report.scenarios.successfulWriteTermination;
  if (
    !hasExactKeys(writeTermination, [
      "cpuHardCapPercent",
      "jobKillOnClose",
      "writeBoundaryObserved",
      "triggerMainExecutablePresent",
      "triggerMainExecutableBytes",
      "triggerReadErrorType",
      "rootExitCode",
      "processTreeTerminatedByProbe",
      "ownedProcessCountBeforeTermination",
      "ownedProcessCountAfter",
      "maximumOwnedProcessCount",
      "installedProductVersion",
      "installedCoreBytes",
      "installedCoreSha256",
      "candidateCoreMatches",
      "oldCorePreserved",
      "uninstallerPresent",
      "uninstallerSha256",
      "historicalUninstallerPreserved",
      "licenseFiles",
      "licenseFilesExact",
      "licenseHashesMatch",
      "interruptedFileSetChanged",
      "interruptedFileSetIncomplete",
      "sentinelPreserved",
    ]) ||
    writeTermination.cpuHardCapPercent !== 1 ||
    writeTermination.jobKillOnClose !== true ||
    writeTermination.writeBoundaryObserved !== true ||
    writeTermination.triggerMainExecutablePresent !== true ||
    !Number.isInteger(writeTermination.triggerMainExecutableBytes) ||
    writeTermination.triggerMainExecutableBytes <= 0 ||
    writeTermination.triggerMainExecutableBytes >= candidateCore.bytes ||
    writeTermination.triggerReadErrorType !== null ||
    writeTermination.rootExitCode !== 1 ||
    writeTermination.processTreeTerminatedByProbe !== true ||
    !Number.isInteger(writeTermination.ownedProcessCountBeforeTermination) ||
    writeTermination.ownedProcessCountBeforeTermination < 1 ||
    writeTermination.ownedProcessCountAfter !== 0 ||
    !Number.isInteger(writeTermination.maximumOwnedProcessCount) ||
    writeTermination.maximumOwnedProcessCount <
      writeTermination.ownedProcessCountBeforeTermination ||
    typeof writeTermination.installedProductVersion !== "string" ||
    !Number.isInteger(writeTermination.installedCoreBytes) ||
    writeTermination.installedCoreBytes <= 0 ||
    writeTermination.installedCoreBytes >= candidateCore.bytes ||
    !/^[A-F0-9]{64}$/u.test(writeTermination.installedCoreSha256) ||
    writeTermination.installedCoreSha256 === HISTORICAL_RELEASE.installedCoreSha256 ||
    writeTermination.installedCoreSha256 === candidateCore.sha256 ||
    writeTermination.candidateCoreMatches !== false ||
    writeTermination.oldCorePreserved !== false ||
    writeTermination.uninstallerPresent !== true ||
    writeTermination.uninstallerSha256 !== HISTORICAL_RELEASE.installedUninstallerSha256 ||
    writeTermination.historicalUninstallerPreserved !== true ||
    !Array.isArray(writeTermination.licenseFiles) ||
    writeTermination.licenseFiles.length !== 0 ||
    writeTermination.licenseFilesExact !== false ||
    writeTermination.licenseHashesMatch !== false ||
    writeTermination.interruptedFileSetChanged !== true ||
    writeTermination.interruptedFileSetIncomplete !== true ||
    writeTermination.sentinelPreserved !== true
  ) {
    return false;
  }

  const recovery = report.scenarios.candidateRecovery;
  const uninstall = report.scenarios.candidateUninstall;
  if (
    !hasExactKeys(recovery, [
      "installExitCode",
      "installedProductVersion",
      "installedCoreBytes",
      "installedCoreSha256",
      "installedCoreMatches",
      "licenseFiles",
      "licenseFilesExact",
      "licenseHashesMatch",
      "uninstallerSha256",
      "sentinelPreserved",
    ]) ||
    recovery.installExitCode !== 0 ||
    recovery.installedProductVersion !== candidateVersion ||
    recovery.installedCoreBytes !== candidateCore.bytes ||
    recovery.installedCoreSha256 !== candidateCore.sha256 ||
    recovery.installedCoreMatches !== true ||
    JSON.stringify(recovery.licenseFiles) !== JSON.stringify(NSIS_PAYLOAD_LICENSE_FILES) ||
    recovery.licenseFilesExact !== true ||
    recovery.licenseHashesMatch !== true ||
    !/^[A-F0-9]{64}$/u.test(recovery.uninstallerSha256) ||
    recovery.uninstallerSha256 === HISTORICAL_RELEASE.installedUninstallerSha256 ||
    recovery.sentinelPreserved !== true ||
    !hasExactKeys(uninstall, ["uninstallExitCode", "installRootRemoved", "sentinelPreserved"]) ||
    uninstall.uninstallExitCode !== 0 ||
    uninstall.installRootRemoved !== true ||
    uninstall.sentinelPreserved !== true ||
    !hasExactKeys(report.dataBoundary, [
      "defaultLocalDataDirectoryUsed",
      "syntheticSentinelOnly",
      "authenticHistoricalDatabaseUsed",
      "sentinelSha256",
      "sentinelPreservedAtEveryStep",
    ]) ||
    report.dataBoundary.defaultLocalDataDirectoryUsed !== true ||
    report.dataBoundary.syntheticSentinelOnly !== true ||
    report.dataBoundary.authenticHistoricalDatabaseUsed !== false ||
    !/^[A-F0-9]{64}$/u.test(report.dataBoundary.sentinelSha256) ||
    report.dataBoundary.sentinelPreservedAtEveryStep !== true ||
    !hasExactKeys(report.cleanup, [
      "ownedRegistrationRemoved",
      "unexpectedDefaultInstallRootAbsent",
      "desktopShortcutRemoved",
      "startMenuShortcutRemoved",
      "dataRootRemoved",
      "qaRootRemoved",
      "applicationProcessCount",
      "installerProcessCount",
    ]) ||
    report.cleanup.ownedRegistrationRemoved !== true ||
    report.cleanup.unexpectedDefaultInstallRootAbsent !== true ||
    report.cleanup.desktopShortcutRemoved !== true ||
    report.cleanup.startMenuShortcutRemoved !== true ||
    report.cleanup.dataRootRemoved !== true ||
    report.cleanup.qaRootRemoved !== true ||
    report.cleanup.applicationProcessCount !== 0 ||
    report.cleanup.installerProcessCount !== 0 ||
    JSON.stringify(report.limitations) !==
      JSON.stringify(INSTALL_FAILURE_RECOVERY_PROBE_LIMITATIONS)
  ) {
    return false;
  }
  return true;
}

export function uninstallDataChoiceProbeEvidenceMatches(
  report,
  manifestArtifacts,
  probeScriptSha256,
  candidateVersion,
) {
  const artifacts = new Map(manifestArtifacts.map((artifact) => [artifact.id, artifact]));
  const candidateInstaller = artifacts.get("nsis_installer");
  const candidateCore = artifacts.get("nsis_installed_core");
  if (
    !hasExactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "mode",
      "ready",
      "bindings",
      "version",
      "environment",
      "scenarios",
      "dataBoundary",
      "cleanup",
      "limitations",
    ]) ||
    report.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    report.mode !== "release_uninstall_data_choice_probe" ||
    report.ready !== true ||
    !hasExactKeys(report.bindings, [
      "probeScriptSha256",
      "candidateInstallerSha256",
      "candidateInstalledCoreSha256",
      "candidateInstallerBytes",
    ]) ||
    report.bindings.probeScriptSha256 !== probeScriptSha256 ||
    report.bindings.candidateInstallerSha256 !== candidateInstaller?.sha256 ||
    report.bindings.candidateInstalledCoreSha256 !== candidateCore?.sha256 ||
    report.bindings.candidateInstallerBytes !== candidateInstaller?.bytes ||
    report.version !== candidateVersion ||
    !hasExactKeys(report.environment, [
      "currentUserAuthenticated",
      "interactiveSession",
      "profileRegistryQueryAvailable",
      "tokenProfilePathMatchesEnvironment",
      "localAppDataMatchesTokenProfile",
      "roamingAppDataMatchesTokenProfile",
      "preexistingApplicationProcessCount",
      "preexistingProductRegistration",
      "preexistingLocalDataRoot",
      "preexistingRoamingDataRoot",
      "preexistingDefaultInstallRoot",
      "preexistingShortcut",
      "preexistingRunValue",
      "customTemporaryInstallRootUsed",
    ]) ||
    report.environment.currentUserAuthenticated !== true ||
    report.environment.interactiveSession !== true ||
    report.environment.profileRegistryQueryAvailable !== true ||
    report.environment.tokenProfilePathMatchesEnvironment !== true ||
    report.environment.localAppDataMatchesTokenProfile !== true ||
    report.environment.roamingAppDataMatchesTokenProfile !== true ||
    report.environment.preexistingApplicationProcessCount !== 0 ||
    report.environment.preexistingProductRegistration !== false ||
    report.environment.preexistingLocalDataRoot !== false ||
    report.environment.preexistingRoamingDataRoot !== false ||
    report.environment.preexistingDefaultInstallRoot !== false ||
    report.environment.preexistingShortcut !== false ||
    report.environment.preexistingRunValue !== false ||
    report.environment.customTemporaryInstallRootUsed !== true ||
    !hasExactKeys(report.scenarios, ["defaultPreserve", "explicitDelete"]) ||
    !Number.isInteger(candidateInstaller?.bytes) ||
    candidateInstaller.bytes <= 0 ||
    !Number.isInteger(candidateCore?.bytes) ||
    candidateCore.bytes <= 0
  ) {
    return false;
  }

  const validInstalledCore = (step) =>
    step.installExitCode === 0 &&
    step.installedProductVersion === candidateVersion &&
    step.installedCoreBytes === candidateCore.bytes &&
    step.installedCoreSha256 === candidateCore.sha256 &&
    step.installedCoreMatches === true;
  const preserve = report.scenarios.defaultPreserve;
  const explicit = report.scenarios.explicitDelete;
  const allowedButtonNames = new Set(["Uninstall", "Close"]);
  if (
    !hasExactKeys(preserve, [
      "installExitCode",
      "installedProductVersion",
      "installedCoreBytes",
      "installedCoreSha256",
      "installedCoreMatches",
      "uninstallExitCode",
      "installRootRemoved",
      "localDataSentinelPreserved",
      "roamingDataSentinelPreserved",
    ]) ||
    !validInstalledCore(preserve) ||
    preserve.uninstallExitCode !== 0 ||
    preserve.installRootRemoved !== true ||
    preserve.localDataSentinelPreserved !== true ||
    preserve.roamingDataSentinelPreserved !== true ||
    !hasExactKeys(explicit, [
      "installExitCode",
      "installedProductVersion",
      "installedCoreBytes",
      "installedCoreSha256",
      "installedCoreMatches",
      "checkboxFound",
      "checkboxInitiallyOff",
      "checkboxToggledOn",
      "uninstallButtonInvoked",
      "completionButtonInvoked",
      "processTreeTimedOut",
      "ownedProcessCountAfter",
      "observedButtonNames",
      "installRootRemoved",
      "localDataRootRemoved",
      "roamingDataRootRemoved",
    ]) ||
    !validInstalledCore(explicit) ||
    explicit.checkboxFound !== true ||
    explicit.checkboxInitiallyOff !== true ||
    explicit.checkboxToggledOn !== true ||
    explicit.uninstallButtonInvoked !== true ||
    explicit.completionButtonInvoked !== true ||
    explicit.processTreeTimedOut !== false ||
    explicit.ownedProcessCountAfter !== 0 ||
    !Array.isArray(explicit.observedButtonNames) ||
    explicit.observedButtonNames.length !== new Set(explicit.observedButtonNames).size ||
    !explicit.observedButtonNames.every(
      (name) => typeof name === "string" && allowedButtonNames.has(name),
    ) ||
    explicit.installRootRemoved !== true ||
    explicit.localDataRootRemoved !== true ||
    explicit.roamingDataRootRemoved !== true ||
    !hasExactKeys(report.dataBoundary, [
      "syntheticSentinelsOnly",
      "authenticUserDataUsed",
      "localSentinelSha256",
      "roamingSentinelSha256",
    ]) ||
    report.dataBoundary.syntheticSentinelsOnly !== true ||
    report.dataBoundary.authenticUserDataUsed !== false ||
    !/^[A-F0-9]{64}$/u.test(report.dataBoundary.localSentinelSha256) ||
    !/^[A-F0-9]{64}$/u.test(report.dataBoundary.roamingSentinelSha256) ||
    report.dataBoundary.localSentinelSha256 === report.dataBoundary.roamingSentinelSha256 ||
    !hasExactKeys(report.cleanup, [
      "ownedRegistrationRemoved",
      "desktopShortcutRemoved",
      "startMenuShortcutRemoved",
      "localDataRootRemoved",
      "roamingDataRootRemoved",
      "qaRootRemoved",
      "applicationProcessCount",
      "uninstallerProcessCount",
    ]) ||
    report.cleanup.ownedRegistrationRemoved !== true ||
    report.cleanup.desktopShortcutRemoved !== true ||
    report.cleanup.startMenuShortcutRemoved !== true ||
    report.cleanup.localDataRootRemoved !== true ||
    report.cleanup.roamingDataRootRemoved !== true ||
    report.cleanup.qaRootRemoved !== true ||
    report.cleanup.applicationProcessCount !== 0 ||
    report.cleanup.uninstallerProcessCount !== 0 ||
    JSON.stringify(report.limitations) !== JSON.stringify(UNINSTALL_DATA_CHOICE_PROBE_LIMITATIONS)
  ) {
    return false;
  }
  return true;
}

export function coldStartEvidenceMatches(
  report,
  manifestArtifacts,
  manifestSha256,
  measureScriptSha256,
) {
  const stableCoreSha256 = manifestArtifacts.find(
    (artifact) => artifact.id === "nsis_installed_core",
  )?.sha256;
  if (
    !hasExactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "mode",
      "ready",
      "failureCode",
      "bindings",
      "candidate",
      "environment",
      "summary",
      "samples",
      "limitations",
    ]) ||
    report.schemaVersion !== 2 ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    report?.mode !== "default_release_fresh_profile_cold_start" ||
    report?.ready !== true ||
    report?.failureCode !== null ||
    !hasExactKeys(report.bindings, ["measureScriptSha256"]) ||
    report.bindings.measureScriptSha256 !== measureScriptSha256 ||
    !hasExactKeys(report.candidate, [
      "manifestSha256",
      "stableCoreSha256",
      "stagedCopySha256",
      "byteIdenticalStagedCopy",
    ]) ||
    !hasExactKeys(report.environment, [
      "interactiveSession",
      "freshTestAccountAcknowledged",
      "preexistingDataRoot",
      "preexistingApplicationProcessCount",
      "applicationErrorQueryAvailable",
      "profileRegistryQueryAvailable",
      "tokenProfilePathMatchesEnvironment",
    ]) ||
    !hasExactKeys(report.summary, [
      "sampleCount",
      "minimumMilliseconds",
      "p50Milliseconds",
      "p95Milliseconds",
      "maximumMilliseconds",
    ]) ||
    JSON.stringify(report.limitations) !== JSON.stringify(COLD_START_LIMITATIONS) ||
    typeof stableCoreSha256 !== "string" ||
    report.candidate?.manifestSha256 !== manifestSha256 ||
    report.candidate?.stableCoreSha256 !== stableCoreSha256 ||
    report.candidate?.stagedCopySha256 !== stableCoreSha256 ||
    report.candidate?.byteIdenticalStagedCopy !== true ||
    report.environment?.interactiveSession !== true ||
    report.environment?.freshTestAccountAcknowledged !== true ||
    report.environment?.preexistingDataRoot !== false ||
    report.environment?.preexistingApplicationProcessCount !== 0 ||
    report.environment?.applicationErrorQueryAvailable !== true ||
    report.environment?.profileRegistryQueryAvailable !== true ||
    report.environment?.tokenProfilePathMatchesEnvironment !== true ||
    !Array.isArray(report.samples) ||
    report.samples.length < 3 ||
    report.summary?.sampleCount !== report.samples.length
  ) {
    return false;
  }
  const timings = report.samples.map((sample) => sample.startupToVisibleWindowMilliseconds);
  const sortedTimings = [...timings].sort((left, right) => left - right);
  const percentile = (value) =>
    sortedTimings[Math.max(0, Math.ceil(value * sortedTimings.length) - 1)];
  if (
    timings.some((timing) => !Number.isFinite(timing) || timing <= 0) ||
    !Number.isFinite(report.summary.minimumMilliseconds) ||
    !Number.isFinite(report.summary.p50Milliseconds) ||
    !Number.isFinite(report.summary.p95Milliseconds) ||
    !Number.isFinite(report.summary.maximumMilliseconds) ||
    report.summary.minimumMilliseconds > report.summary.p50Milliseconds ||
    report.summary.p50Milliseconds > report.summary.p95Milliseconds ||
    report.summary.p95Milliseconds > report.summary.maximumMilliseconds ||
    report.summary.minimumMilliseconds !== sortedTimings[0] ||
    report.summary.p50Milliseconds !== percentile(0.5) ||
    report.summary.p95Milliseconds !== percentile(0.95) ||
    report.summary.maximumMilliseconds !== sortedTimings.at(-1)
  ) {
    return false;
  }
  const sequences = new Set();
  const samplesValid = report.samples.every((sample) => {
    if (
      !hasExactKeys(sample, [
        "sequence",
        "visibleWindowObserved",
        "startupToVisibleWindowMilliseconds",
        "terminationMode",
        "ownedProcessCount",
        "aiChildProcessCount",
        "applicationErrorCount",
        "applicationErrorQueryAvailable",
        "dataRootRemoved",
      ]) ||
      !Number.isInteger(sample.sequence) ||
      sequences.has(sample.sequence)
    ) {
      return false;
    }
    sequences.add(sample.sequence);
    return (
      sample.visibleWindowObserved === true &&
      sample.terminationMode === "forced_after_window_probe" &&
      Number.isInteger(sample.ownedProcessCount) &&
      sample.ownedProcessCount >= 1 &&
      sample.aiChildProcessCount === 0 &&
      sample.applicationErrorCount === 0 &&
      sample.applicationErrorQueryAvailable === true &&
      sample.dataRootRemoved === true
    );
  });
  return (
    samplesValid &&
    [...sequences].sort((left, right) => left - right).every((value, index) => value === index + 1)
  );
}

export function check(id, passed, passedDetail, pending = false, pendingDetail = passedDetail) {
  return {
    id,
    status: passed ? "passed" : pending ? "pending" : "failed",
    detail: passed ? passedDetail : pendingDetail,
  };
}

export function defaultRegistrationPendingDetail(report, transitionEvidenceValid) {
  if (!transitionEvidenceValid) {
    return "尚未取得与当前候选绑定的干净测试账户默认安装路径及控制面板注册证据";
  }
  if (report?.environment?.currentUserRegistry64Writable === false) {
    return "默认路径文件转换已验证，但当前测试令牌无法写入64位HKCU，控制面板注册必须在可写注册表的干净账户复测";
  }
  return "默认路径文件转换已验证，测试账户可写64位HKCU，但尚未观察到逐阶段控制面板注册";
}

export function licenseReviewCheck(evidenceValid, reviewClaimed, packetReady) {
  return check(
    "license_review",
    evidenceValid,
    "当前候选、渠道、发布者、目标地区、第三方许可证、NOTICE、MPL源码地址和素材权利已由具名人工复核并通过结构化签字复验",
    !reviewClaimed,
    packetReady
      ? "候选绑定的许可证复核包已生成；仍需冻结渠道/发布者并由具名人工完成地区、NOTICE、源码可得性、素材权利与专业法律复核"
      : "尚未取得与当前候选材料完全一致的许可证人工复核包及具名签字",
  );
}

export function smartScreenCheck(evidenceValid, observationClaimed, packetReady) {
  return check(
    "smartscreen_clean_machine",
    evidenceValid,
    "当前候选已在满足下载来源标记、在线信誉与无历史执行条件的干净机上完成SmartScreen观察，并通过具名人工签字复验",
    !observationClaimed,
    packetReady
      ? "候选绑定的外部信任测试包已生成；仍需在真实干净机完成SmartScreen观察并提交具名人工签字"
      : "尚未取得与当前候选完全一致的SmartScreen外部测试包及具名人工签字",
  );
}

export function thirdPartySecurityCheck(
  evidenceValid,
  matrixClaimedComplete,
  minimumProducts,
  packetReady,
) {
  return check(
    "third_party_security_matrix",
    evidenceValid,
    `至少${minimumProducts}款非Defender目标安全软件已在真实实时防护环境完成零检测验证，并通过具名人工签字复验`,
    !matrixClaimedComplete,
    packetReady
      ? `候选绑定的外部信任测试包已生成；仍需完成至少${minimumProducts}款非Defender安全软件的真实零检测验证并提交具名人工签字`
      : `尚未取得与当前候选完全一致的至少${minimumProducts}款第三方安全软件测试包及具名人工签字`,
  );
}

export function rfc3161ProtocolCheck(evidenceValid, protocolClaimed, packetReady) {
  return check(
    "rfc3161_protocol_verified",
    evidenceValid,
    "当前候选三项正式产物的有效签名、同证书、精确发布者、时间戳证书及RFC 3161 /fd SHA256、/tr、/td SHA256操作证据已通过具名人工签字复验",
    !protocolClaimed,
    packetReady
      ? "候选绑定的签名协议包已生成；仍需冻结渠道、发布者和时间戳URL，使用真实签名候选完成RFC 3161操作并提交具名人工签字"
      : "尚未取得与当前候选完全一致的签名协议包及具名人工签字",
  );
}

export function accessibilityAcceptanceCheck(evidenceValid, acceptanceClaimed, packetReady) {
  return check(
    "accessibility_acceptance",
    evidenceValid,
    "当前签名候选已完成人工多档DPI、文本缩放、高对比度、减少动态、全键盘、Narrator及安装卸载矩阵，并通过候选绑定具名签字复验",
    !acceptanceClaimed,
    packetReady
      ? "候选绑定的无障碍验收包已生成；仍需在最终签名候选上完成人工多档DPI、文本缩放、高对比度、减少动态、全键盘、Narrator及安装卸载矩阵"
      : "尚未取得与当前候选完全一致的无障碍验收包及具名人工签字",
  );
}

export function upgradeRollbackDrillCheck(evidenceValid, drillClaimed, packetReady) {
  return check(
    "upgrade_rollback_drill",
    evidenceValid,
    "当前签名候选已在默认路径完成注册、真实v1.3.2数据库迁移、物理掉电或硬重置、真实Windows重启、安全恢复与旧版回退，并通过具名人工签字复验",
    !drillClaimed,
    packetReady
      ? "候选绑定的完整升级回退包已生成；仍需真实v1.3.2数据库、签名候选、可写HKCU、物理掉电或硬重置、真实Windows重启及具名人工签字"
      : "尚未取得与当前候选完全一致的完整升级回退包及具名人工签字",
  );
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();
}

function inspectSignatures() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      signatureScriptPath,
      "-ManifestPath",
      manifestPath,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`Authenticode inspection failed with exit code ${result.status}`);
  }
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function buildReport() {
  const [manifest, policy, evidence, packageJson, tauriConfig] = await Promise.all([
    readJson(manifestPath),
    readJson(policyPath),
    readJson(evidencePath),
    readJson(path.join(projectRoot, "package.json")),
    readJson(path.join(projectRoot, "src-tauri", "tauri.conf.json")),
  ]);

  if (manifest.schemaVersion !== 1 || policy.schemaVersion !== 1 || evidence.schemaVersion !== 1) {
    throw new Error("unsupported release evidence schema");
  }
  if (
    manifest.productVersion !== packageJson.version ||
    tauriConfig.version !== packageJson.version ||
    manifest.productName !== policy.product.name ||
    tauriConfig.identifier !== policy.product.identifier
  ) {
    throw new Error("release product identity or version is inconsistent");
  }
  if (
    JSON.stringify(policy.releaseArtifacts) !==
      JSON.stringify(["stable_core", "nsis_installed_core", "nsis_installer"]) ||
    JSON.stringify(policy.excludedPrototypeArtifacts) !==
      JSON.stringify(["bridge_prototype", "ai_prototype"])
  ) {
    throw new Error("release artifact policy is incomplete or reordered");
  }

  const ids = new Set();
  const artifactPaths = new Set();
  const canonicalReleaseRoot = await realpath(releaseRoot);
  let hashesMatch = manifest.artifacts.length === EXPECTED_ARTIFACTS.size;
  for (const artifact of manifest.artifacts) {
    if (
      ids.has(artifact.id) ||
      artifactPaths.has(artifact.path) ||
      EXPECTED_ARTIFACTS.get(artifact.id) !== artifact.bundleDisposition
    ) {
      hashesMatch = false;
      continue;
    }
    ids.add(artifact.id);
    artifactPaths.add(artifact.path);
    const absolutePath = resolveOwnedArtifact(releaseRoot, artifact.path);
    const [metadata, canonicalArtifact] = await Promise.all([
      lstat(absolutePath),
      realpath(absolutePath),
    ]);
    const canonicalRelative = path.relative(canonicalReleaseRoot, canonicalArtifact);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      canonicalRelative.startsWith("..") ||
      path.isAbsolute(canonicalRelative)
    ) {
      hashesMatch = false;
      continue;
    }
    if ((await hashFile(absolutePath)) !== artifact.sha256) hashesMatch = false;
  }
  for (const id of EXPECTED_ARTIFACTS.keys()) {
    if (!ids.has(id)) hashesMatch = false;
  }

  const bundle = tauriConfig.bundle ?? {};
  const bundleText = JSON.stringify({
    externalBin: bundle.externalBin ?? [],
    resources: bundle.resources ?? [],
  }).toLowerCase();
  const bundleIsolated = ![
    "yuanyuan-ai",
    "yuanyuan-bridge",
    "runtime-qa",
    "yuanyuan-task-watch-fixture",
    "migration-qa",
    "yuanyuan-database-migration-qa",
    "yuanyuan-pid-reuse-qa",
    "yuanyuan-crash-privacy-qa",
  ].some((marker) => bundleText.includes(marker));

  const signatureRecords = inspectSignatures();
  for (const artifact of manifest.artifacts) {
    const absolutePath = resolveOwnedArtifact(releaseRoot, artifact.path);
    if ((await hashFile(absolutePath)) !== artifact.sha256) hashesMatch = false;
  }
  const signatureGate = summarizeSignatureGate(
    signatureRecords,
    policy.releaseArtifacts,
    policy.signing.publisherSubject,
  );

  let sbom = null;
  let licenses = null;
  let defenderScan = null;
  let aiDisabledReport = null;
  let releaseColdStartReport = null;
  let nsisPayloadReport = null;
  let upgradeRollbackProbeReport = null;
  let defaultUpgradeRollbackProbeReport = null;
  let installFailureRecoveryProbeReport = null;
  let firstStartRecoveryProbeReport = null;
  let firstStartRecoveryDatabaseReport = null;
  let firstStartRecoveryDatabaseReportBytes = null;
  let licenseReviewPacket = null;
  let licenseReviewPacketBytes = null;
  let licenseReviewAttestation = null;
  let externalTrustPacket = null;
  let externalTrustPacketBytes = null;
  let externalTrustAttestation = null;
  let signingProtocolPacket = null;
  let signingProtocolPacketBytes = null;
  let signingProtocolAttestation = null;
  let accessibilityAcceptancePacket = null;
  let accessibilityAcceptancePacketBytes = null;
  let accessibilityAcceptanceAttestation = null;
  let upgradeCompletionPacket = null;
  let upgradeCompletionPacketBytes = null;
  let upgradeCompletionAttestation = null;
  let authenticV132MigrationReport = null;
  let authenticV132MigrationReportBytes = null;
  let uninstallDataChoiceProbeReport = null;
  let nsisScript = null;
  try {
    [sbom, licenses] = await Promise.all([readJson(sbomPath), readJson(licensePath)]);
  } catch {
    // The report intentionally records missing generated evidence as pending.
  }
  try {
    defenderScan = await readJson(defenderScanPath);
  } catch {
    // Defender is an explicit candidate-bound step and is allowed to be absent.
  }
  try {
    aiDisabledReport = await readJson(aiDisabledReportPath);
  } catch {
    // This automated regression is mandatory and becomes a failed check when absent.
  }
  try {
    releaseColdStartReport = await readJson(releaseColdStartReportPath);
  } catch {
    // Exact default-binary cold start needs a disposable fresh Windows test account.
  }
  try {
    nsisPayloadReport = await readJson(nsisPayloadReportPath);
  } catch {
    // The exact main executable embedded in NSIS must be extracted and candidate-bound.
  }
  try {
    upgradeRollbackProbeReport = await readJson(upgradeRollbackProbeReportPath);
  } catch {
    // The isolated historical/current installer transition is a candidate-bound probe.
  }
  try {
    defaultUpgradeRollbackProbeReport = await readJson(
      defaultUpgradeRollbackProbeReportPath,
    );
  } catch {
    // Default-path registration transitions require an acknowledged clean test account.
  }
  try {
    installFailureRecoveryProbeReport = await readJson(
      installFailureRecoveryProbeReportPath,
    );
  } catch {
    // Candidate corruption and replacement obstruction are isolated candidate-bound probes.
  }
  try {
    firstStartRecoveryProbeReport = await readJson(firstStartRecoveryProbeReportPath);
    firstStartRecoveryDatabaseReportBytes = await readFile(
      firstStartRecoveryDatabaseReportPath,
    );
    firstStartRecoveryDatabaseReport = JSON.parse(
      firstStartRecoveryDatabaseReportBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    // Controlled fresh-first-start interruption needs an acknowledged disposable account.
  }
  try {
    licenseReviewPacketBytes = await readFile(licenseReviewPacketPath);
    licenseReviewPacket = JSON.parse(
      licenseReviewPacketBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    // The deterministic packet is generated from the current candidate and license materials.
  }
  try {
    licenseReviewAttestation = await readJson(licenseReviewAttestationPath);
  } catch {
    // A named human reviewer must create this file after the channel and publisher are frozen.
  }
  try {
    externalTrustPacketBytes = await readFile(externalTrustPacketPath);
    externalTrustPacket = JSON.parse(
      externalTrustPacketBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    // The deterministic packet is generated from the current candidate and release policy.
  }
  try {
    externalTrustAttestation = await readJson(externalTrustAttestationPath);
  } catch {
    // Named human testers must create this file after real clean-machine observations.
  }
  try {
    signingProtocolPacketBytes = await readFile(signingProtocolPacketPath);
    signingProtocolPacket = JSON.parse(
      signingProtocolPacketBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    // The deterministic packet is generated from the current candidate and signing policy.
  }
  try {
    signingProtocolAttestation = await readJson(signingProtocolAttestationPath);
  } catch {
    // A named human signing operator must create this after the final signed candidate exists.
  }
  try {
    accessibilityAcceptancePacketBytes = await readFile(
      accessibilityAcceptancePacketPath,
    );
    accessibilityAcceptancePacket = JSON.parse(
      accessibilityAcceptancePacketBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    // The deterministic packet is generated from the candidate and accessibility policy.
  }
  try {
    accessibilityAcceptanceAttestation = await readJson(
      accessibilityAcceptanceAttestationPath,
    );
  } catch {
    // A named human must complete the signed-candidate Windows accessibility matrix.
  }
  try {
    upgradeCompletionPacketBytes = await readFile(upgradeCompletionPacketPath);
    upgradeCompletionPacket = JSON.parse(
      upgradeCompletionPacketBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    // The deterministic packet records present and missing candidate-bound completion materials.
  }
  try {
    upgradeCompletionAttestation = await readJson(upgradeCompletionAttestationPath);
  } catch {
    // A named human tester must create this after the real upgrade and interruption matrix.
  }
  try {
    authenticV132MigrationReportBytes = await readFile(authenticV132MigrationReportPath);
    authenticV132MigrationReport = JSON.parse(
      authenticV132MigrationReportBytes.toString("utf8").replace(/^\uFEFF/, ""),
    );
  } catch {
    // An authentic v1.3.2 database copy has not yet produced the canonical release report.
  }
  try {
    uninstallDataChoiceProbeReport = await readJson(uninstallDataChoiceProbeReportPath);
  } catch {
    // The real NSIS checkbox interaction requires a clean interactive Windows session.
  }
  try {
    nsisScript = await readFile(nsisScriptPath, "utf8");
  } catch {
    // The generated installer script is required to prove license resource installation.
  }
  const manifestSha256 = await hashFile(manifestPath);
  const releaseColdStartScriptSha256 = await hashFile(releaseColdStartScriptPath);
  const nsisPayloadScriptSha256 = await hashFile(nsisPayloadScriptPath);
  const nsisPayloadLicenseSourceSha256 = {
    "ASSETS_LICENSE.md": await hashFile(
      path.join(projectRoot, productBrand.assets.licenseFile),
    ),
    "LICENSE.txt": await hashFile(path.join(projectRoot, "LICENSE")),
    "THIRD_PARTY_LICENSES.txt": await hashFile(
      path.join(projectRoot, "THIRD_PARTY_LICENSES.txt"),
    ),
    "THIRD_PARTY_NOTICES.md": await hashFile(
      path.join(projectRoot, "THIRD_PARTY_NOTICES.md"),
    ),
  };
  const upgradeRollbackProbeScriptSha256 = await hashFile(upgradeRollbackProbeScriptPath);
  const installFailureRecoveryProbeScriptSha256 = await hashFile(
    installFailureRecoveryProbeScriptPath,
  );
  const firstStartRecoveryProbeScriptSha256 = await hashFile(
    firstStartRecoveryProbeScriptPath,
  );
  const firstStartRecoveryCaptureHelperSha256 = await hashFile(
    firstStartRecoveryCaptureHelperPath,
  );
  const uninstallDataChoiceProbeScriptSha256 = await hashFile(
    uninstallDataChoiceProbeScriptPath,
  );
  let firstStartRecoveryEvidenceValid = false;
  if (
    firstStartRecoveryProbeReport &&
    firstStartRecoveryDatabaseReport &&
    firstStartRecoveryDatabaseReportBytes
  ) {
    firstStartRecoveryEvidenceValid = await firstStartRecoveryEvidenceMatches({
      report: firstStartRecoveryProbeReport,
      captureReport: firstStartRecoveryDatabaseReport,
      fixturePath: firstStartRecoveryFixturePath,
      manifest,
      manifestSha256,
      probeScriptSha256: firstStartRecoveryProbeScriptSha256,
      captureHelperSha256: firstStartRecoveryCaptureHelperSha256,
      captureReportBytes: firstStartRecoveryDatabaseReportBytes.length,
      captureReportSha256: createHash("sha256")
        .update(firstStartRecoveryDatabaseReportBytes)
        .digest("hex")
      .toUpperCase(),
    });
  }
  let licenseReviewPacketReady = false;
  let licenseReviewEvidenceValid = false;
  try {
    const expectedLicenseReviewPacket = await buildReleaseLicenseReviewPacket();
    licenseReviewPacketReady =
      licenseReviewPacket !== null &&
      licenseReviewPacketBytes !== null &&
      licenseReviewPacketBytes.toString("utf8").replace(/^\uFEFF/, "") ===
        canonicalLicenseReviewPacketText(expectedLicenseReviewPacket);
    if (licenseReviewPacketReady && licenseReviewAttestation) {
      licenseReviewEvidenceValid = releaseLicenseReviewEvidenceMatches({
        attestation: licenseReviewAttestation,
        packet: licenseReviewPacket,
        expectedPacket: expectedLicenseReviewPacket,
        packetSha256: createHash("sha256")
          .update(licenseReviewPacketBytes)
          .digest("hex")
          .toUpperCase(),
        manifest,
        manifestSha256,
        releasePolicy: policy,
        releaseEvidence: evidence,
      });
    }
  } catch {
    // A stale or incomplete packet cannot satisfy the human license review gate.
  }
  let externalTrustPacketReady = false;
  let smartScreenEvidenceValid = false;
  let thirdPartySecurityEvidenceValid = false;
  try {
    const expectedExternalTrustPacket = await buildReleaseExternalTrustPacket();
    externalTrustPacketReady =
      externalTrustPacket !== null &&
      externalTrustPacketBytes !== null &&
      externalTrustPacketBytes.toString("utf8").replace(/^\uFEFF/, "") ===
        canonicalExternalTrustPacketText(expectedExternalTrustPacket);
    if (externalTrustPacketReady && externalTrustAttestation) {
      const externalTrustEvidence = {
        attestation: externalTrustAttestation,
        packet: externalTrustPacket,
        expectedPacket: expectedExternalTrustPacket,
        packetSha256: createHash("sha256")
          .update(externalTrustPacketBytes)
          .digest("hex")
          .toUpperCase(),
        manifest,
        manifestSha256,
        releasePolicy: policy,
        releaseEvidence: evidence,
      };
      smartScreenEvidenceValid =
        smartScreenExternalEvidenceMatches(externalTrustEvidence);
      thirdPartySecurityEvidenceValid =
        thirdPartySecurityExternalEvidenceMatches(externalTrustEvidence);
    }
  } catch {
    // Stale packets and incomplete attestations cannot satisfy external trust gates.
  }
  let signingProtocolPacketReady = false;
  let signingProtocolEvidenceValid = false;
  try {
    const expectedSigningProtocolPacket = await buildReleaseSigningProtocolPacket();
    signingProtocolPacketReady =
      signingProtocolPacket !== null &&
      signingProtocolPacketBytes !== null &&
      signingProtocolPacketBytes.toString("utf8").replace(/^\uFEFF/, "") ===
        canonicalSigningProtocolPacketText(expectedSigningProtocolPacket);
    if (signingProtocolPacketReady && signingProtocolAttestation) {
      signingProtocolEvidenceValid = releaseSigningProtocolEvidenceMatches({
        attestation: signingProtocolAttestation,
        packet: signingProtocolPacket,
        expectedPacket: expectedSigningProtocolPacket,
        packetSha256: createHash("sha256")
          .update(signingProtocolPacketBytes)
          .digest("hex")
          .toUpperCase(),
        manifest,
        manifestSha256,
        releasePolicy: policy,
        releaseEvidence: evidence,
        signatureRecords,
      });
    }
  } catch {
    // A stale packet, unfrozen policy, unsigned candidate, or incomplete attestation fails closed.
  }
  let accessibilityAcceptancePacketReady = false;
  let accessibilityAcceptanceEvidenceValid = false;
  try {
    const expectedAccessibilityAcceptancePacket =
      await buildReleaseAccessibilityAcceptancePacket();
    accessibilityAcceptancePacketReady =
      accessibilityAcceptancePacket !== null &&
      accessibilityAcceptancePacketBytes !== null &&
      accessibilityAcceptancePacketBytes.toString("utf8").replace(/^\uFEFF/, "") ===
        canonicalAccessibilityAcceptancePacketText(
          expectedAccessibilityAcceptancePacket,
        );
    if (accessibilityAcceptancePacketReady && accessibilityAcceptanceAttestation) {
      accessibilityAcceptanceEvidenceValid =
        releaseAccessibilityAcceptanceEvidenceMatches({
          attestation: accessibilityAcceptanceAttestation,
          packet: accessibilityAcceptancePacket,
          expectedPacket: expectedAccessibilityAcceptancePacket,
          packetSha256: createHash("sha256")
            .update(accessibilityAcceptancePacketBytes)
            .digest("hex")
            .toUpperCase(),
          manifest,
          manifestSha256,
          releasePolicy: policy,
          releaseEvidence: evidence,
          signatureRecords,
        });
    }
  } catch {
    // Missing human listening, matrix entries, signed artifacts, or exact bindings fail closed.
  }
  const candidateHash = manifest.artifacts.find((artifact) => artifact.id === "nsis_installer")?.sha256;
  const candidateInstallerArtifact = manifest.artifacts.find(
    (artifact) => artifact.id === "nsis_installer",
  );
  let expectedCorruptedCandidate = null;
  if (candidateInstallerArtifact) {
    const candidateInstallerPath = resolveOwnedArtifact(
      releaseRoot,
      candidateInstallerArtifact.path,
    );
    const candidateInstallerBytes = await readFile(candidateInstallerPath);
    const corruptedBytes = Math.floor(candidateInstallerBytes.length / 2);
    expectedCorruptedCandidate = {
      bytes: corruptedBytes,
      sha256: createHash("sha256")
        .update(candidateInstallerBytes.subarray(0, corruptedBytes))
        .digest("hex")
        .toUpperCase(),
    };
  }
  const isolatedTransitionEvidenceValid = upgradeRollbackProbeEvidenceMatches(
    upgradeRollbackProbeReport,
    manifest.artifacts,
    upgradeRollbackProbeScriptSha256,
    packageJson.version,
  );
  const defaultPathTransitionEvidenceValid = defaultUpgradeRollbackProbeEvidenceMatches(
    defaultUpgradeRollbackProbeReport,
    manifest.artifacts,
    upgradeRollbackProbeScriptSha256,
    packageJson.version,
  );
  const defaultPathRegistrationEvidenceValid =
    defaultUpgradeRollbackRegistrationEvidenceMatches(
      defaultUpgradeRollbackProbeReport,
      manifest.artifacts,
      upgradeRollbackProbeScriptSha256,
      packageJson.version,
    );
  const installFailureRecoveryEvidenceValid = installFailureRecoveryProbeEvidenceMatches(
    installFailureRecoveryProbeReport,
    manifest.artifacts,
    installFailureRecoveryProbeScriptSha256,
    packageJson.version,
    expectedCorruptedCandidate,
  );
  const uninstallDataChoiceEvidenceValid = uninstallDataChoiceProbeEvidenceMatches(
    uninstallDataChoiceProbeReport,
    manifest.artifacts,
    uninstallDataChoiceProbeScriptSha256,
    packageJson.version,
  );
  const upgradeAutomaticGates = {
    isolated_installer_transition_probe: isolatedTransitionEvidenceValid,
    default_install_path_transition_probe: defaultPathTransitionEvidenceValid,
    default_install_control_panel_registration: defaultPathRegistrationEvidenceValid,
    isolated_install_failure_recovery_probe: installFailureRecoveryEvidenceValid,
    default_release_first_start_database_recovery: firstStartRecoveryEvidenceValid,
    uninstall_data_choice_probe: uninstallDataChoiceEvidenceValid,
  };
  let upgradeCompletionPacketReady = false;
  let upgradeCompletionEvidenceValid = false;
  try {
    const expectedUpgradeCompletionPacket = await buildReleaseUpgradeCompletionPacket();
    upgradeCompletionPacketReady =
      upgradeCompletionPacket !== null &&
      upgradeCompletionPacketBytes !== null &&
      upgradeCompletionPacketBytes.toString("utf8").replace(/^\uFEFF/, "") ===
        canonicalUpgradeCompletionPacketText(expectedUpgradeCompletionPacket);
    if (
      upgradeCompletionPacketReady &&
      upgradeCompletionAttestation &&
      authenticV132MigrationReport &&
      authenticV132MigrationReportBytes
    ) {
      upgradeCompletionEvidenceValid = upgradeCompletionAttestationMatches({
        attestation: upgradeCompletionAttestation,
        packet: upgradeCompletionPacket,
        expectedPacket: expectedUpgradeCompletionPacket,
        packetSha256: createHash("sha256")
          .update(upgradeCompletionPacketBytes)
          .digest("hex")
          .toUpperCase(),
        manifest,
        manifestSha256,
        releaseEvidence: evidence,
        automaticGates: upgradeAutomaticGates,
        signatureGate,
        signingProtocolEvidenceValid,
        migrationReport: authenticV132MigrationReport,
        migrationReportBytes: authenticV132MigrationReportBytes,
      });
    }
  } catch {
    // Missing real database, signed-candidate, restart, power-loss, or human evidence fails closed.
  }
  const checks = [
    check("artifact_hashes", hashesMatch, "清单中的产物集合、角色和SHA-256与磁盘一致"),
    check("installer_boundary", bundleIsolated, "正式安装声明不包含Bridge、AI或运行验收夹具"),
    check(
      "nsis_installed_payload",
      nsisPayloadEvidenceMatches(
        nsisPayloadReport,
        manifest.artifacts,
        nsisPayloadScriptSha256,
        packageJson.version,
        nsisPayloadLicenseSourceSha256,
      ),
      "NSIS实际安装主程序已提取、绑定候选并验证包类型、许可材料和卸载清理",
      true,
      "尚未取得与当前候选绑定的NSIS实际安装主程序证据",
    ),
    check(
      "isolated_installer_transition_probe",
      isolatedTransitionEvidenceValid,
      "官方v1.3.2与当前候选已完成隔离安装、升级、先卸载当前版再回装旧版及数据哨兵保留探测",
      true,
      "尚未取得与当前候选绑定的隔离安装、升级和安全回装旧版探测证据",
    ),
    check(
      "default_install_path_transition_probe",
      defaultPathTransitionEvidenceValid,
      "官方v1.3.2与当前候选已在明确确认的干净测试账户完成默认安装路径、升级、卸载和安全回装旧版文件转换；控制面板注册仍由完整门单独判定",
      true,
      "尚未取得与当前候选绑定的干净测试账户默认安装路径文件转换证据",
    ),
    check(
      "default_install_control_panel_registration",
      defaultPathRegistrationEvidenceValid,
      "官方v1.3.2与当前候选已在可写HKCU的干净账户逐阶段验证控制面板注册、版本和卸载边界",
      true,
      defaultRegistrationPendingDetail(
        defaultUpgradeRollbackProbeReport,
        defaultPathTransitionEvidenceValid,
      ),
    ),
    check(
      "isolated_install_failure_recovery_probe",
      installFailureRecoveryEvidenceValid,
      "损坏候选和主程序替换受阻均在写入前非零中止；另在观察到部分主程序写入后终止受限Job，证明不完整文件集、合成数据哨兵保留及原始候选恢复",
      true,
      "尚未取得与当前候选绑定的损坏安装包及文件替换受阻恢复证据",
    ),
    check(
      "default_release_first_start_database_recovery",
      firstStartRecoveryEvidenceValid,
      "当前NSIS安装核心已在干净合成数据目录观察到非空SQLite WAL后受控终止，并由同一候选恢复至可见窗口、架构11与完整默认数据；规范化数据库样本及清理状态均已独立复验",
      true,
      "尚未取得与当前候选绑定的首次启动写库受控终止、同候选恢复及规范化数据库证据",
    ),
    check(
      "uninstall_data_choice_probe",
      uninstallDataChoiceEvidenceValid,
      "真实NSIS卸载器已证明默认同时保留Local与Roaming数据，只有明确勾选删除数据后才移除两个合成数据根",
      true,
      "尚未取得与当前候选绑定的NSIS默认保留与明确选择删除数据交互证据",
    ),
    check(
      "ai_disabled_regression",
      aiDisabledEvidenceMatches(aiDisabledReport, manifest.artifacts, manifestSha256),
      "AI关闭组合门已绑定当前主程序和安装包，且默认核心只允许本地IPC",
    ),
    check(
      "default_release_fresh_profile_cold_start",
      coldStartEvidenceMatches(
        releaseColdStartReport,
        manifest.artifacts,
        manifestSha256,
        releaseColdStartScriptSha256,
      ),
      "默认release主程序已在干净Windows测试账户完成候选绑定的新配置冷启动采样",
      true,
      "尚未取得与当前候选绑定的干净Windows测试账户新配置冷启动证据",
    ),
    check(
      "sbom_generated",
      sbom?.bomFormat === "CycloneDX",
      "已生成CycloneDX依赖物料清单",
      true,
      "尚未生成CycloneDX依赖物料清单",
    ),
    check(
      "license_inventory_generated",
      licenses?.schemaVersion === 1 && licenses?.summary?.unresolved === 0,
      "已生成无缺失声明的第三方许可证清单",
      true,
      "尚未生成无缺失声明的第三方许可证清单",
    ),
    check(
      "license_materials_bundled",
      licenseBundleEvidenceMatches(bundle.resources, nsisScript),
      "安装脚本会安装并卸载代码、素材、第三方摘要和逐组件许可原文",
    ),
    check(
      "distribution_channel_selected",
      policy.distribution.selectedChannel !== "pending",
      "发布渠道已冻结",
      true,
      "发布渠道尚未冻结",
    ),
    check(
      "publisher_identity_frozen",
      signatureGate.identityFrozen,
      "精确发布者Subject已冻结",
      true,
      "精确发布者Subject尚未冻结",
    ),
    check(
      "release_artifacts_signed",
      signatureGate.signed,
      "主程序和安装包的Authenticode状态均为Valid",
      true,
      "主程序和安装包尚未取得有效Authenticode签名",
    ),
    check(
      "one_certificate_per_release",
      signatureGate.sameCertificate,
      "同一候选产物使用同一张签名证书",
      true,
      "尚未证明同一候选产物使用同一张签名证书",
    ),
    check(
      "publisher_identity_matches",
      signatureGate.publisherMatches,
      "签名发布者与冻结身份精确一致",
      true,
      "尚未证明签名发布者与冻结身份精确一致",
    ),
    check(
      "trusted_timestamp_present",
      signatureGate.timestamped,
      "所有发布产物均包含可验证时间戳证书",
      true,
      "发布产物尚未包含可验证时间戳证书",
    ),
    rfc3161ProtocolCheck(
      signingProtocolEvidenceValid,
      evidence.rfc3161ProtocolVerified === true,
      signingProtocolPacketReady,
    ),
    accessibilityAcceptanceCheck(
      accessibilityAcceptanceEvidenceValid,
      evidence.accessibilityAcceptanceVerified === true,
      accessibilityAcceptancePacketReady,
    ),
    check(
      "defender_scan",
      defenderEvidenceMatches(defenderScan, manifest.artifacts, policy.releaseArtifacts),
      "当前候选已完成Defender扫描",
      true,
      "当前候选尚未完成Defender扫描",
    ),
    smartScreenCheck(
      smartScreenEvidenceValid,
      evidence.smartScreenCleanMachineObserved === true,
      externalTrustPacketReady,
    ),
    thirdPartySecurityCheck(
      thirdPartySecurityEvidenceValid,
      Number.isInteger(evidence.thirdPartySecurityProductsVerified) &&
        evidence.thirdPartySecurityProductsVerified >=
          policy.manualReleaseGates.minimumThirdPartySecurityProducts,
      policy.manualReleaseGates.minimumThirdPartySecurityProducts,
      externalTrustPacketReady,
    ),
    upgradeRollbackDrillCheck(
      upgradeCompletionEvidenceValid,
      evidence.upgradeRollbackDrillVerified === true,
      upgradeCompletionPacketReady,
    ),
    licenseReviewCheck(
      licenseReviewEvidenceValid,
      evidence.licenseReviewVerified === true,
      licenseReviewPacketReady,
    ),
  ];

  const ready = checks.every((item) => item.status === "passed");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    productVersion: packageJson.version,
    candidateSha256: candidateHash,
    readyForRelease: ready,
    summary: {
      passed: checks.filter((item) => item.status === "passed").length,
      pending: checks.filter((item) => item.status === "pending").length,
      failed: checks.filter((item) => item.status === "failed").length,
    },
    checks,
    signatures: signatureRecords,
    defender: defenderScan,
    evidenceReferences: evidence.evidenceReferences,
  };
}

export async function main(args = process.argv.slice(2)) {
  const strict = args.includes("--strict");
  if (args.some((arg) => arg !== "--strict")) {
    throw new Error("usage: node scripts/generate_release_preflight.mjs [--strict]");
  }
  const report = await buildReport();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `Release preflight: ${report.summary.passed} passed, ${report.summary.pending} pending, ${report.summary.failed} failed.`,
  );
  console.log(`Report written: ${reportPath}`);
  if (strict && !report.readyForRelease) process.exitCode = 2;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
