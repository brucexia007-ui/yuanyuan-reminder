import { createHash } from "node:crypto";

export const STORE_DATA_CAPTURE_CHECKPOINTS = [
  "nsis_before",
  "msix_after",
  "backup_baseline",
  "backup_mutated",
  "backup_restored",
  "update_before",
  "update_after",
  "uninstall_keep_before",
  "uninstall_keep_reinstalled",
  "delete_before",
];

export const STORE_DATA_CAPTURE_REPORTS = [
  ...STORE_DATA_CAPTURE_CHECKPOINTS,
  "delete_after",
];

const EXPECTED_TABLES = [
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

const APPLICATION_IDENTIFIER = "com.yuanyuan.reminder";
const LOGICAL_DATA_ROOT = "LOCALAPPDATA/com.yuanyuan.reminder";
const DATABASE_FILE_NAME = "yuanyuan-reminder.sqlite3";

export class StoreDataCaptureContractError extends Error {}

function fail(message) {
  throw new StoreDataCaptureContractError(message);
}

export function captureSha256(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("capture evidence must be provided as bytes");
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactJsonBytes(bytes, document, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`${label} bytes are not valid JSON: ${error.message}`);
  }
  if (!exact(parsed, document)) fail(`${label} document drifted from its bound bytes`);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields drifted from the Store capture contract`);
  }
}

function hash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function uuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    fail(`${label} must be a lowercase non-nil UUID`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO timestamp`);
  }
}

function privacy(value, label) {
  exactKeys(
    value,
    [
      "syntheticDataOnly",
      "realUserDataAccessed",
      "rawUserContentRecorded",
      "dataPathRecorded",
    ],
    label,
  );
  if (
    value.syntheticDataOnly !== true ||
    value.realUserDataAccessed !== false ||
    value.rawUserContentRecorded !== false ||
    value.dataPathRecorded !== false
  ) {
    fail(`${label} does not prove the synthetic, aggregate-only privacy boundary`);
  }
}

function counts(value, label) {
  exactKeys(value, EXPECTED_TABLES, label);
  if (!Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0)) {
    fail(`${label} contains an invalid aggregate count`);
  }
}

function validateSession(session, sessionId) {
  exactKeys(
    session,
    [
      "schemaVersion",
      "mode",
      "initializedAt",
      "sessionId",
      "applicationIdentifier",
      "logicalDataRoot",
      "databaseFileName",
      "expectedSchemaVersion",
      "candidateSha256",
      "storeReleaseManifestSha256",
      "runtimeReportSha256",
      "syntheticDataOnly",
      "disposableWindows11Attested",
    ],
    "capture session",
  );
  uuid(sessionId, "capture session ID");
  if (
    session.schemaVersion !== 1 ||
    session.mode !== "synthetic_store_data_lifecycle_session" ||
    session.sessionId !== sessionId ||
    session.applicationIdentifier !== APPLICATION_IDENTIFIER ||
    session.logicalDataRoot !== LOGICAL_DATA_ROOT ||
    session.databaseFileName !== DATABASE_FILE_NAME ||
    session.expectedSchemaVersion !== 11 ||
    session.syntheticDataOnly !== true ||
    session.disposableWindows11Attested !== true
  ) {
    fail("capture session boundary drifted");
  }
  timestamp(session.initializedAt, "capture session initializedAt");
  hash(session.candidateSha256, "capture session candidateSha256");
  hash(session.storeReleaseManifestSha256, "capture session storeReleaseManifestSha256");
  hash(session.runtimeReportSha256, "capture session runtimeReportSha256");
}

