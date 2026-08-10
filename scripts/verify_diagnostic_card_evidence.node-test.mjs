import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseDiagnosticCardEvidence,
  validateDiagnosticCardEvidence,
} from "./verify_diagnostic_card_evidence.mjs";

const RUN = "20260808T194020Z";
const REPORT_FILE = `diagnostic-card-${RUN}.json`;
const BINDINGS = {
  applicationSha256: "A".repeat(64),
  fixtureSha256: "B".repeat(64),
  scriptSha256: "C".repeat(64),
  backdropScriptSha256: "D".repeat(64),
};

function screenshotArtifacts(width = 607, height = 943) {
  return {
    [`diagnostic-card-${RUN}-initial.png`]: {
      sha256: "E".repeat(64),
      width,
      height,
      distinctRgbCount: 257,
      luminanceRange: 180,
      chromaticPixelCount: 20_000,
    },
    [`diagnostic-card-${RUN}-preview.png`]: {
      sha256: "F".repeat(64),
      width,
      height,
      distinctRgbCount: 257,
      luminanceRange: 180,
      chromaticPixelCount: 20_000,
    },
  };
}

function diagnosticExport(overrides = {}) {
  const value = {
    schema_version: 1,
    generated_at_unix_ms: 1_755_000_000_000,
    core_version: "1.4.0",
    task_event_protocol_version: 1,
    control_protocol_version: 1,
    ai_status: "circuit_open",
    bridge_diagnostics: [
      { code: "queue_full", count: 1 },
      { code: "timeout", count: 3 },
    ],
    queue: { pending_files: 3, pending_bytes: 12_480, quarantined_files: 1 },
    ...overrides,
  };
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function exportHash(bytes = diagnosticExport()) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function validEvidence() {
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-08T19:40:58.651Z",
    profile: "diagnostic-card",
    bindings: { ...BINDINGS },
    display: {
      dpi: 144,
      scalePercent: 150,
      left: 1627,
      top: 579,
      right: 2234,
      bottom: 1522,
      physicalWidth: 607,
      physicalHeight: 943,
      logicalWidth: 404.7,
      logicalHeight: 628.7,
    },
    accessibility: {
      titleObserved: true,
      statusObserved: true,
      previewRegionObserved: true,
      criticalBoundsInsideWindow: true,
      triggerBounds: { left: 1692, top: 1119, width: 168, height: 45 },
      previewBounds: { left: 1692, top: 1119, width: 459, height: 254 },
      confirmBounds: { left: 1708, top: 1311, width: 102, height: 46 },
      cancelBounds: { left: 1820, top: 1311, width: 68, height: 46 },
    },
    keyboard: {
      initialFocus: "查看诊断快照内容",
      focusAfterOpen: "选择保存位置",
      focusAfterTab: "取消",
      focusAfterCancel: "查看诊断快照内容",
    },
    privacy: {
      prelaunchNeutralBackdropUsed: true,
      panelTemporarilyTopmostForCapture: true,
      backdropControlledExit: true,
      captureScope: "single_panel_window_over_prelaunch_neutral_backdrop",
    },
    isolation: {
      formalUserFilesWritten: 0,
      applicationErrorQueryAvailable: true,
      applicationErrorCount: 0,
      qaRootRemoved: true,
    },
    process: { controlledExit: true, exitCode: 0 },
    screenshots: {
      initial: {
        file: `diagnostic-card-${RUN}-initial.png`,
        sha256: "E".repeat(64),
      },
      preview: {
        file: `diagnostic-card-${RUN}-preview.png`,
        sha256: "F".repeat(64),
      },
    },
    export: {
      nativeSaveDialogObserved: true,
      nativeSaveDialogClosed: true,
      selectedLocationUsed: true,
      file: `diagnostic-card-${RUN}-export.json`,
      sha256: exportHash(),
      bytes: diagnosticExport().length,
      schemaVersion: 1,
      sensitiveScanStatus: "clean",
      sensitiveScanVersion: 1,
      sensitiveScanChecks: 4,
      sensitiveMatches: 0,
      selectedPathReturned: false,
      internalCopyCreated: false,
      automaticUpload: false,
    },
    ready: true,
    limitations: [
      "This run covers one Windows desktop and its active DPI configuration.",
      "UI Automation and injected Enter/Tab keys do not replace Narrator human listening.",
      "The exported diagnostic contains fixed synthetic runtime-QA metadata and no authentic user data.",
      "This does not replace 100%, 125%, 150%, and 200% DPI matrix review.",
    ],
  };
}

