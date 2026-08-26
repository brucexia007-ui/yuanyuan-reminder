import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa-learning-sleep",
  "release",
);
const applicationPath = path.join(runtimeRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeRoot, "yuanyuan-runtime-qa-fixture.exe");
const scriptPath = path.join(projectRoot, "scripts", "measure_learning_sleep_wake.ps1");

const SHA256 = /^[A-F0-9]{64}$/;
const LOWER_SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HEADWORD = /^qa[a-z]+$/;
const MENU_ITEMS = [
  "打开今日任务",
  "记录一次喝水",
  "新建任务",
  "暂停提醒 30 分钟",
  "立即睡觉/叫醒圆圆",
  "",
  "总在最前",
  "鼠标穿透",
  "显示课程快捷按键",
  "设置",
  "隐藏圆圆",
  "退出圆圆提醒工具",
];
const CAPTURE_NAMES = [
  "active-learning.png",
  "sleep-menu.png",
  "sleeping.png",
  "wake-menu.png",
  "wake-up.png",
];
const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The five cards are synthetic and contain no personal learning material.",
  "The real pet context menu, Tauri command path, presentation arbiter, SQLite pause transition, React replacement, and Windows accessibility tree are included.",
  "The native menu is opened and inspected, then its shared pet-sleep handler is invoked through an exact runtime-QA control trigger because this environment blocks physical pointer and system-input injection; physical right-click and OS-level menu selection remain manual checks.",
  "PrintWindow captures are restricted to isolated application-owned windows and do not capture the desktop.",
  "This report does not replace a human Narrator, reduced-motion, multi-DPI, locked-break authentication, or signed-candidate review.",
];
const STATE_KEYS = [
  "sessionId",
  "status",
  "stateRevision",
  "currentItemId",
  "headword",
  "pauseReason",
  "interruptedEventCount",
  "interruptedAtUnixMs",
  "answerCommittedEventCount",
  "questionAttemptCount",
  "reviewLogCount",
  "integrityCheck",
  "foreignKeyViolationCount",
];
const PET_SNAPSHOT_KEYS = [
  "revision",
  "activity",
  "source",
  "leaseId",
  "resumableLearningSessionId",
  "restoreTarget",
];

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
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

export function syntheticSleepWakeFixtureSha256() {
  let csv = "headword,meanings_zh\n";
  for (let index = 0; index < 5; index += 1) {
    csv += `qa${alphabeticIndex(index)},合成释义 ${index + 1}\n`;
  }
  return sha256(Buffer.from(csv, "utf8"));
}

function validateState(state, phase, errors) {
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
    !Number.isInteger(state.interruptedEventCount) ||
    state.interruptedEventCount < 0
  ) {
    errors.push(`${phase} session identity or counters are invalid`);
  }
  for (const field of [
    "answerCommittedEventCount",
    "questionAttemptCount",
    "reviewLogCount",
    "foreignKeyViolationCount",
  ]) {
    if (!Number.isInteger(state[field]) || state[field] !== 0) {
      errors.push(`${phase} does not prove zero writes and a healthy database`);
      break;
    }
  }
  if (state.integrityCheck !== "ok") {
    errors.push(`${phase} database integrity is invalid`);
  }
}

function validatePetSnapshot(snapshot, phase, errors) {
  if (
    !exactKeys(snapshot, PET_SNAPSHOT_KEYS) ||
    !Number.isInteger(snapshot?.revision) ||
    snapshot.revision < 1 ||
    snapshot.leaseId !== null
  ) {
    errors.push(`${phase} pet snapshot schema is invalid`);
  }
}

