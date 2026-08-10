import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EXTERNAL_TRUST_ATTESTATION_TEXT,
  SECURITY_PRODUCT_STAGES,
  SMARTSCREEN_STAGES,
  canonicalExternalTrustPacketText,
  createReleaseExternalTrustPacket,
} from "./generate_release_external_trust_packet.mjs";
import {
  EXTERNAL_TRUST_ATTESTATION_REFERENCE,
  EXTERNAL_TRUST_PACKET_REFERENCE,
  smartScreenExternalEvidenceMatches,
  thirdPartySecurityExternalEvidenceMatches,
} from "./verify_release_external_trust.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function buildInputs() {
  const manifest = {
    schemaVersion: 1,
    productVersion: "1.4.0",
    generatedAt: "2026-08-10T00:00:00.000Z",
    artifacts: [
      { id: "stable_core", bytes: 10, sha256: "A".repeat(64) },
      { id: "nsis_installed_core", bytes: 11, sha256: "B".repeat(64) },
      { id: "nsis_installer", bytes: 12, sha256: "C".repeat(64) },
    ],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const releasePolicy = {
    schemaVersion: 1,
    releaseArtifacts: ["stable_core", "nsis_installed_core", "nsis_installer"],
    manualReleaseGates: {
      minimumThirdPartySecurityProducts: 2,
      requireSmartScreenCleanMachineObservation: true,
    },
  };
  const policyBytes = Buffer.from(`${JSON.stringify(releasePolicy, null, 2)}\n`);
  const packet = createReleaseExternalTrustPacket({
    manifest,
    manifestSha256: sha256(manifestBytes),
    releasePolicy,
    releasePolicySha256: sha256(policyBytes),
  });
  const packetBytes = Buffer.from(canonicalExternalTrustPacketText(packet));
  return { manifest, manifestBytes, releasePolicy, packet, packetBytes };
}

function tester(name = "External Tester") {
  return {
    name,
    role: "Windows release tester",
    organization: "Independent Test Lab",
    humanTester: true,
  };
}

function environment(seed) {
  return {
    machineAlias: `clean-win-${seed}`,
    windowsEdition: "Windows 11 Pro",
    windowsVersion: "24H2",
    osBuild: "26100.1000",
    accountType: "standard_user",
    cleanSnapshotSha256: sha256(Buffer.from(`snapshot-${seed}`)),
  };
}

function references(kind) {
  return [
    `docs/release/evidence/${kind}.md`,
    "docs/release/P0_RELEASE_SIGNING_AND_FALSE_POSITIVE_SOP.md",
  ].sort((left, right) => left.localeCompare(right, "en"));
}

function product(packet, name, seed) {
  return {
    productName: name,
    productVersion: "1.0.0",
    engineVersion: "2.0.0",
    definitionVersion: "2026.08.10.1",
    testedAt: "2026-08-11T00:00:00.000Z",
    tester: tester(`${name} Tester`),
    environment: environment(seed),
    candidateArtifacts: packet.candidate.releaseArtifacts,
    realTimeProtectionEnabled: true,
    stages: Object.fromEntries(SECURITY_PRODUCT_STAGES.map((stage) => [stage, "passed"])),
    detections: [],
    evidenceReferences: references(`security-${seed}`),
    passed: true,
  };
}

function attestation(packet, packetBytes) {
  return {
    schemaVersion: 1,
    mode: "release_external_trust_attestation",
    packetSha256: sha256(packetBytes),
    candidateManifestSha256: packet.candidate.manifestSha256,
    smartScreen: {
      testedAt: "2026-08-11T00:00:00.000Z",
      tester: tester(),
      environment: environment("smartscreen"),
      candidateInstallerSha256: "C".repeat(64),
      networkReputationAvailable: true,
      previousYuanyuanInstall: false,
      previousCandidateExecution: false,
      markOfWebPresent: true,
      sourceZone: "internet",
      stages: Object.fromEntries(SMARTSCREEN_STAGES.map((stage) => [stage, "passed"])),
      promptDisposition: "no_warning",
      evidenceReferences: references("smartscreen"),
      passed: true,
    },
    securityProducts: [product(packet, "Security Suite Alpha", "alpha"), product(packet, "Security Suite Beta", "beta")],
    attestationText: EXTERNAL_TRUST_ATTESTATION_TEXT,
  };
}

function baseArgs() {
  const inputs = buildInputs();
  const externalAttestation = attestation(inputs.packet, inputs.packetBytes);
  const releaseEvidence = {
    releaseCandidateSha256: "C".repeat(64),
    smartScreenCleanMachineObserved: true,
    thirdPartySecurityProductsVerified: 2,
    evidenceReferences: [
      EXTERNAL_TRUST_PACKET_REFERENCE,
      EXTERNAL_TRUST_ATTESTATION_REFERENCE,
    ],
  };
  return {
    ...inputs,
    attestation: externalAttestation,
    expectedPacket: inputs.packet,
    packetSha256: sha256(inputs.packetBytes),
    manifestSha256: sha256(inputs.manifestBytes),
    releaseEvidence,
    now: new Date("2026-08-12T00:00:00.000Z"),
  };
}

test("accepts clean SmartScreen and two distinct zero-detection product observations", () => {
  const args = baseArgs();
  assert.equal(smartScreenExternalEvidenceMatches(args), true);
  assert.equal(thirdPartySecurityExternalEvidenceMatches(args), true);
});

test("rejects missing internet provenance, warnings, AI testers, and packet drift", () => {
  const args = baseArgs();
  const candidates = [
    { ...args.attestation.smartScreen, markOfWebPresent: false },
    { ...args.attestation.smartScreen, promptDisposition: "warned" },
    {
      ...args.attestation.smartScreen,
      tester: tester("Codex Automated Tester"),
    },
  ];
  for (const smartScreen of candidates) {
    assert.equal(
      smartScreenExternalEvidenceMatches({
        ...args,
        attestation: { ...args.attestation, smartScreen },
      }),
      false,
    );
  }
  assert.equal(
    smartScreenExternalEvidenceMatches({
      ...args,
      expectedPacket: { ...args.packet, schemaVersion: 2 },
    }),
    false,
  );
});

test("rejects Defender, duplicate products, detections, and optimistic product counts", () => {
  const args = baseArgs();
  const invalidMatrices = [
    [product(args.packet, "Microsoft Defender", "one"), product(args.packet, "Suite Beta", "two")],
    [product(args.packet, "Suite Alpha", "one"), product(args.packet, "suite alpha", "two")],
    [
      { ...product(args.packet, "Suite Alpha", "one"), detections: ["candidate.exe"] },
      product(args.packet, "Suite Beta", "two"),
    ],
  ];
  for (const securityProducts of invalidMatrices) {
    assert.equal(
      thirdPartySecurityExternalEvidenceMatches({
        ...args,
        attestation: { ...args.attestation, securityProducts },
      }),
      false,
    );
  }
  assert.equal(
    thirdPartySecurityExternalEvidenceMatches({
      ...args,
      releaseEvidence: { ...args.releaseEvidence, thirdPartySecurityProductsVerified: 3 },
    }),
    false,
  );
});
