import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureFirstStartRecoveryDatabase } from "./capture_first_start_recovery_database.mjs";
import {
  FIRST_START_RECOVERY_LIMITATIONS,
  firstStartRecoveryEvidenceMatches,
} from "./verify_first_start_recovery_evidence.mjs";

const tables = [
  "activity_tracking_state",
  "companion_attention_budget",
  "companion_proactive_attention",
  "focus_sessions",
  "occurrences",
  "pet_interactions",
  "reminders",
  "settings",
  "task_watch_attention_deferrals",
  "water_log",
];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-first-start-verify-"));
  const sourcePath = path.join(root, "yuanyuan-reminder.sqlite3");
  const fixturePath = path.join(root, "release-first-start-recovery.sqlite3");
  const capturePath = path.join(root, "release-first-start-recovery-database.json");
  const database = new DatabaseSync(sourcePath);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=11;");
  for (const table of tables) database.exec(`CREATE TABLE ${table}(id TEXT)`);
  database.exec(
    "INSERT INTO settings VALUES ('settings'); INSERT INTO reminders VALUES ('water'), ('activity');",
  );
  database.close();
  await captureFirstStartRecoveryDatabase({
    sourcePath,
    fixturePath,
    reportPath: capturePath,
    attestation: "synthetic_fresh_first_start",
  });
  const fixtureBytes = await readFile(fixturePath);
  const captureBytes = await readFile(capturePath);
  return {
    fixturePath,
    fixtureBytes,
    captureBytes,
    captureReport: JSON.parse(captureBytes.toString("utf8")),
  };
}

function fileEvidence(name) {
  return { present: true, bytes: 4096, sha256: hash(Buffer.from(name)) };
}

function makeReport(fixture, manifest, captureReportSha256) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-10T00:00:00.000Z",
    mode: "release_first_start_database_recovery_probe",
    ready: true,
    failureCode: null,
    bindings: {
      probeScriptSha256: hash(Buffer.from("probe")),
      captureHelperSha256: hash(Buffer.from("capture")),
      manifestSha256: hash(Buffer.from("manifest")),
      candidateArtifactId: "nsis_installed_core",
      candidateBytes: manifest.artifacts[0].bytes,
      candidateSha256: manifest.artifacts[0].sha256,
      stagedCandidateSha256: manifest.artifacts[0].sha256,
      databaseCaptureReportSha256: captureReportSha256,
      databaseFixtureSha256: hash(fixture.fixtureBytes),
    },
    environment: {
      interactiveSession: true,
      freshTestAccountAcknowledged: true,
      profileRegistryQueryAvailable: true,
      tokenProfilePathMatchesEnvironment: true,
      localAppDataMatchesTokenProfile: true,
      preexistingDataRoot: false,
      preexistingApplicationProcessCount: 0,
      emptyFormalDataRootProvisionedByProbe: true,
    },
    interruption: {
      method: "windows_job_cpu_hard_cap_then_terminate_after_nonzero_wal",
      cpuHardCapPercent: 1,
      jobKillOnClose: true,
      walWatcherArmed: true,
      walChangeObserved: true,
      walNonzeroObserved: true,
      triggerMainDatabaseBytes: 4096,
      triggerWalBytes: 8272,
      ownedProcessCountBeforeTermination: 1,
      jobTerminationRequested: true,
      rootExitCode: 1,
      processCountAfterTermination: 0,
      mainDatabaseAfterTermination: fileEvidence("main"),
      walAfterTermination: fileEvidence("wal"),
      shmAfterTermination: { present: false, bytes: 0, sha256: null },
    },
    recovery: {
      sameCandidateRelaunched: true,
      visibleWindowObserved: true,
      ownedProcessCount: 3,
      aiChildProcessCount: 0,
      applicationErrorQueryAvailable: true,
      applicationErrorCount: 0,
      processCountAfterProbeStop: 0,
      databaseCapture: {
        reportFileName: "release-first-start-recovery-database.json",
        reportBytes: fixture.captureBytes.length,
        reportSha256: captureReportSha256,
        fixtureFileName: "release-first-start-recovery.sqlite3",
        fixtureBytes: fixture.fixtureBytes.length,
        fixtureSha256: hash(fixture.fixtureBytes),
        ready: true,
        attestation: "synthetic_fresh_first_start",
        sourceHealth: fixture.captureReport.source.healthBeforeCheckpoint,
        fixtureHealth: fixture.captureReport.fixture.health,
        fixtureSidecarCount: 0,
      },
    },
    cleanup: {
      formalDataRootRemoved: true,
      stageRootRemoved: true,
      evidenceTempRootRemoved: true,
      applicationProcessCount: 0,
    },
    limitations: FIRST_START_RECOVERY_LIMITATIONS,
  };
}

test("accepts exact first-start interruption, recovery, fixture, and cleanup evidence", async () => {
  const fixture = await makeFixture();
  const manifest = {
    artifacts: [{ id: "nsis_installed_core", bytes: 100, sha256: hash(Buffer.from("app")) }],
  };
  const captureReportSha256 = hash(fixture.captureBytes);
  const report = makeReport(fixture, manifest, captureReportSha256);
  assert.equal(
    await firstStartRecoveryEvidenceMatches({
      report,
      captureReport: fixture.captureReport,
      fixturePath: fixture.fixturePath,
      manifest,
      manifestSha256: hash(Buffer.from("manifest")),
      probeScriptSha256: hash(Buffer.from("probe")),
      captureHelperSha256: hash(Buffer.from("capture")),
      captureReportBytes: fixture.captureBytes.length,
      captureReportSha256,
    }),
    true,
  );
});

test("rejects altered interruption claims and a modified fixture", async () => {
  const fixture = await makeFixture();
  const manifest = {
    artifacts: [{ id: "nsis_installed_core", bytes: 100, sha256: hash(Buffer.from("app")) }],
  };
  const captureReportSha256 = hash(fixture.captureBytes);
  const report = makeReport(fixture, manifest, captureReportSha256);
  report.interruption.walNonzeroObserved = false;
  const args = {
    report,
    captureReport: fixture.captureReport,
    fixturePath: fixture.fixturePath,
    manifest,
    manifestSha256: hash(Buffer.from("manifest")),
    probeScriptSha256: hash(Buffer.from("probe")),
    captureHelperSha256: hash(Buffer.from("capture")),
    captureReportBytes: fixture.captureBytes.length,
    captureReportSha256,
  };
  assert.equal(await firstStartRecoveryEvidenceMatches(args), false);
  report.interruption.walNonzeroObserved = true;
  await writeFile(fixture.fixturePath, Buffer.concat([fixture.fixtureBytes, Buffer.from("tamper")]));
  assert.equal(await firstStartRecoveryEvidenceMatches(args), false);
});
