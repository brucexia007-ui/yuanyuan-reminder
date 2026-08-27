import assert from "node:assert/strict";
import test from "node:test";

import {
  validateUnifiedBundle,
  validateUnifiedCargoFeatures,
  validateUnifiedSourceContract,
} from "./verify_unified_product_boundary.mjs";

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

const valid = {
  manifest,
  packageJson: { scripts: { build: "tsc -b && vite build" } },
  cargoToml: '[features]\ndefault = ["learning"]\nlearning = ["dep:csv"]\n',
  libRs: 'commands::get_learning_home,\ncommands::list_today,\n',
  tauriConfig: {
    productName: "圆圆提醒",
    identifier: "com.yuanyuan.reminder",
    version: "1.5.0",
  },
  windowCapabilities: {
    identifier: "default",
    permissions: ["core:window:allow-start-dragging"],
  },
  viteConfig: 'plugins: [react()]',
  featureGate:
    'export const LEARNING_BUNDLE_MARKER = "yuanyuan-learning-integrated-ui";\nexport const learningBuildEnabled = true;',
  initialLearningMigration: "VALUES(1, 'manual_only', 3, 5);",
  legacyPreviewConfigExists: false,
};

test("requires learning in the default Cargo feature set", () => {
  assert.doesNotThrow(() => validateUnifiedCargoFeatures(valid.cargoToml));
  assert.throws(
    () => validateUnifiedCargoFeatures(valid.cargoToml.replace('["learning"]', "[]")),
    /exactly/u,
  );
});

test("accepts only one product identity and one default frontend build", () => {
  assert.doesNotThrow(() => validateUnifiedSourceContract(valid));
  assert.throws(
    () =>
      validateUnifiedSourceContract({
        ...valid,
        packageJson: {
          scripts: { "learning:desktop:build": "tauri build --config tauri.learning-preview.conf.json" },
        },
      }),
    /obsolete|Preview/u,
  );
  assert.throws(
    () => validateUnifiedSourceContract({ ...valid, legacyPreviewConfigExists: true }),
    /must be removed/u,
  );
  assert.throws(
    () =>
      validateUnifiedSourceContract({
        ...valid,
        initialLearningMigration: "VALUES(1, 'automatic_opt_in', 3, 5);",
      }),
    /default-off/u,
  );
  assert.throws(
    () =>
      validateUnifiedSourceContract({
        ...valid,
        windowCapabilities: { identifier: "default", permissions: [] },
      }),
    /start-dragging/u,
  );
});

test("requires integrated learning bytes while rejecting edition identities", () => {
  const paths = ["dist/index.html", "dist/assets/pet/learning-atlas.webp"];
  const javascript = "get_learning_home preview_learning_import delete_learning_data";
  assert.doesNotThrow(() => validateUnifiedBundle(paths, javascript));
  assert.throws(
    () => validateUnifiedBundle(paths, `${javascript} com.yuanyuan.reminder.learning-preview`),
    /obsolete edition/u,
  );
  assert.throws(
    () => validateUnifiedBundle(["dist/index.html"], javascript),
    /learning pet asset/u,
  );
});
