import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa-learning-recovery",
  "release",
);
const applicationPath = path.join(runtimeRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeRoot, "yuanyuan-runtime-qa-fixture.exe");
const scriptPath = path.join(projectRoot, "scripts", "measure_learning_crash_recovery.ps1");

const SHA256 = /^[A-F0-9]{64}$/;
const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HEADWORD = /^qa[a-z]+$/;
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
const SCENARIOS = {
  committed: {
    profile: "learning-crash-recovery",
    expectedAnswerCount: 1,
    limitations: COMMITTED_LIMITATIONS,
  },
  "in-flight-commit": {
    profile: "learning-in-flight-commit-recovery",
    expectedAnswerCount: 0,
    limitations: IN_FLIGHT_LIMITATIONS,
  },
};
const JOURNAL_KEYS = [
  "databaseExists",
  "databaseBytes",
  "databaseSha256",
  "walExists",
  "walBytes",
  "walSha256",
  "shmExists",
  "shmBytes",
  "shmSha256",
];
const STATE_KEYS = [
  "sessionId",
  "status",
  "stateRevision",
  "currentItemId",
  "headword",
  "plannedCount",
  "completedCount",
  "pauseReason",
  "eventCount",
  "crashRecoveredEventCount",
  "resumedEventCount",
  "answerCommittedEventCount",
  "questionAttemptCount",
  "reviewLogCount",
  "lastAnsweredItemId",
  "lastAnsweredHeadword",
  "lastAnswerOutcome",
  "integrityCheck",
  "foreignKeyViolationCount",
];

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function closeEnough(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.05;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * ordered.length) - 1);
  return Math.round(ordered[index] * 10) / 10;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function alphabeticIndex(rawIndex) {
  let index = rawIndex;
  const characters = [];
  for (;;) {
    characters.push(String.fromCharCode("a".charCodeAt(0) + (index % 26)));
    index = Math.floor(index / 26);
    if (index === 0) break;
    index -= 1;
  }
  return characters.reverse().join("");
}

export function syntheticRecoveryFixtureSha256() {
  let csv = "headword,meanings_zh\n";
  for (let index = 0; index < 5; index += 1) {
    csv += `qa${alphabeticIndex(index)},合成释义 ${index + 1}\n`;
  }
  return sha256(Buffer.from(csv, "utf8"));
}

function validateState(state, phase, expectedAnswerCount, errors) {
  if (!exactKeys(state, STATE_KEYS)) {
    errors.push(`${phase} state schema is not exact`);
    return;
  }
  if (
    typeof state.sessionId !== "string" ||
    state.sessionId.length < 1 ||
    state.sessionId.length > 64 ||
    !["active", "paused"].includes(state.status) ||
    !Number.isInteger(state.stateRevision) ||
    state.stateRevision < 1 ||
    !LOWER_SHA256.test(state.currentItemId) ||
    !HEADWORD.test(state.headword) ||
    !Number.isInteger(state.plannedCount) ||
    state.plannedCount !== 3 ||
    state.completedCount !== expectedAnswerCount ||
    !Number.isInteger(state.eventCount) ||
    state.eventCount < 2
  ) {
    errors.push(`${phase} session identity or counters are invalid`);
  }
  for (const field of [
    "crashRecoveredEventCount",
    "resumedEventCount",
    "answerCommittedEventCount",
    "questionAttemptCount",
    "reviewLogCount",
    "foreignKeyViolationCount",
  ]) {
    if (!Number.isInteger(state[field]) || state[field] < 0) {
      errors.push(`${phase} ${field} is invalid`);
    }
  }
  if (
    state.answerCommittedEventCount !== expectedAnswerCount ||
    state.questionAttemptCount !== expectedAnswerCount ||
    state.reviewLogCount !== expectedAnswerCount ||
    state.integrityCheck !== "ok" ||
    state.foreignKeyViolationCount !== 0
  ) {
    errors.push(`${phase} does not prove exactly ${expectedAnswerCount} committed answers in a healthy database`);
  }
  if (expectedAnswerCount === 0) {
    if (
      state.lastAnsweredItemId !== null ||
      state.lastAnsweredHeadword !== null ||
      state.lastAnswerOutcome !== null
    ) {
      errors.push(`${phase} unexpectedly identifies a committed answer`);
    }
  } else if (
    !LOWER_SHA256.test(state.lastAnsweredItemId ?? "") ||
    !HEADWORD.test(state.lastAnsweredHeadword ?? "") ||
    !["correct", "incorrect"].includes(state.lastAnswerOutcome)
  ) {
    errors.push(`${phase} committed answer identity is invalid`);
  }
}

