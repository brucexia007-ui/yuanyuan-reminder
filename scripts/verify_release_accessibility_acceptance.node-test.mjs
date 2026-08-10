import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

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
  createReleaseAccessibilityAcceptancePacket,
} from "./generate_release_accessibility_acceptance_packet.mjs";
import {
  ACCESSIBILITY_ACCEPTANCE_ATTESTATION_REFERENCE,
  ACCESSIBILITY_ACCEPTANCE_PACKET_REFERENCE,
  accessibilityAcceptanceAttestationMatches,
  releaseAccessibilityAcceptanceEvidenceMatches,
} from "./verify_release_accessibility_acceptance.mjs";

const HASHES = {
  stable_core: "1".repeat(64),
  nsis_installed_core: "2".repeat(64),
  nsis_installer: "3".repeat(64),
};

function sortedReferences(...references) {
  return references.sort((left, right) => left.localeCompare(right, "en"));
}

function fixture() {
  const manifest = {
    schemaVersion: 1,
    productVersion: "1.4.0",
    generatedAt: "2026-08-10T00:00:00.000Z",
    artifacts: Object.entries(HASHES).map(([id, sha256], index) => ({
      id,
      path: `candidate-${id}.exe`,
      bytes: 1000 + index,
      sha256,
    })),
  };
  const releasePolicy = {
    schemaVersion: 1,
    releaseArtifacts: ["stable_core", "nsis_installed_core", "nsis_installer"],
    signing: { publisherSubject: "CN=Yuanyuan Test Publisher" },
    manualReleaseGates: { requireAccessibilityAcceptance: true },
  };
  const manifestSha256 = "A".repeat(64);
  const packet = createReleaseAccessibilityAcceptancePacket({
    manifest,
    manifestSha256,
    releasePolicy,
    releasePolicySha256: "B".repeat(64),
  });
  const packetSha256 = createHash("sha256")
    .update(`${JSON.stringify(packet, null, 2)}\n`)
    .digest("hex")
    .toUpperCase();
  const observationReferences = sortedReferences(
    "docs/release/accessibility/result.json",
  );
  const workflowResults = Object.fromEntries(
    CORE_WORKFLOWS.map((workflow) => [workflow, "passed"]),
  );
  const visualObservation = (percent) => ({
    percent,
    installedCoreSha256: HASHES.nsis_installed_core,
    workflowResults,
    noClipping: true,
    noOverlap: true,
    noUnexpectedHorizontalScroll: true,
    readableText: true,
    evidenceReferences: observationReferences,
    passed: true,
  });
  const attestation = {
    schemaVersion: 1,
    mode: "release_accessibility_acceptance_attestation",
    packetSha256,
    candidateManifestSha256: manifestSha256,
    startedAt: "2026-08-10T01:00:00.000Z",
    completedAt: "2026-08-10T02:00:00.000Z",
    tester: {
      name: "Human Accessibility Reviewer",
      role: "Accessibility quality reviewer",
      organization: "Yuanyuan Release Review",
      humanTester: true,
    },
    environment: {
      machineAlias: "clean-accessibility-lab",
      windowsEdition: "Windows 11 Pro",
      windowsVersion: "24H2",
      osBuild: "26100.1000",
      webView2Version: "138.0.3351.95",
      accountType: "standard_user",
      systemLanguage: "zh-CN",
      interactiveDesktop: true,
      audioOutputAvailable: true,
      cleanSnapshotSha256: "C".repeat(64),
    },
    humanObservedAllResults: true,
    automationUsedForPrimaryVerdict: false,
    artifactRecords: packet.candidate.releaseArtifacts.map((artifact) => ({
      ...artifact,
      executed: true,
      passed: true,
    })),
    dpiObservations: DPI_PERCENTAGES.map(visualObservation),
    textScaleObservations: TEXT_SCALE_PERCENTAGES.map(visualObservation),
    contrastObservations: CONTRAST_MODES.map((mode) => ({
      mode,
      installedCoreSha256: HASHES.nsis_installed_core,
      systemContrastEnabled: true,
      workflowResults,
      foregroundBackgroundDistinct: true,
      focusVisible: true,
      selectedAndDisabledStatesDistinct: true,
      informationNotColorOnly: true,
      evidenceReferences: observationReferences,
      passed: true,
    })),
    reducedMotionObservation: {
      installedCoreSha256: HASHES.nsis_installed_core,
      windowsAnimationEffectsDisabled: true,
      applicationReducedMotionEnabled: true,
      coreWorkflowsCompleted: true,
      animatedMotionReplaced: true,
      meaningPreserved: true,
      noFlashing: true,
      evidenceReferences: observationReferences,
      passed: true,
    },
    keyboardPaths: KEYBOARD_PATHS.map((pathId) => ({
      pathId,
      installedCoreSha256: HASHES.nsis_installed_core,
      pointerUsed: false,
      allControlsReachable: true,
      focusOrderLogical: true,
      focusVisible: true,
      focusReturnedAfterDialog: true,
      escapeOrCancelAvailable: true,
      evidenceReferences: observationReferences,
      passed: true,
    })),
    narratorPaths: NARRATOR_PATHS.map((pathId) => ({
      pathId,
      installedCoreSha256: HASHES.nsis_installed_core,
      screenReader: "Windows Narrator",
      speechOutputHeard: true,
      namesRolesAndStatesAccurate: true,
      dynamicChangesAnnounced: true,
      noCriticalSilence: true,
      noDuplicateBlockingAnnouncement: true,
      evidenceReferences: observationReferences,
      passed: true,
    })),
    setupPaths: SETUP_PATHS.map((pathId) => ({
      pathId,
      installerSha256: HASHES.nsis_installer,
      installedCoreSha256: HASHES.nsis_installed_core,
      keyboardOnly: true,
      narratorUsed: true,
      choicesAndConsequencesAnnounced: true,
      focusVisible: true,
      dataDispositionObserved:
        pathId === "installer_install"
          ? "not_applicable"
          : pathId === "uninstaller_preserve_data"
            ? "preserved"
            : "deleted",
      evidenceReferences: observationReferences,
      passed: true,
    })),
    unresolvedFindings: [],
    evidenceReferences: sortedReferences(
      ACCESSIBILITY_SOP_REFERENCE,
      "docs/release/accessibility/reviewer-signoff.md",
    ),
    attestationText: ACCESSIBILITY_ATTESTATION_TEXT,
  };
  const signatureRecords = releasePolicy.releaseArtifacts.map((id) => ({
    id,
    status: "Valid",
    signerSubject: releasePolicy.signing.publisherSubject,
    signerThumbprint: "D".repeat(40),
    timestampPresent: true,
    timestampSubject: "CN=RFC3161 Test TSA",
  }));
  const releaseEvidence = {
    accessibilityAcceptanceVerified: true,
    releaseCandidateSha256: HASHES.nsis_installer,
    evidenceReferences: [
      ACCESSIBILITY_ACCEPTANCE_PACKET_REFERENCE,
      ACCESSIBILITY_ACCEPTANCE_ATTESTATION_REFERENCE,
    ],
  };
  return {
    manifest,
    releasePolicy,
    manifestSha256,
    packet,
    expectedPacket: packet,
    packetSha256,
    attestation,
    signatureRecords,
    releaseEvidence,
    now: new Date("2026-08-10T03:00:00.000Z"),
  };
}

