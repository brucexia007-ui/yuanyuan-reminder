import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createMsixStoreReleaseManifest,
  STORE_RELEASE_PAYLOAD,
  StoreReleaseManifestError,
} from "./generate_msix_store_release_manifest.mjs";

const bytes = (value) => Buffer.from(value);
const hash = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();

function fixture() {
  const identityBytes = bytes("store identity");
  const identity = {
    schemaVersion: 1,
    status: "partner_center_confirmed",
    product: { storeId: "9N1234567890", reservedProductName: "Yuanyuan Reminder" },
    package: {
      identityName: "12345Yuanyuan.Reminder",
      packageFamilyName: "12345Yuanyuan.Reminder_abcdefghjkmnp",
    },
    platform: { version: "1.4.0.0", architecture: "x64" },
  };
  const candidatePackageBytes = bytes("unsigned Store package");
  const payloadArtifacts = Object.fromEntries(
    STORE_RELEASE_PAYLOAD.map(({ path }) => [path, bytes(`payload:${path}`)]),
  );
  const sourceLicenseArtifacts = {
    "licenses/ASSETS_LICENSE.md": payloadArtifacts["licenses/ASSETS_LICENSE.md"],
    "licenses/LICENSE.txt": payloadArtifacts["licenses/LICENSE.txt"],
    "licenses/THIRD_PARTY_LICENSES.txt": payloadArtifacts["licenses/THIRD_PARTY_LICENSES.txt"],
    "licenses/THIRD_PARTY_NOTICES.md": payloadArtifacts["licenses/THIRD_PARTY_NOTICES.md"],
  };
  const candidateReport = {
    schemaVersion: 1,
    mode: "msix_store_candidate",
    generatedAt: "2026-08-10T13:00:00.000Z",
    candidate: {
      path: "src-tauri/target/msix-store/12345Yuanyuan.Reminder_1.4.0.0_x64-store.msix",
      bytes: candidatePackageBytes.length,
      sha256: hash(candidatePackageBytes),
      signatureStatus: "NotSigned",
      storeSubmissionReady: false,
      version: "1.4.0.0",
    },
    sourceControl: { gitHead: "a".repeat(40) },
    manifest: {
      storeId: identity.product.storeId,
      identityName: identity.package.identityName,
      packageFamilyName: identity.package.packageFamilyName,
    },
    payload: {
      files: STORE_RELEASE_PAYLOAD.map(({ path }) => path),
      exactBoundaryVerified: true,
      prototypeSidecarsExcluded: true,
      nestedInstallerExcluded: true,
    },
  };
  const candidateReportBytes = bytes("candidate report");
  const submissionInputs = {
    schemaVersion: 1,
    status: "human_confirmed_ready_for_partner_center_entry",
    product: { identitySha256: hash(identityBytes) },
    outcome: { readyForPartnerCenterEntry: true, partnerCenterSubmissionComplete: false },
  };
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { component: { name: "yuanyuan-reminder", version: "1.4.0" } },
    components: [
      { purl: "pkg:cargo/a@1.0.0", scope: "required" },
      { purl: "pkg:npm/b@1.0.0", scope: "excluded" },
    ],
  };
  const licenseInventory = {
    schemaVersion: 1,
    productVersion: "1.4.0",
    summary: { components: 2, unresolved: 0 },
    components: [{ purl: "pkg:cargo/a@1.0.0" }, { purl: "pkg:npm/b@1.0.0" }],
  };
  return {
    now: new Date("2026-08-11T00:00:00.000Z"),
    input: {
      candidateReport,
      candidateReportBytes,
      identity,
      identityBytes,
      submissionInputs,
      submissionInputsBytes: bytes("submission inputs"),
      releasePolicy: {
        schemaVersion: 1,
        distribution: {
          strategy: "low_cost_staged",
          selectedChannel: "pending",
          plannedStableChannel: "microsoft_store",
        },
      },
      releasePolicyBytes: bytes("release policy"),
      privacyPolicyBytes: bytes("privacy policy"),
      candidatePackageBytes,
      payloadArtifacts,
      sourceLicenseArtifacts,
      sbom,
      sbomBytes: bytes("sbom"),
      licenseInventory,
      licenseInventoryBytes: bytes("license inventory"),
      generatorBytes: bytes("generator"),
    },
  };
}

function rejects(value, pattern) {
  assert.throws(
    () => createMsixStoreReleaseManifest(value.input, { now: value.now }),
    (error) => error instanceof StoreReleaseManifestError && pattern.test(error.message),
  );
}

test("creates an exact Store-only release manifest with every payload hash", () => {
  const value = fixture();
  const manifest = createMsixStoreReleaseManifest(value.input, { now: value.now });
  assert.equal(manifest.payload.fileCount, 10);
  assert.deepEqual(
    manifest.payload.files.map(({ path, role }) => ({ path, role })),
    STORE_RELEASE_PAYLOAD,
  );
  assert.equal(manifest.candidate.sha256, hash(value.input.candidatePackageBytes));
  assert.equal(manifest.boundary.directDistributionAllowed, false);
  assert.equal(manifest.boundary.microsoftStoreResigningRequired, true);
  assert.equal(manifest.compliance.sbom.requiredComponents, 1);
});

test("rejects payload expansion and candidate mutation", () => {
  const expanded = fixture();
  expanded.input.payloadArtifacts["yuanyuan-ai.exe"] = bytes("prototype");
  rejects(expanded, /missing or expanded/u);

  const mutated = fixture();
  mutated.input.candidatePackageBytes = bytes("mutated package");
  rejects(mutated, /exact unsigned Store intake/u);
});

test("rejects license content that differs from the packaged bytes", () => {
  const value = fixture();
  value.input.sourceLicenseArtifacts["licenses/LICENSE.txt"] = bytes("different license");
  rejects(value, /bundled license drifted/u);
});

test("rejects an incomplete SBOM or unresolved license inventory", () => {
  const noRequired = fixture();
  noRequired.input.sbom.components[0].scope = "excluded";
  rejects(noRequired, /no required/u);

  const unresolved = fixture();
  unresolved.input.licenseInventory.summary.unresolved = 1;
  rejects(unresolved, /license inventory/u);
});

test("rejects submission and channel claims that are not ready for Store entry", () => {
  const submission = fixture();
  submission.input.submissionInputs.outcome.readyForPartnerCenterEntry = false;
  rejects(submission, /pre-entry record/u);

  const policy = fixture();
  policy.input.releasePolicy.distribution.selectedChannel = "microsoft_store";
  rejects(policy, /pending low-cost/u);
});
