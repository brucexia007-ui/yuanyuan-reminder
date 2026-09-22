import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "./community_release_contract.mjs";
import { validateAcceptedArtifactManifest } from "./community_accepted_artifacts.mjs";

const version = "1.5.33";
const files = {
  portable: Buffer.from("accepted-portable"),
  setup: Buffer.from("accepted-installer"),
  "jiaojiao-pet-pack": Buffer.from("original-pet-package"),
  sourceLicense: Buffer.from("original-license"),
};
const source = {
  schemaVersion: 1,
  donorCommit: "d".repeat(40),
  packageFileName: "饺饺.yuanyuan-pet",
  packageSha256: sha256(files["jiaojiao-pet-pack"]),
  embeddedLicenseFileName: "LICENSE.txt",
  embeddedLicenseSha256: sha256(files.sourceLicense),
  sourceLicenseFile: "docs/pet-packs/JIAOJIAO_STANDALONE_ASSETS_LICENSE.md",
};
const acceptance = {
  status: "accepted",
  candidate: { testedCommit: "a".repeat(40), installerSha256: sha256(files.setup) },
};
const authority = {
  channel: "stable", productName: "圆圆提醒", identifier: "com.yuanyuan.reminder", version,
};
const manifest = {
  schemaVersion: 1,
  status: "ACCEPTED_FOR_STABLE_RELEASE",
  product: { name: authority.productName, identifier: authority.identifier, version },
  testedCommit: acceptance.candidate.testedCommit,
  artifacts: [
    ["portable", `圆圆提醒_${version}_windows-x64-portable.exe`],
    ["setup", `圆圆提醒_${version}_x64-setup.exe`],
    ["jiaojiao-pet-pack", "饺饺.yuanyuan-pet"],
  ].map(([id, fileName]) => ({ id, fileName, bytes: files[id].length, sha256: sha256(files[id]) })),
};

function validate(overrides = {}) {
  return validateAcceptedArtifactManifest({ manifest, acceptance, authority, source, files, ...overrides });
}

test("accepts only the three original byte-bound candidate artifacts", () => {
  assert.equal(validate().length, 3);
  assert.throws(() => validate({ files: { ...files, portable: Buffer.from("rebuild") } }), /portable name, size, or SHA-256/u);
  assert.throws(() => validate({ files: { ...files, "jiaojiao-pet-pack": Buffer.from("changed") } }), /jiaojiao-pet-pack name, size, or SHA-256/u);
  assert.throws(() => validate({ files: { ...files, sourceLicense: Buffer.from("changed") } }), /original embedded pet license/u);
});

test("rejects premature publication, wrong version, and missing human acceptance", () => {
  assert.throws(() => validate({ manifest: { ...manifest, status: "PENDING" } }), /acceptance is pending/u);
  assert.throws(() => validate({ authority: { ...authority, channel: "development" } }), /acceptance is pending/u);
  assert.throws(() => validate({ acceptance: { ...acceptance, status: "pending" } }), /acceptance is pending/u);
  assert.throws(() => validate({ manifest: { ...manifest, product: { ...manifest.product, version: "1.5.32" } } }), /identity, version/u);
  assert.throws(() => validate({ acceptance: { ...acceptance, candidate: { ...acceptance.candidate, installerSha256: "0".repeat(64) } } }), /installed E2E acceptance/u);
});
