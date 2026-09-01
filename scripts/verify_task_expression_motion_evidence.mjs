import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { brandPetText } from "./product_brand_contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeReleaseRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa",
  "release",
);
const evidenceRoot = path.join(runtimeReleaseRoot, "evidence");
const applicationPath = path.join(runtimeReleaseRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeReleaseRoot, "yuanyuan-task-watch-fixture.exe");
const measureScriptPath = path.join(projectRoot, "scripts", "measure_task_failure_motion.ps1");
const captureScriptPath = path.join(projectRoot, "scripts", "capture_installed_pet.py");
const backdropScriptPath = path.join(projectRoot, "scripts", "run_neutral_capture_backdrop.py");

const EXPECTED_MANIFEST_KEYS = [
  "bindings",
  "generatedAt",
  "limitations",
  "passed",
  "reviewedAt",
  "reviewer",
  "scenarios",
  "schemaVersion",
];
const EXPECTED_BINDING_KEYS = [
  "applicationSha256",
  "backdropScriptSha256",
  "captureScriptSha256",
  "fixtureSha256",
  "measureScriptSha256",
];
const EXPECTED_SCENARIO_KEYS = [
  "accessibleFragment",
  "fullMotion",
  "privacyReview",
  "reducedMotion",
  "report",
  "reportSha256",
  "scenario",
  "semanticReview",
];
const EXPECTED_REVIEW_KEYS = [
  "animationGif",
  "animationGifSha256",
  "contactSheet",
  "contactSheetSha256",
  "distinctFrameCount",
  "visualReview",
];
const EXPECTED_REPORT_KEYS = [
  "accessibleFragment",
  "candidate",
  "candidateSha256",
  "generatedAt",
  "passed",
  "samples",
  "scenario",
  "schemaVersion",
  "startupTimeoutSeconds",
];
const EXPECTED_SAMPLE_KEYS = [
  "accessibleStateObserved",
  "animationGif",
  "animationMode",
  "backdropControlledExit",
  "captureStartedAtUtc",
  "contactSheet",
  "controlledExit",
  "distinctFrameCount",
  "exitCode",
  "failure",
  "prelaunchBackdropUsed",
  "qaRootRemoved",
  "runtimeStageReady",
  "sampleCount",
  "scenario",
];
const EXPECTED_LIMITATIONS = [
  "Motion semantics and privacy were reviewed from hash-bound contact sheets; they are not inferred by image classification.",
  "Capture covers one Windows desktop and its active DPI configuration.",
  "This does not replace multi-DPI, Narrator, sleep-resume, lock-screen, or signed production-candidate evidence.",
];
const SCENARIOS = {
  "failed-only": {
    accessibleFragment: brandPetText("圆圆发现任务没有成功，正在你身边陪着"),
    semanticReview: "failure_action_settles_with_failure_card",
  },
  "waiting-user-only": {
    accessibleFragment: brandPetText("圆圆发现任务正在等待你的确认"),
    semanticReview: "glass_paws_action_settles_with_bell_and_waiting_card",
  },
  "stalled-only": {
    accessibleFragment: brandPetText("圆圆发现任务可能停住了"),
    semanticReview: "review_action_settles_with_stalled_card",
  },
};
const SCENARIO_NAMES = Object.keys(SCENARIOS);
const SHA256 = /^[0-9A-F]{64}$/;

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function expectedArtifactNames(reportName, mode) {
  const stem = reportName.slice(0, -".json".length);
  return {
    contactSheet: `${stem}-${mode}/installed-contact-sheet.png`,
    animationGif: `${stem}-${mode}/installed-animation.gif`,
  };
}

function reportArtifactPathMatches(value, evidenceDirectory, expectedRelative) {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    path.resolve(value) === path.resolve(evidenceDirectory, expectedRelative)
  );
}

