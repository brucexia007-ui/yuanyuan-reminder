import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePendingPolicyHashFromPromotedBytes,
  StoreCertificationVerificationError,
  validateStoreCertificationAcceptance,
} from "./verify_msix_store_certification.mjs";
import { createHash } from "node:crypto";

const HASHES = {
  storeIdentitySha256: "1".repeat(64),
  storeSubmissionInputsSha256: "2".repeat(64),
  storeReleaseManifestSha256: "3".repeat(64),
  storeLicenseReviewPacketSha256: "4".repeat(64),
  storeLicenseReviewAcceptanceSha256: "5".repeat(64),
  storeDataLifecycleAcceptanceSha256: "6".repeat(64),
  storeDefenderReportSha256: "7".repeat(64),
  storeSecurityAcceptanceSha256: "8".repeat(64),
  preSubmissionAcceptanceSha256: "9".repeat(64),
  certifiedRuntimeReportSha256: "A".repeat(64),
  microsoftSignedPackageSha256: "B".repeat(64),
  releasePolicyBeforePromotionSha256: "C".repeat(64),
};

function fixture({ promoted = false } = {}) {
  return {
    expectedStoreId: "9N1234567890",
    expectedBindings: { ...HASHES },
    evidenceArtifact: {
      format: "png",
      width: 1600,
      height: 900,
      byteLength: 12345,
      sha256: "A".repeat(64),
    },
    promoted,
    now: new Date("2026-08-12T00:00:00.000Z"),
    document: {
      schemaVersion: 1,
      status: promoted
        ? "store_certified_channel_promoted"
        : "store_certified_ready_for_channel_promotion",
      partnerCenter: {
        productStoreId: "9N1234567890",
        submissionId: "submission-2026.08.10-1",
        certificationStatus: "passed",
        publicationStatus: "in_microsoft_store",
        certifiedAt: "2026-08-10T08:00:00.000Z",
        publishedAt: "2026-08-10T09:00:00.000Z",
        storeListingUrl: "https://apps.microsoft.com/detail/9N1234567890",
        restrictedCapabilityApproval: "approved",
        iarc: {
          ratingId: "IARC-123456",
          ratings: [
            { system: "IARC Generic", rating: "3+" },
            { system: "ESRB", rating: "Everyone" },
          ],
        },
      },
      evidence: {
        path: "src-tauri/target/msix-store-certification/partner-center-redacted-evidence.png",
        sha256: "A".repeat(64),
        redacted: true,
        reviewedBy: "Release Reviewer",
        reviewedAt: "2026-08-10T11:00:00.000Z",
      },
      bindings: { ...HASHES },
      outcome: {
        blockingFindings: [],
        readyToSelectMicrosoftStore: true,
        approvedBy: "Project Maintainer",
        approvedAt: "2026-08-10T12:00:00.000Z",
        selectedChannel: promoted ? "microsoft_store" : "pending",
        releasePolicyAfterPromotionSha256: promoted ? "B".repeat(64) : null,
        promotedBy: promoted ? "Project Maintainer" : null,
        promotedAt: promoted ? "2026-08-10T12:30:00.000Z" : null,
      },
    },
  };
}

function rejects(input, pattern) {
  assert.throws(
    () => validateStoreCertificationAcceptance(input.document, input),
    (error) => error instanceof StoreCertificationVerificationError && pattern.test(error.message),
  );
}

test("accepts an exact published Store certification packet before channel promotion", () => {
  const input = fixture();
  assert.equal(validateStoreCertificationAcceptance(input.document, input), input.document);
});

test("accepts the explicit post-promotion state", () => {
  const input = fixture({ promoted: true });
  assert.equal(validateStoreCertificationAcceptance(input.document, input), input.document);
});

test("rejects pending certification, publication, or runFullTrust approval", () => {
  const pendingCertification = fixture();
  pendingCertification.document.partnerCenter.certificationStatus = "pending";
  rejects(pendingCertification, /certification must be passed/u);

  const unpublished = fixture();
  unpublished.document.partnerCenter.publicationStatus = "certified";
  rejects(unpublished, /publication status/u);

  const capabilityPending = fixture();
  capabilityPending.document.partnerCenter.restrictedCapabilityApproval = "pending";
  rejects(capabilityPending, /runFullTrust/u);
});

test("rejects identity drift, a non-Store URL, or incomplete IARC evidence", () => {
  const identityDrift = fixture();
  identityDrift.document.partnerCenter.productStoreId = "9N0000000000";
  rejects(identityDrift, /drifted/u);

  const wrongUrl = fixture();
  wrongUrl.document.partnerCenter.storeListingUrl = "https://example.com/9N1234567890";
  rejects(wrongUrl, /Microsoft Store listing/u);

  const noRatings = fixture();
  noRatings.document.partnerCenter.iarc.ratings = [];
  rejects(noRatings, /must record/u);
});

test("rejects unredacted, stale, or automation-approved evidence", () => {
  const unredacted = fixture();
  unredacted.document.evidence.redacted = false;
  rejects(unredacted, /must be redacted/u);

  const stale = fixture();
  stale.document.evidence.sha256 = "F".repeat(64);
  rejects(stale, /hash or format/u);

  const automated = fixture();
  automated.document.outcome.approvedBy = "Codex Bot";
  rejects(automated, /identify a human/u);
});

test("rejects stale bindings and premature promotion fields", () => {
  const stale = fixture();
  stale.document.bindings.microsoftSignedPackageSha256 = "F".repeat(64);
  rejects(stale, /bindings drifted/u);

  const premature = fixture();
  premature.document.outcome.selectedChannel = "microsoft_store";
  rejects(premature, /must remain pending/u);
});

test("rejects a promoted packet without the promoted policy hash or human transition", () => {
  const noHash = fixture({ promoted: true });
  noHash.document.outcome.releasePolicyAfterPromotionSha256 = null;
  rejects(noHash, /uppercase SHA-256/u);

  const noHuman = fixture({ promoted: true });
  noHuman.document.outcome.promotedBy = "AI automation";
  rejects(noHuman, /identify a human/u);
});

test("derives the before-promotion policy hash from a one-field channel transition", () => {
  const pending = Buffer.from('{\n  "distribution": {\n    "selectedChannel": "pending"\n  }\n}\n');
  const promoted = Buffer.from(
    '{\n  "distribution": {\n    "selectedChannel": "microsoft_store"\n  }\n}\n',
  );
  const expected = createHash("sha256").update(pending).digest("hex").toUpperCase();
  assert.equal(derivePendingPolicyHashFromPromotedBytes(promoted), expected);
  assert.throws(
    () => derivePendingPolicyHashFromPromotedBytes(pending),
    /exactly one canonical/u,
  );
});
