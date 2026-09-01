import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateFunctionalRegressionEvidence,
  validateBrandEvidence,
  validateIdentityLockEvidence,
  validatePackagingEvidence,
  validatePetAssetEvidence,
  validateVerificationEvidence,
  validateVisualQaEvidence,
} from "./pet-evidence.mjs";

const directions = [
  ["000", "up"], ["022.5", "up-right"], ["045", "up-right"], ["067.5", "up-right"],
  ["090", "right"], ["112.5", "down-right"], ["135", "down-right"], ["157.5", "down-right"],
  ["180", "down"], ["202.5", "down-left"], ["225", "down-left"], ["247.5", "down-left"],
  ["270", "left"], ["292.5", "up-left"], ["315", "up-left"], ["337.5", "up-left"],
];
const features = [
  "reminder_management", "snooze_levels", "missed_reminder_policy", "automatic_backup",
  "manual_backup", "basic_companion", "reunion_action", "task_watch", "learning_blackboard",
  "learning_invitation_preemption", "hide_restore_pet", "panel_drag", "interaction_bubble_clearance",
  "focus_calm", "water_before_activity",
];
const interactions = [
  "treat_direction_follow", "wand_eight_directions", "pet_head_zone_only",
  "ball_charge_flight_chase_bat_carry_drop", "learning_expression_rows",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function artifact(root, role, relativePath, contents) {
  const bytes = Buffer.from(contents);
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return { role, path: relativePath.replaceAll("\\", "/"), sha256: sha256(bytes), bytes: bytes.length };
}

test("brand and identity-lock evidence bind an independent identity and final reference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-identity-lock-"));
  try {
    const state = {
      request: {
        petDisplayName: "糖糖",
        petSex: "female",
        petBreed: "橘猫",
        petPersonality: "安静",
        petStylePreset: "soft-illustration",
        photoInputCount: 1,
      },
      steps: [{ id: "identity_lock", status: "pending" }],
    };
    const brand = {
      pet: { displayName: "糖糖", sex: "female", breed: "橘猫", personality: "安静" },
      application: { identifier: "com.example.tangtang" },
      storage: { directoryName: "com.example.tangtang" },
    };
    const brandArtifact = await artifact(root, "brand_config", "product-brand.json", `${JSON.stringify(brand)}\n`);
    await assert.doesNotReject(() => validateBrandEvidence([brandArtifact], root, state));
    brand.pet.sex = "male";
    const wrongRequestSex = await artifact(root, "brand_config", "product-brand.json", `${JSON.stringify(brand)}\n`);
    await assert.rejects(() => validateBrandEvidence([wrongRequestSex], root, state), /CUSTOMIZATION_EVIDENCE_INVALID/u);
    brand.pet.sex = "female";
    brand.pet.breed = "英短";
    const wrongRequestBreed = await artifact(root, "brand_config", "product-brand.json", `${JSON.stringify(brand)}\n`);
    await assert.rejects(() => validateBrandEvidence([wrongRequestBreed], root, state), /CUSTOMIZATION_EVIDENCE_INVALID/u);
    brand.pet.breed = "橘猫";
    brand.application.identifier = "com.yuanyuan.reminder";
    brand.storage.directoryName = "com.yuanyuan.reminder";
    const officialBrand = await artifact(root, "brand_config", "work/official-brand.json", `${JSON.stringify(brand)}\n`);
    await assert.rejects(() => validateBrandEvidence([officialBrand], root, state), /CUSTOMIZATION_EVIDENCE_INVALID/u);

    const reference = await artifact(root, "identity_reference", "work/reference.png", "synthetic reference image");
    const lock = {
      schemaVersion: 1,
      profile: "yuanyuan-custom-pet-identity-lock",
      petDisplayName: "糖糖",
      sex: "female",
      stylePreset: "soft-illustration",
      createdAt: "2026-08-28T12:00:00Z",
      sourcePhotoCount: 1,
      sourcePhotoSha256: ["d".repeat(64)],
      referenceImage: { path: reference.path, sha256: reference.sha256, bytes: reference.bytes },
      visualIdentity: {
        speciesAndAge: "adult cat", coatAndGradient: "warm ginger", faceShape: "round face",
        eyes: "green eyes", noseMuzzleAndEars: "pink nose and upright ears",
        bodyAndProportions: "compact body", markings: "white chest",
        signatureTraits: "tail tip", motionPersonality: "calm movement",
      },
      mustPreserve: ["green eyes", "white chest"],
      mustAvoid: ["no collar", "no background"],
    };
    const lockArtifact = await artifact(root, "identity_lock", "work/identity-lock.json", `${JSON.stringify(lock)}\n`);
    await assert.doesNotReject(() => validateIdentityLockEvidence([lockArtifact, reference], root, state));
    lock.sex = "male";
    const wrongSex = await artifact(root, "identity_lock", "work/wrong-sex-lock.json", `${JSON.stringify(lock)}\n`);
    await assert.rejects(() => validateIdentityLockEvidence([wrongSex, reference], root, state), /CUSTOMIZATION_EVIDENCE_INVALID/u);
    lock.sex = "female";
    lock.referenceImage.sha256 = "e".repeat(64);
    const drifted = await artifact(root, "identity_lock", "work/drifted-lock.json", `${JSON.stringify(lock)}\n`);
    await assert.rejects(() => validateIdentityLockEvidence([drifted, reference], root, state), /CUSTOMIZATION_EVIDENCE_INVALID/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("functional evidence rejects pending templates and accepts the exact regression matrix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-pet-functional-"));
  try {
    const state = { source: { resolvedCommit: "a".repeat(40) } };
    const snapshot = {
      sha256: "c".repeat(64),
      diffBytes: 42,
      untrackedFiles: [{ path: "new.txt", bytes: 3 }],
    };
    const sourceSnapshotFn = async () => snapshot;
    await writeFile(path.join(root, "product-version.json"), JSON.stringify({ version: "1.5.6" }));
    const template = await readFile(path.resolve(import.meta.dirname, "../../customization/pet/functional-regression.template.json"));
    const templateDocument = JSON.parse(template.toString("utf8"));
    assert.deepEqual(templateDocument.windowsScaling.map((entry) => entry.percent), [100, 125, 150, 200]);
    let evidence = await artifact(root, "functional_regression_report", "work/functional.json", template);
    await assert.rejects(
      () => validateFunctionalRegressionEvidence([evidence], root, state, { sourceSnapshotFn }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );
    const passing = {
      schemaVersion: 1,
      profile: "yuanyuan-custom-pet-functional-regression",
      sourceCommit: "a".repeat(40),
      sourceSnapshotSha256: snapshot.sha256,
      sourceDiffBytes: snapshot.diffBytes,
      untrackedSourceFiles: snapshot.untrackedFiles,
      productVersion: "1.5.6",
      testedAt: "2026-08-28T12:00:00Z",
      testedBy: "Human reviewer",
      windowsScaling: [100, 125, 150, 200].map((percent) => ({ percent, result: "pass", notes: "checked" })),
      displayTopologies: ["single_monitor", "multi_monitor"].map((topology) => ({ topology, result: "pass", notes: "checked" })),
      features: features.map((id) => ({ id, result: "pass", notes: "checked" })),
      interactions: interactions.map((id) => ({ id, result: "pass", notes: "checked" })),
    };
    evidence = await artifact(root, "functional_regression_report", "work/passing-functional.json", `${JSON.stringify(passing)}\n`);
    await assert.doesNotReject(
      () => validateFunctionalRegressionEvidence([evidence], root, state, { sourceSnapshotFn }),
    );
    passing.privatePhotoPath = "must-not-be-recorded";
    evidence = await artifact(root, "functional_regression_report", "work/unknown-field-functional.json", `${JSON.stringify(passing)}\n`);
    await assert.rejects(
      () => validateFunctionalRegressionEvidence([evidence], root, state, { sourceSnapshotFn }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );
    delete passing.privatePhotoPath;
    passing.sourceCommit = "b".repeat(40);
    evidence = await artifact(root, "functional_regression_report", "work/wrong-commit-functional.json", `${JSON.stringify(passing)}\n`);
    await assert.rejects(
      () => validateFunctionalRegressionEvidence([evidence], root, state, { sourceSnapshotFn }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );
    passing.sourceCommit = state.source.resolvedCommit;
    passing.sourceSnapshotSha256 = "d".repeat(64);
    evidence = await artifact(root, "functional_regression_report", "work/stale-snapshot-functional.json", `${JSON.stringify(passing)}\n`);
    await assert.rejects(
      () => validateFunctionalRegressionEvidence([evidence], root, state, { sourceSnapshotFn }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visual evidence binds strict structural QA, every preview, 16 directions, and 39 reviewed rows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-pet-visual-"));
  try {
    const petDirectory = "public/assets/pet";
    const iconDirectory = "src-tauri/icons";
    const licenseFile = "CUSTOM_ASSETS_LICENSE.md";
    await writeFile(path.join(root, "product-brand.json"), JSON.stringify({
      pet: { displayName: "Synthetic Pet", sex: "female", breed: "Synthetic Breed", personality: "Calm" },
      application: { displayName: "Synthetic Reminder", packageName: "synthetic-reminder" },
      assets: { petDirectory, iconDirectory, licenseFile },
    }));
    await mkdir(path.join(root, "customization/pet"), { recursive: true });
    const baselinePaths = [
      `${petDirectory}/spritesheet.webp`, `${petDirectory}/sleep-atlas.webp`,
      `${petDirectory}/life-atlas.webp`, `${petDirectory}/learning-atlas.webp`,
      `${petDirectory}/fallback.png`, `${iconDirectory}/32x32.png`,
      `${iconDirectory}/128x128.png`, `${iconDirectory}/128x128@2x.png`,
      `${iconDirectory}/icon.ico`, "ASSETS_LICENSE.md",
    ];
    await writeFile(path.join(root, "customization/pet/official-asset-hashes.json"), JSON.stringify({
      schemaVersion: 1,
      profile: "yuanyuan-official-pet-assets-v2",
      assets: Object.fromEntries(baselinePaths.map((entry, index) => [entry, `${index}`.padStart(64, "a")])),
    }));
    const assetSpecs = [
      ["standard_atlas", `${petDirectory}/spritesheet.webp`],
      ["sleep_atlas", `${petDirectory}/sleep-atlas.webp`],
      ["life_atlas", `${petDirectory}/life-atlas.webp`],
      ["learning_atlas", `${petDirectory}/learning-atlas.webp`],
      ["fallback_image", `${petDirectory}/fallback.png`],
    ];
    const recordedAssets = [];
    for (const [role, relativePath] of assetSpecs) recordedAssets.push(await artifact(root, role, relativePath, `custom-${role}`));
    recordedAssets.push(await artifact(root, "pet_manifest", `${petDirectory}/pet-manifest.json`, JSON.stringify({
      id: "synthetic-reminder",
      displayName: "Synthetic Pet",
      sex: "female",
      breed: "Synthetic Breed",
      personality: "Calm",
      spriteVersionNumber: 2,
      assetLicense: licenseFile,
      animations: { idle: {} },
    })));
    const icons = [];
    for (const name of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.ico"]) {
      const icon = await artifact(root, name === "icon.ico" ? "windows_icon" : `unused_${name}`, `${iconDirectory}/${name}`, `custom-${name}`);
      icons.push({ path: icon.path, sha256: icon.sha256, bytes: icon.bytes });
      if (name === "icon.ico") recordedAssets.push(icon);
    }
    const assetLicense = await artifact(root, "asset_license", licenseFile, "Synthetic Reminder\nspritesheet.webp sleep-atlas.webp life-atlas.webp learning-atlas.webp fallback.png icon.ico\n");
    recordedAssets.push(assetLicense);
    await assert.doesNotReject(() => validatePetAssetEvidence(recordedAssets, root));
    const contact = await artifact(root, "contact_sheet", "work/contact.png", "contact");
    const direction = await artifact(root, "direction_sheet", "work/directions.png", "directions");
    const previews = [];
    for (let index = 0; index < 39; index += 1) {
      const bytes = Buffer.from(`preview-${index}`);
      const relativePath = `work/previews/${index}.gif`;
      await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await writeFile(path.join(root, relativePath), bytes);
      previews.push({ sheet: "synthetic", row: index, name: `row-${index}`, path: relativePath, sha256: sha256(bytes), bytes: bytes.length });
    }
    const preview = await artifact(root, "animation_preview", "work/previews-index.json", `${JSON.stringify({ schemaVersion: 1, previews })}\n`);
    const report = {
      schemaVersion: 1,
      profile: "yuanyuan-custom-pet-pack-qa",
      spriteVersionNumber: 2,
      completeRowsRequired: true,
      structural: { ok: true, frameCount: 312, failedFrameCount: 0 },
      customAssetReplacement: {
        required: true,
        ok: true,
        baselineProfile: "yuanyuan-official-pet-assets-v2",
        changedPaths: [
          ...assetSpecs.map(([, relativePath]) => relativePath),
          ...icons.map((entry) => entry.path),
          licenseFile,
        ],
        unchangedPaths: [],
      },
      bindings: {
        manifest: recordedAssets.find((entry) => entry.role === "pet_manifest"),
        atlases: ["standard", "sleep", "life", "learning"].map((sheet, index) => ({
          sheet,
          ...recordedAssets[index],
        })),
        fallback: recordedAssets.find((entry) => entry.role === "fallback_image"),
        icons,
        assetLicense,
      },
      artifacts: {
        contactSheet: { path: contact.path, sha256: contact.sha256 },
        directionSheet: { path: direction.path, sha256: direction.sha256 },
        previewIndex: { path: preview.path, sha256: preview.sha256, count: 39 },
      },
    };
    const reportArtifact = await artifact(root, "qa_report", "work/report.json", `${JSON.stringify(report)}\n`);
    const review = {
      schemaVersion: 1,
      reviewedAt: null,
      reviewedBy: null,
      visualQa: "pending",
      contactSheet: contact.path,
      directionSheet: direction.path,
      directions: directions.map(([degree, expected]) => ({ degree, expected, verdict: "pending", observed: "", reason: "" })),
      rowReview: Array.from({ length: 39 }, (_, row) => ({ sheet: "synthetic", row, name: `row-${row}`, verdict: "pending", reason: "" })),
    };
    let semantics = await artifact(root, "direction_semantics", "work/review-pending.json", `${JSON.stringify(review)}\n`);
    const evidence = [contact, direction, preview, reportArtifact, semantics];
    const state = { artifacts: recordedAssets };
    await assert.rejects(() => validateVisualQaEvidence(evidence, root, state), /CUSTOMIZATION_EVIDENCE_INVALID/u);
    review.reviewedAt = "2026-08-28T12:00:00Z";
    review.reviewedBy = "Independent reviewer";
    review.visualQa = "pass";
    review.directions.forEach((entry) => Object.assign(entry, { verdict: "pass", observed: entry.expected, reason: "visible landmarks" }));
    review.rowReview.forEach((entry) => Object.assign(entry, { verdict: "pass", reason: "motion preview checked" }));
    semantics = await artifact(root, "direction_semantics", "work/review-pass.json", `${JSON.stringify(review)}\n`);
    await assert.doesNotReject(() => validateVisualQaEvidence([contact, direction, preview, reportArtifact, semantics], root, state));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification and packaging evidence stay bound to one exact source snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-delivery-evidence-"));
  try {
    const version = { version: "1.5.6" };
    const brand = {
      application: { identifier: "com.synthetic.reminder" },
      artifacts: { installerBaseName: "Synthetic", portableBaseName: "Synthetic" },
    };
    await writeFile(path.join(root, "product-version.json"), JSON.stringify(version));
    const brandBytes = Buffer.from(JSON.stringify(brand));
    await writeFile(path.join(root, "product-brand.json"), brandBytes);
    const snapshot = { sha256: "b".repeat(64), diffBytes: 42, untrackedFiles: [{ path: "new.txt", bytes: 3 }] };
    const sourceSnapshotFn = async () => snapshot;
    const functional = {
      sourceCommit: "a".repeat(40),
      sourceSnapshotSha256: snapshot.sha256,
      sourceDiffBytes: snapshot.diffBytes,
      untrackedSourceFiles: snapshot.untrackedFiles,
    };
    const functionalArtifact = await artifact(
      root,
      "functional_regression_report",
      "work/functional-report.json",
      `${JSON.stringify(functional)}\n`,
    );
    const state = {
      runId: "20260828T120000000Z-1234abcd",
      source: { resolvedCommit: "a".repeat(40) },
      artifacts: [functionalArtifact],
    };
    const verification = {
      schemaVersion: 1,
      profile: "yuanyuan-customization-verification",
      runId: state.runId,
      baselineCommit: state.source.resolvedCommit,
      sourceSnapshotSha256: snapshot.sha256,
      sourceDiffBytes: snapshot.diffBytes,
      untrackedSourceFiles: snapshot.untrackedFiles,
      productVersion: version.version,
      brandIdentifier: brand.application.identifier,
      brandSha256: sha256(brandBytes),
      startedAt: "2026-08-28T12:00:00Z",
      completedAt: "2026-08-28T12:01:00Z",
      results: ["npm.cmd run verify", "cargo test --locked", "npm.cmd run tauri build"].map((command) => ({
        command, exitCode: 0, durationMs: 1, outputSha256: "c".repeat(64),
      })),
      passed: true,
    };
    const verificationArtifact = await artifact(root, "verification_report", "work/verification-report.json", `${JSON.stringify(verification)}\n`);
    await assert.doesNotReject(() => validateVerificationEvidence(
      [verificationArtifact], root, state, { sourceSnapshotFn },
    ));
    const staleFunctional = await artifact(
      root,
      "functional_regression_report",
      "work/stale-functional-report.json",
      `${JSON.stringify({ ...functional, sourceSnapshotSha256: "d".repeat(64) })}\n`,
    );
    state.artifacts[0] = staleFunctional;
    await assert.rejects(
      () => validateVerificationEvidence([verificationArtifact], root, state, { sourceSnapshotFn }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );
    state.artifacts[0] = functionalArtifact;
    verification.results[2].command = "npm.cmd run tauri dev";
    const tamperedVerification = await artifact(root, "verification_report", "work/tampered-verification.json", `${JSON.stringify(verification)}\n`);
    await assert.rejects(
      () => validateVerificationEvidence([tamperedVerification], root, state, { sourceSnapshotFn }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );

    state.artifacts.push(verificationArtifact);
    const installer = await artifact(root, "installer", `work/Synthetic_${version.version}_x64-setup.exe`, Buffer.from([0x4d, 0x5a, 1]));
    const portable = await artifact(
      root,
      "portable",
      `work/Synthetic_${version.version}_windows-x64-portable.exe`,
      Buffer.concat([Buffer.from([0x4d, 0x5a, 2]), Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii")]),
    );
    const checksumText = `${installer.sha256}  ${path.basename(installer.path)}\n${portable.sha256}  ${path.basename(portable.path)}\n`;
    const checksums = await artifact(root, "checksums", "work/SHA256SUMS.txt", checksumText);
    const manifest = {
      schemaVersion: 1,
      profile: "yuanyuan-customization-delivery",
      generatedAt: "2026-08-28T12:02:00Z",
      runId: state.runId,
      baselineCommit: state.source.resolvedCommit,
      sourceSnapshotSha256: snapshot.sha256,
      productVersion: version.version,
      brandIdentifier: brand.application.identifier,
      artifacts: { installer, portable, checksums },
    };
    const deliveryManifest = await artifact(root, "delivery_manifest", "work/delivery-manifest.json", `${JSON.stringify(manifest)}\n`);
    const deliveryArtifacts = [installer, portable, checksums, deliveryManifest];
    await assert.doesNotReject(() => validatePackagingEvidence(
      deliveryArtifacts, root, state, { sourceSnapshotFn },
    ));
    await writeFile(
      path.join(root, verificationArtifact.path),
      `${JSON.stringify({ ...verification, passed: false })}\n`,
    );
    await assert.rejects(
      () => validatePackagingEvidence(deliveryArtifacts, root, state, { sourceSnapshotFn }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );
    await writeFile(path.join(root, verificationArtifact.path), `${JSON.stringify(verification)}\n`);
    await assert.rejects(
      () => validatePackagingEvidence(deliveryArtifacts, root, state, { sourceSnapshotFn: async () => ({ ...snapshot, sha256: "d".repeat(64) }) }),
      /CUSTOMIZATION_EVIDENCE_INVALID/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
