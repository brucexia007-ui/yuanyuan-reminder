import assert from "node:assert/strict";
import test from "node:test";

import {
  collectProductVersionDrift,
  synchronizeProductVersionSources,
  validateProductManifest,
} from "./sync_unified_product_version.mjs";

const manifest = {
  schemaVersion: 1,
  productName: "圆圆提醒",
  identifier: "com.yuanyuan.reminder",
  version: "1.5.0",
  releaseTrain: "unified-product",
  channel: "development",
  capabilities: {
    learningIntegrated: true,
    automaticLearningInvitationsDefault: false,
    bundledPersonalLearningContent: false,
  },
  legacyEditions: [
    "com.yuanyuan.reminder.learning-preview",
    "com.yuanyuan.reminder.learning-personal",
  ],
};

const sources = {
  manifest,
  packageJson: { name: "yuanyuan-reminder", version: "1.4.0" },
  packageLock: {
    name: "yuanyuan-reminder",
    version: "1.4.0",
    packages: { "": { name: "yuanyuan-reminder", version: "1.4.0" } },
  },
  cargoToml: '[package]\nname = "yuanyuan-reminder"\nversion = "1.4.0"\n\n[features]\ndefault = []\n',
  cargoLock: '[[package]]\nname = "yuanyuan-reminder"\nversion = "1.4.0"\ndependencies = []\n',
  tauriConfig: {
    productName: "旧名称",
    version: "1.4.0",
    identifier: "com.yuanyuan.reminder.learning-preview",
  },
};

test("accepts only the unified product identity and content policy", () => {
  assert.doesNotThrow(() => validateProductManifest(manifest));
  for (const mutate of [
    (value) => (value.identifier = "com.yuanyuan.reminder.learning-preview"),
    (value) => (value.version = "1.5"),
    (value) => (value.capabilities.automaticLearningInvitationsDefault = true),
    (value) => (value.capabilities.bundledPersonalLearningContent = true),
    (value) => value.legacyEditions.reverse(),
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(() => validateProductManifest(invalid), /unified product|legacy edition/u);
  }
});

test("accepts a schema-bound custom product identity", () => {
  const custom = {
    ...structuredClone(manifest),
    productName: "饺饺提醒",
    identifier: "com.brucexia.jiaojiao.reminder",
    brandConfig: "product-brand.json",
  };
  const brand = {
    application: {
      displayName: "饺饺提醒",
      identifier: "com.brucexia.jiaojiao.reminder",
      packageName: "jiaojiao-reminder",
    },
  };
  assert.doesNotThrow(() => validateProductManifest(custom, brand));
  assert.throws(
    () => validateProductManifest({ ...custom, identifier: "com.example.drift" }, brand),
    /unified product/u,
  );
});

test("synchronizes every product version and identity source", () => {
  const synchronized = synchronizeProductVersionSources(sources);
  const checked = { ...sources, ...synchronized };
  assert.deepEqual(collectProductVersionDrift(checked), []);
  assert.equal(synchronized.packageJson.version, "1.5.0");
  assert.equal(synchronized.packageLock.packages[""].version, "1.5.0");
  assert.match(synchronized.cargoToml, /version = "1\.5\.0"/u);
  assert.match(synchronized.cargoLock, /version = "1\.5\.0"/u);
  assert.equal(synchronized.tauriConfig.productName, "圆圆提醒");
  assert.equal(synchronized.tauriConfig.identifier, "com.yuanyuan.reminder");
});

test("reports every unsynchronized source without optimistic success", () => {
  const drift = collectProductVersionDrift(sources);
  assert.deepEqual(
    drift.map((finding) => finding.source),
    [
      "package.json",
      "package-lock.json",
      "package-lock.json packages['']",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
      "src-tauri/tauri.conf.json productName",
      "src-tauri/tauri.conf.json identifier",
    ],
  );
});
