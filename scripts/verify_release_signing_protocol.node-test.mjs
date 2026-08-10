import assert from "node:assert/strict";
import test from "node:test";

import { createReleaseSigningProtocolPacket } from "./generate_release_signing_protocol_packet.mjs";
import {
  SIGNING_PROTOCOL_ATTESTATION_REFERENCE,
  SIGNING_PROTOCOL_PACKET_REFERENCE,
  releaseSigningProtocolEvidenceMatches,
  signingProtocolAttestationMatches,
} from "./verify_release_signing_protocol.mjs";

const MANIFEST_SHA256 = "A".repeat(64);
const POLICY_SHA256 = "B".repeat(64);
const SCRIPT_SHA256 = "C".repeat(64);
const PACKET_SHA256 = "D".repeat(64);
const PUBLISHER = "CN=Yuanyuan Test Publisher";
const THUMBPRINT = "E".repeat(40);
const TIMESTAMP_SUBJECT = "CN=RFC 3161 Test Timestamp Authority";
const NOW = new Date("2026-08-11T00:00:00.000Z");

function manifest() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-10T10:00:00.000Z",
    productVersion: "1.4.0",
    artifacts: [
      { id: "stable_core", bytes: 101, sha256: "1".repeat(64) },
      { id: "nsis_installed_core", bytes: 102, sha256: "2".repeat(64) },
      { id: "nsis_installer", bytes: 103, sha256: "3".repeat(64) },
    ],
  };
}

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    distribution: {
      selectedChannel: "ca_code_signing_certificate",
      allowedChannels: [
        "microsoft_store",
        "artifact_signing_public_trust",
        "ca_code_signing_certificate",
      ],
    },
    signing: {
      publisherSubject: PUBLISHER,
      fileDigest: "sha256",
      timestampProtocol: "rfc3161",
      timestampDigest: "sha256",
      timestampUrl: "https://timestamp.example.test/rfc3161",
      requireOneCertificatePerRelease: true,
    },
    releaseArtifacts: ["stable_core", "nsis_installed_core", "nsis_installer"],
    manualReleaseGates: { requireRfc3161ProtocolEvidence: true },
    ...overrides,
  };
}

function packetFor(releasePolicy = policy()) {
  return createReleaseSigningProtocolPacket({
    manifest: manifest(),
    manifestSha256: MANIFEST_SHA256,
    releasePolicy,
    releasePolicySha256: POLICY_SHA256,
    signatureInspectionScriptSha256: SCRIPT_SHA256,
  });
}

function references(label) {
  return [
    `docs/release/evidence/${label}.json`,
    "docs/release/P0_RELEASE_SIGNING_AND_FALSE_POSITIVE_SOP.md",
  ].sort((left, right) => left.localeCompare(right, "en"));
}

function signatures(packet) {
  return packet.candidate.releaseArtifacts.map((artifact) => ({
    id: artifact.id,
    status: "Valid",
    signerSubject: PUBLISHER,
    signerThumbprint: THUMBPRINT,
    signerNotBefore: "2026-01-01T00:00:00.000Z",
    signerNotAfter: "2028-01-01T00:00:00.000Z",
    timestampPresent: true,
    timestampSubject: TIMESTAMP_SUBJECT,
    timestampNotBefore: "2026-01-01T00:00:00.000Z",
    timestampNotAfter: "2036-01-01T00:00:00.000Z",
  }));
}

