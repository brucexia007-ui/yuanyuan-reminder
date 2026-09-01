import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sourceSnapshot } from "./source-snapshot.mjs";

const DIRECTIONS = [
  ["000", "up"], ["022.5", "up-right"], ["045", "up-right"], ["067.5", "up-right"],
  ["090", "right"], ["112.5", "down-right"], ["135", "down-right"], ["157.5", "down-right"],
  ["180", "down"], ["202.5", "down-left"], ["225", "down-left"], ["247.5", "down-left"],
  ["270", "left"], ["292.5", "up-left"], ["315", "up-left"], ["337.5", "up-left"],
];
const FEATURES = [
  "reminder_management", "snooze_levels", "missed_reminder_policy", "automatic_backup",
  "manual_backup", "basic_companion", "reunion_action", "task_watch", "learning_blackboard",
  "learning_invitation_preemption", "hide_restore_pet", "panel_drag", "interaction_bubble_clearance",
  "focus_calm", "water_before_activity",
];
const INTERACTIONS = [
  "treat_direction_follow", "wand_eight_directions", "pet_head_zone_only",
  "ball_charge_flight_chase_bat_carry_drop", "learning_expression_rows",
];

function fail(message) {
  throw new Error(`CUSTOMIZATION_EVIDENCE_INVALID: ${message}`);
}

async function json(filePath) {
  try {
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`${path.basename(filePath)} is not valid JSON: ${error.message}`);
  }
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readProjectFile(projectRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    fail("bound artifact path is invalid");
  }
  const root = await realpath(projectRoot);
  const resolved = await realpath(path.resolve(root, relativePath));
  const within = path.relative(root, resolved);
  if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    fail("bound artifact escapes the project");
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.size < 1) fail("bound artifact must be a non-empty regular file");
  return readFile(resolved);
}

function artifactMap(artifacts) {
  return new Map(artifacts.map((artifact) => [artifact.role, artifact]));
}

const PET_ASSET_FILES = {
  standard_atlas: "spritesheet.webp",
  sleep_atlas: "sleep-atlas.webp",
  life_atlas: "life-atlas.webp",
  learning_atlas: "learning-atlas.webp",
  fallback_image: "fallback.png",
  pet_manifest: "pet-manifest.json",
};

async function productBrand(projectRoot) {
  return json(path.join(projectRoot, "product-brand.json"));
}

async function officialAssetHashes(projectRoot) {
  const baseline = await json(path.join(projectRoot, "customization/pet/official-asset-hashes.json"));
  if (baseline.schemaVersion !== 1 || baseline.profile !== "yuanyuan-official-pet-assets-v2" || !baseline.assets) {
    fail("official asset hash baseline is invalid");
  }
  return baseline;
}

export async function validatePetAssetEvidence(artifacts, projectRoot) {
  const byRole = artifactMap(artifacts);
  const [brand, baseline] = await Promise.all([productBrand(projectRoot), officialAssetHashes(projectRoot)]);
  for (const [role, filename] of Object.entries(PET_ASSET_FILES)) {
    const artifact = byRole.get(role);
    const expectedPath = path.posix.join(brand.assets.petDirectory, filename);
    if (artifact?.path !== expectedPath) fail(`${role} must replace ${expectedPath}`);
    if (role !== "pet_manifest" && artifact.sha256 === baseline.assets[expectedPath]) {
      fail(`${expectedPath} still matches the official pet asset`);
    }
  }
  const icon = byRole.get("windows_icon");
  const iconPath = path.posix.join(brand.assets.iconDirectory, "icon.ico");
  if (icon?.path !== iconPath || icon.sha256 === baseline.assets[iconPath]) {
    fail("Windows icon.ico must replace the official icon");
  }
  const manifest = await json(path.join(projectRoot, byRole.get("pet_manifest").path));
  if (
    manifest.spriteVersionNumber !== 2
    || manifest.id !== brand.application.packageName
    || manifest.displayName !== brand.pet.displayName
    || manifest.sex !== brand.pet.sex
    || manifest.breed !== brand.pet.breed
    || manifest.personality !== brand.pet.personality
    || manifest.assetLicense !== brand.assets.licenseFile
    || !manifest.animations
    || typeof manifest.animations !== "object"
  ) {
    fail("custom pet manifest must bind the custom brand and remain a complete sprite v2 manifest");
  }
}

