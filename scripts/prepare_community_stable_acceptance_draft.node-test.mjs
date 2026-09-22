import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCommunityStableAcceptanceDraft,
  validateOwnedAcceptanceOutputPath,
} from "./prepare_community_stable_acceptance_draft.mjs";
import {
  COMMUNITY_STABLE_PROMOTION_PATHS,
  validateCommunityStableAcceptance,
} from "./community_stable_acceptance_contract.mjs";

const hash = (letter) => letter.repeat(64);
const testedCommit = "a".repeat(40);
const authorizationRecordSha256 = createHash("sha256").update(
  readFileSync(new URL("../docs/release/COMMUNITY_STABLE_V2_WAIVER_DECISION.md", import.meta.url)),
).digest("hex").toUpperCase();

function fixture() {
  const installerBytes = Buffer.from("jiaojiao-installer");
  const installerSha256 = createHash("sha256").update(installerBytes).digest("hex").toUpperCase();
  return {
    authority: { schemaVersion: 1, productName: "饺饺提醒", identifier: "com.brucexia.jiaojiao.reminder", version: "1.5.7" },
    brand: { application: { displayName: "饺饺提醒", identifier: "com.brucexia.jiaojiao.reminder" } },
    testedCommit,
    installerBytes,
    endurance: {
      ready: false,
      smokePassed: true,
      bindings: {
        applicationSha256: hash("1"),
        fixtureSha256: hash("2"),
        scriptSha256: hash("3"),
      },
      request: { acceptanceGateRequested: true },
      acceptanceGate: { passed: false, failures: ["power_suspend_resume_pair_missing", "session_lock_unlock_pair_missing"] },
      clock: { wallClockObservedSeconds: 86405, activeSampleCoverageSeconds: 72000 },
      transitions: { powerSuspendResumeObserved: false, sessionLockUnlockObserved: false },
      process: { controlledExit: true },
      isolation: { applicationErrorCount: 0 },
      storage: { formalUserFilesWritten: 0 },
    },
    enduranceSha256: hash("A"),
    enduranceBinding: {
      schemaVersion: 1,
      buildVariant: "runtime-qa-learning",
      source: { commit: testedCommit, dirty: false },
      product: {
        name: "饺饺提醒",
        identifier: "com.brucexia.jiaojiao.reminder",
        version: "1.5.7",
      },
      artifacts: {
        application: { sha256: hash("1") },
        fixture: { sha256: hash("2") },
        measureScript: { sha256: hash("3") },
      },
    },
    enduranceBindingSha256: hash("9"),
    installedStatus: {
      schemaVersion: 2,
      ready: true,
      source: { commit: testedCommit },
      candidateStage: { installerSha256 },
      functional: {
        installerSha256,
        scenarios: {
          installAndLaunch: true,
          snoozeThirtyMinutes: true,
          missedReminderNotify: true,
          missedReminderSkipOld: true,
          reminderDelivery: true,
          hideAndRestorePet: true,
          panelDrag: true,
          automaticBackup: true,
          backupAndRestore: true,
          restartPersistence: true,
          uninstallKeepsDataByDefault: true,
        },
        formalUserDataUsed: false,
        cleanup: { applicationExited: true, dataRootRemoved: true },
      },
    },
    installedStatusSha256: hash("B"),
    v132Status: { ready: true, source: { commit: testedCommit, v132PortableSha256: "D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD" } },
    v132StatusSha256: hash("C"),
    v132Capture: { status: "passed", fixtureLogicalSha256: hash("D"), sourceStableDuringCapture: true },
    v132Migration: {
      status: "passed",
      sourceLogicalSha256: hash("D"),
      migratedMatchedSourceRowsSha256: hash("D"),
      checks: [
        { id: "backup_restore", passed: true },
        { id: "failed_restore_rollback", passed: true },
      ],
    },
    v132MigrationSha256: hash("F"),
    v1527Report: {
      schemaVersion: 1, status: "passed", candidateCommit: testedCommit,
      candidateInstallerSha256: installerSha256,
      baselineInstallerSha256: "424E2D607E08CA274672DFF343D12393DE3CF9C4FBC7BA3789FC7A8ACFFF4C7E",
      baselineFileCount: 218, databaseMigration7to8Passed: true,
      oldRowsAndSettingsPreserved: true, petPackRecoveryPassed: true,
      rollbackBothDatabasesIntegrityPassed: true, rollbackVisibleStatePassed: true,
    },
    v1527ReportSha256: hash("8"),
    waiverAuthorizationSha256: authorizationRecordSha256,
    learningEnvelope: {
      status: "passed",
      sourceCommit: testedCommit,
      sourceBindingSha256: hash("9"),
    },
    learningEnvelopeSha256: hash("E"),
    learningRuntime: {
      status: "passed",
      tauriImportPassed: true,
      cancellationPassed: true,
      importedCards: 20000,
      paginationPassed: true,
      answersApplied: 1000,
      databaseGrowthWithinLimit: true,
      backupRestorePassed: true,
    },
  };
}

