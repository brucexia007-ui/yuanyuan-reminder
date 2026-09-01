import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sha256Pattern = /^[0-9A-F]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const expectedRelease = Object.freeze({
  tagCommit: "11841b88cf7b3e6d10502fd0158401e2c02167ae",
  portableSha256: "D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD",
  checksumSha256: "A3553273D4EE693FED5B9DB50C83A675EB0C1650B022A75067C6A1A83CDB160D",
  tagArchiveSha256: "ED91C071372B08BECAC0D7DA258B1B80154C2C25834FCCA87F338A33A592024E",
});
const sourceTables = [
  "activity_tracking_state",
  "focus_sessions",
  "occurrences",
  "pet_interactions",
  "reminders",
  "settings",
  "water_log",
];
const captureChecks = [
  "source_integrity",
  "v132_schema_identity",
  "source_stability",
  "sqlite_backup",
  "logical_identity",
];
const migrationChecks = [
  "source_read_only",
  "source_integrity",
  "v132_schema_identity",
  "production_migration",
  "row_preservation",
  "backup_restore",
  "failed_restore_rollback",
  "post_restore_health",
];

function fail(message) {
  throw new Error(`authentic v1.3.2 evidence rejected: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function exactKeys(value, expected, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} keys are not exact`,
  );
}

function validSha(value, label) {
  requireValue(sha256Pattern.test(value), `${label} is not an uppercase SHA-256 digest`);
}

function validDate(value, label) {
  requireValue(Number.isFinite(Date.parse(value)), `${label} is not a valid timestamp`);
}

function validateCounts(value, expectedKeys, label) {
  exactKeys(value, expectedKeys, label);
  for (const [key, count] of Object.entries(value)) {
    requireValue(Number.isSafeInteger(count) && count >= 0, `${label}.${key} is not a non-negative count`);
  }
}