function validateJournalState(state, phase, requireResidualJournal, errors) {
  if (!exactKeys(state, JOURNAL_KEYS)) {
    errors.push(`${phase} journal schema is not exact`);
    return;
  }
  if (
    state.databaseExists !== true ||
    !Number.isInteger(state.databaseBytes) ||
    state.databaseBytes <= 0 ||
    !SHA256.test(state.databaseSha256 ?? "")
  ) {
    errors.push(`${phase} database artifact is invalid`);
  }
  for (const prefix of ["wal", "shm"]) {
    const exists = state[`${prefix}Exists`];
    const bytes = state[`${prefix}Bytes`];
    const digest = state[`${prefix}Sha256`];
    if (
      typeof exists !== "boolean" ||
      !Number.isInteger(bytes) ||
      bytes < 0 ||
      (exists && (bytes <= 0 || !SHA256.test(digest ?? ""))) ||
      (!exists && (bytes !== 0 || digest !== null))
    ) {
      errors.push(`${phase} ${prefix.toUpperCase()} artifact is inconsistent`);
    }
    if (requireResidualJournal && exists !== true) {
      errors.push(`${phase} does not prove residual ${prefix.toUpperCase()} recovery`);
    }
  }
}

export function validateLearningCrashRecoveryReport(report, expectedBindings) {
  const errors = [];
  if (
    !exactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "source",
      "bindings",
      "device",
      "request",
      "fixture",
      "summary",
      "evidenceGate",
      "ready",
      "limitations",
      "samples",
    ])
  ) {
    return ["report schema is not exact"];
  }
  const scenario = SCENARIOS[report.request?.scenario];
  if (
    report.schemaVersion !== 4 ||
    !scenario ||
    report.profile !== scenario?.profile ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    typeof report.ready !== "boolean"
  ) {
    errors.push("report identity is invalid");
  }
  if (
    !exactKeys(report.source, ["gitCommit", "gitDirty", "gitStatusSha256"]) ||
    !COMMIT.test(report.source?.gitCommit ?? "") ||
    typeof report.source?.gitDirty !== "boolean" ||
    !SHA256.test(report.source?.gitStatusSha256 ?? "")
  ) {
    errors.push("source state is incomplete");
  }
  if (
    !exactKeys(report.bindings, [
      "applicationSha256",
      "fixtureExecutableSha256",
      "fixtureContentSha256",
      "scriptSha256",
    ])
  ) {
    errors.push("binding schema is not exact");
  } else {
    for (const value of Object.values(report.bindings)) {
      if (typeof value !== "string" || !SHA256.test(value)) {
        errors.push("a binding is not an uppercase SHA-256 value");
        break;
      }
    }
    if (
      report.bindings.applicationSha256 !== expectedBindings.applicationSha256 ||
      report.bindings.fixtureExecutableSha256 !== expectedBindings.fixtureExecutableSha256 ||
      report.bindings.scriptSha256 !== expectedBindings.scriptSha256
    ) {
      errors.push("report bindings are stale or do not match the measured artifacts");
    }
    if (report.bindings.fixtureContentSha256 !== syntheticRecoveryFixtureSha256()) {
      errors.push("deterministic fixture content hash is invalid");
    }
  }
  if (
    !exactKeys(report.device, [
      "windowsProductName",
      "windowsDisplayVersion",
      "windowsBuild",
      "processorArchitecture",
      "logicalProcessors",
      "powerLineStatus",
      "webView2RuntimeVersion",
    ]) ||
    !Number.isInteger(report.device?.logicalProcessors) ||
    report.device.logicalProcessors < 1 ||
    !["Online", "Offline", "Unknown"].includes(report.device?.powerLineStatus) ||
    [
      report.device?.windowsProductName,
      report.device?.windowsBuild,
      report.device?.processorArchitecture,
      report.device?.webView2RuntimeVersion,
    ].some((value) => typeof value !== "string" || value.length === 0)
  ) {
    errors.push("device evidence is incomplete");
  }
  if (
    !exactKeys(report.request, [
      "sampleCount",
      "firstExitAfterSeconds",
      "secondExitAfterSeconds",
      "committedAnswersBeforeCrash",
      "scenario",
      "evidenceGateRequested",
    ]) ||
    !Number.isInteger(report.request?.sampleCount) ||
    report.request.sampleCount < 1 ||
    report.request.sampleCount > 10 ||
    report.request.firstExitAfterSeconds !== 120 ||
    !Number.isInteger(report.request.secondExitAfterSeconds) ||
    report.request.secondExitAfterSeconds < 30 ||
    report.request.secondExitAfterSeconds > 120 ||
    report.request.committedAnswersBeforeCrash !== scenario?.expectedAnswerCount ||
    typeof report.request.evidenceGateRequested !== "boolean"
  ) {
    errors.push("request contract is invalid");
  }
  if (
    !exactKeys(report.fixture, ["cardCount", "contentKind"]) ||
    report.fixture?.cardCount !== 5 ||
    report.fixture?.contentKind !== "deterministic-synthetic-english-csv"
  ) {
    errors.push("fixture declaration is invalid");
  }
  if (
    !exactKeys(report.summary, [
      "passedSamples",
      "resumeAvailableP50Milliseconds",
      "resumeAvailableP95Milliseconds",
      "resumedBlackboardP50Milliseconds",
      "resumedBlackboardP95Milliseconds",
      "samplesWithResidualWal",
      "samplesWithResidualShm",
      "samplesWithHealthyRestart",
      "commitHookEnteredP50Milliseconds",
      "commitHookEnteredP95Milliseconds",
      "samplesWithUncommittedAnswerAbsent",
    ]) ||
    !Number.isInteger(report.summary?.passedSamples) ||
    !Number.isInteger(report.summary?.samplesWithResidualWal) ||
    !Number.isInteger(report.summary?.samplesWithResidualShm) ||
    !Number.isInteger(report.summary?.samplesWithHealthyRestart) ||
    !Number.isInteger(report.summary?.samplesWithUncommittedAnswerAbsent)
  ) {
    errors.push("summary schema is invalid");
  }
  if (
    !exactKeys(report.evidenceGate, ["requested", "minimumSamples", "passed", "failures"]) ||
    typeof report.evidenceGate?.requested !== "boolean" ||
    report.evidenceGate?.minimumSamples !== 5 ||
    !Array.isArray(report.evidenceGate?.failures)
  ) {
    errors.push("evidence gate schema is invalid");
  }
  if (!Array.isArray(report.samples) || report.samples.length !== report.request?.sampleCount) {
    errors.push("raw sample count does not match the request");
  }

  const passed = [];
  for (const [index, sample] of (report.samples ?? []).entries()) {
    if (
      !exactKeys(sample, [
        "sample",
        "scenario",
        "fixtureDatabaseSha256",
        "fixtureDatabaseBytes",
        "firstPageReadyMilliseconds",
        "initialBlackboardMilliseconds",
        "answeredHeadword",
        "preAnswerState",
        "originalHeadword",
        "preCrashState",
        "commitHookArmed",
        "commitHookEntered",
        "commitHookEnteredMilliseconds",
        "crashInjected",
        "crashExitCode",
        "postCrashJournal",
        "restartPageReadyMilliseconds",
        "resumeAvailableMilliseconds",
        "postRestartState",
        "residualJournalRecovered",
        "resumedBlackboardMilliseconds",
        "resumedHeadword",
        "postResumeState",
        "sameSession",
        "sameItem",
        "sameHeadword",
        "committedAnswerPreserved",
        "uncommittedAnswerAbsent",
        "secondControlledExit",
        "secondExitCode",
        "postControlledExitJournal",
        "maxVisibleWindows",
        "maxAccessibleNodes",
        "observedAccessibleNames",
        "rootRemoved",
        "passed",
        "failure",
      ])
    ) {
      errors.push(`sample ${index + 1} schema is not exact`);
      continue;
    }
    if (
      sample.sample !== index + 1 ||
      sample.scenario !== report.request?.scenario ||
      !SHA256.test(sample.fixtureDatabaseSha256 ?? "") ||
      !Number.isInteger(sample.fixtureDatabaseBytes) ||
      sample.fixtureDatabaseBytes <= 0 ||
      [
        sample.firstPageReadyMilliseconds,
        sample.initialBlackboardMilliseconds,
        sample.restartPageReadyMilliseconds,
        sample.resumeAvailableMilliseconds,
        sample.resumedBlackboardMilliseconds,
      ].some((value) => !Number.isFinite(value) || value <= 0) ||
      !HEADWORD.test(sample.answeredHeadword ?? "") ||
      !HEADWORD.test(sample.originalHeadword ?? "") ||
      !HEADWORD.test(sample.resumedHeadword ?? "") ||
      !Number.isInteger(sample.maxVisibleWindows) ||
      sample.maxVisibleWindows < 1 ||
      !Number.isInteger(sample.maxAccessibleNodes) ||
      sample.maxAccessibleNodes < 1 ||
      !Array.isArray(sample.observedAccessibleNames)
    ) {
      errors.push(`sample ${index + 1} measurements are invalid`);
    }
    for (const requiredName of [
      "学习页面",
      "圆圆桌面英语复习",
      "继续上一轮",
      sample.answeredHeadword,
      sample.originalHeadword,
    ]) {
      if (
        typeof requiredName !== "string" ||
        !sample.observedAccessibleNames.some(
          (name) => typeof name === "string" && name.includes(requiredName),
        )
      ) {
        errors.push(`sample ${index + 1} accessibility evidence is incomplete`);
        break;
      }
    }
    validateState(sample.preAnswerState, `sample ${index + 1} pre-answer`, 0, errors);
    validateState(
      sample.preCrashState,
      `sample ${index + 1} pre-crash`,
      scenario?.expectedAnswerCount ?? -1,
      errors,
    );
    validateJournalState(sample.postCrashJournal, `sample ${index + 1} post-crash`, true, errors);
    validateState(
      sample.postRestartState,
      `sample ${index + 1} post-restart`,
      scenario?.expectedAnswerCount ?? -1,
      errors,
    );
    validateState(
      sample.postResumeState,
      `sample ${index + 1} post-resume`,
      scenario?.expectedAnswerCount ?? -1,
      errors,
    );
    validateJournalState(
      sample.postControlledExitJournal,
      `sample ${index + 1} post-controlled-exit`,
      false,
      errors,
    );
    const initial = sample.preAnswerState ?? {};
    const before = sample.preCrashState ?? {};
    const recovered = sample.postRestartState ?? {};
    const resumed = sample.postResumeState ?? {};
    const beforeDelta = report.request?.scenario === "committed" ? 1 : 0;
    if (
      initial.status !== "active" ||
      initial.pauseReason !== null ||
      initial.crashRecoveredEventCount !== 0 ||
      initial.resumedEventCount !== 0 ||
      before.status !== "active" ||
      before.pauseReason !== null ||
      before.stateRevision !== initial.stateRevision + beforeDelta ||
      before.eventCount !== initial.eventCount + beforeDelta ||
      before.crashRecoveredEventCount !== 0 ||
      before.resumedEventCount !== 0 ||
      recovered.status !== "paused" ||
      recovered.pauseReason !== "crash_recovery" ||
      recovered.stateRevision !== before.stateRevision + 1 ||
      recovered.eventCount !== before.eventCount + 1 ||
      recovered.crashRecoveredEventCount !== 1 ||
      recovered.resumedEventCount !== 0 ||
      resumed.status !== "active" ||
      resumed.pauseReason !== null ||
      resumed.stateRevision !== recovered.stateRevision + 1 ||
      resumed.eventCount !== recovered.eventCount + 1 ||
      resumed.crashRecoveredEventCount !== 1 ||
      resumed.resumedEventCount !== 1
    ) {
      errors.push(`sample ${index + 1} state transition proof is invalid`);
    }
    if (report.request?.scenario === "committed") {
      if (
        sample.commitHookArmed !== false ||
        sample.commitHookEntered !== false ||
        sample.commitHookEnteredMilliseconds !== null ||
        sample.uncommittedAnswerAbsent !== false ||
        initial.sessionId !== before.sessionId ||
        before.sessionId !== recovered.sessionId ||
        before.sessionId !== resumed.sessionId ||
        initial.currentItemId !== before.lastAnsweredItemId ||
        initial.headword !== sample.answeredHeadword ||
        before.lastAnsweredHeadword !== sample.answeredHeadword ||
        before.currentItemId === before.lastAnsweredItemId ||
        before.currentItemId !== recovered.currentItemId ||
        before.currentItemId !== resumed.currentItemId ||
        before.headword !== recovered.headword ||
        before.headword !== resumed.headword ||
        before.headword !== sample.originalHeadword ||
        before.headword !== sample.resumedHeadword ||
        before.lastAnsweredItemId !== recovered.lastAnsweredItemId ||
        before.lastAnsweredItemId !== resumed.lastAnsweredItemId ||
        before.lastAnsweredHeadword !== recovered.lastAnsweredHeadword ||
        before.lastAnsweredHeadword !== resumed.lastAnsweredHeadword ||
        before.lastAnswerOutcome !== recovered.lastAnswerOutcome ||
        before.lastAnswerOutcome !== resumed.lastAnswerOutcome ||
        sample.sameSession !== true ||
        sample.sameItem !== true ||
        sample.sameHeadword !== true ||
        sample.committedAnswerPreserved !== true
      ) {
        errors.push(
          `sample ${index + 1} did not preserve one committed answer and the next unanswered question`,
        );
      }
    } else if (
      sample.commitHookArmed !== true ||
      sample.commitHookEntered !== true ||
      !Number.isFinite(sample.commitHookEnteredMilliseconds) ||
      sample.commitHookEnteredMilliseconds <= 0 ||
      sample.committedAnswerPreserved !== false ||
      sample.uncommittedAnswerAbsent !== true ||
      initial.sessionId !== before.sessionId ||
      before.sessionId !== recovered.sessionId ||
      before.sessionId !== resumed.sessionId ||
      initial.currentItemId !== before.currentItemId ||
      before.currentItemId !== recovered.currentItemId ||
      before.currentItemId !== resumed.currentItemId ||
      initial.headword !== sample.answeredHeadword ||
      initial.headword !== before.headword ||
      before.headword !== recovered.headword ||
      before.headword !== resumed.headword ||
      before.headword !== sample.originalHeadword ||
      before.headword !== sample.resumedHeadword ||
      [before, recovered, resumed].some(
        (state) =>
          state.lastAnsweredItemId !== null ||
          state.lastAnsweredHeadword !== null ||
          state.lastAnswerOutcome !== null,
      ) ||
      sample.sameSession !== true ||
      sample.sameItem !== true ||
      sample.sameHeadword !== true
    ) {
      errors.push(`sample ${index + 1} did not prove rollback of the in-flight answer commit`);
    }
    if (
      sample.crashInjected !== true ||
      !Number.isInteger(sample.crashExitCode) ||
      sample.crashExitCode === 0 ||
      sample.residualJournalRecovered !== true ||
      sample.secondControlledExit !== true ||
      sample.secondExitCode !== 0 ||
      sample.rootRemoved !== true ||
      sample.passed !== true ||
      sample.failure !== null
    ) {
      errors.push(`sample ${index + 1} process or cleanup evidence is invalid`);
    } else {
      passed.push(sample);
    }
  }

  const resumeAvailable = passed.map((sample) => sample.resumeAvailableMilliseconds);
  const resumedBlackboard = passed.map((sample) => sample.resumedBlackboardMilliseconds);
  const commitHookEntered = passed
    .map((sample) => sample.commitHookEnteredMilliseconds)
    .filter(Number.isFinite);
  const expectedSummary = {
    passedSamples: passed.length,
    resumeAvailableP50Milliseconds: percentile(resumeAvailable, 0.5),
    resumeAvailableP95Milliseconds: percentile(resumeAvailable, 0.95),
    resumedBlackboardP50Milliseconds: percentile(resumedBlackboard, 0.5),
    resumedBlackboardP95Milliseconds: percentile(resumedBlackboard, 0.95),
    samplesWithResidualWal: passed.filter((sample) => sample.postCrashJournal?.walExists).length,
    samplesWithResidualShm: passed.filter((sample) => sample.postCrashJournal?.shmExists).length,
    samplesWithHealthyRestart: passed.filter((sample) => sample.residualJournalRecovered).length,
    commitHookEnteredP50Milliseconds: percentile(commitHookEntered, 0.5),
    commitHookEnteredP95Milliseconds: percentile(commitHookEntered, 0.95),
    samplesWithUncommittedAnswerAbsent: passed.filter(
      (sample) => sample.uncommittedAnswerAbsent,
    ).length,
  };
  if (report.summary?.passedSamples !== expectedSummary.passedSamples) {
    errors.push("passed sample count is optimistic");
  }
  for (const key of Object.keys(expectedSummary).filter((key) => key !== "passedSamples")) {
    if (
      (expectedSummary[key] === null && report.summary?.[key] !== null) ||
      (expectedSummary[key] !== null && !closeEnough(report.summary?.[key], expectedSummary[key]))
    ) {
      errors.push(`${key} does not match raw samples`);
    }
  }
  const sampleSetPassed = passed.length === report.request?.sampleCount;
  if (report.evidenceGate?.requested) {
    const expectedGatePassed = report.request.sampleCount >= 5 && sampleSetPassed;
    if (
      report.request.evidenceGateRequested !== true ||
      report.evidenceGate.passed !== expectedGatePassed ||
      (expectedGatePassed && report.evidenceGate.failures.length !== 0) ||
      (!expectedGatePassed && report.evidenceGate.failures.length === 0) ||
      report.ready !== expectedGatePassed
    ) {
      errors.push("evidence gate result is inconsistent");
    }
  } else if (
    report.request?.evidenceGateRequested !== false ||
    report.evidenceGate?.passed !== null ||
    report.evidenceGate?.failures.length !== 0 ||
    report.ready !== sampleSetPassed
  ) {
    errors.push("smoke readiness is inconsistent");
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(scenario?.limitations)) {
    errors.push("limitations are missing or changed");
  }
  return errors;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const reportArgument = argumentValue("--report");
  if (!reportArgument) throw new Error("--report is required");
  const reportPath = path.resolve(reportArgument);
  const [raw, application, fixture, script] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(applicationPath),
    readFile(fixturePath),
    readFile(scriptPath),
  ]);
  const report = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const errors = validateLearningCrashRecoveryReport(report, {
    applicationSha256: sha256(application),
    fixtureExecutableSha256: sha256(fixture),
    scriptSha256: sha256(script),
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  if (!report.ready) {
    console.error("- learning crash recovery report is valid but did not pass its gate");
    process.exitCode = 1;
    return;
  }
  console.log(
    `Learning ${report.request.scenario} crash recovery evidence passed: ${report.summary.passedSamples}/${report.request.sampleCount}, resume P95 ${report.summary.resumedBlackboardP95Milliseconds} ms.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
