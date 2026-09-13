import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "./community_release_contract.mjs";
import { validateAcceptedInstallerArtifact } from "./verify_community_stable_artifact_binding.mjs";

const installerBytes = Buffer.from("accepted-jiaojiao-installer");
const installerSha256 = sha256(installerBytes);
const expectedProduct = {
  name: "饺饺提醒",
  identifier: "com.brucexia.jiaojiao.reminder",
  installerBaseName: "饺饺提醒",
  portableBaseName: "饺饺提醒",
};
const authority = {
  schemaVersion: 1,
  productName: expectedProduct.name,
  identifier: expectedProduct.identifier,
  version: "1.5.7",
  releaseTrain: "unified-product",
  channel: "stable",
};

function fixture() {
  return {
    acceptance: {
      schemaVersion: 1,
      status: "accepted",
      product: {
        name: expectedProduct.name,
        identifier: expectedProduct.identifier,
        version: authority.version,
      },
      candidate: {
        testedCommit: "a".repeat(40),
        installerSha256,
      },
      checks: {
        installedCandidateE2e: {
          status: "passed",
          installerSha256,
        },
      },
      review: {},
    },
    authority,
    expectedProduct,
    installerBytes,
  };
}

test("accepts only the exact installer bytes named by completed E2E acceptance", () => {
  const result = validateAcceptedInstallerArtifact(fixture());
  assert.equal(result.installerSha256, installerSha256);
  assert.equal(result.installerBytes, installerBytes.length);
});

test("rejects a post-acceptance rebuild with different installer bytes", () => {
  const input = fixture();
  input.installerBytes = Buffer.from("rebuilt-but-not-accepted");
  assert.throws(
    () => validateAcceptedInstallerArtifact(input),
    /differ from the accepted installer/u,
  );
});

test("rejects pending, cross-version, or cross-E2E installer claims", () => {
  const pending = fixture();
  pending.acceptance.status = "pending";
  assert.throws(() => validateAcceptedInstallerArtifact(pending), /not complete/u);

  const version = fixture();
  version.acceptance.product.version = "1.5.6";
  assert.throws(() => validateAcceptedInstallerArtifact(version), /product identity/u);

  const e2e = fixture();
  e2e.acceptance.checks.installedCandidateE2e.installerSha256 = "B".repeat(64);
  assert.throws(() => validateAcceptedInstallerArtifact(e2e), /not bound/u);
});