export function validateLearningSleepWakeReport(report, expectedBindings, expectedCaptures) {
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
      "timestamps",
      "observations",
      "state",
      "captures",
      "ready",
      "limitations",
      "failure",
    ])
  ) {
    return ["report schema is not exact"];
  }
  if (
    report.schemaVersion !== 1 ||
    report.profile !== "learning-sleep-wake" ||
    !Number.isFinite(Date.parse(report.generatedAt))
  ) {
    errors.push("report identity is invalid");
  }
  if (
    !exactKeys(report.source, ["branch", "commit", "dirty"]) ||
    report.source?.branch !== "feat/fragment-learning-stage-0-1" ||
    !COMMIT.test(report.source?.commit ?? "") ||
    typeof report.source?.dirty !== "boolean"
  ) {
    errors.push("source state is incomplete");
  }
  if (
    !exactKeys(report.bindings, [
      "applicationSha256",
      "fixtureExecutableSha256",
      "fixtureContentSha256",
      "fixtureDatabaseSha256",
      "scriptSha256",
    ]) ||
    Object.values(report.bindings ?? {}).some(
      (value) => typeof value !== "string" || !SHA256.test(value),
    )
  ) {
    errors.push("binding schema is invalid");
  } else {
    for (const field of ["applicationSha256", "fixtureExecutableSha256", "scriptSha256"]) {
      if (report.bindings[field] !== expectedBindings[field]) {
        errors.push("report bindings are stale or do not match the measured artifacts");
        break;
      }
    }
    if (report.bindings.fixtureContentSha256 !== syntheticSleepWakeFixtureSha256()) {
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
      "webView2RuntimeVersion",
    ]) ||
    !Number.isInteger(report.device?.logicalProcessors) ||
    report.device.logicalProcessors < 1 ||
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
    !exactKeys(report.request, ["exitAfterSeconds", "cardCount"]) ||
    !Number.isInteger(report.request?.exitAfterSeconds) ||
    report.request.exitAfterSeconds < 45 ||
    report.request.exitAfterSeconds > 120 ||
    report.request.cardCount !== 5
  ) {
    errors.push("request contract is invalid");
  }
  if (!exactKeys(report.timestamps, ["startedAt", "sleepInvokedAt", "wakeInvokedAt"])) {
    errors.push("timestamp schema is invalid");
  } else {
    const started = Date.parse(report.timestamps.startedAt);
    const sleep = Date.parse(report.timestamps.sleepInvokedAt);
    const wake = Date.parse(report.timestamps.wakeInvokedAt);
    if (![started, sleep, wake].every(Number.isFinite) || !(started <= sleep && sleep < wake)) {
      errors.push("sleep/wake timestamps are inconsistent");
    }
  }

  const observationKeys = [
    "sleepMenuFound",
    "wakeMenuFound",
    "sleepStatusFound",
    "wakeStatusFound",
    "blackboardYielded",
    "blackboardStayedClosedAfterWake",
    "stateContractPassed",
    "controlledExit",
    "exitCode",
    "rootRemoved",
    "sleepMenuOpenMode",
    "wakeMenuOpenMode",
    "sleepMenuAccessibleNames",
    "wakeMenuAccessibleNames",
    "sleepMenuWindowDetails",
    "sleepMenuCommand",
    "wakeMenuCommand",
    "controlStatus",
  ];
  if (!exactKeys(report.observations, observationKeys)) {
    errors.push("observation schema is not exact");
  } else {
    for (const field of [
      "sleepMenuFound",
      "wakeMenuFound",
      "sleepStatusFound",
      "wakeStatusFound",
      "blackboardYielded",
      "blackboardStayedClosedAfterWake",
      "stateContractPassed",
      "controlledExit",
      "rootRemoved",
    ]) {
      if (report.observations[field] !== true) {
        errors.push("a required Windows observation did not pass");
        break;
      }
    }
    if (report.observations.exitCode !== 0) errors.push("controlled exit did not succeed");
    for (const phase of ["sleep", "wake"]) {
      if (
        report.observations[`${phase}MenuOpenMode`] !== "runtime-qa-control" ||
        JSON.stringify(report.observations[`${phase}MenuAccessibleNames`]) !==
          JSON.stringify(MENU_ITEMS)
      ) {
        errors.push(`${phase} native menu evidence is invalid`);
      }
      const command = report.observations[`${phase}MenuCommand`];
      if (
        !exactKeys(command, ["itemPosition", "commandId", "ownerHandle", "dispatch"]) ||
        command.itemPosition !== 4 ||
        !Number.isInteger(command.commandId) ||
        command.commandId < 1 ||
        !Number.isInteger(command.ownerHandle) ||
        command.ownerHandle < 1 ||
        command.dispatch !== "runtime-qa-shared-menu-handler"
      ) {
        errors.push(`${phase} shared menu command evidence is invalid`);
      }
    }
    const windows = report.observations.sleepMenuWindowDetails;
    if (
      !Array.isArray(windows) ||
      !windows.some((window) => window?.className === "#32768") ||
      !windows.some((window) => window?.className === "Tauri Window") ||
      windows.some(
        (window) =>
          !exactKeys(window, ["handle", "className", "left", "top", "right", "bottom"]),
      )
    ) {
      errors.push("native menu window evidence is incomplete");
    }
  }

  if (!exactKeys(report.state, ["before", "afterSleep", "afterWake", "petAfterSleep", "petAfterWake"])) {
    errors.push("state evidence schema is not exact");
  } else {
    validateState(report.state.before, "before", errors);
    validateState(report.state.afterSleep, "after sleep", errors);
    validateState(report.state.afterWake, "after wake", errors);
    validatePetSnapshot(report.state.petAfterSleep, "after sleep", errors);
    validatePetSnapshot(report.state.petAfterWake, "after wake", errors);
    const before = report.state.before;
    const sleeping = report.state.afterSleep;
    const wake = report.state.afterWake;
    if (
      before.status !== "active" ||
      before.pauseReason !== null ||
      before.interruptedEventCount !== 0 ||
      before.interruptedAtUnixMs !== null ||
      sleeping.status !== "paused" ||
      sleeping.pauseReason !== "preempted_high_priority" ||
      sleeping.stateRevision !== before.stateRevision + 1 ||
      sleeping.interruptedEventCount !== before.interruptedEventCount + 1 ||
      !Number.isInteger(sleeping.interruptedAtUnixMs) ||
      sleeping.interruptedAtUnixMs < 1 ||
      JSON.stringify(wake) !== JSON.stringify(sleeping)
    ) {
      errors.push("sleep/wake persisted transition is invalid");
    }
    if (
      before.sessionId !== sleeping.sessionId ||
      before.currentItemId !== sleeping.currentItemId ||
      before.headword !== sleeping.headword
    ) {
      errors.push("manual sleep did not preserve the unanswered question");
    }
    const petSleep = report.state.petAfterSleep;
    const petWake = report.state.petAfterWake;
    if (
      petSleep.activity !== "sleeping" ||
      petSleep.source !== "manual" ||
      petSleep.resumableLearningSessionId !== before.sessionId ||
      petSleep.restoreTarget !== "learning" ||
      petWake.revision !== petSleep.revision + 1 ||
      petWake.activity !== "interrupted" ||
      petWake.source !== "learning" ||
      petWake.resumableLearningSessionId !== before.sessionId ||
      petWake.restoreTarget !== "learning"
    ) {
      errors.push("pet sleep/wake snapshot contract is invalid");
    }
  }

  const statusEntries = report.observations?.controlStatus;
  const status = new Map(
    Array.isArray(statusEntries) &&
      statusEntries.every((entry) => exactKeys(entry, ["name", "value"]))
      ? statusEntries.map((entry) => [entry.name, entry.value])
      : [],
  );
  const expectedOk = [
    "context-menu-1-consumed",
    "context-menu-1-main-thread-entered",
    "context-menu-1-popup-returned",
    "context-menu-2-consumed",
    "context-menu-2-main-thread-entered",
    "context-menu-2-popup-returned",
    "pet-sleep-menu-1-consumed",
    "pet-sleep-menu-1-main-thread-entered",
    "pet-sleep-menu-1-handler-returned",
    "pet-sleep-menu-2-consumed",
    "pet-sleep-menu-2-main-thread-entered",
    "pet-sleep-menu-2-handler-returned",
  ];
  if (
    status.size !== 16 ||
    expectedOk.some((name) => status.get(name) !== "ok\n") ||
    status.get("pet-sleep-menu-1-selected-action") !== "sleep\n" ||
    status.get("pet-sleep-menu-2-selected-action") !== "wake\n"
  ) {
    errors.push("runtime-QA control status chain is invalid");
  } else {
    try {
      const embeddedSleep = JSON.parse(status.get("pet-sleep-menu-1-snapshot"));
      const embeddedWake = JSON.parse(status.get("pet-sleep-menu-2-snapshot"));
      if (
        JSON.stringify(embeddedSleep) !== JSON.stringify(report.state.petAfterSleep) ||
        JSON.stringify(embeddedWake) !== JSON.stringify(report.state.petAfterWake)
      ) {
        errors.push("embedded pet snapshots do not match state evidence");
      }
    } catch {
      errors.push("embedded pet snapshots are not valid JSON");
    }
  }

  if (!Array.isArray(report.captures) || report.captures.length !== CAPTURE_NAMES.length) {
    errors.push("capture evidence is incomplete");
  } else {
    const actualNames = report.captures.map((capture) => capture?.name);
    if (JSON.stringify(actualNames) !== JSON.stringify(CAPTURE_NAMES)) {
      errors.push("capture names or order are invalid");
    }
    for (const capture of report.captures) {
      if (
        !exactKeys(capture, ["name", "bytes", "sha256"]) ||
        !Number.isInteger(capture.bytes) ||
        capture.bytes < 1 ||
        !SHA256.test(capture.sha256 ?? "") ||
        expectedCaptures?.[capture.name]?.bytes !== capture.bytes ||
        expectedCaptures?.[capture.name]?.sha256 !== capture.sha256
      ) {
        errors.push("a capture is missing, stale, or hash-mismatched");
        break;
      }
    }
    if (new Set(report.captures.map((capture) => capture.sha256)).size < 4) {
      errors.push("captures do not prove distinct active, sleeping, and wake surfaces");
    }
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS)) {
    errors.push("limitations are missing or changed");
  }
  if (report.ready !== true || report.failure !== null) {
    errors.push("report readiness is inconsistent");
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
  const captureDirectory = reportPath.slice(0, -path.extname(reportPath).length);
  const [raw, application, fixture, script, ...captureBytes] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(applicationPath),
    readFile(fixturePath),
    readFile(scriptPath),
    ...CAPTURE_NAMES.map((name) => readFile(path.join(captureDirectory, name))),
  ]);
  const report = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const expectedCaptures = Object.fromEntries(
    CAPTURE_NAMES.map((name, index) => [
      name,
      { bytes: captureBytes[index].length, sha256: sha256(captureBytes[index]) },
    ]),
  );
  const errors = validateLearningSleepWakeReport(
    report,
    {
      applicationSha256: sha256(application),
      fixtureExecutableSha256: sha256(fixture),
      scriptSha256: sha256(script),
    },
    expectedCaptures,
  );
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "Learning native-menu sleep/wake evidence passed: paused once, woke resumable, 5 captures verified.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