function validate(
  report,
  artifacts = screenshotArtifacts(),
  bindings = BINDINGS,
  exported = diagnosticExport(),
) {
  return validateDiagnosticCardEvidence(report, bindings, {
    reportFile: REPORT_FILE,
    screenshotArtifacts: artifacts,
    exportArtifact: exported,
  });
}

test("accepts source-bound, non-blank diagnostic card evidence", () => {
  assert.equal(validate(validEvidence()), true);
});

test("parses UTF-8 evidence with or without a Windows BOM", () => {
  const evidence = validEvidence();
  const json = JSON.stringify(evidence);
  assert.deepEqual(parseDiagnosticCardEvidence(Buffer.from(json)), evidence);
  assert.deepEqual(
    parseDiagnosticCardEvidence(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
    ),
    evidence,
  );
});

test("rejects stale bindings and unknown report fields", () => {
  assert.equal(validate(validEvidence(), screenshotArtifacts(), { ...BINDINGS, scriptSha256: "0".repeat(64) }), false);
  assert.equal(validate({ ...validEvidence(), machineName: "must-not-exist" }), false);
});

test("rejects virtualized dimensions and out-of-window accessible bounds", () => {
  const virtualized = validEvidence();
  virtualized.display.physicalWidth = 405;
  assert.equal(validate(virtualized), false);

  const clipped = validEvidence();
  clipped.accessibility.cancelBounds.left = 2200;
  clipped.accessibility.cancelBounds.width = 80;
  assert.equal(validate(clipped), false);
});

test("rejects broken keyboard, privacy, isolation, or process gates", () => {
  const focus = validEvidence();
  focus.keyboard.focusAfterCancel = "";
  assert.equal(validate(focus), false);

  const privacy = validEvidence();
  privacy.privacy.panelTemporarilyTopmostForCapture = false;
  assert.equal(validate(privacy), false);

  const writes = validEvidence();
  writes.isolation.formalUserFilesWritten = 1;
  assert.equal(validate(writes), false);

  const exit = validEvidence();
  exit.process.exitCode = 1;
  assert.equal(validate(exit), false);
});

test("rejects stale, wrong-sized, or visually blank screenshots", () => {
  const stale = screenshotArtifacts();
  stale[`diagnostic-card-${RUN}-initial.png`].sha256 = "0".repeat(64);
  assert.equal(validate(validEvidence(), stale), false);

  assert.equal(validate(validEvidence(), screenshotArtifacts(405, 629)), false);

  const blank = screenshotArtifacts();
  blank[`diagnostic-card-${RUN}-preview.png`].distinctRgbCount = 1;
  blank[`diagnostic-card-${RUN}-preview.png`].luminanceRange = 0;
  blank[`diagnostic-card-${RUN}-preview.png`].chromaticPixelCount = 0;
  assert.equal(validate(validEvidence(), blank), false);
});

test("rejects stale, sensitive, or optimistic native export evidence", () => {
  const stale = validEvidence();
  stale.export.sha256 = "0".repeat(64);
  assert.equal(validate(stale), false);

  const sensitive = diagnosticExport({ core_version: "sk-live-canary" });
  const sensitiveReport = validEvidence();
  sensitiveReport.export.sha256 = exportHash(sensitive);
  sensitiveReport.export.bytes = sensitive.length;
  assert.equal(validate(sensitiveReport, screenshotArtifacts(), BINDINGS, sensitive), false);

  const exposed = validEvidence();
  exposed.export.selectedPathReturned = true;
  assert.equal(validate(exposed), false);
});
