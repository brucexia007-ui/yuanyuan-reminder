import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  parseTaskExpressionMotionEvidence,
  validateTaskExpressionMotionEvidence,
} from "./verify_task_expression_motion_evidence.mjs";

const evidenceDirectory = path.resolve("C:\\evidence");
const bindings = {
  applicationSha256: "A".repeat(64),
  backdropScriptSha256: "B".repeat(64),
  captureScriptSha256: "C".repeat(64),
  fixtureSha256: "D".repeat(64),
  measureScriptSha256: "E".repeat(64),
};
const scenarios = [
  ["failed-only", "圆圆发现任务没有成功，正在你身边陪着", "failure_action_settles_with_failure_card"],
  ["waiting-user-only", "圆圆发现任务正在等待你的确认", "glass_paws_action_settles_with_bell_and_waiting_card"],
  ["stalled-only", "圆圆发现任务可能停住了", "review_action_settles_with_stalled_card"],
];

function validBundle() {
  const reportsByName = {};
  const artifactHashes = {};
  const reviews = scenarios.map(([scenario, accessibleFragment, semanticReview], index) => {
    const stamp = `20260808T16500${index}Z`;
    const report = `task-expression-motion-${stamp}-${scenario}.json`;
    const reportHash = String(index + 1).repeat(64);
    const modes = [
      ["always", 12, "expected_action_and_settle_sequence"],
      ["off", 1, "stable_semantic_equivalent_pose"],
    ];
    const samples = [];
    const motionReviews = {};
    for (const [mode, distinctFrameCount, visualReview] of modes) {
      const stem = report.slice(0, -5);
      const contactSheet = `${stem}-${mode}/installed-contact-sheet.png`;
      const animationGif = `${stem}-${mode}/installed-animation.gif`;
      const contactSheetSha256 = (mode === "always" ? "F" : "1").repeat(64);
      const animationGifSha256 = (mode === "always" ? "2" : "3").repeat(64);
      artifactHashes[contactSheet] = contactSheetSha256;
      artifactHashes[animationGif] = animationGifSha256;
      motionReviews[mode] = {
        animationGif,
        animationGifSha256,
        contactSheet,
        contactSheetSha256,
        distinctFrameCount,
        visualReview,
      };
      samples.push({
        animationMode: mode,
        scenario,
        runtimeStageReady: true,
        accessibleStateObserved: true,
        captureStartedAtUtc: "2026-08-08T16:50:00.000Z",
        sampleCount: 24,
        distinctFrameCount,
        prelaunchBackdropUsed: true,
        backdropControlledExit: true,
        controlledExit: true,
        exitCode: 0,
        qaRootRemoved: true,
        contactSheet: path.resolve(evidenceDirectory, contactSheet),
        animationGif: path.resolve(evidenceDirectory, animationGif),
        failure: null,
      });
    }
    artifactHashes[report] = reportHash;
    reportsByName[report] = {
      schemaVersion: 6,
      generatedAt: "2026-08-08T16:50:00.000Z",
      candidate: path.resolve(
        import.meta.dirname,
        "..",
        "src-tauri",
        "target",
        "runtime-qa",
        "release",
        "yuanyuan-reminder.exe",
      ),
      candidateSha256: bindings.applicationSha256,
      scenario,
      startupTimeoutSeconds: 30,
      accessibleFragment,
      samples,
      passed: true,
    };
    return {
      scenario,
      report,
      reportSha256: reportHash,
      accessibleFragment,
      semanticReview,
      privacyReview: "neutral_backdrop_only",
      fullMotion: motionReviews.always,
      reducedMotion: motionReviews.off,
    };
  });
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-08-08T16:51:00.000Z",
      reviewedAt: "2026-08-08T16:52:00.000Z",
      reviewer: "Codex visual inspection",
      bindings: { ...bindings },
      scenarios: reviews,
      limitations: [
        "Motion semantics and privacy were reviewed from hash-bound contact sheets; they are not inferred by image classification.",
        "Capture covers one Windows desktop and its active DPI configuration.",
        "This does not replace multi-DPI, Narrator, sleep-resume, lock-screen, or signed production-candidate evidence.",
      ],
      passed: true,
    },
    reportsByName,
    artifactHashes,
  };
}

function validate(bundle) {
  return validateTaskExpressionMotionEvidence(bundle.manifest, {
    reportsByName: bundle.reportsByName,
    artifactHashes: bundle.artifactHashes,
    expectedBindings: bindings,
    evidenceDirectory,
  });
}

test("accepts three hash-bound privacy-reviewed motion scenarios", () => {
  assert.equal(validate(validBundle()), true);
});

test("parses UTF-8 review manifests with or without a Windows BOM", () => {
  const manifest = validBundle().manifest;
  const json = JSON.stringify(manifest);
  assert.deepEqual(parseTaskExpressionMotionEvidence(Buffer.from(json)), manifest);
  assert.deepEqual(
    parseTaskExpressionMotionEvidence(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
    ),
    manifest,
  );
});

test("rejects stale visual hashes, script bindings, and optimistic privacy review", () => {
  const staleVisual = validBundle();
  staleVisual.manifest.scenarios[0].fullMotion.contactSheetSha256 = "9".repeat(64);
  assert.equal(validate(staleVisual), false);

  const staleScript = validBundle();
  staleScript.manifest.bindings.backdropScriptSha256 = "9".repeat(64);
  assert.equal(validate(staleScript), false);

  const privacy = validBundle();
  privacy.manifest.scenarios[1].privacyReview = "not_reviewed";
  assert.equal(validate(privacy), false);
});

test("rejects missing semantics, moving reduced motion, and unknown fields", () => {
  const semantics = validBundle();
  semantics.manifest.scenarios[2].semanticReview = "generic_motion";
  assert.equal(validate(semantics), false);

  const movingReduced = validBundle();
  const review = movingReduced.manifest.scenarios[0];
  review.reducedMotion.distinctFrameCount = 3;
  movingReduced.reportsByName[review.report].samples[1].distinctFrameCount = 3;
  assert.equal(validate(movingReduced), false);

  const unknown = validBundle();
  unknown.manifest.desktopPath = "must-not-exist";
  assert.equal(validate(unknown), false);
});
