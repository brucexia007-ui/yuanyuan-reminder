import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

test("checked-in product brand schema requires the complete pet identity", async () => {
  const schema = await readJson("customization/product-brand.schema.json");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.properties.pet.required, [
    "displayName",
    "sex",
    "breed",
    "personality",
  ]);
  assert.deepEqual(schema.properties.pet.properties.sex.enum, [
    "female",
    "male",
    "unknown",
  ]);
  assert.equal(schema.properties.pet.additionalProperties, false);
});

test("unified application keeps Round identity and data while pet names vary", async () => {
  const { verifyUnifiedPetIdentity } = await import('./verify_unified_pet_identity.mjs');
  await verifyUnifiedPetIdentity(projectRoot);
});

test("current Windows real-machine probes derive formal paths and labels from product brand", async () => {
  const scriptExpectations = new Map([
    [
      "scripts/measure_release_cold_start.ps1",
      ["brandConfig.storage.directoryName"],
    ],
    [
      "scripts/measure_learning_memory.ps1",
      ["brandConfig.storage.directoryName", "brandConfig.pet.displayName"],
    ],
    [
      "scripts/measure_diagnostic_card.ps1",
      [
        "brandConfig.storage.directoryName",
        "brandConfig.application.displayName",
      ],
    ],
    [
      "scripts/probe_release_first_start_recovery.ps1",
      [
        "brandConfig.storage.directoryName",
        "brandConfig.storage.mainDatabaseFile",
      ],
    ],
    [
      "scripts/measure_community_stable_learning_runtime.ps1",
      [
        "brandConfig.storage.directoryName",
        "brandConfig.storage.mainDatabaseFile",
        "brandConfig.storage.learningDatabaseFile",
      ],
    ],
    [
      "scripts/run_community_stable_sandbox_data_probe.ps1",
      [
        "brandConfig.application.identifier",
        "brandConfig.pet.displayName",
        "brandConfig.storage.mainDatabaseFile",
        "brandConfig.artifacts.installerBaseName",
      ],
    ],
    [
      "scripts/inspect_nsis_payload.ps1",
      ["brandConfig.artifacts.installerBaseName", "brandConfig.assets.licenseFile"],
    ],
    [
      "scripts/probe_release_uninstall_data_choice.ps1",
      ["brandConfig.artifacts.installerBaseName"],
    ],
    [
      "scripts/probe_release_upgrade_rollback.ps1",
      [
        "brandConfig.artifacts.installerBaseName",
        "brandConfig.assets.licenseFile",
        '$productKey = "Registry::HKEY_CURRENT_USER\\Software\\$installerManufacturer\\$productName"',
      ],
    ],
    [
      "scripts/probe_release_install_failure_recovery.ps1",
      [
        "brandConfig.artifacts.installerBaseName",
        "brandConfig.assets.licenseFile",
        '$productKey = "Registry::HKEY_CURRENT_USER\\Software\\$installerManufacturer\\$productName"',
      ],
    ],
  ]);

  for (const [relativePath, requiredFragments] of scriptExpectations) {
    const script = await readFile(path.join(projectRoot, relativePath), "utf8");
    assert.match(script, /product-brand\.json/u, relativePath);
    assert.doesNotMatch(script, /com\.yuanyuan\.reminder/u, relativePath);
    assert.doesNotMatch(
      script,
      /Registry::HKEY_CURRENT_USER\\Software\\yuanyuan\\\$productName/u,
      relativePath,
    );
    for (const fragment of requiredFragments) {
      assert.ok(script.includes(fragment), `${relativePath}: missing ${fragment}`);
    }
  }

  const diagnosticScript = await readFile(
    path.join(projectRoot, "scripts/measure_diagnostic_card.ps1"),
    "utf8",
  );
  assert.doesNotMatch(diagnosticScript, /5ZyG5ZyG5o\+Q6YaS/u);

  const learningScaleScript = await readFile(
    path.join(projectRoot, "scripts/measure_community_stable_learning_runtime.ps1"),
    "utf8",
  );
  assert.doesNotMatch(learningScaleScript, /"yuanyuan-reminder\.sqlite3/u);
  assert.doesNotMatch(learningScaleScript, /"yuanyuan-learning\.sqlite3/u);
});

test("runtime QA fixtures retain the unified database filenames", async () => {
  const brand = await readJson('product-brand.json');
  for (const file of ['src-tauri/src/runtime_qa.rs', 'src-tauri/src/installed_candidate_qa.rs']) {
    const source = await readFile(path.join(projectRoot, file), 'utf8');
    assert.ok(source.includes(brand.storage.mainDatabaseFile));
    assert.ok(!source.includes('crate::brand::'));
  }
});

test("unified naming checks accept original licensed assets without rewriting them", async () => {
  const { execFileSync } = await import('node:child_process');
  const files = ['product-version.json', 'product-brand.json', 'public/assets/pet/pet-manifest.json', 'ASSETS_LICENSE.md'];
  const before = await Promise.all(files.map(file => readFile(path.join(projectRoot, file))));
  execFileSync(process.execPath, ['scripts/sync_product_brand.mjs', '--write'], { cwd: projectRoot });
  execFileSync(process.execPath, ['scripts/verify_product_brand_copy_boundary.mjs'], { cwd: projectRoot });
  const after = await Promise.all(files.map(file => readFile(path.join(projectRoot, file))));
  assert.deepEqual(after, before);
});
