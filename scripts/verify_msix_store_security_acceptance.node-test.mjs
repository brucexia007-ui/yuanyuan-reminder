import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  STORE_SECURITY_ATTESTATION_TEXT,
  StoreSecurityAcceptanceError,
  validateMsixStoreSecurityAcceptance,
} from "./verify_msix_store_security_acceptance.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

function fixture() {
  const storeReleaseManifestBytes = Buffer.from("Store release manifest");
  const storeDefenderReportBytes = Buffer.from("Store Defender report");
  const releasePolicyBytes = Buffer.from("release policy");
  const verifierBytes = Buffer.from("security verifier");
  const storeReleaseManifest = {
    schemaVersion: 1,
    mode: "msix_store_release_manifest",
    generatedAt: "2026-08-10T08:00:00.000Z",
    candidate: {
      path: "src-tauri/target/msix-store/Yuanyuan_1.4.0.0_x64-store.msix",
      bytes: 120000,
      sha256: "A".repeat(64),
    },
    payload: {
      files: [
        { path: "AppxManifest.xml", bytes: 1000, sha256: "B".repeat(64) },
        { path: "yuanyuan-reminder.exe", bytes: 2000, sha256: "C".repeat(64) },
      ],
    },
    boundary: {
      directDistributionAllowed: false,
      microsoftStoreResigningRequired: true,
    },
  };
  const releasePolicy = {
    manualReleaseGates: {
      minimumThirdPartySecurityProducts: 2,
      requireDefenderScan: true,
    },
  };
  const targets = [
    {
      id: "unsigned_store_candidate",
      path: storeReleaseManifest.candidate.path,
      bytes: storeReleaseManifest.candidate.bytes,
      sha256: storeReleaseManifest.candidate.sha256,
    },
    ...storeReleaseManifest.payload.files.map((payload) => ({
      id: `payload:${payload.path}`,
      path: `src-tauri/target/msix-store/unpacked/${payload.path}`,
      bytes: payload.bytes,
      sha256: payload.sha256,
    })),
  ];
  function product(vendorName, productName, slug, hour) {
    const testedHour = String(hour).padStart(2, "0");
    const definitionHour = String(hour - 1).padStart(2, "0");
    return {
      vendorName,
      productName,
      productVersion: "1.0.0",
      engineVersion: "2.0.0",
      definitionVersion: "2026.08.10.1",
      definitionsUpdatedAt: `2026-08-10T${definitionHour}:00:00.000Z`,
      testedAt: `2026-08-10T${testedHour}:00:00.000Z`,
      tester: {
        name: `${vendorName} Tester`,
        role: "Windows release tester",
        organization: "Independent Test Lab",
        humanTester: true,
      },
      environment: {
        machineAlias: `clean-win-${slug}`,
        windowsEdition: "Windows 11 Pro",
        windowsVersion: "24H2",
        osBuild: "10.0.26100.1000",
        accountType: "administrator",
        cleanSnapshotSha256: hash(Buffer.from(`snapshot-${slug}`)),
      },
      targets,
      realTimeProtectionEnabled: true,
      scanMode: "full_candidate_and_unpacked_payload",
      detections: [],
      evidence: {
        path: `src-tauri/target/msix-store-security/${slug}-redacted-evidence.png`,
        sha256: hash(Buffer.from(`evidence-${slug}`)),
        redacted: true,
      },
      notes: `Observed a completed zero-detection scan of the exact Store candidate and unpacked payload with ${productName}.`,
      passed: true,
    };
  }
  const securityProducts = [
    product("Vendor Alpha", "Security Suite Alpha", "alpha", 9),
    product("Vendor Beta", "Security Suite Beta", "beta", 10),
  ];
  const evidenceArtifacts = Object.fromEntries(
    securityProducts.map((product) => [
      product.evidence.path,
      { format: "png", width: 1600, height: 900, sha256: product.evidence.sha256 },
    ]),
  );
  const document = {
    schemaVersion: 1,
    status: "human_accepted_store_security_matrix",
    bindings: {
      storeReleaseManifestSha256: hash(storeReleaseManifestBytes),
      storeDefenderReportSha256: hash(storeDefenderReportBytes),
      unsignedStoreCandidateSha256: storeReleaseManifest.candidate.sha256,
      releasePolicySha256: hash(releasePolicyBytes),
      verifierSha256: hash(verifierBytes),
    },
    requirements: {
      minimumThirdPartySecurityProducts: 2,
      defenderEvidenceRequired: true,
      smartScreenDisposition: "not_applicable_store_managed_distribution",
      directDistributionAllowed: false,
    },
    securityProducts,
    outcome: {
      blockingFindings: [],
      verifiedThirdPartySecurityProducts: 2,
      approvedBy: "Project Maintainer",
      approvedAt: "2026-08-10T11:00:00.000Z",
      accepted: true,
    },
    attestationText: STORE_SECURITY_ATTESTATION_TEXT,
  };
  return {
    document,
    storeReleaseManifest,
    storeReleaseManifestBytes,
    storeDefenderReportBytes,
    releasePolicy,
    releasePolicyBytes,
    verifierBytes,
    evidenceArtifacts,
    now: new Date("2026-08-11T00:00:00.000Z"),
  };
}