export function parseTaskExpressionMotionEvidence(bytes) {
  const text = Buffer.isBuffer(bytes)
    ? bytes.toString("utf8")
    : Buffer.from(bytes).toString("utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export function validateTaskExpressionMotionEvidence(
  manifest,
  { reportsByName, artifactHashes, expectedBindings, evidenceDirectory },
) {
  if (!hasExactKeys(manifest, EXPECTED_MANIFEST_KEYS)) return false;
  if (!hasExactKeys(manifest.bindings, EXPECTED_BINDING_KEYS)) return false;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.passed !== true ||
    !validTime(manifest.generatedAt) ||
    !validTime(manifest.reviewedAt) ||
    Date.parse(manifest.reviewedAt) < Date.parse(manifest.generatedAt) ||
    typeof manifest.reviewer !== "string" ||
    manifest.reviewer.length < 3 ||
    manifest.reviewer.length > 80 ||
    JSON.stringify(manifest.limitations) !== JSON.stringify(EXPECTED_LIMITATIONS) ||
    JSON.stringify(manifest.bindings) !== JSON.stringify(expectedBindings) ||
    !Array.isArray(manifest.scenarios) ||
    manifest.scenarios.length !== SCENARIO_NAMES.length
  ) {
    return false;
  }

  for (const [index, scenarioReview] of manifest.scenarios.entries()) {
    const scenario = SCENARIO_NAMES[index];
    const contract = SCENARIOS[scenario];
    if (
      !hasExactKeys(scenarioReview, EXPECTED_SCENARIO_KEYS) ||
      !hasExactKeys(scenarioReview.fullMotion, EXPECTED_REVIEW_KEYS) ||
      !hasExactKeys(scenarioReview.reducedMotion, EXPECTED_REVIEW_KEYS) ||
      scenarioReview.scenario !== scenario ||
      scenarioReview.accessibleFragment !== contract.accessibleFragment ||
      scenarioReview.semanticReview !== contract.semanticReview ||
      scenarioReview.privacyReview !== "neutral_backdrop_only" ||
      scenarioReview.fullMotion.visualReview !== "expected_action_and_settle_sequence" ||
      scenarioReview.reducedMotion.visualReview !== "stable_semantic_equivalent_pose" ||
      !/^task-expression-motion-\d{8}T\d{6}Z-(failed-only|waiting-user-only|stalled-only)\.json$/.test(
        scenarioReview.report,
      ) ||
      !SHA256.test(scenarioReview.reportSha256) ||
      artifactHashes[scenarioReview.report] !== scenarioReview.reportSha256
    ) {
      return false;
    }

    const report = reportsByName[scenarioReview.report];
    if (
      !hasExactKeys(report, EXPECTED_REPORT_KEYS) ||
      report.schemaVersion !== 6 ||
      report.passed !== true ||
      !validTime(report.generatedAt) ||
      path.resolve(report.candidate) !== path.resolve(applicationPath) ||
      report.candidateSha256 !== expectedBindings.applicationSha256 ||
      report.scenario !== scenario ||
      report.startupTimeoutSeconds !== 30 ||
      report.accessibleFragment !== contract.accessibleFragment ||
      !Array.isArray(report.samples) ||
      report.samples.length !== 2
    ) {
      return false;
    }

    for (const [sampleIndex, sample] of report.samples.entries()) {
      const mode = sampleIndex === 0 ? "always" : "off";
      const review = mode === "always" ? scenarioReview.fullMotion : scenarioReview.reducedMotion;
      const expectedNames = expectedArtifactNames(scenarioReview.report, mode);
      if (
        !hasExactKeys(sample, EXPECTED_SAMPLE_KEYS) ||
        sample.animationMode !== mode ||
        sample.scenario !== scenario ||
        sample.runtimeStageReady !== true ||
        sample.accessibleStateObserved !== true ||
        !validTime(sample.captureStartedAtUtc) ||
        !Number.isSafeInteger(sample.sampleCount) ||
        sample.sampleCount < 20 ||
        !Number.isSafeInteger(sample.distinctFrameCount) ||
        sample.distinctFrameCount < 1 ||
        sample.prelaunchBackdropUsed !== true ||
        sample.backdropControlledExit !== true ||
        sample.controlledExit !== true ||
        sample.exitCode !== 0 ||
        sample.qaRootRemoved !== true ||
        sample.failure !== null ||
        sample.distinctFrameCount !== review.distinctFrameCount ||
        (mode === "always" && sample.distinctFrameCount < 4) ||
        (mode === "off" && sample.distinctFrameCount > 2) ||
        review.contactSheet !== expectedNames.contactSheet ||
        review.animationGif !== expectedNames.animationGif ||
        !reportArtifactPathMatches(sample.contactSheet, evidenceDirectory, review.contactSheet) ||
        !reportArtifactPathMatches(sample.animationGif, evidenceDirectory, review.animationGif) ||
        !SHA256.test(review.contactSheetSha256) ||
        !SHA256.test(review.animationGifSha256) ||
        artifactHashes[review.contactSheet] !== review.contactSheetSha256 ||
        artifactHashes[review.animationGif] !== review.animationGifSha256
      ) {
        return false;
      }
    }
  }
  return true;
}

