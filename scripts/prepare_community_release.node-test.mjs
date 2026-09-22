import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildCommunityReleaseBundle,
  communityProductFromBrand,
  validateCommunityStableAuthority,
  validateCommunityStablePolicy,
} from "./community_release_contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const policyBytes = await readFile(
  path.join(projectRoot, "docs", "release", "COMMUNITY_STABLE_RELEASE_POLICY_V2.json"),
);
const policy = JSON.parse(policyBytes.toString("utf8"));
const brand = JSON.parse(await readFile(path.join(projectRoot, "product-brand.json"), "utf8"));
const expectedProduct = communityProductFromBrand(brand);
const authority = {
  schemaVersion: 1,
  productName: expectedProduct.name,
  identifier: expectedProduct.identifier,
  version: "1.5.2",
  releaseTrain: "unified-product",
  channel: "stable",
};

test("freezes unsigned GitHub distribution as disclosed advisory, not a stability blocker", () => {
  assert.equal(validateCommunityStablePolicy(policy, expectedProduct), policy);
  assert.equal(policy.artifactPolicy.codeSigningRequired, false);
  assert.equal(validateCommunityStableAuthority(authority, expectedProduct), authority);
  assert.equal(
    policy.blockingCommands[0],
    "npm.cmd run release:community:authority",
  );
  assert.ok(policy.advisoryOnly.includes("smartscreen-reputation"));
  assert.ok(policy.blockingQualityGates.includes("critical-e2e"));
  assert.ok(policy.blockingQualityGates.includes("database-migration-and-backup"));

  const weakened = structuredClone(policy);
  weakened.blockingQualityGates.splice(
    weakened.blockingQualityGates.indexOf("critical-e2e"),
    1,
  );
  assert.throws(() => validateCommunityStablePolicy(weakened, expectedProduct), /blockingQualityGates/u);

  const hiddenWarning = structuredClone(policy);
  hiddenWarning.requiredWarnings[0] = "Unsigned build.";
  assert.throws(() => validateCommunityStablePolicy(hiddenWarning, expectedProduct), /requiredWarnings/u);

  const wrongBrand = { ...expectedProduct, name: "Other Reminder" };
  assert.throws(
    () => validateCommunityStablePolicy(policy, wrongBrand),
    /product identity/u,
  );
  assert.throws(
    () => validateCommunityStableAuthority(authority, wrongBrand),
    /stable unified product/u,
  );
});

test("builds source-bound assets, checksums, and mandatory unsigned-download guidance", () => {
  const bundle = buildCommunityReleaseBundle({
    policy,
    authority,
    expectedProduct,
    tag: "v1.5.2",
    sourceCommit: "a".repeat(40),
    policyBytes,
    portableBytes: Buffer.from("portable"),
    installerBytes: Buffer.from("installer"),
    petPackBytes: Buffer.from("pet-pack"),
    sourceLicenseBytes: Buffer.from("original-license"),
    supplementalPermissionBytes: Buffer.from("signed one-release permission"),
    sourceInfoBytes: Buffer.from("source-summary"),
  });
  assert.deepEqual(
    bundle.artifacts.map((artifact) => artifact.fileName),
    [
      `${expectedProduct.portableBaseName}_1.5.2_windows-x64-portable.exe`,
      `${expectedProduct.installerBaseName}_1.5.2_x64-setup.exe`,
      "饺饺.yuanyuan-pet",
      "JIAOJIAO_STANDALONE_ASSETS_LICENSE.md",
      "JIAOJIAO_RELEASE_PERMISSION_SUPPLEMENT.md",
      "PET_PACK_SOURCE.md",
    ],
  );
  assert.match(bundle.checksums, /^[0-9a-f]{64}  /mu);
  assert.match(bundle.checksums, new RegExp(expectedProduct.portableBaseName, "u"));
  assert.match(bundle.notes, /未知发布者/u);
  assert.match(bundle.notes, /Smart App Control/u);
  assert.match(bundle.notes, /SHA256SUMS\.txt/u);
  assert.match(bundle.notes, /完整应用数据目录/u);
  assert.match(bundle.notes, /真实 1\.3\.2 用户历史数据未取得、未验证/u);
  assert.equal(bundle.manifest.codeSigning.required, false);
  assert.equal(bundle.manifest.source.commit, "a".repeat(40));
  assert.doesNotMatch(JSON.stringify(bundle.manifest), /[A-Z]:\\/u);
});

test("rejects development builds, tag drift, and malformed source identity", () => {
  const input = {
    policy,
    authority,
    expectedProduct,
    tag: "v1.5.2",
    sourceCommit: "b".repeat(40),
    policyBytes,
    portableBytes: Buffer.from("portable"),
    installerBytes: Buffer.from("installer"),
    petPackBytes: Buffer.from("pet-pack"),
    sourceLicenseBytes: Buffer.from("original-license"),
    supplementalPermissionBytes: Buffer.from("signed one-release permission"),
    sourceInfoBytes: Buffer.from("source-summary"),
  };
  assert.throws(
    () => buildCommunityReleaseBundle({ ...input, authority: { ...authority, channel: "rc" } }),
    /stable unified product/u,
  );
  assert.throws(
    () => validateCommunityStableAuthority({ ...authority, channel: "development" }, expectedProduct),
    /stable unified product/u,
  );
  assert.throws(
    () => buildCommunityReleaseBundle({ ...input, tag: "v1.5.3" }),
    /tag must exactly match/u,
  );
  assert.throws(
    () => buildCommunityReleaseBundle({ ...input, sourceCommit: "main" }),
    /canonical lowercase Git commit/u,
  );
});

test("keeps the GitHub workflow bound to a stable main tag and generated disclosures", async () => {
  const workflow = await readFile(
    path.join(projectRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  assert.match(workflow, /fetch-depth:\s*0/u);
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*write/u);
  assert.match(workflow, /authority\.channel\s+-ne\s+"stable"/u);
  assert.match(workflow, /rev-parse\s+"\$\{\{ github\.ref_name \}\}\^\{commit\}"/u);
  assert.match(workflow, /merge-base --is-ancestor/u);
  assert.match(workflow, /COMMUNITY_SOURCE_COMMIT/u);
  assert.match(workflow, /release:community:acceptance/u);
  assert.doesNotMatch(workflow, /release:community:artifact-binding/u);
  assert.match(workflow, /COMMUNITY_PRODUCT_NAME/u);
  assert.match(workflow, /--release-commit\s+"\$env:COMMUNITY_SOURCE_COMMIT"/u);
  assert.match(workflow, /release build changed tracked source/u);
  assert.match(workflow, /prepare_community_release_draft\.mjs/u);
  assert.match(workflow, /--commit\s+"\$env:COMMUNITY_SOURCE_COMMIT"/u);
  assert.match(workflow, /--draft --verify-tag --notes-file/u);
  assert.doesNotMatch(workflow, /gh release create[^\n]*release-assets/u);
  assert.doesNotMatch(workflow, /--title\s+"圆圆提醒/u);
});
