import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateV132Evidence } from "./verify_community_stable_v132_evidence.mjs";

const tagCommit = "11841b88cf7b3e6d10502fd0158401e2c02167ae";
const portableSha256 = "D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD";
const checksumSha256 = "A3553273D4EE693FED5B9DB50C83A675EB0C1650B022A75067C6A1A83CDB160D";
const archiveSha256 = "ED91C071372B08BECAC0D7DA258B1B80154C2C25834FCCA87F338A33A592024E";
const hash = (letter) => letter.repeat(64);
const sourceCounts = {
  activity_tracking_state: 1,
  focus_sessions: 0,
  occurrences: 0,
  pet_interactions: 0,
  reminders: 2,
  settings: 1,
  water_log: 0,
};
const captureIds = [
  "source_integrity",
  "v132_schema_identity",
  "source_stability",
  "sqlite_backup",
  "logical_identity",
];
const migrationIds = [
  "source_read_only",
  "source_integrity",
  "v132_schema_identity",
  "production_migration",
  "row_preservation",
  "backup_restore",
  "failed_restore_rollback",
  "post_restore_health",
];
const checks = (ids) => ids.map((id) => ({ id, passed: true, detail: `${id} completed successfully` }));

function fixture() {
  const observed = {
    source: {
      branch: "feat/unified-v1-5",
      commit: "2e4496e93f469846bbe149df6f04ad643091c248",
      dirty: false,
    },
    sourceMetadataSha256: hash("A"),
    webView2MetadataSha256: hash("B"),
    v132PortableSha256: portableSha256,
    v132ChecksumSha256: checksumSha256,
    v132TagArchiveSha256: archiveSha256,
    captureHelperSha256: hash("C"),
    migrationHelperSha256: hash("D"),
    captureScriptSha256: hash("E"),
    hostScriptSha256: hash("F"),
    fixtureSha256: hash("1"),
    fixtureBytes: 77_824,
    captureReportSha256: hash("2"),
    provenanceReportSha256: hash("3"),
    migrationReportSha256: hash("4"),
    currentSchemaVersion: 12,
  };
  const sourceMetadata = {
    schemaVersion: 1,
    capturedAt: "2026-08-27T07:10:39.145Z",
    branch: observed.source.branch,
    commit: observed.source.commit,
    dirty: false,
    v132TagCommit: tagCommit,
    v132PortableSha256: portableSha256,
    v132ChecksumSha256: checksumSha256,
    v132TagArchiveSha256: archiveSha256,
    captureHelperSha256: observed.captureHelperSha256,
    migrationHelperSha256: observed.migrationHelperSha256,
    captureScriptSha256: observed.captureScriptSha256,
    hostScriptSha256: observed.hostScriptSha256,
    webView2Sha256: hash("5"),
    webView2Version: "151.0.4129.107",
  };
  const webView = {
    schemaVersion: 1,
    source: "installed-host-microsoft-webview2-runtime",
    bytes: 4_000_000,
    sha256: sourceMetadata.webView2Sha256,
    signatureStatus: "Valid",
    signerSubject: "CN=Microsoft Windows, O=Microsoft Corporation, C=US",
    productVersion: sourceMetadata.webView2Version,
  };
  const capture = {
    schemaVersion: 1,
    status: "passed",
    generatedAt: "2026-08-27T07:11:00.000Z",
    expectedSourceRelease: "1.3.2",
    sourceReleaseEvidence: "exact_tag_runtime_plus_operator_attestation",
    sourceDatabaseVersion: 6,
    sourceMainSizeBytes: 4096,
    sourceMainSha256: hash("6"),
    sourceWalPresent: true,
    sourceWalSizeBytes: 214_272,
    sourceWalSha256: hash("A"),
    sourceShmPresent: true,
    sourceStableDuringCapture: true,
    fixtureFileName: "authentic-v1.3.2.sqlite3",
    fixtureSizeBytes: observed.fixtureBytes,
    fixtureSha256: observed.fixtureSha256,
    fixtureLogicalSha256: hash("B"),
    fixtureTableCounts: { ...sourceCounts },
    checks: checks(captureIds),
    privacy: "Contains no paths and no user content.",
  };
  const provenance = {
    schemaVersion: 1,
    status: "passed",
    generatedAt: "2026-08-27T07:11:01.000Z",
    sourceRelease: {
      version: "1.3.2",
      gitTag: "v1.3.2",
      gitCommit: tagCommit,
      distributionChannel: "github_release_asset",
      releasePage: "https://github.com/brucexia007-ui/yuanyuan-reminder/releases/tag/v1.3.2",
      releaseAssetFileName: "Yuanyuan-Reminder-1.3.2-x64-Portable.exe",
      tagArchiveSha256: archiveSha256,
      tagArchiveMatchesRepository: true,
      executableSha256: portableSha256,
      executableSizeBytes: 20_574_720,
      productVersion: "1.3.2",
      fileVersion: "1.3.2",
      releaseChecksumFileName: "SHA256SUMS.txt",
      releaseChecksumFileSha256: checksumSha256,
      releaseChecksumMatched: true,
      stagedCopyHashMatched: true,
    },
    execution: {
      interactiveSession: true,
      freshTestAccountAcknowledged: true,
      tokenProfileResolvedThroughRegistry: true,
      preexistingDataRoot: false,
      preexistingApplicationProcessCount: 0,
      launchUtc: "2026-08-27T07:10:45.000Z",
      visibleWindowObserved: true,
      runtimeDatabaseCreated: true,
      childStreamsRedirected: false,
      stagedInTestProfileTemp: true,
      webViewJavascriptDisabledForInitialization: true,
      terminationMode: "owned_process_tree_forced_after_initialization",
      processTreeStopped: true,
      dataRootRemoved: true,
      stageRemoved: true,
    },
    capture: {
      executableSha256: observed.captureHelperSha256,
      reportFileName: "v132-capture-report.json",
      reportSha256: observed.captureReportSha256,
      fixtureFileName: "authentic-v1.3.2.sqlite3",
      fixtureSha256: observed.fixtureSha256,
      fixtureSizeBytes: observed.fixtureBytes,
      databaseVersion: 6,
    },
    limitations: ["Unsigned asset identity is verified by exact release hashes."],
    privacy: "Contains no paths and no user content.",
  };
  const migration = {
    schemaVersion: 1,
    status: "passed",
    generatedAt: "2026-08-27T07:11:02.000Z",
    expectedSourceRelease: "1.3.2",
    sourceReleaseEvidence: "operator_attested_copy_plus_schema_version_6",
    sourceReleaseEvidenceLimit: "Schema version alone does not prove release provenance.",
    sourceFileName: "authentic-v1.3.2.sqlite3",
    sourceSizeBytes: observed.fixtureBytes,
    sourceSha256: observed.fixtureSha256,
    sourceDatabaseVersion: 6,
    migratedDatabaseVersion: 12,
    sourceLogicalSha256: capture.fixtureLogicalSha256,
    migratedMatchedSourceRowsSha256: capture.fixtureLogicalSha256,
    sourceTableCounts: { ...sourceCounts },
    migratedTableCounts: {
      ...sourceCounts,
      companion_attention_budget: 1,
      companion_proactive_attention: 0,
      task_watch_attention_deferrals: 0,
    },
    checks: checks(migrationIds),
    privacy: "Contains no paths and no user content.",
  };
  const status = {
    schemaVersion: 1,
    generatedAt: "2026-08-27T07:11:03.000Z",
    profile: "community-stable-authentic-v132",
    sandboxUser: "WDAGUtilityAccount",
    interactiveSession: true,
    source: structuredClone(sourceMetadata),
    sourceMetadataSha256: observed.sourceMetadataSha256,
    webView2MetadataSha256: observed.webView2MetadataSha256,
    mappedMicrosoftWebView2RuntimeVerified: true,
    temporaryWebView2DetectionRegistration: true,
    authenticRuntimeDatabaseCreated: true,
    authenticCapturePassed: true,
    migrationBackupRollbackPassed: true,
    formalUserDataUsed: false,
    sandboxDataCleaned: true,
    fixtureSha256: observed.fixtureSha256,
    captureReportSha256: observed.captureReportSha256,
    provenanceReportSha256: observed.provenanceReportSha256,
    migrationReportSha256: observed.migrationReportSha256,
    ready: true,
    failure: null,
  };
  return { status, sourceMetadata, webView, capture, provenance, migration, observed };
}