test("assembles four verified reports and one exact installer into a pending human draft", () => {
  const draft = buildCommunityStableAcceptanceDraft(fixture());
  assert.equal(draft.status, "pending");
  assert.equal(draft.review.operator, null);
  assert.equal(draft.candidate.testedCommit, testedCommit);
  assert.equal(draft.checks.endurance24h.reportSha256, hash("A"));
  assert.equal(draft.checks.endurance24h.sourceBindingSha256, hash("9"));
  assert.equal(draft.checks.installedCandidateE2e.reportSha256, hash("B"));
  assert.equal(draft.checks.legacyDataCompatibility.syntheticMigrationReportSha256, hash("F"));
  assert.equal(draft.checks.learningRuntime.reportSha256, hash("E"));
  assert.equal(draft.checks.learningRuntime.sourceBindingSha256, hash("9"));
  assert.equal(draft.checks.legacyDataCompatibility.officialBinarySha256, "D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD");
  assert.equal(draft.checks.learningRuntime.importedCards, 20000);
  const accepted = structuredClone(draft);
  accepted.status = "accepted";
  accepted.review.operator = "Brucexia";
  accepted.review.completedAt = "2026-08-29T06:00:00.000Z";
  accepted.review.permissionSha256 = hash("4");
  assert.equal(
    validateCommunityStableAcceptance(accepted, {
      authority: {
        ...fixture().authority,
        releaseTrain: "unified-product",
        channel: "stable",
      },
      expectedProduct: {
        name: "饺饺提醒",
        identifier: "com.brucexia.jiaojiao.reminder",
        installerBaseName: "饺饺提醒",
        portableBaseName: "饺饺提醒",
      },
      releaseCommit: "b".repeat(40),
      changedPaths: COMMUNITY_STABLE_PROMOTION_PATHS,
      now: new Date("2026-08-29T07:00:00.000Z"),
    }),
    accepted,
  );
});

test("rejects cross-commit, cross-installer, and incomplete evidence", () => {
  const commit = fixture();
  commit.learningEnvelope.sourceCommit = "b".repeat(40);
  assert.throws(() => buildCommunityStableAcceptanceDraft(commit), /learning evidence commit/u);

  const installer = fixture();
  installer.installedStatus.functional.installerSha256 = hash("F");
  assert.throws(() => buildCommunityStableAcceptanceDraft(installer), /different installer/u);

  const rollback = fixture();
  rollback.v132Migration.checks.find(({ id }) => id === "failed_restore_rollback").passed = false;
  assert.throws(() => buildCommunityStableAcceptanceDraft(rollback), /failure rollback/u);

  const endurance = fixture();
  endurance.enduranceBinding.buildVariant = "runtime-qa";
  assert.throws(() => buildCommunityStableAcceptanceDraft(endurance), /not learning-on/u);

  const learningBinding = fixture();
  learningBinding.learningEnvelope.sourceBindingSha256 = hash("8");
  assert.throws(() => buildCommunityStableAcceptanceDraft(learningBinding), /different source binding/u);

  const extraFailure = fixture();
  extraFailure.endurance.acceptanceGate.failures.push("database_growth_limit_exceeded");
  assert.throws(() => buildCommunityStableAcceptanceDraft(extraFailure), /two authorized event waivers/u);

  const oldInstaller = fixture();
  oldInstaller.v1527Report.baselineInstallerSha256 = hash("0");
  assert.throws(() => buildCommunityStableAcceptanceDraft(oldInstaller), /1\.5\.27 installer/u);
});