function validateChecks(value, expectedIds, label) {
  requireValue(Array.isArray(value) && value.length === expectedIds.length, `${label} count is wrong`);
  const observedIds = [];
  for (const check of value) {
    exactKeys(check, ["id", "passed", "detail"], `${label} item`);
    requireValue(check.passed === true, `${label}.${check.id} did not pass`);
    requireValue(typeof check.detail === "string" && check.detail.length >= 10, `${label}.${check.id} detail is missing`);
    observedIds.push(check.id);
  }
  requireValue(
    JSON.stringify(observedIds.sort()) === JSON.stringify([...expectedIds].sort()),
    `${label} identities are incomplete`,
  );
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function sha256(file) {
  const digest = createHash("sha256");
  digest.update(await readFile(file));
  return digest.digest("hex").toUpperCase();
}

function gitText(arguments_) {
  return execFileSync("git", ["-C", projectRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function currentSource() {
  return {
    branch: gitText(["branch", "--show-current"]),
    commit: gitText(["rev-parse", "HEAD"]),
    dirty: gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0,
  };
}

export function validateV132Evidence({
  status,
  sourceMetadata,
  webView,
  capture,
  provenance,
  migration,
  observed,
  requireClean = true,
}) {
  exactKeys(status, [
    "schemaVersion",
    "generatedAt",
    "profile",
    "sandboxUser",
    "interactiveSession",
    "source",
    "sourceMetadataSha256",
    "webView2MetadataSha256",
    "mappedMicrosoftWebView2RuntimeVerified",
    "temporaryWebView2DetectionRegistration",
    "authenticRuntimeDatabaseCreated",
    "authenticCapturePassed",
    "migrationBackupRollbackPassed",
    "formalUserDataUsed",
    "sandboxDataCleaned",
    "fixtureSha256",
    "captureReportSha256",
    "provenanceReportSha256",
    "migrationReportSha256",
    "ready",
    "failure",
  ], "status");
  requireValue(status.schemaVersion === 1, "status schema is wrong");
  requireValue(status.profile === "community-stable-authentic-v132", "status profile is wrong");
  requireValue(status.sandboxUser === "WDAGUtilityAccount", "status was not captured in Windows Sandbox");
  validDate(status.generatedAt, "status.generatedAt");
  for (const key of [
    "interactiveSession",
    "mappedMicrosoftWebView2RuntimeVerified",
    "temporaryWebView2DetectionRegistration",
    "authenticRuntimeDatabaseCreated",
    "authenticCapturePassed",
    "migrationBackupRollbackPassed",
    "sandboxDataCleaned",
    "ready",
  ]) requireValue(status[key] === true, `status.${key} must be true`);
  requireValue(status.formalUserDataUsed === false, "formal user data was used");
  requireValue(status.failure === null, "status contains a failure");

  exactKeys(sourceMetadata, [
    "schemaVersion",
    "capturedAt",
    "branch",
    "commit",
    "dirty",
    "v132TagCommit",
    "v132PortableSha256",
    "v132ChecksumSha256",
    "v132TagArchiveSha256",
    "captureHelperSha256",
    "migrationHelperSha256",
    "captureScriptSha256",
    "hostScriptSha256",
    "webView2Sha256",
    "webView2Version",
  ], "sourceMetadata");
  requireValue(JSON.stringify(status.source) === JSON.stringify(sourceMetadata), "status source does not match metadata file");
  requireValue(sourceMetadata.schemaVersion === 1, "source metadata schema is wrong");
  validDate(sourceMetadata.capturedAt, "sourceMetadata.capturedAt");
  requireValue(sourceMetadata.branch === observed.source.branch && sourceMetadata.branch.length > 0, "source branch is stale");
  requireValue(commitPattern.test(sourceMetadata.commit), "source commit is invalid");
  requireValue(sourceMetadata.commit === observed.source.commit, "source commit is stale");
  requireValue(sourceMetadata.dirty === observed.source.dirty, "source dirty state is stale");
  if (requireClean) requireValue(sourceMetadata.dirty === false, "formal evidence requires a clean checkout");

  const bindings = [
    ["source metadata", status.sourceMetadataSha256, observed.sourceMetadataSha256],
    ["WebView2 metadata", status.webView2MetadataSha256, observed.webView2MetadataSha256],
    ["v1.3.2 portable", sourceMetadata.v132PortableSha256, observed.v132PortableSha256],
    ["v1.3.2 checksum", sourceMetadata.v132ChecksumSha256, observed.v132ChecksumSha256],
    ["v1.3.2 source archive", sourceMetadata.v132TagArchiveSha256, observed.v132TagArchiveSha256],
    ["capture helper", sourceMetadata.captureHelperSha256, observed.captureHelperSha256],
    ["migration helper", sourceMetadata.migrationHelperSha256, observed.migrationHelperSha256],
    ["capture script", sourceMetadata.captureScriptSha256, observed.captureScriptSha256],
    ["host script", sourceMetadata.hostScriptSha256, observed.hostScriptSha256],
    ["mapped WebView2 runtime", sourceMetadata.webView2Sha256, webView.sha256],
    ["fixture", status.fixtureSha256, observed.fixtureSha256],
    ["capture report", status.captureReportSha256, observed.captureReportSha256],
    ["provenance report", status.provenanceReportSha256, observed.provenanceReportSha256],
    ["migration report", status.migrationReportSha256, observed.migrationReportSha256],
  ];
  for (const [label, actual, expected] of bindings) {
    validSha(actual, label);
    requireValue(actual === expected, `${label} binding is stale`);
  }
  requireValue(sourceMetadata.v132TagCommit === expectedRelease.tagCommit, "v1.3.2 tag commit changed");
  requireValue(sourceMetadata.v132PortableSha256 === expectedRelease.portableSha256, "v1.3.2 portable digest changed");
  requireValue(sourceMetadata.v132ChecksumSha256 === expectedRelease.checksumSha256, "v1.3.2 checksum digest changed");
  requireValue(sourceMetadata.v132TagArchiveSha256 === expectedRelease.tagArchiveSha256, "v1.3.2 source archive digest changed");
  requireValue(sourceMetadata.webView2Version === webView.productVersion, "WebView2 version binding is stale");

  exactKeys(webView, ["schemaVersion", "source", "bytes", "sha256", "signatureStatus", "signerSubject", "productVersion"], "webView");
  requireValue(webView.schemaVersion === 1, "WebView2 metadata schema is wrong");
  requireValue(webView.source === "installed-host-microsoft-webview2-runtime", "WebView2 source is wrong");
  requireValue(Number.isSafeInteger(webView.bytes) && webView.bytes > 0, "WebView2 byte count is invalid");
  validSha(webView.sha256, "WebView2 runtime");
  requireValue(webView.signatureStatus === "Valid", "WebView2 signature is invalid");
  requireValue(webView.signerSubject.includes("O=Microsoft Corporation"), "WebView2 signer is not Microsoft");

  exactKeys(capture, [
    "schemaVersion",
    "status",
    "generatedAt",
    "expectedSourceRelease",
    "sourceReleaseEvidence",
    "sourceDatabaseVersion",
    "sourceMainSizeBytes",
    "sourceMainSha256",
    "sourceWalPresent",
    "sourceWalSizeBytes",
    "sourceWalSha256",
    "sourceShmPresent",
    "sourceStableDuringCapture",
    "fixtureFileName",
    "fixtureSizeBytes",
    "fixtureSha256",
    "fixtureLogicalSha256",
    "fixtureTableCounts",
    "checks",
    "privacy",
  ], "capture");
  requireValue(capture.schemaVersion === 1 && capture.status === "passed", "capture report is not passed");
  validDate(capture.generatedAt, "capture.generatedAt");
  requireValue(capture.expectedSourceRelease === "1.3.2", "capture source release is wrong");
  requireValue(capture.sourceReleaseEvidence === "exact_tag_runtime_plus_operator_attestation", "capture source evidence is weak");
  requireValue(capture.sourceDatabaseVersion === 6, "captured database is not schema 6");
  requireValue(capture.sourceWalPresent === true && capture.sourceShmPresent === true, "runtime WAL/SHM evidence is missing");
  requireValue(capture.sourceStableDuringCapture === true, "runtime source was not stable during capture");
  requireValue(Number.isSafeInteger(capture.sourceMainSizeBytes) && capture.sourceMainSizeBytes > 0, "runtime database size is invalid");
  requireValue(Number.isSafeInteger(capture.sourceWalSizeBytes) && capture.sourceWalSizeBytes > 0, "runtime WAL size is invalid");
  validSha(capture.sourceMainSha256, "runtime database");
  validSha(capture.sourceWalSha256, "runtime WAL");
  validSha(capture.fixtureLogicalSha256, "fixture logical digest");
  requireValue(capture.fixtureFileName === "authentic-v1.3.2.sqlite3", "fixture file name is wrong");
  requireValue(capture.fixtureSha256 === observed.fixtureSha256, "capture fixture digest is stale");
  requireValue(capture.fixtureSizeBytes === observed.fixtureBytes, "capture fixture size is stale");
  validateCounts(capture.fixtureTableCounts, sourceTables, "capture.fixtureTableCounts");
  validateChecks(capture.checks, captureChecks, "capture.checks");

  exactKeys(provenance, ["schemaVersion", "status", "generatedAt", "sourceRelease", "execution", "capture", "limitations", "privacy"], "provenance");
  requireValue(provenance.schemaVersion === 1 && provenance.status === "passed", "provenance report is not passed");
  validDate(provenance.generatedAt, "provenance.generatedAt");
  exactKeys(provenance.sourceRelease, [
    "version", "gitTag", "gitCommit", "distributionChannel", "releasePage",
    "releaseAssetFileName", "tagArchiveSha256", "tagArchiveMatchesRepository",
    "executableSha256", "executableSizeBytes", "productVersion", "fileVersion",
    "releaseChecksumFileName", "releaseChecksumFileSha256", "releaseChecksumMatched",
    "stagedCopyHashMatched",
  ], "provenance.sourceRelease");
  requireValue(provenance.sourceRelease.version === "1.3.2" && provenance.sourceRelease.gitTag === "v1.3.2", "provenance version/tag is wrong");
  requireValue(provenance.sourceRelease.gitCommit === expectedRelease.tagCommit, "provenance tag commit is wrong");
  requireValue(provenance.sourceRelease.distributionChannel === "github_release_asset", "provenance channel is wrong");
  requireValue(provenance.sourceRelease.releaseAssetFileName === "Yuanyuan-Reminder-1.3.2-x64-Portable.exe", "provenance asset name is wrong");
  requireValue(provenance.sourceRelease.tagArchiveSha256 === expectedRelease.tagArchiveSha256, "provenance archive digest is wrong");
  requireValue(provenance.sourceRelease.executableSha256 === expectedRelease.portableSha256, "provenance executable digest is wrong");
  requireValue(provenance.sourceRelease.releaseChecksumFileSha256 === expectedRelease.checksumSha256, "provenance checksum digest is wrong");
  for (const key of ["tagArchiveMatchesRepository", "releaseChecksumMatched", "stagedCopyHashMatched"]) {
    requireValue(provenance.sourceRelease[key] === true, `provenance.sourceRelease.${key} must be true`);
  }
  requireValue(provenance.sourceRelease.productVersion === "1.3.2" && provenance.sourceRelease.fileVersion === "1.3.2", "provenance executable version is wrong");

  exactKeys(provenance.execution, [
    "interactiveSession", "freshTestAccountAcknowledged", "tokenProfileResolvedThroughRegistry",
    "preexistingDataRoot", "preexistingApplicationProcessCount", "launchUtc", "visibleWindowObserved",
    "runtimeDatabaseCreated", "childStreamsRedirected", "stagedInTestProfileTemp",
    "webViewJavascriptDisabledForInitialization", "terminationMode", "processTreeStopped",
    "dataRootRemoved", "stageRemoved",
  ], "provenance.execution");
  validDate(provenance.execution.launchUtc, "provenance.execution.launchUtc");
  for (const key of [
    "interactiveSession", "freshTestAccountAcknowledged", "tokenProfileResolvedThroughRegistry",
    "visibleWindowObserved", "runtimeDatabaseCreated", "stagedInTestProfileTemp",
    "webViewJavascriptDisabledForInitialization", "processTreeStopped", "dataRootRemoved", "stageRemoved",
  ]) requireValue(provenance.execution[key] === true, `provenance.execution.${key} must be true`);
  requireValue(provenance.execution.preexistingDataRoot === false, "capture account had a pre-existing data root");
  requireValue(provenance.execution.preexistingApplicationProcessCount === 0, "capture account had a pre-existing app process");
  requireValue(provenance.execution.childStreamsRedirected === false, "capture unexpectedly redirected legacy streams");
  requireValue(provenance.execution.terminationMode === "owned_process_tree_forced_after_initialization", "capture termination mode is wrong");
  exactKeys(provenance.capture, [
    "executableSha256", "reportFileName", "reportSha256", "fixtureFileName",
    "fixtureSha256", "fixtureSizeBytes", "databaseVersion",
  ], "provenance.capture");
  requireValue(provenance.capture.executableSha256 === observed.captureHelperSha256, "provenance capture helper is stale");
  requireValue(provenance.capture.reportSha256 === observed.captureReportSha256, "provenance capture report is stale");
  requireValue(provenance.capture.fixtureSha256 === observed.fixtureSha256, "provenance fixture is stale");
  requireValue(provenance.capture.fixtureSizeBytes === observed.fixtureBytes && provenance.capture.databaseVersion === 6, "provenance fixture metadata is wrong");

  exactKeys(migration, [
    "schemaVersion", "status", "generatedAt", "expectedSourceRelease", "sourceReleaseEvidence",
    "sourceReleaseEvidenceLimit", "sourceFileName", "sourceSizeBytes", "sourceSha256",
    "sourceDatabaseVersion", "migratedDatabaseVersion", "sourceLogicalSha256",
    "migratedMatchedSourceRowsSha256", "sourceTableCounts", "migratedTableCounts", "checks", "privacy",
  ], "migration");
  requireValue(migration.schemaVersion === 1 && migration.status === "passed", "migration report is not passed");
  validDate(migration.generatedAt, "migration.generatedAt");
  requireValue(migration.expectedSourceRelease === "1.3.2", "migration source release is wrong");
  requireValue(migration.sourceFileName === "authentic-v1.3.2.sqlite3", "migration source file is wrong");
  requireValue(migration.sourceSizeBytes === observed.fixtureBytes && migration.sourceSha256 === observed.fixtureSha256, "migration source binding is stale");
  requireValue(migration.sourceDatabaseVersion === 6, "migration source schema is wrong");
  requireValue(migration.migratedDatabaseVersion === observed.currentSchemaVersion, "migration target schema is stale");
  requireValue(migration.sourceLogicalSha256 === capture.fixtureLogicalSha256, "migration source logical digest is stale");
  requireValue(migration.migratedMatchedSourceRowsSha256 === migration.sourceLogicalSha256, "migration changed legacy rows");
  requireValue(JSON.stringify(migration.sourceTableCounts) === JSON.stringify(capture.fixtureTableCounts), "migration source counts changed");
  validateCounts(migration.sourceTableCounts, sourceTables, "migration.sourceTableCounts");
  for (const [key, count] of Object.entries(migration.migratedTableCounts)) {
    requireValue(Number.isSafeInteger(count) && count >= 0, `migration.migratedTableCounts.${key} is invalid`);
  }
  for (const key of sourceTables) {
    requireValue(migration.migratedTableCounts[key] === migration.sourceTableCounts[key], `migration count changed for ${key}`);
  }
  validateChecks(migration.checks, migrationChecks, "migration.checks");
  requireValue(Date.parse(capture.generatedAt) <= Date.parse(provenance.generatedAt), "capture/provenance timestamps are reversed");
  requireValue(Date.parse(provenance.generatedAt) <= Date.parse(migration.generatedAt), "provenance/migration timestamps are reversed");
  requireValue(Date.parse(migration.generatedAt) <= Date.parse(status.generatedAt), "migration/status timestamps are reversed");
}

function argumentValue(name) {
  const positions = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length !== 1 || !process.argv[positions[0] + 1]) fail(`${name} must be provided exactly once`);
  return process.argv[positions[0] + 1];
}

async function main() {
  const evidenceRoot = path.resolve(argumentValue("--evidence-root"));
  const allowedRoot = path.join(projectRoot, "src-tauri", "target", "community-stable-v132-sandbox") + path.sep;
  requireValue(evidenceRoot.startsWith(allowedRoot), "evidence root is outside the v1.3.2 Sandbox evidence area");
  const paths = {
    status: path.join(evidenceRoot, "v132-sandbox-status.json"),
    sourceMetadata: path.join(evidenceRoot, "source-metadata.json"),
    webView: path.join(evidenceRoot, "webview2-mapped-runtime.json"),
    capture: path.join(evidenceRoot, "v132-capture-report.json"),
    provenance: path.join(evidenceRoot, "v132-provenance-report.json"),
    migration: path.join(evidenceRoot, "current-migration-report.json"),
    fixture: path.join(evidenceRoot, "authentic-v1.3.2.sqlite3"),
  };
  const [status, sourceMetadata, webView, capture, provenance, migration] = await Promise.all([
    readJson(paths.status),
    readJson(paths.sourceMetadata),
    readJson(paths.webView),
    readJson(paths.capture),
    readJson(paths.provenance),
    readJson(paths.migration),
  ]);
  const assetRoot = path.join(projectRoot, "src-tauri", "target", "v132-runtime-qa-11841b88");
  const migrationFiles = await readdir(path.join(projectRoot, "src-tauri", "migrations"));
  const currentSchemaVersion = Math.max(...migrationFiles.flatMap((name) => {
    const match = /^(\d+)_/u.exec(name);
    return match ? [Number.parseInt(match[1], 10)] : [];
  }));
  const fixtureStat = await stat(paths.fixture);
  const observed = {
    source: currentSource(),
    sourceMetadataSha256: await sha256(paths.sourceMetadata),
    webView2MetadataSha256: await sha256(paths.webView),
    v132PortableSha256: await sha256(path.join(assetRoot, "published", "Yuanyuan-Reminder-1.3.2-x64-Portable.exe")),
    v132ChecksumSha256: await sha256(path.join(assetRoot, "published", "SHA256SUMS.txt")),
    v132TagArchiveSha256: await sha256(path.join(assetRoot, "yuanyuan-reminder-v1.3.2.zip")),
    captureHelperSha256: await sha256(path.join(projectRoot, "src-tauri", "target", "release", "yuanyuan-database-migration-qa-capture.exe")),
    migrationHelperSha256: await sha256(path.join(projectRoot, "src-tauri", "target", "release", "yuanyuan-database-migration-qa.exe")),
    captureScriptSha256: await sha256(path.join(projectRoot, "scripts", "capture_v132_runtime_database.ps1")),
    hostScriptSha256: await sha256(path.join(projectRoot, "scripts", "run_community_stable_v132_sandbox_probe_host.ps1")),
    fixtureSha256: await sha256(paths.fixture),
    fixtureBytes: fixtureStat.size,
    captureReportSha256: await sha256(paths.capture),
    provenanceReportSha256: await sha256(paths.provenance),
    migrationReportSha256: await sha256(paths.migration),
    currentSchemaVersion,
  };
  validateV132Evidence({
    status,
    sourceMetadata,
    webView,
    capture,
    provenance,
    migration,
    observed,
    requireClean: !process.argv.includes("--allow-dirty"),
  });
  requireValue(
    await readFile(path.join(evidenceRoot, "v132-sandbox.complete"), "utf8") ===
      "YUANYUAN_WINDOWS_SANDBOX_V132_COMPLETE_V1\n",
    "completion marker is invalid",
  );
  const captureLog = await readFile(path.join(evidenceRoot, "v132-capture.log"), "utf8");
  requireValue(captureLog.includes("v1.3.2 runtime database capture passed"), "capture log did not reach success");
  console.log(`Authentic v1.3.2 compatibility evidence verified: ${evidenceRoot}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
