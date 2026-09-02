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

test("饺饺's requested female identity stays synchronized into runtime assets", async () => {
  const [brand, manifest, assetLicense] = await Promise.all([
    readJson("product-brand.json"),
    readJson("public/assets/pet/pet-manifest.json"),
    readFile(path.join(projectRoot, "JIAOJIAO_ASSETS_LICENSE.md"), "utf8"),
  ]);
  assert.deepEqual(brand.pet, {
    displayName: "饺饺",
    sex: "female",
    breed: "英短金点",
    personality: "乖巧高冷",
  });
  assert.equal(manifest.displayName, brand.pet.displayName);
  assert.equal(manifest.sex, brand.pet.sex);
  assert.equal(manifest.breed, brand.pet.breed);
  assert.equal(manifest.personality, brand.pet.personality);
  assert.match(manifest.description, /饺饺.*英短金点母猫.*乖巧高冷/u);
  assert.match(assetLicense, /宠物名为“饺饺”，是一只母猫/u);
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

test("runtime QA fixtures use the branded reminder and learning database filenames", async () => {
  const runtimeQa = await readFile(
    path.join(projectRoot, "src-tauri/src/runtime_qa.rs"),
    "utf8",
  );
  assert.match(runtimeQa, /crate::brand::main_database_file\(\)/u);
  assert.match(runtimeQa, /crate::brand::learning_database_file\(\)/u);
  assert.doesNotMatch(runtimeQa, /yuanyuan-reminder\.sqlite3/u);
  assert.doesNotMatch(runtimeQa, /yuanyuan-learning\.sqlite3/u);
});

test("public product documents describe the current 饺饺 1.5.10 identity and data boundary", async () => {
  const [readme, readmeEnglish, privacy, security, changelog, learningStatus] = await Promise.all([
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "README.en.md"), "utf8"),
    readFile(path.join(projectRoot, "PRIVACY.md"), "utf8"),
    readFile(path.join(projectRoot, "SECURITY.md"), "utf8"),
    readFile(path.join(projectRoot, "CHANGELOG.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/learning/IMPLEMENTATION_STATUS.md"), "utf8"),
  ]);
  for (const [relativePath, document] of [
    ["README.md", readme],
    ["README.en.md", readmeEnglish],
    ["PRIVACY.md", privacy],
    ["SECURITY.md", security],
  ]) {
    assert.doesNotMatch(document, /圆圆/u, relativePath);
  }
  assert.match(readme, /<h1 align="center">饺饺提醒<\/h1>/u);
  assert.match(readme, /Version 1\.5\.10/u);
  assert.match(readme, /饺饺提醒_\*_x64-setup\.exe/u);
  assert.match(readme, /饺饺提醒_\*_windows-x64-portable\.exe/u);
  assert.match(readme, /%LOCALAPPDATA%\\com\.brucexia\.jiaojiao\.reminder\\/u);
  assert.match(readme, /\(JIAOJIAO_ASSETS_LICENSE\.md\)/u);
  assert.match(readme, /public\/assets\/pet\/fallback\.png/u);
  assert.doesNotMatch(readme, /docs\/images\//u);
  assert.match(readmeEnglish, /^# 饺饺提醒 \(Jiaojiao Reminder\)$/mu);
  assert.match(readmeEnglish, /public\/assets\/pet\/fallback\.png/u);
  assert.doesNotMatch(readmeEnglish, /docs\/images\//u);
  assert.match(privacy, /适用版本：饺饺提醒 1\.5\.10/u);
  assert.match(privacy, /通用学习包内容/u);
  assert.match(privacy, /答题进度/u);
  assert.match(security, /饺饺提醒是本地桌面工具/u);
  assert.match(changelog, /^## 1\.5\.10 -/mu);
  assert.match(changelog, /英短金点母猫“饺饺”/u);
  assert.match(changelog, /乖巧高冷/u);
  assert.match(learningStatus, /基线：饺饺提醒统一产品 v1\.5\.7/u);
  assert.match(learningStatus, /`jiaojiao-learning\.sqlite3`/u);
  assert.match(learningStatus, /`jiaojiao-reminder\.sqlite3`/u);
  assert.doesNotMatch(learningStatus, /圆圆提醒|`yuanyuan-learning\.sqlite3`/u);
});

test("current application, MSIX, and Store publication surfaces use the product brand mirrors", async () => {
  const [submissionTemplateText, previewManifest, storeManifest, storeRunbook, indexHtml, capabilityText] = await Promise.all([
    readFile(path.join(projectRoot, "docs/release/MSIX_STORE_SUBMISSION_INPUTS_V1.template.json"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri/msix/AppxManifest.preview.xml"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri/msix/AppxManifest.store.xml"), "utf8"),
    readFile(path.join(projectRoot, "docs/release/MSIX_STORE_ONBOARDING_RUNBOOK.md"), "utf8"),
    readFile(path.join(projectRoot, "index.html"), "utf8"),
    readFile(path.join(projectRoot, "src-tauri/capabilities/default.json"), "utf8"),
  ]);
  const submissionTemplate = JSON.parse(submissionTemplateText);
  assert.equal(submissionTemplate.product.name, "饺饺提醒");
  assert.match(submissionTemplate.listing.description, /^饺饺提醒/u);
  assert.match(submissionTemplate.listing.screenshots[0].caption, /桌面上的饺饺/u);
  assert.match(submissionTemplate.declarations.restrictedCapabilities[0].justification, /^饺饺提醒 is/u);
  assert.doesNotMatch(submissionTemplateText, /圆圆/u);
  for (const manifest of [previewManifest, storeManifest]) {
    assert.match(manifest, /DisplayName="饺饺提醒"/u);
    assert.match(manifest, /Description="饺饺陪你喝水、安排工作和准时休息"/u);
    assert.doesNotMatch(manifest, /圆圆/u);
  }
  assert.match(previewManifest, /<DisplayName>饺饺提醒（MSIX 预览）<\/DisplayName>/u);
  assert.match(storeManifest, /<DisplayName>饺饺提醒<\/DisplayName>/u);
  assert.match(storeRunbook, /--reserved-product-name "饺饺提醒"/u);
  assert.match(storeRunbook, /删除饺饺全部本地数据/u);
  assert.match(storeRunbook, /LOCALAPPDATA\/com\.brucexia\.jiaojiao\.reminder/u);
  assert.match(indexHtml, /<title>饺饺提醒<\/title>/u);
  assert.doesNotMatch(indexHtml, /圆圆/u);
  const capability = JSON.parse(capabilityText);
  assert.equal(capability.description, "饺饺提醒应用窗口的最小权限");
  assert.doesNotMatch(capabilityText, /圆圆/u);
});
