import assert from "node:assert/strict";
import test from "node:test";

import {
  syntheticRecoveryFixtureSha256,
  validateLearningCrashRecoveryReport,
} from "./verify_learning_crash_recovery_evidence.mjs";

const APP = "A".repeat(64);
const FIXTURE = "B".repeat(64);
const SCRIPT = "D".repeat(64);
const DATABASE = "E".repeat(64);
const ANSWERED_ITEM = "1".repeat(64);
const CURRENT_ITEM = "2".repeat(64);
const COMMITTED_LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The five cards are deterministic synthetic data and contain no personal learning material.",
  "The crash is an exact forced termination of the owned QA application process; Windows UI Automation validates the recovery and resume surfaces.",
  "Exactly one answer is committed before the crash; its attempt, review, event, item, and outcome remain single while the next unanswered question is restored.",
  "Each passing sample observes non-empty SQLite WAL and SHM files after forced termination, then proves a healthy restart, one-time recovery, controlled exit, and owned-root cleanup.",
  "This committed-answer scenario does not cover termination inside SQLite commit, physical disk exhaustion, or hardware I/O failure.",
  "This report does not replace strong-reminder preemption, multi-DPI, Narrator, reduced-motion, signed-candidate, or migration recovery evidence.",
];
const IN_FLIGHT_LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The five cards are deterministic synthetic data and contain no personal learning material.",
  "A runtime-QA-only answer gate is armed immediately before transaction.commit; SQLite's commit hook writes the entered stage after all answer SQL and blocks inside the commit callback until the owned process is terminated.",
  "Each passing sample proves that the in-flight selection leaves no answer attempt, review, schedule advancement, answer event, or completed count after restart, and the original question remains resumable.",
  "Each passing sample observes non-empty SQLite WAL and SHM files after forced termination, then proves a healthy restart, one-time crash recovery, controlled exit, and owned-root cleanup.",
  "This controlled callback window does not model every later durable-write or hardware power-loss point, physical disk exhaustion, corrupted journals, or hardware I/O failure.",
  "This report does not replace strong-reminder preemption, multi-DPI, Narrator, reduced-motion, signed-candidate, or migration recovery evidence.",
];
const bindings = {
  applicationSha256: APP,
  fixtureExecutableSha256: FIXTURE,
  scriptSha256: SCRIPT,
};

function state(status, revision, eventCount, crashCount, resumedCount, answerCount = 1) {
  return {
    sessionId: "session-1",
    status,
    stateRevision: revision,
    currentItemId: answerCount === 0 ? ANSWERED_ITEM : CURRENT_ITEM,
    headword: answerCount === 0 ? "qaa" : "qab",
    plannedCount: 3,
    completedCount: answerCount,
    pauseReason: status === "paused" ? "crash_recovery" : null,
    eventCount,
    crashRecoveredEventCount: crashCount,
    resumedEventCount: resumedCount,
    answerCommittedEventCount: answerCount,
    questionAttemptCount: answerCount,
    reviewLogCount: answerCount,
    lastAnsweredItemId: answerCount === 0 ? null : ANSWERED_ITEM,
    lastAnsweredHeadword: answerCount === 0 ? null : "qaa",
    lastAnswerOutcome: answerCount === 0 ? null : "correct",
    integrityCheck: "ok",
    foreignKeyViolationCount: 0,
  };
}

function journalState(withResidualJournal) {
  return {
    databaseExists: true,
    databaseBytes: 262144,
    databaseSha256: "3".repeat(64),
    walExists: withResidualJournal,
    walBytes: withResidualJournal ? 32992 : 0,
    walSha256: withResidualJournal ? "4".repeat(64) : null,
    shmExists: withResidualJournal,
    shmBytes: withResidualJournal ? 32768 : 0,
    shmSha256: withResidualJournal ? "5".repeat(64) : null,
  };
}