export async function validateAssetLicenseEvidence(artifacts, projectRoot) {
  const artifact = artifactMap(artifacts).get("asset_license");
  const [brand, baseline] = await Promise.all([productBrand(projectRoot), officialAssetHashes(projectRoot)]);
  if (
    artifact.path !== brand.assets.licenseFile
    || artifact.path === "ASSETS_LICENSE.md"
    || artifact.sha256 === baseline.assets["ASSETS_LICENSE.md"]
    || path.extname(artifact.path).toLowerCase() !== ".md"
  ) fail("custom pet requires a separate Markdown asset license file");
  const text = await readFile(path.join(projectRoot, artifact.path), "utf8");
  const requiredNames = ["spritesheet.webp", "sleep-atlas.webp", "life-atlas.webp", "learning-atlas.webp", "fallback.png", "icon.ico"];
  if (!text.includes(brand.application.displayName) || requiredNames.some((name) => !text.includes(name))) {
    fail("custom asset license must name the application and every delivered pet/icon asset family");
  }
}

function exactIds(entries, expected, label) {
  if (!Array.isArray(entries) || entries.length !== expected.length) fail(`${label} must contain the exact required entries`);
  const ids = entries.map((entry) => entry?.id);
  if (JSON.stringify(ids) !== JSON.stringify(expected)) fail(`${label} order or identity drifted`);
  for (const entry of entries) {
    exactObjectKeys(entry, ["id", "result", "notes"], `${label}.${entry.id ?? "unknown"}`);
    if (entry.result !== "pass" || typeof entry.notes !== "string") fail(`${label}.${entry.id} is not a recorded pass`);
  }
}

function hasExactObjectKeys(value, expected) {
  return !(
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  );
}

function exactObjectKeys(value, expected, label) {
  if (!hasExactObjectKeys(value, expected)) fail(`${label} fields are invalid`);
}

export async function validateBrandEvidence(artifacts, projectRoot, state) {
  const artifact = artifactMap(artifacts).get("brand_config");
  if (artifact?.path !== "product-brand.json") fail("brand step must bind product-brand.json");
  const bytes = await readProjectFile(projectRoot, artifact.path);
  const brand = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  if (
    artifact.sha256 !== hash(bytes)
    || brand.pet?.displayName !== state.request.petDisplayName
    || (state.request.petSex != null && brand.pet?.sex !== state.request.petSex)
    || (state.request.petBreed != null && brand.pet?.breed !== state.request.petBreed)
    || (state.request.petPersonality != null && brand.pet?.personality !== state.request.petPersonality)
    || !/^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/u.test(brand.application?.identifier ?? "")
  ) fail("brand config does not match the customization request or a safe application identity");
  if (state.steps.find((entry) => entry.id === "identity_lock")?.status !== "not_required"
      && (
        brand.application.identifier === "com.yuanyuan.reminder"
        || brand.storage?.directoryName !== brand.application.identifier
        || brand.storage.directoryName === "com.yuanyuan.reminder"
      )) {
    fail("a customized pet must use an independent matching application and storage identity");
  }
}