test("accepts complete authentic v1.3.2 migration evidence", () => {
  assert.doesNotThrow(() => validateV132Evidence(fixture()));
});

test("rejects a missing migration rollback result", () => {
  const input = fixture();
  input.migration.checks.find(({ id }) => id === "failed_restore_rollback").passed = false;
  assert.throws(() => validateV132Evidence(input), /failed_restore_rollback/u);
});

test("rejects stale release and fixture bindings", () => {
  const release = fixture();
  release.sourceMetadata.v132PortableSha256 = hash("0");
  release.status.source.v132PortableSha256 = hash("0");
  assert.throws(() => validateV132Evidence(release), /v1\.3\.2 portable/u);

  const database = fixture();
  database.capture.fixtureSha256 = hash("9");
  assert.throws(() => validateV132Evidence(database), /capture fixture digest/u);
});

test("rejects dirty formal evidence while allowing development evidence", () => {
  const input = fixture();
  input.observed.source.dirty = true;
  input.sourceMetadata.dirty = true;
  input.status.source.dirty = true;
  assert.throws(() => validateV132Evidence(input), /clean checkout/u);
  assert.doesNotThrow(() => validateV132Evidence({ ...input, requireClean: false }));
});

test("current v1.3.2 evidence uses a version-neutral migration report name", async () => {
  const [host, verifier, draft] = await Promise.all([
    readFile(new URL("./run_community_stable_v132_sandbox_probe_host.ps1", import.meta.url), "utf8"),
    readFile(new URL("./verify_community_stable_v132_evidence.mjs", import.meta.url), "utf8"),
    readFile(new URL("./prepare_community_stable_acceptance_draft.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [host, verifier, draft]) {
    assert.match(source, /current-migration-report\.json/u);
    assert.doesNotMatch(source, /v153-migration-report|v1\.5\.3 migration/u);
  }
});

test("v1.3.2 public E2E builds, runs, and independently verifies under runtime guards", async () => {
  const [wrapper, helperWrapper, host, packageJson] = await Promise.all([
    readFile(new URL("./run_community_stable_v132_sandbox_probe_guarded.ps1", import.meta.url), "utf8"),
    readFile(new URL("./build_community_stable_v132_sandbox_helpers_guarded.ps1", import.meta.url), "utf8"),
    readFile(new URL("./run_community_stable_v132_sandbox_probe_host.ps1", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const wrapperExclusiveIndex = wrapper.indexOf("Assert-YuanyuanRuntimeQaExclusive");
  const wrapperHelperIndex = wrapper.indexOf("& npm.cmd run release:community:v132-sandbox:helper");
  const wrapperHostIndex = wrapper.indexOf("& powershell.exe");
  const wrapperVerifierIndex = wrapper.indexOf('"scripts/verify_community_stable_v132_evidence.mjs"');
  const allowDirtyConditionIndex = wrapper.indexOf("if ($AllowDirty)");
  const allowDirtyForwardIndex = wrapper.indexOf('$verificationArguments += "--allow-dirty"');
  assert.ok(
    wrapperExclusiveIndex >= 0 &&
      wrapperHelperIndex > wrapperExclusiveIndex &&
      wrapperHostIndex > wrapperHelperIndex &&
      wrapperVerifierIndex > wrapperHostIndex,
  );
  assert.ok(allowDirtyConditionIndex >= 0 && allowDirtyForwardIndex > allowDirtyConditionIndex);
  assert.match(wrapper, /YUANYUAN_V132_EVIDENCE_ROOT=/u);
  assert.match(wrapper, /evidenceMarkers\.Count -ne 1/u);
  assert.match(wrapper, /\[IO\.Path\]::IsPathRooted\(\$evidenceRoot\)/u);
  const helperExclusiveIndex = helperWrapper.indexOf("Assert-YuanyuanRuntimeQaExclusive");
  const helperBuildIndex = helperWrapper.indexOf("& cargo build");
  assert.ok(helperExclusiveIndex >= 0 && helperBuildIndex > helperExclusiveIndex);
  assert.match(helperWrapper, /--locked/u);
  assert.match(helperWrapper, /--features migration-qa/u);
  assert.match(helperWrapper, /--bin yuanyuan-database-migration-qa\s/u);
  assert.match(helperWrapper, /--bin yuanyuan-database-migration-qa-capture/u);
  assert.match(
    packageJson.scripts["release:community:v132-sandbox:helper"],
    /build_community_stable_v132_sandbox_helpers_guarded\.ps1/u,
  );
  assert.match(
    packageJson.scripts["release:community:v132-sandbox"],
    /run_community_stable_v132_sandbox_probe_guarded\.ps1/u,
  );
  const hostExclusiveIndex = host.indexOf("Assert-YuanyuanRuntimeQaExclusive");
  const hostSandboxIndex = host.indexOf("WindowsSandbox.exe");
  assert.ok(hostExclusiveIndex >= 0 && hostSandboxIndex > hostExclusiveIndex);
  assert.match(host, /YUANYUAN_V132_EVIDENCE_ROOT=\$outputRoot/u);
});
