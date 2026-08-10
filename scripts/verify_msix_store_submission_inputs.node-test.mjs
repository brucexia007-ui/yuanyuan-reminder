import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createStoreSubmissionInputsDraft,
  inspectPng,
  StoreSubmissionInputsVerificationError,
  STORE_SCREENSHOTS,
  validateStoreSubmissionInputs,
} from "./verify_msix_store_submission_inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = JSON.parse(
  readFileSync(
    path.join(projectRoot, "docs", "release", "MSIX_STORE_SUBMISSION_INPUTS_V1.template.json"),
    "utf8",
  ),
);
const identityHash = "A".repeat(64);
const candidateHash = "B".repeat(64);
const screenshotHash = "C".repeat(64);
const bindingHash = "D".repeat(64);
const now = new Date("2026-08-11T00:00:00.000Z");

function fixture() {
  const document = structuredClone(template);
  document.status = "human_confirmed_ready_for_partner_center_entry";
  document.product.identitySha256 = identityHash;
  for (const screenshot of document.listing.screenshots) {
    screenshot.sha256 = screenshotHash;
    screenshot.width = 1920;
    screenshot.height = 1080;
    screenshot.capturedFromCandidateSha256 = candidateHash;
  }
  document.properties.publicUrlsVerifiedBy = "Release Maintainer";
  document.properties.publicUrlsVerifiedAt = "2026-08-10T12:00:00.000Z";
  document.availability.visibility = "not_discoverable_direct_link_only";
  document.availability.marketSelection.mode = "selected_markets";
  document.availability.marketSelection.markets = ["CN", "SG"];
  document.availability.confirmedBy = "Release Maintainer";
  document.availability.confirmedAt = "2026-08-10T12:10:00.000Z";
  document.declarations.confirmedBy = "Release Maintainer";
  document.declarations.confirmedAt = "2026-08-10T12:20:00.000Z";
  document.ageRating.contentFactsConfirmedBy = "Release Maintainer";
  document.ageRating.contentFactsConfirmedAt = "2026-08-10T12:30:00.000Z";
  document.sourceBindings = {
    storeCandidateReportSha256: bindingHash,
    unsignedStoreCandidateSha256: candidateHash,
    privacyPolicySha256: bindingHash,
    publicUrlsReportSha256: bindingHash,
    publicUrlsVerifierSha256: bindingHash,
    readmeSha256: bindingHash,
    tauriConfigSha256: bindingHash,
    storeManifestTemplateSha256: bindingHash,
    assetLicenseSha256: bindingHash,
    verifierSha256: bindingHash,
  };
  document.outcome.readyForPartnerCenterEntry = true;
  document.outcome.approvedBy = "Release Maintainer";
  document.outcome.approvedAt = "2026-08-10T13:00:00.000Z";
  const screenshotArtifacts = Object.fromEntries(
    STORE_SCREENSHOTS.map((item) => [
      item.path,
      {
        format: "png",
        width: 1920,
        height: 1080,
        byteLength: 1024,
        sha256: screenshotHash,
      },
    ]),
  );
  return {
    document,
    expectedIdentitySha256: identityHash,
    expectedBindings: structuredClone(document.sourceBindings),
    screenshotArtifacts,
    publicUrlsReportCheckedAt: "2026-08-10T11:00:00.000Z",
    now,
  };
}

function rejects(mutator, pattern) {
  const value = fixture();
  mutator(value);
  assert.throws(
    () => validateStoreSubmissionInputs(value.document, value),
    (error) => error instanceof StoreSubmissionInputsVerificationError && pattern.test(error.message),
  );
}

test("accepts exact human-confirmed Store listing and submission inputs", () => {
  const value = fixture();
  assert.equal(validateStoreSubmissionInputs(value.document, value), value.document);
});