export async function validateIdentityLockEvidence(artifacts, projectRoot, state) {
  const byRole = artifactMap(artifacts);
  const lockArtifact = byRole.get("identity_lock");
  const referenceArtifact = byRole.get("identity_reference");
  const [lock, brand] = await Promise.all([
    json(path.join(projectRoot, lockArtifact.path)),
    productBrand(projectRoot),
  ]);
  exactObjectKeys(lock, [
    "schemaVersion", "profile", "petDisplayName", "sex", "stylePreset", "createdAt",
    "sourcePhotoCount", "sourcePhotoSha256", "referenceImage", "visualIdentity",
    "mustPreserve", "mustAvoid",
  ], "identity lock");
  if (
    lock.schemaVersion !== 1
    || lock.profile !== "yuanyuan-custom-pet-identity-lock"
    || lock.petDisplayName !== state.request.petDisplayName
    || lock.petDisplayName !== brand.pet.displayName
    || (state.request.petSex != null && lock.sex !== state.request.petSex)
    || lock.sex !== brand.pet.sex
    || lock.stylePreset !== state.request.petStylePreset
    || !Number.isFinite(Date.parse(lock.createdAt))
    || lock.sourcePhotoCount !== state.request.photoInputCount
    || !Array.isArray(lock.sourcePhotoSha256)
    || lock.sourcePhotoSha256.length !== lock.sourcePhotoCount
    || lock.sourcePhotoSha256.some((entry) => !/^[a-f0-9]{64}$/u.test(entry))
  ) fail("identity lock does not match the private request summary");
  exactObjectKeys(lock.referenceImage, ["path", "sha256", "bytes"], "identity reference");
  if (
    lock.referenceImage.path !== referenceArtifact.path
    || lock.referenceImage.sha256 !== referenceArtifact.sha256
    || lock.referenceImage.bytes !== referenceArtifact.bytes
    || !/\.(png|webp)$/iu.test(referenceArtifact.path)
  ) fail("identity lock does not bind the final PNG/WebP reference image");
  const visualKeys = [
    "speciesAndAge", "coatAndGradient", "faceShape", "eyes", "noseMuzzleAndEars",
    "bodyAndProportions", "markings", "signatureTraits", "motionPersonality",
  ];
  exactObjectKeys(lock.visualIdentity, visualKeys, "visual identity");
  if (visualKeys.some((key) => typeof lock.visualIdentity[key] !== "string" || lock.visualIdentity[key].trim().length < 2)) {
    fail("every visual identity field must be completed");
  }
  for (const [value, label] of [[lock.mustPreserve, "mustPreserve"], [lock.mustAvoid, "mustAvoid"]]) {
    if (!Array.isArray(value) || value.length < 2 || value.some((entry) => typeof entry !== "string" || entry.trim().length < 2)) {
      fail(`${label} must contain at least two concrete identity rules`);
    }
  }
}