test("formal 24-hour acceptance is pinned to the integrated learning build", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    packageJson.scripts["runtime:baseline:acceptance"],
    /run_community_stable_runtime_baseline\.ps1/u,
  );
  assert.match(
    packageJson.scripts["release:community:runtime-baseline:verify"],
    /verify_community_stable_runtime_baseline_candidate\.mjs/u,
  );
  const assembler = readFileSync(
    new URL("./prepare_community_stable_acceptance_draft.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    assembler,
    /verify_community_stable_runtime_baseline_candidate\.mjs[\s\S]*?--tested-commit/u,
  );
  assert.match(assembler, /buildVariant: "runtime-qa-learning"/u);
  assert.match(
    assembler,
    /verify_community_stable_learning_runtime_evidence\.mjs[\s\S]*?--binding[\s\S]*?enduranceBindingPath/u,
  );
  assert.match(assembler, /verify_community_stable_v1527_evidence\.mjs/u);
  assert.doesNotMatch(assembler, /--allow-dirty/u);
  const controlledBuilder = readFileSync(
    new URL("./build_community_stable_runtime_baseline_candidate.ps1", import.meta.url),
    "utf8",
  );
  assert.match(
    controlledBuilder,
    /cargo build --locked --release --features "runtime-qa,learning,tauri\/custom-protocol"/u,
  );
  assert.match(
    controlledBuilder,
    /cargo clean -p yuanyuan-reminder --target-dir "target\/runtime-qa-learning"/u,
  );
  assert.ok(
    controlledBuilder.indexOf("status --porcelain=v1 --untracked-files=all") <
      controlledBuilder.indexOf("cargo clean -p yuanyuan-reminder"),
    "the clean-check must precede generated-output cleanup",
  );
  const controlledRunner = readFileSync(
    new URL("./run_community_stable_runtime_baseline.ps1", import.meta.url),
    "utf8",
  );
  const measureScript = readFileSync(
    new URL("./measure_runtime_baseline.ps1", import.meta.url),
    "utf8",
  );
  for (const requiredArgument of [
    "-BuildVariant learning-on",
    "-DurationSeconds 86400",
    "-SampleIntervalSeconds 60",
    "-WarmupSeconds 300",
    "-AcceptanceGate",
  ]) assert.match(controlledRunner, new RegExp(requiredArgument, "u"));
  assert.match(
    controlledRunner,
    /Assert-YuanyuanRuntimeQaExclusive/u,
  );
  const sourceBindingVerifyIndex = controlledRunner.indexOf(
    "verify_community_stable_runtime_source_binding.mjs",
  );
  const measureIndex = controlledRunner.indexOf('"measure_runtime_baseline.ps1"');
  const finalVerifyIndex = controlledRunner.indexOf(
    "verify_community_stable_runtime_baseline_candidate.mjs",
  );
  assert.ok(
    sourceBindingVerifyIndex >= 0 &&
      measureIndex > sourceBindingVerifyIndex &&
      finalVerifyIndex > measureIndex,
  );
  assert.match(controlledRunner, /\[Parameter\(Mandatory = \$true\)\][\s\S]*?\$SourceBindingPath/u);
  assert.match(controlledRunner, /Runtime baseline report written: /u);
  assert.match(controlledRunner, /reportMarkers\.Count -ne 1/u);
  assert.match(controlledRunner, /\[IO\.Path\]::IsPathRooted\(\$reportPath\)/u);
  assert.match(measureScript, /Runtime baseline report written: \$reportPath/u);
  assert.match(
    controlledBuilder,
    /runtime:baseline:acceptance -- -SourceBindingPath/u,
  );
  assert.match(
    packageJson.scripts["runtime:qa:learning:build"],
    /build_runtime_qa_learning_guarded\.ps1/u,
  );
  for (const guardedScript of [
    "build_community_stable_e2e_stage.ps1",
    "run_community_stable_sandbox_data_probe_host.ps1",
    "run_community_stable_v132_sandbox_probe_host.ps1",
    "measure_community_stable_learning_runtime.ps1",
    "build_community_stable_sandbox_helper_guarded.ps1",
    "build_community_stable_v132_sandbox_helpers_guarded.ps1",
    "build_runtime_qa_learning_guarded.ps1",
    "build_community_stable_runtime_baseline_candidate.ps1",
  ]) {
    assert.match(
      readFileSync(new URL(`./${guardedScript}`, import.meta.url), "utf8"),
      /Assert-YuanyuanRuntimeQaExclusive/u,
      `${guardedScript} must enforce runtime-QA exclusivity`,
    );
  }
});

test("acceptance draft output parent must resolve inside the owned customization tree", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "jiaojiao-acceptance-output-"));
  try {
    const ownedBase = path.join(temporaryRoot, "work", "customization");
    const runRoot = path.join(ownedBase, "run-1");
    const outsideRoot = path.join(temporaryRoot, "outside");
    await Promise.all([
      mkdir(runRoot, { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
    ]);
    assert.equal(
      await validateOwnedAcceptanceOutputPath(
        path.join(runRoot, "formal-draft-1"),
        ownedBase,
      ),
      await realpath(ownedBase),
    );
    await assert.rejects(
      validateOwnedAcceptanceOutputPath(
        path.join(outsideRoot, "formal-draft-1"),
        ownedBase,
      ),
      /outside work\/customization/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