function attestation(packet, signatureRecords) {
  return {
    schemaVersion: 1,
    mode: "release_signing_protocol_attestation",
    attestedAt: "2026-08-10T12:00:00.000Z",
    packetSha256: PACKET_SHA256,
    candidateManifestSha256: MANIFEST_SHA256,
    operator: {
      name: "Release Operator",
      role: "Release Engineer",
      organization: "Yuanyuan Test Organization",
      humanOperator: true,
    },
    signingTool: {
      name: "SignTool",
      version: "10.0.26100.0",
      executableSha256: "F".repeat(64),
    },
    protocol: {
      fileDigest: "sha256",
      fileDigestArgument: "/fd SHA256",
      timestampProtocol: "rfc3161",
      timestampUrl: "https://timestamp.example.test/rfc3161",
      timestampUrlArgument: "/tr",
      timestampDigest: "sha256",
      timestampDigestArgument: "/td SHA256",
      legacyTimestampArgumentPresent: false,
    },
    artifactRecords: packet.candidate.releaseArtifacts.map((artifact, index) => ({
      artifactId: artifact.id,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      signerSubject: signatureRecords[index].signerSubject,
      signerThumbprint: signatureRecords[index].signerThumbprint,
      timestampSubject: signatureRecords[index].timestampSubject,
      timestampNotBefore: signatureRecords[index].timestampNotBefore,
      timestampNotAfter: signatureRecords[index].timestampNotAfter,
      executionEvidenceSha256: `${index + 4}`.repeat(64),
      evidenceReferences: references(`sign-${artifact.id}`),
      passed: true,
    })),
    unresolvedFindings: [],
    evidenceReferences: references("signing-summary"),
    attestationText:
      "I attest that the named human operator verified the exact candidate artifacts, signing identity, signing tool, SHA-256 file digest, RFC 3161 timestamp URL, SHA-256 timestamp digest, execution evidence, and resulting Authenticode records described by this packet, with no omitted credential exposure or unresolved result.",
  };
}

function args() {
  const releasePolicy = policy();
  const packet = packetFor(releasePolicy);
  const signatureRecords = signatures(packet);
  return {
    attestation: attestation(packet, signatureRecords),
    packet,
    expectedPacket: structuredClone(packet),
    packetSha256: PACKET_SHA256,
    manifest: manifest(),
    manifestSha256: MANIFEST_SHA256,
    releasePolicy,
    signatureRecords,
    now: NOW,
  };
}

test("accepts exact signed artifacts and independently recorded RFC 3161 protocol", () => {
  const input = args();
  assert.equal(signingProtocolAttestationMatches(input), true);

  const releaseEvidence = {
    releaseCandidateSha256: "3".repeat(64),
    rfc3161ProtocolVerified: true,
    evidenceReferences: [
      SIGNING_PROTOCOL_PACKET_REFERENCE,
      SIGNING_PROTOCOL_ATTESTATION_REFERENCE,
    ],
  };
  assert.equal(
    releaseSigningProtocolEvidenceMatches({ ...input, releaseEvidence }),
    true,
  );
  releaseEvidence.rfc3161ProtocolVerified = false;
  assert.equal(
    releaseSigningProtocolEvidenceMatches({ ...input, releaseEvidence }),
    false,
  );
});

test("rejects AI operators, weak or legacy protocol, credentials, and signature drift", () => {
  const mutations = [
    (input) => {
      input.attestation.operator.name = "Codex Operator";
    },
    (input) => {
      input.attestation.protocol.fileDigestArgument = "/fd SHA1";
    },
    (input) => {
      input.attestation.protocol.legacyTimestampArgumentPresent = true;
    },
    (input) => {
      input.attestation.signingTool.name = "SignTool password=secret";
    },
    (input) => {
      input.signatureRecords[1].signerThumbprint = "9".repeat(40);
    },
    (input) => {
      input.signatureRecords[2].timestampPresent = false;
    },
    (input) => {
      input.attestation.artifactRecords[0].executionEvidenceSha256 = null;
    },
    (input) => {
      input.expectedPacket.candidate.releaseArtifacts[0].bytes += 1;
    },
  ];
  for (const mutate of mutations) {
    const input = args();
    mutate(input);
    assert.equal(signingProtocolAttestationMatches(input), false);
  }
});

test("packet remains generatable but explicitly unready before channel decisions freeze", () => {
  const pending = policy();
  pending.distribution.selectedChannel = "pending";
  pending.signing.publisherSubject = null;
  pending.signing.timestampUrl = null;
  const packet = packetFor(pending);
  assert.equal(packet.frozenPolicy.decisionsFrozen, false);

  const input = args();
  input.packet = packet;
  input.expectedPacket = structuredClone(packet);
  input.releasePolicy = pending;
  input.attestation.packetSha256 = PACKET_SHA256;
  assert.equal(signingProtocolAttestationMatches(input), false);
});
