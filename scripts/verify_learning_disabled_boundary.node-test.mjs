import assert from "node:assert/strict";
import test from "node:test";

import {
  forbiddenDefaultBundleMarkers,
  validateDefaultBundle,
  validateLearningFeatureDeclaration,
  validateSourceBoundary,
} from "./verify_learning_disabled_boundary.mjs";

const validCargo = `
[features]
default = []
learning = ["dep:csv"]

[dependencies]
csv = { version = "1", optional = true }
`;

test("learning feature is explicit and default-off", () => {
  assert.doesNotThrow(() => validateLearningFeatureDeclaration(validCargo));
  assert.throws(
    () => validateLearningFeatureDeclaration(validCargo.replace("default = []", "default = [\"learning\"]")),
    /default features must remain empty/u,
  );
  assert.throws(
    () => validateLearningFeatureDeclaration(validCargo.replace('learning = ["dep:csv"]', "")),
    /isolated learning feature/u,
  );
  assert.throws(
    () => validateLearningFeatureDeclaration(validCargo.replace('"dep:csv"', '"runtime-qa"')),
    /only optional learning dependencies/u,
  );
});

test("default source boundary excludes learning commands and resources", () => {
  const fixture = {
    packageJson: { scripts: { build: "tsc -b && vite build", check: "vitest run" } },
    cargoToml: validCargo,
    libRs: "commands::get_runtime_capabilities, commands::list_today",
    tauriConfig: { bundle: { resources: { "../LICENSE": "licenses/LICENSE.txt" } } },
  };
  assert.doesNotThrow(() => validateSourceBoundary(fixture));
  assert.throws(
    () => validateSourceBoundary({ ...fixture, libRs: "commands::get_learning_home" }),
    /registers a learning command/u,
  );
  assert.doesNotThrow(() =>
    validateSourceBoundary({
      ...fixture,
      libRs: '#[cfg(feature = "learning")]\ncommands::get_learning_home,',
    }),
  );
  assert.throws(
    () =>
      validateSourceBoundary({
        ...fixture,
        tauriConfig: { bundle: { resources: { "../learning-content": "learning-content" } } },
      }),
    /learning resources/u,
  );
});

test("default bundle rejects every frozen learning marker", () => {
  assert.doesNotThrow(() => validateDefaultBundle("dist/app.js", "ordinary reminder code"));
  assert.throws(
    () => validateDefaultBundle("dist/assets/pet/learning-atlas.webp", ""),
    /learning-only asset/u,
  );
  for (const marker of forbiddenDefaultBundleMarkers) {
    assert.throws(
      () => validateDefaultBundle("dist/app.js", `before ${marker} after`),
      /disabled learning marker/u,
    );
  }
});