export async function validateVisualQaEvidence(artifacts, projectRoot, state) {
  const byRole = artifactMap(artifacts);
  const reportArtifact = byRole.get("qa_report");
  const semanticsArtifact = byRole.get("direction_semantics");
  const contactArtifact = byRole.get("contact_sheet");
  const directionArtifact = byRole.get("direction_sheet");
  const previewArtifact = byRole.get("animation_preview");
  const [report, brand, baseline] = await Promise.all([
    json(path.join(projectRoot, reportArtifact.path)),
    productBrand(projectRoot),
    officialAssetHashes(projectRoot),
  ]);
  const expectedReplacementPaths = [
    ...Object.values(PET_ASSET_FILES).filter((name) => name !== "pet-manifest.json").map((name) => path.posix.join(brand.assets.petDirectory, name)),
    ...["32x32.png", "128x128.png", "128x128@2x.png", "icon.ico"].map((name) => path.posix.join(brand.assets.iconDirectory, name)),
    brand.assets.licenseFile,
  ];
  if (
    report.schemaVersion !== 1
    || report.profile !== "yuanyuan-custom-pet-pack-qa"
    || report.spriteVersionNumber !== 2
    || report.completeRowsRequired !== true
    || report.structural?.ok !== true
    || report.structural?.frameCount !== 312
    || report.structural?.failedFrameCount !== 0
    || report.artifacts?.previewIndex?.count !== 39
    || report.customAssetReplacement?.required !== true
    || report.customAssetReplacement?.ok !== true
    || report.customAssetReplacement?.baselineProfile !== "yuanyuan-official-pet-assets-v2"
    || !Array.isArray(report.customAssetReplacement?.unchangedPaths)
    || report.customAssetReplacement.unchangedPaths.length !== 0
    || JSON.stringify(report.customAssetReplacement?.changedPaths) !== JSON.stringify(expectedReplacementPaths)
  ) fail("pet QA report is not a passing strict 39-row report");
  const bindings = [
    [contactArtifact, report.artifacts.contactSheet, "contact sheet"],
    [directionArtifact, report.artifacts.directionSheet, "direction sheet"],
    [previewArtifact, report.artifacts.previewIndex, "preview index"],
  ];
  for (const [artifact, expected, label] of bindings) {
    if (!artifact || artifact.path !== expected?.path || artifact.sha256 !== expected?.sha256) fail(`${label} is not bound to the QA report`);
  }

  const recorded = artifactMap(state.artifacts);
  const sheetRoles = { standard: "standard_atlas", sleep: "sleep_atlas", life: "life_atlas", learning: "learning_atlas" };
  if (
    !Array.isArray(report.bindings?.atlases)
    || JSON.stringify(report.bindings.atlases.map((entry) => entry.sheet)) !== JSON.stringify(Object.keys(sheetRoles))
  ) fail("QA report must bind all four atlases in canonical order");
  for (const binding of report.bindings?.atlases ?? []) {
    const artifact = recorded.get(sheetRoles[binding.sheet]);
    if (!artifact || artifact.path !== binding.path || artifact.sha256 !== binding.sha256 || artifact.bytes !== binding.bytes) {
      fail(`QA atlas binding drifted for ${binding.sheet ?? "unknown"}`);
    }
  }
  for (const [binding, role, label] of [
    [report.bindings?.manifest, "pet_manifest", "manifest"],
    [report.bindings?.fallback, "fallback_image", "fallback"],
    [report.bindings?.assetLicense, "asset_license", "asset license"],
  ]) {
    const artifact = recorded.get(role);
    if (!artifact || artifact.path !== binding?.path || artifact.sha256 !== binding?.sha256 || artifact.bytes !== binding?.bytes) {
      fail(`QA ${label} binding drifted`);
    }
  }
  const iconBinding = report.bindings?.icons?.find((entry) => entry.path.endsWith("/icon.ico"));
  const iconArtifact = recorded.get("windows_icon");
  if (!iconArtifact || iconArtifact.path !== iconBinding?.path || iconArtifact.sha256 !== iconBinding?.sha256 || iconArtifact.bytes !== iconBinding?.bytes) {
    fail("QA Windows icon binding drifted");
  }
  if (!Array.isArray(report.bindings?.icons) || report.bindings.icons.length !== 4) fail("QA report must bind all four Windows icon files");
  for (const binding of report.bindings.icons) {
    const bytes = await readProjectFile(projectRoot, binding.path);
    if (binding.sha256 !== hash(bytes) || binding.bytes !== bytes.length || binding.sha256 === baseline.assets[binding.path]) {
      fail(`QA icon binding is stale or still official: ${binding.path}`);
    }
  }

  const previewIndex = await json(path.join(projectRoot, previewArtifact.path));
  if (previewIndex.schemaVersion !== 1 || !Array.isArray(previewIndex.previews) || previewIndex.previews.length !== 39) {
    fail("preview index must name all 39 animation rows");
  }
  for (const preview of previewIndex.previews) {
    if (!/^[a-f0-9]{64}$/u.test(preview.sha256 ?? "") || typeof preview.path !== "string") fail("preview index entry is malformed");
    const bytes = await readProjectFile(projectRoot, preview.path);
    if (hash(bytes) !== preview.sha256) fail(`animation preview drifted: ${preview.path}`);
  }

  const semantics = await json(path.join(projectRoot, semanticsArtifact.path));
  if (
    semantics.schemaVersion !== 1
    || semantics.visualQa !== "pass"
    || typeof semantics.reviewedBy !== "string"
    || semantics.reviewedBy.trim().length < 2
    || !Number.isFinite(Date.parse(semantics.reviewedAt))
    || semantics.contactSheet !== contactArtifact.path
    || semantics.directionSheet !== directionArtifact.path
  ) fail("visual review identity or artifact bindings are incomplete");
  if (!Array.isArray(semantics.directions) || semantics.directions.length !== DIRECTIONS.length) fail("direction semantics must contain all 16 directions");
  semantics.directions.forEach((entry, index) => {
    const [degree, expected] = DIRECTIONS[index];
    if (
      entry.degree !== degree
      || entry.expected !== expected
      || !["pass", "warning"].includes(entry.verdict)
      || typeof entry.observed !== "string"
      || entry.observed.trim().length === 0
      || typeof entry.reason !== "string"
      || entry.reason.trim().length === 0
    ) fail(`direction ${degree} is missing an accepted semantic verdict`);
  });
  if (!Array.isArray(semantics.rowReview) || semantics.rowReview.length !== 39) fail("row review must cover all 39 rows");
  for (const row of semantics.rowReview) {
    if (!["pass", "warning"].includes(row.verdict) || typeof row.reason !== "string" || row.reason.trim().length === 0) {
      fail(`row review is incomplete for ${row.sheet ?? "unknown"}:${row.row ?? "unknown"}`);
    }
  }
}

