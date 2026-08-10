import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCESSIBILITY_ATTESTATION_TEXT,
  ACCESSIBILITY_SOP_REFERENCE,
  CONTRAST_MODES,
  CORE_WORKFLOWS,
  DPI_PERCENTAGES,
  KEYBOARD_PATHS,
  NARRATOR_PATHS,
  SETUP_PATHS,
  TEXT_SCALE_PERCENTAGES,
  buildReleaseAccessibilityAcceptancePacket,
  canonicalAccessibilityAcceptancePacketText,
} from "./generate_release_accessibility_acceptance_packet.mjs";

export const ACCESSIBILITY_ACCEPTANCE_PACKET_REFERENCE =
  "src-tauri/target/release/release-accessibility-acceptance-packet.json";
export const ACCESSIBILITY_ACCEPTANCE_ATTESTATION_REFERENCE =
  "docs/release/RELEASE_ACCESSIBILITY_ACCEPTANCE_ATTESTATION_V1.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exact(Object.keys(value).sort(), [...keys].sort())
  );
}

function validText(value, minimum, maximum) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function validHumanTester(tester) {
  if (
    !hasExactKeys(tester, ["name", "role", "organization", "humanTester"]) ||
    !validText(tester.name, 3, 80) ||
    !validText(tester.role, 3, 80) ||
    !validText(tester.organization, 2, 120) ||
    tester.humanTester !== true
  ) {
    return false;
  }
  return !/(?:\bcodex\b|\bchatgpt\b|\bai\b|\bbot\b|automated|automation|人工智能|自动化)/i.test(
    `${tester.name} ${tester.role} ${tester.organization}`,
  );
}

function validEnvironment(environment) {
  return (
    hasExactKeys(environment, [
      "machineAlias",
      "windowsEdition",
      "windowsVersion",
      "osBuild",
      "webView2Version",
      "accountType",
      "systemLanguage",
      "interactiveDesktop",
      "audioOutputAvailable",
      "cleanSnapshotSha256",
    ]) &&
    validText(environment.machineAlias, 3, 80) &&
    validText(environment.windowsEdition, 3, 80) &&
    validText(environment.windowsVersion, 2, 40) &&
    validText(environment.osBuild, 3, 40) &&
    validText(environment.webView2Version, 3, 80) &&
    ["standard_user", "administrator"].includes(environment.accountType) &&
    validText(environment.systemLanguage, 2, 40) &&
    environment.interactiveDesktop === true &&
    environment.audioOutputAvailable === true &&
    /^[A-F0-9]{64}$/.test(environment.cleanSnapshotSha256)
  );
}

function validReference(reference) {
  if (typeof reference !== "string" || reference.length < 5 || reference.length > 300) {
    return false;
  }
  if (reference.startsWith("https://")) return true;
  return (
    !path.isAbsolute(reference) &&
    !reference.includes("\\") &&
    !reference.split("/").includes("..") &&
    reference.startsWith("docs/")
  );
}

function validReferences(references, minimum, requiredReference = null) {
  return (
    Array.isArray(references) &&
    references.length >= minimum &&
    references.every(validReference) &&
    exact(
      references,
      [...new Set(references)].sort((left, right) => left.localeCompare(right, "en")),
    ) &&
    (requiredReference === null || references.includes(requiredReference))
  );
}

function validTimeWindow(startedAt, completedAt, manifestGeneratedAt, now) {
  const start = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  const manifest = Date.parse(manifestGeneratedAt);
  return (
    Number.isFinite(start) &&
    Number.isFinite(completed) &&
    Number.isFinite(manifest) &&
    start >= manifest &&
    completed >= start &&
    completed <= now.getTime() + 5 * 60 * 1000
  );
}

function validWorkflowResults(results) {
  return (
    hasExactKeys(results, CORE_WORKFLOWS) &&
    CORE_WORKFLOWS.every((workflow) => results[workflow] === "passed")
  );
}

function validVisualObservation(observation, expectedPercent, installedCoreSha256) {
  return (
    hasExactKeys(observation, [
      "percent",
      "installedCoreSha256",
      "workflowResults",
      "noClipping",
      "noOverlap",
      "noUnexpectedHorizontalScroll",
      "readableText",
      "evidenceReferences",
      "passed",
    ]) &&
    observation.percent === expectedPercent &&
    observation.installedCoreSha256 === installedCoreSha256 &&
    validWorkflowResults(observation.workflowResults) &&
    observation.noClipping === true &&
    observation.noOverlap === true &&
    observation.noUnexpectedHorizontalScroll === true &&
    observation.readableText === true &&
    validReferences(observation.evidenceReferences, 1) &&
    observation.passed === true
  );
}