function makeReport(count = 5, gate = true, scenario = "committed") {
  const committed = scenario === "committed";
  const samples = Array.from({ length: count }, (_, index) => ({
    sample: index + 1,
    scenario,
    fixtureDatabaseSha256: DATABASE,
    fixtureDatabaseBytes: 262144 + index,
    firstPageReadyMilliseconds: 700 + index,
    initialBlackboardMilliseconds: 350 + index,
    answeredHeadword: "qaa",
    preAnswerState: state("active", 2, 2, 0, 0, 0),
    originalHeadword: committed ? "qab" : "qaa",
    preCrashState: committed
      ? state("active", 3, 3, 0, 0)
      : state("active", 2, 2, 0, 0, 0),
    commitHookArmed: !committed,
    commitHookEntered: !committed,
    commitHookEnteredMilliseconds: committed ? null : 25 + index,
    crashInjected: true,
    crashExitCode: -1,
    postCrashJournal: journalState(true),
    restartPageReadyMilliseconds: 720 + index,
    resumeAvailableMilliseconds: 760 + index,
    postRestartState: committed
      ? state("paused", 4, 4, 1, 0)
      : state("paused", 3, 3, 1, 0, 0),
    residualJournalRecovered: true,
    resumedBlackboardMilliseconds: 360 + index,
    resumedHeadword: committed ? "qab" : "qaa",
    postResumeState: committed
      ? state("active", 5, 5, 1, 1)
      : state("active", 4, 4, 1, 1, 0),
    sameSession: true,
    sameItem: true,
    sameHeadword: true,
    committedAnswerPreserved: committed,
    uncommittedAnswerAbsent: !committed,
    secondControlledExit: true,
    secondExitCode: 0,
    postControlledExitJournal: journalState(false),
    maxVisibleWindows: 2,
    maxAccessibleNodes: 50,
    observedAccessibleNames: [
      "学习页面",
      "圆圆桌面英语复习",
      "继续上一轮",
      "qaa",
      committed ? "qab" : "qaa",
    ],
    rootRemoved: true,
    passed: true,
    failure: null,
  }));
  const resume = samples.map((sample) => sample.resumeAvailableMilliseconds);
  const blackboard = samples.map((sample) => sample.resumedBlackboardMilliseconds);
  const commitHook = samples
    .map((sample) => sample.commitHookEnteredMilliseconds)
    .filter(Number.isFinite);
  const percentile = (values, fraction) => {
    if (values.length === 0) return null;
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
  };
  return {
    schemaVersion: 4,
    generatedAt: "2026-08-19T15:00:00.000Z",
    profile: committed ? "learning-crash-recovery" : "learning-in-flight-commit-recovery",
    source: {
      gitCommit: "a".repeat(40),
      gitDirty: true,
      gitStatusSha256: "F".repeat(64),
    },
    bindings: {
      applicationSha256: APP,
      fixtureExecutableSha256: FIXTURE,
      fixtureContentSha256: syntheticRecoveryFixtureSha256(),
      scriptSha256: SCRIPT,
    },
    device: {
      windowsProductName: "Windows",
      windowsDisplayVersion: "25H2",
      windowsBuild: "26200.1",
      processorArchitecture: "AMD64",
      logicalProcessors: 24,
      powerLineStatus: "Online",
      webView2RuntimeVersion: "151.0.0.0",
    },
    request: {
      sampleCount: count,
      firstExitAfterSeconds: 120,
      secondExitAfterSeconds: 30,
      committedAnswersBeforeCrash: committed ? 1 : 0,
      scenario,
      evidenceGateRequested: gate,
    },
    fixture: { cardCount: 5, contentKind: "deterministic-synthetic-english-csv" },
    summary: {
      passedSamples: count,
      resumeAvailableP50Milliseconds: percentile(resume, 0.5),
      resumeAvailableP95Milliseconds: percentile(resume, 0.95),
      resumedBlackboardP50Milliseconds: percentile(blackboard, 0.5),
      resumedBlackboardP95Milliseconds: percentile(blackboard, 0.95),
      samplesWithResidualWal: count,
      samplesWithResidualShm: count,
      samplesWithHealthyRestart: count,
      commitHookEnteredP50Milliseconds: percentile(commitHook, 0.5),
      commitHookEnteredP95Milliseconds: percentile(commitHook, 0.95),
      samplesWithUncommittedAnswerAbsent: committed ? 0 : count,
    },
    evidenceGate: {
      requested: gate,
      minimumSamples: 5,
      passed: gate ? true : null,
      failures: [],
    },
    ready: true,
    limitations: committed ? COMMITTED_LIMITATIONS : IN_FLIGHT_LIMITATIONS,
    samples,
  };
}

test("reconstructs the exact deterministic five-card fixture hash", () => {
  assert.equal(syntheticRecoveryFixtureSha256(), "7DD333242FE8D028BE697D3663BE3C8D937D8DBCFBD58C98E7FBD8F237877EE5");
});

test("accepts complete source-bound crash recovery evidence", () => {
  assert.deepEqual(validateLearningCrashRecoveryReport(makeReport(), bindings), []);
});