test("accepts the complete signed human-observed Windows accessibility matrix", () => {
  const args = fixture();
  assert.equal(accessibilityAcceptanceAttestationMatches(args), true);
  assert.equal(releaseAccessibilityAcceptanceEvidenceMatches(args), true);
});

test("rejects synthetic verdicts, incomplete matrices, silent Narrator, and unsigned candidates", () => {
  const mutations = [
    (args) => {
      args.attestation.tester.role = "AI automation bot";
    },
    (args) => {
      args.attestation.automationUsedForPrimaryVerdict = true;
    },
    (args) => {
      args.attestation.dpiObservations.pop();
    },
    (args) => {
      args.attestation.narratorPaths[0].speechOutputHeard = false;
    },
    (args) => {
      args.signatureRecords[0].status = "NotSigned";
    },
    (args) => {
      args.releaseEvidence.accessibilityAcceptanceVerified = false;
    },
  ];
  for (const mutate of mutations) {
    const args = fixture();
    mutate(args);
    assert.equal(releaseAccessibilityAcceptanceEvidenceMatches(args), false);
  }
});

test("packet stays generatable before publisher and human decisions are available", () => {
  const args = fixture();
  args.releasePolicy.signing.publisherSubject = null;
  const packet = createReleaseAccessibilityAcceptancePacket({
    manifest: args.manifest,
    manifestSha256: args.manifestSha256,
    releasePolicy: args.releasePolicy,
    releasePolicySha256: "B".repeat(64),
  });
  assert.equal(packet.requirements.candidateExecution.exactSignedArtifactsRequired, true);
  assert.deepEqual(packet.requirements.visualMatrix.dpiPercentages, DPI_PERCENTAGES);
});