function validContrastObservation(observation, expectedMode, installedCoreSha256) {
  return (
    hasExactKeys(observation, [
      "mode",
      "installedCoreSha256",
      "systemContrastEnabled",
      "workflowResults",
      "foregroundBackgroundDistinct",
      "focusVisible",
      "selectedAndDisabledStatesDistinct",
      "informationNotColorOnly",
      "evidenceReferences",
      "passed",
    ]) &&
    observation.mode === expectedMode &&
    observation.installedCoreSha256 === installedCoreSha256 &&
    observation.systemContrastEnabled === true &&
    validWorkflowResults(observation.workflowResults) &&
    observation.foregroundBackgroundDistinct === true &&
    observation.focusVisible === true &&
    observation.selectedAndDisabledStatesDistinct === true &&
    observation.informationNotColorOnly === true &&
    validReferences(observation.evidenceReferences, 1) &&
    observation.passed === true
  );
}

function validReducedMotionObservation(observation, installedCoreSha256) {
  return (
    hasExactKeys(observation, [
      "installedCoreSha256",
      "windowsAnimationEffectsDisabled",
      "applicationReducedMotionEnabled",
      "coreWorkflowsCompleted",
      "animatedMotionReplaced",
      "meaningPreserved",
      "noFlashing",
      "evidenceReferences",
      "passed",
    ]) &&
    observation.installedCoreSha256 === installedCoreSha256 &&
    observation.windowsAnimationEffectsDisabled === true &&
    observation.applicationReducedMotionEnabled === true &&
    observation.coreWorkflowsCompleted === true &&
    observation.animatedMotionReplaced === true &&
    observation.meaningPreserved === true &&
    observation.noFlashing === true &&
    validReferences(observation.evidenceReferences, 1) &&
    observation.passed === true
  );
}

function validKeyboardPath(observation, expectedPath, installedCoreSha256) {
  return (
    hasExactKeys(observation, [
      "pathId",
      "installedCoreSha256",
      "pointerUsed",
      "allControlsReachable",
      "focusOrderLogical",
      "focusVisible",
      "focusReturnedAfterDialog",
      "escapeOrCancelAvailable",
      "evidenceReferences",
      "passed",
    ]) &&
    observation.pathId === expectedPath &&
    observation.installedCoreSha256 === installedCoreSha256 &&
    observation.pointerUsed === false &&
    observation.allControlsReachable === true &&
    observation.focusOrderLogical === true &&
    observation.focusVisible === true &&
    observation.focusReturnedAfterDialog === true &&
    observation.escapeOrCancelAvailable === true &&
    validReferences(observation.evidenceReferences, 1) &&
    observation.passed === true
  );
}

function validNarratorPath(observation, expectedPath, installedCoreSha256) {
  return (
    hasExactKeys(observation, [
      "pathId",
      "installedCoreSha256",
      "screenReader",
      "speechOutputHeard",
      "namesRolesAndStatesAccurate",
      "dynamicChangesAnnounced",
      "noCriticalSilence",
      "noDuplicateBlockingAnnouncement",
      "evidenceReferences",
      "passed",
    ]) &&
    observation.pathId === expectedPath &&
    observation.installedCoreSha256 === installedCoreSha256 &&
    observation.screenReader === "Windows Narrator" &&
    observation.speechOutputHeard === true &&
    observation.namesRolesAndStatesAccurate === true &&
    observation.dynamicChangesAnnounced === true &&
    observation.noCriticalSilence === true &&
    observation.noDuplicateBlockingAnnouncement === true &&
    validReferences(observation.evidenceReferences, 1) &&
    observation.passed === true
  );
}

function validSetupPath(observation, expectedPath, installerSha256, installedCoreSha256) {
  const expectedDisposition = {
    installer_install: "not_applicable",
    uninstaller_preserve_data: "preserved",
    uninstaller_delete_data: "deleted",
  }[expectedPath];
  return (
    hasExactKeys(observation, [
      "pathId",
      "installerSha256",
      "installedCoreSha256",
      "keyboardOnly",
      "narratorUsed",
      "choicesAndConsequencesAnnounced",
      "focusVisible",
      "dataDispositionObserved",
      "evidenceReferences",
      "passed",
    ]) &&
    observation.pathId === expectedPath &&
    observation.installerSha256 === installerSha256 &&
    observation.installedCoreSha256 === installedCoreSha256 &&
    observation.keyboardOnly === true &&
    observation.narratorUsed === true &&
    observation.choicesAndConsequencesAnnounced === true &&
    observation.focusVisible === true &&
    observation.dataDispositionObserved === expectedDisposition &&
    validReferences(observation.evidenceReferences, 1) &&
    observation.passed === true
  );
}