export async function validateFunctionalRegressionEvidence(
  artifacts,
  projectRoot,
  state,
  { sourceSnapshotFn = sourceSnapshot } = {},
) {
  const reportArtifact = artifactMap(artifacts).get("functional_regression_report");
  const report = await json(path.join(projectRoot, reportArtifact.path));
  const productVersion = await json(path.join(projectRoot, "product-version.json"));
  const snapshot = await sourceSnapshotFn(projectRoot, state.source.resolvedCommit);
  exactObjectKeys(report, [
    "schemaVersion", "profile", "sourceCommit", "sourceSnapshotSha256",
    "sourceDiffBytes", "untrackedSourceFiles", "productVersion", "testedAt",
    "testedBy", "windowsScaling", "displayTopologies", "features", "interactions",
  ], "functional regression");
  if (
    report.schemaVersion !== 1
    || report.profile !== "yuanyuan-custom-pet-functional-regression"
    || !/^[a-f0-9]{40}$/u.test(report.sourceCommit ?? "")
    || report.sourceCommit !== state.source.resolvedCommit
    || report.sourceSnapshotSha256 !== snapshot.sha256
    || report.sourceDiffBytes !== snapshot.diffBytes
    || JSON.stringify(report.untrackedSourceFiles) !== JSON.stringify(snapshot.untrackedFiles)
    || report.productVersion !== productVersion.version
    || typeof report.testedBy !== "string"
    || report.testedBy.trim().length < 2
    || !Number.isFinite(Date.parse(report.testedAt))
  ) fail("functional regression identity is incomplete");
  if (
    !Array.isArray(report.windowsScaling)
    || JSON.stringify(report.windowsScaling.map((entry) => entry.percent)) !== JSON.stringify([100, 125, 150, 200])
    || report.windowsScaling.some((entry) => !hasExactObjectKeys(entry, ["percent", "result", "notes"]))
    || report.windowsScaling.some((entry) => entry.result !== "pass" || typeof entry.notes !== "string")
  ) fail("Windows 100/125/150/200 percent scaling evidence is incomplete");
  if (
    !Array.isArray(report.displayTopologies)
    || JSON.stringify(report.displayTopologies.map((entry) => entry.topology)) !== JSON.stringify(["single_monitor", "multi_monitor"])
    || report.displayTopologies.some((entry) => !hasExactObjectKeys(entry, ["topology", "result", "notes"]))
    || report.displayTopologies.some((entry) => entry.result !== "pass" || typeof entry.notes !== "string")
  ) fail("single and multi-monitor evidence is incomplete");
  exactIds(report.features, FEATURES, "features");
  exactIds(report.interactions, INTERACTIONS, "interactions");
}