function rejects(input, pattern) {
  assert.throws(
    () => validateMsixStoreSecurityAcceptance(input.document, input),
    (error) => error instanceof StoreSecurityAcceptanceError && pattern.test(error.message),
  );
}

test("accepts two distinct human zero-detection Store security observations", () => {
  const input = fixture();
  assert.equal(validateMsixStoreSecurityAcceptance(input.document, input), input.document);
});

test("rejects the pending template and AI or automation testers", () => {
  const pending = fixture();
  pending.document.status = "pending";
  rejects(pending, /human_accepted/u);

  const automated = fixture();
  automated.document.securityProducts[0].tester.name = "Codex Bot";
  rejects(automated, /human tester/u);
});

test("rejects Defender, duplicate vendors, and reused clean snapshots", () => {
  const defender = fixture();
  defender.document.securityProducts[0].productName = "Microsoft Defender";
  rejects(defender, /non-Defender/u);

  const duplicateVendor = fixture();
  duplicateVendor.document.securityProducts[1].vendorName = "vendor alpha";
  rejects(duplicateVendor, /distinct/u);

  const reusedSnapshot = fixture();
  reusedSnapshot.document.securityProducts[1].environment.cleanSnapshotSha256 =
    reusedSnapshot.document.securityProducts[0].environment.cleanSnapshotSha256;
  rejects(reusedSnapshot, /distinct clean snapshot/u);
});

test("rejects stale definitions, detections, target drift, and incomplete scans", () => {
  const stale = fixture();
  stale.document.securityProducts[0].definitionsUpdatedAt = "2026-08-06T09:00:00.000Z";
  rejects(stale, /definitions/u);

  const detection = fixture();
  detection.document.securityProducts[0].detections.push("candidate.msix");
  rejects(detection, /zero detections/u);

  const target = fixture();
  target.document.securityProducts[0].targets[0].sha256 = "D".repeat(64);
  rejects(target, /targets drifted/u);

  const partial = fixture();
  partial.document.securityProducts[0].scanMode = "package_only";
  rejects(partial, /complete scans/u);
});

test("rejects missing, unredacted, duplicated, or stale evidence", () => {
  const missing = fixture();
  delete missing.evidenceArtifacts[missing.document.securityProducts[0].evidence.path];
  rejects(missing, /does not match/u);

  const unredacted = fixture();
  unredacted.document.securityProducts[0].evidence.redacted = false;
  rejects(unredacted, /redacted/u);

  const duplicate = fixture();
  duplicate.document.securityProducts[1].evidence.path = duplicate.document.securityProducts[0].evidence.path;
  rejects(duplicate, /uniquely/u);

  const staleHash = fixture();
  staleHash.document.securityProducts[0].evidence.sha256 = "E".repeat(64);
  rejects(staleHash, /does not match/u);
});

test("rejects policy, binding, SmartScreen disposition, and approval drift", () => {
  const policy = fixture();
  policy.releasePolicy.manualReleaseGates.minimumThirdPartySecurityProducts = 3;
  rejects(policy, /requirements drifted/u);

  const binding = fixture();
  binding.document.bindings.storeDefenderReportSha256 = "F".repeat(64);
  rejects(binding, /bindings drifted/u);

  const smartScreen = fixture();
  smartScreen.document.requirements.smartScreenDisposition = "passed";
  rejects(smartScreen, /distribution boundary/u);

  const approval = fixture();
  approval.document.outcome.approvedAt = "2026-08-10T09:30:00.000Z";
  rejects(approval, /follow all tests/u);
});