function validArtifactRecords(records, releaseArtifacts) {
  return (
    Array.isArray(records) &&
    records.length === releaseArtifacts.length &&
    records.every((record, index) => {
      const artifact = releaseArtifacts[index];
      return (
        hasExactKeys(record, ["id", "bytes", "sha256", "executed", "passed"]) &&
        record.id === artifact.id &&
        record.bytes === artifact.bytes &&
        record.sha256 === artifact.sha256 &&
        record.executed === true &&
        record.passed === true
      );
    })
  );
}

function validSignatureRecords(signatureRecords, releasePolicy) {
  const ids = releasePolicy.releaseArtifacts;
  const publisher = releasePolicy.signing?.publisherSubject;
  if (!validText(publisher, 3, 300) || !Array.isArray(signatureRecords)) return false;
  const selected = ids.map((id) => signatureRecords.find((record) => record.id === id));
  if (
    selected.some(
      (record) =>
        !record ||
        record.status !== "Valid" ||
        record.signerSubject !== publisher ||
        !/^[A-F0-9]{40,64}$/.test(record.signerThumbprint ?? "") ||
        record.timestampPresent !== true ||
        !validText(record.timestampSubject, 3, 300),
    )
  ) {
    return false;
  }
  return new Set(selected.map((record) => record.signerThumbprint)).size === 1;
}

export function accessibilityAcceptanceAttestationMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releasePolicy,
  signatureRecords,
  now = new Date(),
}) {
  const installedCore = packet?.candidate?.releaseArtifacts?.find(
    (artifact) => artifact.id === "nsis_installed_core",
  );
  const installer = packet?.candidate?.releaseArtifacts?.find(
    (artifact) => artifact.id === "nsis_installer",
  );
  if (
    !exact(packet, expectedPacket) ||
    !hasExactKeys(attestation, [
      "schemaVersion",
      "mode",
      "packetSha256",
      "candidateManifestSha256",
      "startedAt",
      "completedAt",
      "tester",
      "environment",
      "humanObservedAllResults",
      "automationUsedForPrimaryVerdict",
      "artifactRecords",
      "dpiObservations",
      "textScaleObservations",
      "contrastObservations",
      "reducedMotionObservation",
      "keyboardPaths",
      "narratorPaths",
      "setupPaths",
      "unresolvedFindings",
      "evidenceReferences",
      "attestationText",
    ]) ||
    attestation.schemaVersion !== 1 ||
    attestation.mode !== "release_accessibility_acceptance_attestation" ||
    attestation.packetSha256 !== packetSha256 ||
    attestation.candidateManifestSha256 !== manifestSha256 ||
    attestation.candidateManifestSha256 !== packet.candidate.manifestSha256 ||
    releasePolicy.manualReleaseGates?.requireAccessibilityAcceptance !== true ||
    !validTimeWindow(attestation.startedAt, attestation.completedAt, manifest.generatedAt, now) ||
    !validHumanTester(attestation.tester) ||
    !validEnvironment(attestation.environment) ||
    attestation.humanObservedAllResults !== true ||
    attestation.automationUsedForPrimaryVerdict !== false ||
    !validArtifactRecords(attestation.artifactRecords, packet.candidate.releaseArtifacts) ||
    !installedCore ||
    !installer ||
    !validSignatureRecords(signatureRecords, releasePolicy) ||
    !Array.isArray(attestation.dpiObservations) ||
    attestation.dpiObservations.length !== DPI_PERCENTAGES.length ||
    !attestation.dpiObservations.every((observation, index) =>
      validVisualObservation(observation, DPI_PERCENTAGES[index], installedCore.sha256),
    ) ||
    !Array.isArray(attestation.textScaleObservations) ||
    attestation.textScaleObservations.length !== TEXT_SCALE_PERCENTAGES.length ||
    !attestation.textScaleObservations.every((observation, index) =>
      validVisualObservation(
        observation,
        TEXT_SCALE_PERCENTAGES[index],
        installedCore.sha256,
      ),
    ) ||
    !Array.isArray(attestation.contrastObservations) ||
    attestation.contrastObservations.length !== CONTRAST_MODES.length ||
    !attestation.contrastObservations.every((observation, index) =>
      validContrastObservation(observation, CONTRAST_MODES[index], installedCore.sha256),
    ) ||
    !validReducedMotionObservation(
      attestation.reducedMotionObservation,
      installedCore.sha256,
    ) ||
    !Array.isArray(attestation.keyboardPaths) ||
    attestation.keyboardPaths.length !== KEYBOARD_PATHS.length ||
    !attestation.keyboardPaths.every((observation, index) =>
      validKeyboardPath(observation, KEYBOARD_PATHS[index], installedCore.sha256),
    ) ||
    !Array.isArray(attestation.narratorPaths) ||
    attestation.narratorPaths.length !== NARRATOR_PATHS.length ||
    !attestation.narratorPaths.every((observation, index) =>
      validNarratorPath(observation, NARRATOR_PATHS[index], installedCore.sha256),
    ) ||
    !Array.isArray(attestation.setupPaths) ||
    attestation.setupPaths.length !== SETUP_PATHS.length ||
    !attestation.setupPaths.every((observation, index) =>
      validSetupPath(
        observation,
        SETUP_PATHS[index],
        installer.sha256,
        installedCore.sha256,
      ),
    ) ||
    !Array.isArray(attestation.unresolvedFindings) ||
    attestation.unresolvedFindings.length !== 0 ||
    !validReferences(attestation.evidenceReferences, 2, ACCESSIBILITY_SOP_REFERENCE) ||
    attestation.attestationText !== ACCESSIBILITY_ATTESTATION_TEXT
  ) {
    return false;
  }
  return true;
}

