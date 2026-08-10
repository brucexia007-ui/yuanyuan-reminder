import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const manifestPath = path.join(releaseRoot, "release-manifest.json");
const policyPath = path.join(projectRoot, "docs", "release", "RELEASE_POLICY_V1.json");
const outputPath = path.join(
  releaseRoot,
  "release-accessibility-acceptance-packet.json",
);

export const ACCESSIBILITY_ATTESTATION_TEXT =
  "I attest that I personally completed and heard the recorded accessibility matrix on the exact signed release candidate in the native Windows environments described by this packet, that automation was not used as the primary verdict, and that no unresolved blocker or failed result was omitted.";

export const ACCESSIBILITY_SOP_REFERENCE =
  "docs/release/P0_RELEASE_ACCESSIBILITY_ACCEPTANCE_SOP.md";

export const DPI_PERCENTAGES = [100, 125, 150, 200];
export const TEXT_SCALE_PERCENTAGES = [100, 150, 200];
export const CONTRAST_MODES = ["dark", "light"];

export const CORE_WORKFLOWS = [
  "launch_and_open_panel",
  "today_reminders_and_resolution",
  "reminder_management_lifecycle",
  "focus_session_start_and_stop",
  "settings_backup_and_restore",
  "support_path_start_and_exit",
  "complete_exit",
];

export const KEYBOARD_PATHS = [
  "panel_primary_navigation",
  "reminder_management_lifecycle",
  "backup_and_restore_confirmation",
  "support_path_start_and_exit",
  "pet_to_panel_and_complete_exit",
];

export const NARRATOR_PATHS = [
  "panel_landmarks_and_primary_navigation",
  "reminder_management_states_and_errors",
  "focus_and_dynamic_status",
  "backup_restore_and_destructive_confirmation",
  "support_path_controls_and_exit",
  "pet_status_and_panel_entry",
];

export const SETUP_PATHS = [
  "installer_install",
  "uninstaller_preserve_data",
  "uninstaller_delete_data",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function readJsonBytes(bytes) {
  return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

export function createReleaseAccessibilityAcceptancePacket({
  manifest,
  manifestSha256,
  releasePolicy,
  releasePolicySha256,
}) {
  if (
    manifest?.schemaVersion !== 1 ||
    typeof manifest.productVersion !== "string" ||
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    !Array.isArray(manifest.artifacts) ||
    !/^[A-F0-9]{64}$/.test(manifestSha256) ||
    releasePolicy?.schemaVersion !== 1 ||
    !/^[A-F0-9]{64}$/.test(releasePolicySha256) ||
    !exact(releasePolicy.releaseArtifacts, [
      "stable_core",
      "nsis_installed_core",
      "nsis_installer",
    ]) ||
    releasePolicy.manualReleaseGates?.requireAccessibilityAcceptance !== true
  ) {
    throw new Error("accessibility_acceptance_packet_input_schema_mismatch");
  }

  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const releaseArtifacts = releasePolicy.releaseArtifacts.map((id) => {
    const artifact = artifacts.get(id);
    if (
      !artifact ||
      !Number.isInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !/^[A-F0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new Error("accessibility_acceptance_packet_artifact_mismatch");
    }
    return { id, bytes: artifact.bytes, sha256: artifact.sha256 };
  });

  return {
    schemaVersion: 1,
    mode: "release_accessibility_acceptance_packet",
    candidate: {
      productVersion: manifest.productVersion,
      manifestSha256,
      releasePolicySha256,
      releaseArtifacts,
    },
    requirements: {
      candidateExecution: {
        exactSignedArtifactsRequired: true,
        installedCoreMustComeFromCandidateInstaller: true,
        portableCoreSmokeRequired: true,
        nativeInteractiveWindowsRequired: true,
        humanPrimaryVerdictRequired: true,
      },
      visualMatrix: {
        dpiPercentages: DPI_PERCENTAGES,
        textScalePercentages: TEXT_SCALE_PERCENTAGES,
        contrastModes: CONTRAST_MODES,
        reducedMotionRequired: true,
        coreWorkflows: CORE_WORKFLOWS,
      },
      interactionMatrix: {
        keyboardPaths: KEYBOARD_PATHS,
        narratorPaths: NARRATOR_PATHS,
        setupPaths: SETUP_PATHS,
      },
      requiredOutcomes: {
        noClipping: true,
        noOverlap: true,
        noUnexpectedHorizontalScroll: true,
        readableText: true,
        visibleFocus: true,
        logicalFocusOrder: true,
        accurateNamesRolesStates: true,
        dynamicStatusAnnounced: true,
        noCriticalNarratorSilence: true,
        motionMeaningPreserved: true,
        installAndUninstallChoicesAnnounced: true,
      },
    },
    reviewContract: {
      requiredTesterFields: ["name", "role", "organization", "humanTester"],
      requiredEnvironmentFields: [
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
      ],
      minimumEvidenceReferencesPerObservation: 1,
      minimumTopLevelEvidenceReferences: 2,
      requiredEvidenceReference: ACCESSIBILITY_SOP_REFERENCE,
      attestationText: ACCESSIBILITY_ATTESTATION_TEXT,
    },
  };
}

export function canonicalAccessibilityAcceptancePacketText(packet) {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export async function buildReleaseAccessibilityAcceptancePacket() {
  const [manifestBytes, policyBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(policyPath),
  ]);
  return createReleaseAccessibilityAcceptancePacket({
    manifest: readJsonBytes(manifestBytes),
    manifestSha256: sha256(manifestBytes),
    releasePolicy: readJsonBytes(policyBytes),
    releasePolicySha256: sha256(policyBytes),
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error(
      "usage: node scripts/generate_release_accessibility_acceptance_packet.mjs [--check]",
    );
  }
  const packet = await buildReleaseAccessibilityAcceptancePacket();
  const expected = canonicalAccessibilityAcceptancePacketText(packet);
  if (args.includes("--check")) {
    const existing = (await readFile(outputPath, "utf8")).replace(/^\uFEFF/, "");
    if (existing !== expected) {
      throw new Error("release_accessibility_acceptance_packet_is_stale");
    }
    process.stdout.write(
      `Release accessibility acceptance packet is current: ${sha256(Buffer.from(expected))}.\n`,
    );
    return packet;
  }
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(
    `Release accessibility acceptance packet written: ${outputPath}\n`,
  );
  return packet;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(
      `Release accessibility acceptance packet failed: ${error.message}\n`,
    );
    process.exitCode = 2;
  });
}