export async function validateVerificationEvidence(
  artifacts,
  projectRoot,
  state,
  { sourceSnapshotFn = sourceSnapshot } = {},
) {
  const reportArtifact = artifactMap(artifacts).get("verification_report");
  const report = await json(path.join(projectRoot, reportArtifact.path));
  const functionalArtifact = state.artifacts.find((entry) => entry.role === "functional_regression_report");
  if (!functionalArtifact) fail("verification has no completed functional regression report");
  const functionalBytes = await readFile(path.join(projectRoot, functionalArtifact.path));
  if (functionalBytes.length !== functionalArtifact.bytes || hash(functionalBytes) !== functionalArtifact.sha256) {
    fail("functional regression report changed after acceptance");
  }
  let functional;
  try {
    functional = JSON.parse(functionalBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    fail("functional regression report is not valid JSON");
  }
  const [version, brand, brandBytes] = await Promise.all([
    json(path.join(projectRoot, "product-version.json")),
    json(path.join(projectRoot, "product-brand.json")),
    readFile(path.join(projectRoot, "product-brand.json")),
  ]);
  const startedAt = Date.parse(report.startedAt);
  const completedAt = Date.parse(report.completedAt);
  const expectedCommands = ["npm.cmd run verify", "cargo test --locked", "npm.cmd run tauri build"];
  if (
    report.schemaVersion !== 1
    || report.profile !== "yuanyuan-customization-verification"
    || report.runId !== state.runId
    || report.baselineCommit !== state.source.resolvedCommit
    || report.productVersion !== version.version
    || report.brandIdentifier !== brand.application.identifier
    || report.brandSha256 !== hash(brandBytes)
    || report.passed !== true
    || !Number.isFinite(startedAt)
    || !Number.isFinite(completedAt)
    || completedAt < startedAt
    || !Array.isArray(report.results)
    || JSON.stringify(report.results.map((entry) => entry.command)) !== JSON.stringify(expectedCommands)
    || report.results.some((entry) => entry.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(entry.outputSha256 ?? "") || !Number.isSafeInteger(entry.durationMs) || entry.durationMs < 0)
  ) fail("verification report does not prove the three required successful commands");
  const snapshot = await sourceSnapshotFn(projectRoot, state.source.resolvedCommit);
  if (
    report.sourceSnapshotSha256 !== snapshot.sha256
    || report.sourceDiffBytes !== snapshot.diffBytes
    || JSON.stringify(report.untrackedSourceFiles) !== JSON.stringify(snapshot.untrackedFiles)
    || functional.sourceCommit !== state.source.resolvedCommit
    || functional.sourceSnapshotSha256 !== snapshot.sha256
    || functional.sourceDiffBytes !== snapshot.diffBytes
    || JSON.stringify(functional.untrackedSourceFiles) !== JSON.stringify(snapshot.untrackedFiles)
  ) fail("source snapshot changed after verification");
}

export async function validatePackagingEvidence(
  artifacts,
  projectRoot,
  state,
  { sourceSnapshotFn = sourceSnapshot } = {},
) {
  const byRole = artifactMap(artifacts);
  const manifestArtifact = byRole.get("delivery_manifest");
  const manifest = await json(path.join(projectRoot, manifestArtifact.path));
  const verificationArtifact = state.artifacts.find((entry) => entry.role === "verification_report");
  if (!verificationArtifact) fail("packaging has no completed verification report");
  const verificationBytes = await readFile(path.join(projectRoot, verificationArtifact.path));
  if (verificationBytes.length !== verificationArtifact.bytes || hash(verificationBytes) !== verificationArtifact.sha256) {
    fail("verification report changed before packaging");
  }
  let verification;
  try {
    verification = JSON.parse(verificationBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    fail("verification report is not valid JSON");
  }
  const [version, brand] = await Promise.all([
    json(path.join(projectRoot, "product-version.json")),
    json(path.join(projectRoot, "product-brand.json")),
  ]);
  if (
    manifest.schemaVersion !== 1
    || manifest.profile !== "yuanyuan-customization-delivery"
    || manifest.runId !== state.runId
    || manifest.baselineCommit !== state.source.resolvedCommit
    || manifest.sourceSnapshotSha256 !== verification.sourceSnapshotSha256
    || manifest.productVersion !== version.version
    || manifest.brandIdentifier !== brand.application.identifier
    || !Number.isFinite(Date.parse(manifest.generatedAt))
  ) fail("delivery manifest identity drifted from verified source and brand");
  const snapshot = await sourceSnapshotFn(projectRoot, state.source.resolvedCommit);
  if (snapshot.sha256 !== manifest.sourceSnapshotSha256) fail("source snapshot changed before packaging completion");
  const expectedNames = {
    installer: `${brand.artifacts.installerBaseName}_${version.version}_x64-setup.exe`,
    portable: `${brand.artifacts.portableBaseName}_${version.version}_windows-x64-portable.exe`,
    checksums: "SHA256SUMS.txt",
  };
  for (const role of ["installer", "portable", "checksums"]) {
    const artifact = byRole.get(role);
    const bound = manifest.artifacts?.[role];
    if (
      !artifact
      || path.basename(artifact.path) !== expectedNames[role]
      || bound?.path !== artifact.path
      || bound?.sha256 !== artifact.sha256
      || bound?.bytes !== artifact.bytes
    ) fail(`${role} is not exactly bound to the delivery manifest`);
  }
  for (const role of ["installer", "portable"]) {
    const bytes = await readFile(path.join(projectRoot, byRole.get(role).path));
    if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail(`${role} is not a Windows PE executable`);
    if (
      role === "portable"
      && (
        bytes.indexOf(Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii")) < 0
        || bytes.indexOf(Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii")) >= 0
      )
    ) fail("portable executable does not have the Tauri UNK bundle identity");
  }
  const checksums = await readFile(path.join(projectRoot, byRole.get("checksums").path), "utf8");
  const expectedChecksums = ["installer", "portable"]
    .map((role) => `${byRole.get(role).sha256}  ${path.basename(byRole.get(role).path)}`)
    .join("\n") + "\n";
  if (checksums !== expectedChecksums) fail("SHA256SUMS.txt is not canonical or does not bind both executables");
}