export function releaseAccessibilityAcceptanceEvidenceMatches({
  attestation,
  packet,
  expectedPacket,
  packetSha256,
  manifest,
  manifestSha256,
  releasePolicy,
  releaseEvidence,
  signatureRecords,
  now = new Date(),
}) {
  const installer = manifest.artifacts?.find((artifact) => artifact.id === "nsis_installer");
  return (
    releaseEvidence?.accessibilityAcceptanceVerified === true &&
    releaseEvidence.releaseCandidateSha256 === installer?.sha256 &&
    Array.isArray(releaseEvidence.evidenceReferences) &&
    releaseEvidence.evidenceReferences.includes(ACCESSIBILITY_ACCEPTANCE_PACKET_REFERENCE) &&
    releaseEvidence.evidenceReferences.includes(
      ACCESSIBILITY_ACCEPTANCE_ATTESTATION_REFERENCE,
    ) &&
    accessibilityAcceptanceAttestationMatches({
      attestation,
      packet,
      expectedPacket,
      packetSha256,
      manifest,
      manifestSha256,
      releasePolicy,
      signatureRecords,
      now,
    })
  );
}

async function readJsonBytes(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes,
    value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")),
  };
}

function inspectSignatures(projectRoot, manifestPath) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const scriptPath = path.join(projectRoot, "scripts", "inspect_release_signatures.ps1");
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ManifestPath",
      manifestPath,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`authenticode_inspection_failed_${result.status}`);
  }
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function verifyReleaseAccessibilityAcceptanceFiles() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
  const packetPath = path.join(
    releaseRoot,
    "release-accessibility-acceptance-packet.json",
  );
  const attestationPath = path.join(
    projectRoot,
    "docs",
    "release",
    "RELEASE_ACCESSIBILITY_ACCEPTANCE_ATTESTATION_V1.json",
  );
  const manifestPath = path.join(releaseRoot, "release-manifest.json");
  const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
  const evidencePath = path.join(
    projectRoot,
    "docs",
    "release",
    "RELEASE_EVIDENCE_STATUS_V1.json",
  );
  const [packetFile, attestationFile, manifestFile, policyFile, evidenceFile] =
    await Promise.all([
      readJsonBytes(packetPath),
      readJsonBytes(attestationPath),
      readJsonBytes(manifestPath),
      readJsonBytes(policyPath),
      readJsonBytes(evidencePath),
    ]);
  const expectedPacket = await buildReleaseAccessibilityAcceptancePacket();
  if (
    packetFile.bytes.toString("utf8").replace(/^\uFEFF/, "") !==
    canonicalAccessibilityAcceptancePacketText(expectedPacket)
  ) {
    throw new Error("release_accessibility_acceptance_packet_is_stale");
  }
  const valid = releaseAccessibilityAcceptanceEvidenceMatches({
    attestation: attestationFile.value,
    packet: packetFile.value,
    expectedPacket,
    packetSha256: sha256(packetFile.bytes),
    manifest: manifestFile.value,
    manifestSha256: sha256(manifestFile.bytes),
    releasePolicy: policyFile.value,
    releaseEvidence: evidenceFile.value,
    signatureRecords: inspectSignatures(projectRoot, manifestPath),
  });
  if (!valid) throw new Error("release_accessibility_acceptance_attestation_mismatch");
  return attestationFile.value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyReleaseAccessibilityAcceptanceFiles()
    .then(() => {
      process.stdout.write("Release accessibility acceptance evidence verified.\n");
    })
    .catch((error) => {
      process.stderr.write(
        `Release accessibility acceptance verification failed: ${error.message}\n`,
      );
      process.exitCode = 2;
    });
}