test("prepares only machine-derived fields while all human approvals remain pending", () => {
  const value = fixture();
  const draft = createStoreSubmissionInputsDraft(structuredClone(template), value);
  assert.equal(draft.status, "pending");
  assert.equal(draft.product.identitySha256, identityHash);
  assert.deepEqual(draft.sourceBindings, value.expectedBindings);
  assert.equal(draft.listing.screenshots[0].sha256, screenshotHash);
  assert.equal(draft.listing.screenshots[0].capturedFromCandidateSha256, candidateHash);
  assert.equal(draft.properties.publicUrlsVerifiedBy, null);
  assert.equal(draft.availability.visibility, null);
  assert.equal(draft.declarations.confirmedBy, null);
  assert.equal(draft.ageRating.contentFactsConfirmedBy, null);
  assert.equal(draft.outcome.readyForPartnerCenterEntry, false);
  assert.equal(draft.outcome.approvedBy, null);
});

test("rejects the pending template and automated confirmations", () => {
  rejects((value) => {
    value.document.status = "pending";
  }, /human_confirmed/);
  rejects((value) => {
    value.document.outcome.approvedBy = "Codex automation";
  }, /human/);
});

test("rejects Store copy, version, category, and feature drift", () => {
  rejects((value) => {
    value.document.listing.description += " Includes cloud sync.";
  }, /listing copy/);
  rejects((value) => {
    value.document.product.version = "1.4.0.1";
  }, /identity, language, version, or category/);
  rejects((value) => {
    value.document.listing.features[0] = "- Cloud collaboration";
  }, /listing copy/);
});

test("rejects missing, undersized, stale, or renamed screenshots", () => {
  rejects((value) => {
    value.screenshotArtifacts[STORE_SCREENSHOTS[0].path].width = 1280;
  }, /screenshots\[0\]/);
  rejects((value) => {
    value.document.listing.screenshots[1].capturedFromCandidateSha256 = "E".repeat(64);
  }, /screenshots\[1\]/);
  rejects((value) => {
    value.document.listing.screenshots[2].path = "docs/images/care.jpg";
  }, /screenshots\[2\]/);
});

test("rejects privacy, network, commerce, and restricted-capability misstatements", () => {
  rejects((value) => {
    value.document.properties.transmitsPersonalInformation = true;
  }, /privacy or support/);
  rejects((value) => {
    value.document.declarations.appNetworkTransport = true;
  }, /declarations/);
  rejects((value) => {
    value.document.declarations.inAppPurchases = true;
  }, /declarations/);
  rejects((value) => {
    value.document.declarations.localDeveloperToolDiscovery = false;
  }, /declarations/);
  rejects((value) => {
    value.document.declarations.restrictedCapabilities[0].justification = "Needed by the app.";
  }, /runFullTrust/);
});

test("rejects missing market decisions and fabricated IARC completion", () => {
  rejects((value) => {
    value.document.availability.marketSelection.mode = null;
  }, /availability/);
  rejects((value) => {
    value.document.ageRating.questionnaireStatus = "completed";
    value.document.ageRating.ratingId = "FAKE";
  }, /IARC/);
});

test("rejects stale source bindings and optimistic Partner Center completion", () => {
  rejects((value) => {
    value.document.sourceBindings.privacyPolicySha256 = "E".repeat(64);
  }, /stale/);
  rejects((value) => {
    value.document.outcome.partnerCenterSubmissionComplete = true;
  }, /cannot claim/);
});

test("rejects human URL confirmation recorded before anonymous evidence", () => {
  rejects((value) => {
    value.document.properties.publicUrlsVerifiedAt = "2026-08-10T10:59:59.000Z";
  }, /must not predate/);
});

test("reads PNG dimensions from the canonical signature and IHDR header", () => {
  const png = readFileSync(path.join(projectRoot, "docs", "images", "icon.png"));
  const inspected = inspectPng(png);
  assert.deepEqual(inspected, {
    format: "png",
    width: 256,
    height: 256,
    byteLength: png.length,
    sha256: inspected.sha256,
  });
  const truncated = Buffer.from(png.subarray(0, png.length - 4));
  assert.throws(() => inspectPng(truncated), /truncated|missing|IEND/);
  assert.throws(() => inspectPng(Buffer.from("not a png")), /PNG/);
});