function validateCheckpoint(report, name, session) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "status",
      "generatedAt",
      "sessionId",
      "checkpoint",
      "applicationIdentifier",
      "logicalDataRoot",
      "bindings",
      "database",
      "privacy",
    ],
    `capture report ${name}`,
  );
  if (
    report.schemaVersion !== 1 ||
    report.status !== "captured_synthetic_store_data_lifecycle_checkpoint" ||
    report.sessionId !== session.sessionId ||
    report.checkpoint !== name ||
    report.applicationIdentifier !== APPLICATION_IDENTIFIER ||
    report.logicalDataRoot !== LOGICAL_DATA_ROOT
  ) {
    fail(`capture report ${name} boundary drifted`);
  }
  timestamp(report.generatedAt, `capture report ${name} generatedAt`);
  exactKeys(
    report.bindings,
    [
      "candidateSha256",
      "storeReleaseManifestSha256",
      "runtimeReportSha256",
      "sessionManifestSha256",
    ],
    `capture report ${name} bindings`,
  );
  for (const [key, value] of Object.entries(report.bindings)) hash(value, `${name}.${key}`);
  if (
    report.bindings.candidateSha256 !== session.candidateSha256 ||
    report.bindings.storeReleaseManifestSha256 !== session.storeReleaseManifestSha256 ||
    report.bindings.runtimeReportSha256 !== session.runtimeReportSha256
  ) {
    fail(`capture report ${name} release lineage drifted`);
  }
  exactKeys(
    report.database,
    [
      "fileName",
      "schemaVersion",
      "quickCheckOk",
      "logicalStateSha256",
      "tableCounts",
      "mainFileSha256",
      "walPresent",
      "walSha256",
      "shmPresent",
      "sourceStableDuringCapture",
    ],
    `capture report ${name} database`,
  );
  if (
    report.database.fileName !== DATABASE_FILE_NAME ||
    report.database.schemaVersion !== 11 ||
    report.database.quickCheckOk !== true ||
    typeof report.database.walPresent !== "boolean" ||
    typeof report.database.shmPresent !== "boolean" ||
    report.database.sourceStableDuringCapture !== true
  ) {
    fail(`capture report ${name} database boundary drifted`);
  }
  hash(report.database.logicalStateSha256, `${name}.logicalStateSha256`);
  hash(report.database.mainFileSha256, `${name}.mainFileSha256`);
  if (report.database.walPresent) hash(report.database.walSha256, `${name}.walSha256`);
  else if (report.database.walSha256 !== null) fail(`${name}.walSha256 must be null without WAL`);
  counts(report.database.tableCounts, `${name}.tableCounts`);
  privacy(report.privacy, `${name}.privacy`);
}

function validateDeletion(report, session) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "status",
      "generatedAt",
      "sessionId",
      "checkpoint",
      "applicationIdentifier",
      "logicalDataRoot",
      "sessionManifestSha256",
      "dataRootAbsent",
      "databaseAbsent",
      "backupDirectoryAbsent",
      "logsDirectoryAbsent",
      "privacy",
    ],
    "capture report delete_after",
  );
  if (
    report.schemaVersion !== 1 ||
    report.status !== "observed_explicit_store_data_lifecycle_deletion" ||
    report.sessionId !== session.sessionId ||
    report.checkpoint !== "delete_after" ||
    report.applicationIdentifier !== APPLICATION_IDENTIFIER ||
    report.logicalDataRoot !== LOGICAL_DATA_ROOT ||
    report.dataRootAbsent !== true ||
    report.databaseAbsent !== true ||
    report.backupDirectoryAbsent !== true ||
    report.logsDirectoryAbsent !== true
  ) {
    fail("capture report delete_after boundary drifted");
  }
  timestamp(report.generatedAt, "capture report delete_after generatedAt");
  hash(report.sessionManifestSha256, "delete_after.sessionManifestSha256");
  privacy(report.privacy, "delete_after.privacy");
}

function fixedRelativePath(sessionId, name) {
  return `src-tauri/target/msix-store-data-lifecycle/${sessionId}/${name}.json`;
}