test("accepts an exact in-flight SQLite answer commit rollback matrix", () => {
  assert.deepEqual(
    validateLearningCrashRecoveryReport(makeReport(5, true, "in-flight-commit"), bindings),
    [],
  );
});

test("accepts a clean smoke without promoting it to a formal gate", () => {
  assert.deepEqual(validateLearningCrashRecoveryReport(makeReport(1, false), bindings), []);
});

test("rejects stale artifacts, incomplete devices, and fixture drift", () => {
  const report = makeReport();
  report.bindings.scriptSha256 = "9".repeat(64);
  report.bindings.fixtureContentSha256 = "8".repeat(64);
  report.device.webView2RuntimeVersion = "";
  const errors = validateLearningCrashRecoveryReport(report, bindings).join("\n");
  assert.match(errors, /stale|fixture|device/);
});

test("rejects recovery that changes the session, item, or visible question", () => {
  const report = makeReport();
  report.samples[0].postResumeState.sessionId = "session-2";
  report.samples[0].postResumeState.currentItemId = "3".repeat(64);
  report.samples[0].resumedHeadword = "qac";
  const errors = validateLearningCrashRecoveryReport(report, bindings).join("\n");
  assert.match(errors, /preserve one committed answer and the next unanswered question/);
});

test("rejects missing crash events, revision continuity, or duplicated answer proof", () => {
  const report = makeReport();
  report.samples[0].postRestartState.crashRecoveredEventCount = 0;
  report.samples[0].postResumeState.stateRevision = 8;
  report.samples[0].postResumeState.questionAttemptCount = 2;
  const errors = validateLearningCrashRecoveryReport(report, bindings).join("\n");
  assert.match(errors, /transition|exactly 1|preserve/);
});

test("rejects drift in the single committed answer identity or outcome", () => {
  const report = makeReport();
  report.samples[0].postRestartState.lastAnsweredItemId = "9".repeat(64);
  report.samples[0].postResumeState.lastAnswerOutcome = "incorrect";
  report.samples[0].committedAnswerPreserved = false;
  const errors = validateLearningCrashRecoveryReport(report, bindings).join("\n");
  assert.match(errors, /committed answer|preserve/);
});

test("rejects missing or inconsistent residual WAL and SHM recovery evidence", () => {
  const report = makeReport();
  report.samples[0].postCrashJournal.walExists = false;
  report.samples[0].postCrashJournal.walBytes = 0;
  report.samples[0].postCrashJournal.walSha256 = null;
  report.samples[1].postCrashJournal.shmBytes = 0;
  report.samples[2].residualJournalRecovered = false;
  const errors = validateLearningCrashRecoveryReport(report, bindings).join("\n");
  assert.match(errors, /residual WAL recovery/);
  assert.match(errors, /SHM artifact/);
  assert.match(errors, /process or cleanup|samplesWith/);
});

test("rejects an in-flight claim without commit-hook entry or zero visible answer writes", () => {
  const report = makeReport(5, true, "in-flight-commit");
  report.samples[0].commitHookEntered = false;
  report.samples[1].postRestartState.questionAttemptCount = 1;
  report.samples[2].uncommittedAnswerAbsent = false;
  const errors = validateLearningCrashRecoveryReport(report, bindings).join("\n");
  assert.match(errors, /in-flight answer commit/);
  assert.match(errors, /exactly 0 committed answers/);
  assert.match(errors, /samplesWithUncommittedAnswerAbsent/);
});

test("rejects an optimistic sample and a fake short formal gate", () => {
  const report = makeReport();
  report.samples[0].secondExitCode = 9;
  const errors = validateLearningCrashRecoveryReport(report, bindings).join("\n");
  assert.match(errors, /process or cleanup|passed sample|gate/);

  const shortGate = makeReport(1, false);
  shortGate.request.evidenceGateRequested = true;
  shortGate.evidenceGate.requested = true;
  shortGate.evidenceGate.passed = true;
  assert.match(
    validateLearningCrashRecoveryReport(shortGate, bindings).join("\n"),
    /evidence gate/,
  );
});

test("rejects unknown fields and parses PowerShell UTF-8 BOM separately", () => {
  const report = makeReport();
  report.extra = true;
  assert.deepEqual(validateLearningCrashRecoveryReport(report, bindings), [
    "report schema is not exact",
  ]);
  assert.doesNotThrow(() => JSON.parse(`\uFEFF${JSON.stringify(makeReport())}`.replace(/^\uFEFF/, "")));
});