async function readOwnedFile(relativeName, pattern) {
  if (
    typeof relativeName !== "string" ||
    !pattern.test(relativeName) ||
    path.isAbsolute(relativeName) ||
    path.resolve(evidenceRoot, relativeName) === path.resolve(evidenceRoot) ||
    !path.resolve(evidenceRoot, relativeName).startsWith(`${path.resolve(evidenceRoot)}${path.sep}`)
  ) {
    throw new Error("task expression motion evidence path is not owned");
  }
  const absolute = path.resolve(evidenceRoot, relativeName);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("task expression motion evidence must be an ordinary file");
  }
  return readFile(absolute);
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length !== 2 || arguments_[0] !== "--manifest") {
    throw new Error(
      "usage: node scripts/verify_task_expression_motion_evidence.mjs --manifest <absolute-json>",
    );
  }
  const manifestPath = arguments_[1];
  if (
    !path.isAbsolute(manifestPath) ||
    path.dirname(path.resolve(manifestPath)) !== path.resolve(evidenceRoot) ||
    !/^task-expression-motion-visual-review-\d{8}T\d{6}Z\.json$/.test(
      path.basename(manifestPath),
    )
  ) {
    throw new Error("task expression motion manifest must be in the owned evidence directory");
  }
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error("task expression motion manifest must be an ordinary file");
  }

  let manifest;
  try {
    manifest = parseTaskExpressionMotionEvidence(await readFile(manifestPath));
  } catch {
    throw new Error("task expression motion manifest is not valid JSON");
  }
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length !== 3) {
    throw new Error("task expression motion manifest does not contain three scenarios");
  }

  const reportsByName = {};
  const artifactHashes = {};
  for (const scenario of manifest.scenarios) {
    const reportBytes = await readOwnedFile(
      scenario.report,
      /^task-expression-motion-\d{8}T\d{6}Z-(failed-only|waiting-user-only|stalled-only)\.json$/,
    );
    artifactHashes[scenario.report] = sha256(reportBytes);
    try {
      reportsByName[scenario.report] = parseTaskExpressionMotionEvidence(reportBytes);
    } catch {
      throw new Error("task expression motion report is not valid JSON");
    }
    for (const review of [scenario.fullMotion, scenario.reducedMotion]) {
      for (const [nameKey, hashKey, pattern] of [
        ["contactSheet", "contactSheetSha256", /^task-expression-motion-.+\/(installed-contact-sheet\.png)$/],
        ["animationGif", "animationGifSha256", /^task-expression-motion-.+\/(installed-animation\.gif)$/],
      ]) {
        const bytes = await readOwnedFile(review[nameKey], pattern);
        artifactHashes[review[nameKey]] = sha256(bytes);
        if (artifactHashes[review[nameKey]] !== review[hashKey]) {
          throw new Error("task expression motion visual artifact hash is stale");
        }
      }
    }
  }

  const [application, fixture, measureScript, captureScript, backdropScript] = await Promise.all([
    readFile(applicationPath),
    readFile(fixturePath),
    readFile(measureScriptPath),
    readFile(captureScriptPath),
    readFile(backdropScriptPath),
  ]);
  const expectedBindings = {
    applicationSha256: sha256(application),
    backdropScriptSha256: sha256(backdropScript),
    captureScriptSha256: sha256(captureScript),
    fixtureSha256: sha256(fixture),
    measureScriptSha256: sha256(measureScript),
  };
  if (
    !validateTaskExpressionMotionEvidence(manifest, {
      reportsByName,
      artifactHashes,
      expectedBindings,
      evidenceDirectory: evidenceRoot,
    })
  ) {
    throw new Error("task expression motion evidence is pending, stale, or inconsistent");
  }
  console.log("Task expression motion evidence passed: 3/3 privacy-safe reviewed scenarios.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