export function validateStoreDataCaptureReports({
  sessionId,
  session,
  sessionBytes,
  reports,
  reportBytes,
}) {
  if (!Buffer.isBuffer(sessionBytes)) fail("capture session bytes are missing");
  exactJsonBytes(sessionBytes, session, "capture session");
  validateSession(session, sessionId);
  const sessionSha256 = captureSha256(sessionBytes);
  exactKeys(reports, STORE_DATA_CAPTURE_REPORTS, "capture reports");
  exactKeys(reportBytes, STORE_DATA_CAPTURE_REPORTS, "capture report bytes");
  let previousTimestamp = Date.parse(session.initializedAt);
  for (const name of STORE_DATA_CAPTURE_CHECKPOINTS) {
    if (!Buffer.isBuffer(reportBytes[name])) fail(`capture report bytes are missing for ${name}`);
    exactJsonBytes(reportBytes[name], reports[name], `capture report ${name}`);
    validateCheckpoint(reports[name], name, session);
    const currentTimestamp = Date.parse(reports[name].generatedAt);
    if (currentTimestamp < previousTimestamp) {
      fail(`capture report ${name} precedes the prior fixed checkpoint`);
    }
    previousTimestamp = currentTimestamp;
    if (reports[name].bindings.sessionManifestSha256 !== sessionSha256) {
      fail(`capture report ${name} is not bound to the immutable session manifest`);
    }
  }
  if (!Buffer.isBuffer(reportBytes.delete_after)) fail("delete_after report bytes are missing");
  exactJsonBytes(reportBytes.delete_after, reports.delete_after, "capture report delete_after");
  validateDeletion(reports.delete_after, session);
  const deletionTimestamp = Date.parse(reports.delete_after.generatedAt);
  if (deletionTimestamp < previousTimestamp) {
    fail("delete_after precedes the prior fixed checkpoint");
  }
  if (reports.delete_after.sessionManifestSha256 !== sessionSha256) {
    fail("delete_after is not bound to the immutable session manifest");
  }
  return { sessionSha256, completedAt: deletionTimestamp };
}

export function createStoreDataCaptureIndex(input, generatedAt = new Date().toISOString()) {
  const { sessionSha256, completedAt } = validateStoreDataCaptureReports(input);
  timestamp(generatedAt, "capture index generatedAt");
  if (Date.parse(generatedAt) < completedAt) {
    fail("capture index generatedAt precedes completion of the fixed checkpoint sequence");
  }
  return {
    schemaVersion: 1,
    status: "complete_synthetic_store_data_lifecycle_capture",
    generatedAt,
    sessionId: input.sessionId,
    applicationIdentifier: APPLICATION_IDENTIFIER,
    logicalDataRoot: LOGICAL_DATA_ROOT,
    sessionManifest: {
      path: fixedRelativePath(input.sessionId, "session"),
      sha256: sessionSha256,
    },
    bindings: {
      candidateSha256: input.session.candidateSha256,
      storeReleaseManifestSha256: input.session.storeReleaseManifestSha256,
      runtimeReportSha256: input.session.runtimeReportSha256,
    },
    reports: Object.fromEntries(
      STORE_DATA_CAPTURE_REPORTS.map((name) => [
        name,
        {
          path: fixedRelativePath(input.sessionId, name),
          sha256: captureSha256(input.reportBytes[name]),
        },
      ]),
    ),
    privacy: {
      syntheticDataOnly: true,
      realUserDataAccessed: false,
      rawUserContentRecorded: false,
      dataPathRecorded: false,
    },
  };
}

export function validateStoreDataCaptureIndex(index, input) {
  const expected = createStoreDataCaptureIndex(input, index?.generatedAt);
  exactKeys(index, Object.keys(expected), "capture index");
  if (!exact(index, expected)) fail("capture index or a bound report drifted");
  return {
    session: input.session,
    checkpoints: Object.fromEntries(
      STORE_DATA_CAPTURE_CHECKPOINTS.map((name) => [name, input.reports[name]]),
    ),
    deletion: input.reports.delete_after,
  };
}
