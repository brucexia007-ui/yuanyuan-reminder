import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeReleaseRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa",
  "release",
);
const evidenceRoot = path.join(runtimeReleaseRoot, "evidence");
const applicationPath = path.join(runtimeReleaseRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeReleaseRoot, "yuanyuan-runtime-qa-fixture.exe");
const measureScriptPath = path.join(projectRoot, "scripts", "measure_diagnostic_card.ps1");
const backdropScriptPath = path.join(projectRoot, "scripts", "run_neutral_capture_backdrop.py");

const LIMITATIONS = [
  "This run covers one Windows desktop and its active DPI configuration.",
  "UI Automation and injected Enter/Tab keys do not replace Narrator human listening.",
  "The exported diagnostic contains fixed synthetic runtime-QA metadata and no authentic user data.",
  "This does not replace 100%, 125%, 150%, and 200% DPI matrix review.",
];
const SHA256 = /^[0-9A-F]{64}$/;
const REPORT_NAME = /^diagnostic-card-(\d{8}T\d{6}Z)\.json$/;
const ALLOWED_DPI = new Set([96, 120, 144, 192]);

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function closeEnough(actual, expected, tolerance = 0.11) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

const DIAGNOSTIC_CODES = new Set([
  "input_too_large",
  "invalid_json",
  "invalid_protocol",
  "sink_unavailable",
  "queue_full",
  "timeout",
  "sink_rejected",
  "authentication_failed",
  "authentication_unavailable",
  "authentication_paused",
  "replay_rejected",
]);
const FORBIDDEN_EXPORT_MARKERS = [
  "password",
  "passwd",
  "secret",
  "credential",
  "access_token",
  "refresh_token",
  "authorization",
  "workspace",
  "prompt",
  "task_title",
  "task_id",
  "user_name",
  "username",
  "private_key",
  "sk-",
  "ghp_",
  "github_pat_",
  "akia",
  "bearer ",
  "-----begin ",
  ":\\",
  "\\\\",
  "file://",
  "/home/",
  "/users/",
  "%userprofile%",
  "@",
];

export function inspectDiagnosticExport(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 1 || bytes.length > 65_537) {
    throw new Error("diagnostic export has an invalid byte boundary");
  }
  if (bytes.at(-1) !== 0x0a) {
    throw new Error("diagnostic export lacks its canonical trailing newline");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1));
  const value = JSON.parse(text);
  if (
    !hasExactKeys(value, [
      "schema_version",
      "generated_at_unix_ms",
      "core_version",
      "task_event_protocol_version",
      "control_protocol_version",
      "ai_status",
      "bridge_diagnostics",
      "queue",
    ]) ||
    value.schema_version !== 1 ||
    !Number.isSafeInteger(value.generated_at_unix_ms) ||
    value.generated_at_unix_ms <= 0 ||
    typeof value.core_version !== "string" ||
    !/^[A-Za-z0-9._+-]{1,32}$/.test(value.core_version) ||
    !Number.isInteger(value.task_event_protocol_version) ||
    value.task_event_protocol_version <= 0 ||
    !Number.isInteger(value.control_protocol_version) ||
    value.control_protocol_version <= 0 ||
    !new Set([
      "not_installed",
      "unavailable",
      "starting",
      "running",
      "backing_off",
      "circuit_open",
      "stopped",
    ]).has(value.ai_status) ||
    !Array.isArray(value.bridge_diagnostics) ||
    value.bridge_diagnostics.length > DIAGNOSTIC_CODES.size ||
    !hasExactKeys(value.queue, ["pending_files", "pending_bytes", "quarantined_files"]) ||
    ![value.queue.pending_files, value.queue.pending_bytes, value.queue.quarantined_files].every(
      (item) => Number.isSafeInteger(item) && item >= 0,
    )
  ) {
    throw new Error("diagnostic export schema is invalid");
  }
  const codes = new Set();
  for (const entry of value.bridge_diagnostics) {
    if (
      !hasExactKeys(entry, ["code", "count"]) ||
      !DIAGNOSTIC_CODES.has(entry.code) ||
      codes.has(entry.code) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0
    ) {
      throw new Error("diagnostic export counters are invalid");
    }
    codes.add(entry.code);
  }
  const lower = text.toLowerCase();
  const sensitiveMatches = FORBIDDEN_EXPORT_MARKERS.filter((marker) =>
    lower.includes(marker),
  ).length;
  if (sensitiveMatches !== 0) {
    throw new Error("diagnostic export contains a forbidden marker");
  }
  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    schemaVersion: value.schema_version,
    sensitiveMatches,
  };
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

export function inspectDiagnosticPng(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const signature = Buffer.from("89504E470D0A1A0A", "hex");
  if (source.length < 33 || !source.subarray(0, 8).equals(signature)) {
    throw new Error("diagnostic screenshot is not a PNG");
  }

  let offset = 8;
  let header = null;
  const imageParts = [];
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > source.length) throw new Error("diagnostic PNG is truncated");
    const data = source.subarray(dataStart, dataEnd);
    if (type === "IHDR") header = data;
    if (type === "IDAT") imageParts.push(data);
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }
  if (!header || header.length !== 13 || imageParts.length === 0) {
    throw new Error("diagnostic PNG lacks required chunks");
  }

  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const compression = header[10];
  const filterMethod = header[11];
  const interlace = header[12];
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (
    width <= 0 ||
    height <= 0 ||
    bitDepth !== 8 ||
    bytesPerPixel === 0 ||
    compression !== 0 ||
    filterMethod !== 0 ||
    interlace !== 0
  ) {
    throw new Error("diagnostic PNG uses an unsupported pixel format");
  }

  const rowBytes = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(imageParts));
  if (inflated.length !== (rowBytes + 1) * height) {
    throw new Error("diagnostic PNG scanlines are inconsistent");
  }

  let sourceOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  const distinct = new Set();
  let minimumLuminance = 255;
  let maximumLuminance = 0;
  let chromaticPixelCount = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    if (filter > 4) throw new Error("diagnostic PNG has an invalid row filter");
    const row = Buffer.allocUnsafe(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset];
      sourceOffset += 1;
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
      row[x] = (raw + predictor) & 0xff;
    }
    for (let x = 0; x < rowBytes; x += bytesPerPixel) {
      const red = row[x];
      const green = row[x + 1];
      const blue = row[x + 2];
      if (distinct.size <= 256) distinct.add((red << 16) | (green << 8) | blue);
      const luminance = Math.round((299 * red + 587 * green + 114 * blue) / 1000);
      minimumLuminance = Math.min(minimumLuminance, luminance);
      maximumLuminance = Math.max(maximumLuminance, luminance);
      if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 6) {
        chromaticPixelCount += 1;
      }
    }
    previous = row;
  }
  return {
    width,
    height,
    distinctRgbCount: distinct.size,
    luminanceRange: maximumLuminance - minimumLuminance,
    chromaticPixelCount,
  };
}

function validBounds(bounds, display) {
  return (
    hasExactKeys(bounds, ["left", "top", "width", "height"]) &&
    [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.left >= display.left &&
    bounds.top >= display.top &&
    bounds.left + bounds.width <= display.right + 0.1 &&
    bounds.top + bounds.height <= display.bottom + 0.1
  );
}

export function validateDiagnosticCardEvidence(
  report,
  expectedBindings,
  { reportFile, screenshotArtifacts, exportArtifact } = {},
) {
  if (
    !hasExactKeys(report, [
      "schemaVersion",
      "generatedAt",
      "profile",
      "bindings",
      "display",
      "accessibility",
      "keyboard",
      "privacy",
      "isolation",
      "process",
      "screenshots",
      "export",
      "ready",
      "limitations",
    ]) ||
    report.schemaVersion !== 2 ||
    report.profile !== "diagnostic-card" ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS)
  ) {
    return false;
  }

  if (
    !hasExactKeys(report.bindings, [
      "applicationSha256",
      "fixtureSha256",
      "scriptSha256",
      "backdropScriptSha256",
    ]) ||
    Object.keys(report.bindings).some((key) => !SHA256.test(report.bindings[key])) ||
    Object.keys(report.bindings).some((key) => report.bindings[key] !== expectedBindings[key])
  ) {
    return false;
  }

  const display = report.display;
  if (
    !hasExactKeys(display, [
      "dpi",
      "scalePercent",
      "left",
      "top",
      "right",
      "bottom",
      "physicalWidth",
      "physicalHeight",
      "logicalWidth",
      "logicalHeight",
    ]) ||
    !ALLOWED_DPI.has(display.dpi) ||
    ![display.left, display.top, display.right, display.bottom].every(Number.isInteger) ||
    display.right <= display.left ||
    display.bottom <= display.top ||
    display.physicalWidth !== display.right - display.left ||
    display.physicalHeight !== display.bottom - display.top ||
    !closeEnough(display.scalePercent, (display.dpi * 100) / 96, 0.01) ||
    !closeEnough(display.logicalWidth, (display.physicalWidth * 96) / display.dpi) ||
    !closeEnough(display.logicalHeight, (display.physicalHeight * 96) / display.dpi) ||
    display.logicalWidth < 390 ||
    display.logicalWidth > 420 ||
    display.logicalHeight < 610 ||
    display.logicalHeight > 650
  ) {
    return false;
  }

  const accessibility = report.accessibility;
  const bounds = [
    accessibility?.triggerBounds,
    accessibility?.previewBounds,
    accessibility?.confirmBounds,
    accessibility?.cancelBounds,
  ];
  const boundsInside = bounds.every((value) => validBounds(value, display));
  if (
    !hasExactKeys(accessibility, [
      "titleObserved",
      "statusObserved",
      "previewRegionObserved",
      "criticalBoundsInsideWindow",
      "triggerBounds",
      "previewBounds",
      "confirmBounds",
      "cancelBounds",
    ]) ||
    accessibility.titleObserved !== true ||
    accessibility.statusObserved !== true ||
    accessibility.previewRegionObserved !== true ||
    accessibility.criticalBoundsInsideWindow !== boundsInside ||
    !boundsInside
  ) {
    return false;
  }

  if (
    !hasExactKeys(report.keyboard, [
      "initialFocus",
      "focusAfterOpen",
      "focusAfterTab",
      "focusAfterCancel",
    ]) ||
    report.keyboard.initialFocus !== "查看诊断快照内容" ||
    report.keyboard.focusAfterOpen !== "选择保存位置" ||
    report.keyboard.focusAfterTab !== "取消" ||
    report.keyboard.focusAfterCancel !== "查看诊断快照内容" ||
    !hasExactKeys(report.privacy, [
      "prelaunchNeutralBackdropUsed",
      "panelTemporarilyTopmostForCapture",
      "backdropControlledExit",
      "captureScope",
    ]) ||
    report.privacy.prelaunchNeutralBackdropUsed !== true ||
    report.privacy.panelTemporarilyTopmostForCapture !== true ||
    report.privacy.backdropControlledExit !== true ||
    report.privacy.captureScope !== "single_panel_window_over_prelaunch_neutral_backdrop" ||
    !hasExactKeys(report.isolation, [
      "formalUserFilesWritten",
      "applicationErrorQueryAvailable",
      "applicationErrorCount",
      "qaRootRemoved",
    ]) ||
    report.isolation.formalUserFilesWritten !== 0 ||
    report.isolation.applicationErrorQueryAvailable !== true ||
    report.isolation.applicationErrorCount !== 0 ||
    report.isolation.qaRootRemoved !== true ||
    !hasExactKeys(report.process, ["controlledExit", "exitCode"]) ||
    report.process.controlledExit !== true ||
    report.process.exitCode !== 0
  ) {
    return false;
  }

  const match = typeof reportFile === "string" ? REPORT_NAME.exec(reportFile) : null;
  if (!match || !hasExactKeys(report.screenshots, ["initial", "preview"])) return false;
  const expectedScreenshotNames = {
    initial: `diagnostic-card-${match[1]}-initial.png`,
    preview: `diagnostic-card-${match[1]}-preview.png`,
  };
  for (const kind of ["initial", "preview"]) {
    const screenshot = report.screenshots[kind];
    const artifact = screenshotArtifacts?.[expectedScreenshotNames[kind]];
    if (
      !hasExactKeys(screenshot, ["file", "sha256"]) ||
      screenshot.file !== expectedScreenshotNames[kind] ||
      !SHA256.test(screenshot.sha256) ||
      !artifact ||
      screenshot.sha256 !== artifact.sha256 ||
      artifact.width !== display.physicalWidth ||
      artifact.height !== display.physicalHeight ||
      artifact.distinctRgbCount < 16 ||
      artifact.luminanceRange < 32 ||
      artifact.chromaticPixelCount < 100
    ) {
      return false;
    }
  }
  let inspectedExport;
  try {
    inspectedExport = inspectDiagnosticExport(exportArtifact);
  } catch {
    return false;
  }
  const expectedExportName = `diagnostic-card-${match[1]}-export.json`;
  if (
    !hasExactKeys(report.export, [
      "nativeSaveDialogObserved",
      "nativeSaveDialogClosed",
      "selectedLocationUsed",
      "file",
      "sha256",
      "bytes",
      "schemaVersion",
      "sensitiveScanStatus",
      "sensitiveScanVersion",
      "sensitiveScanChecks",
      "sensitiveMatches",
      "selectedPathReturned",
      "internalCopyCreated",
      "automaticUpload",
    ]) ||
    report.export.nativeSaveDialogObserved !== true ||
    report.export.nativeSaveDialogClosed !== true ||
    report.export.selectedLocationUsed !== true ||
    report.export.file !== expectedExportName ||
    report.export.sha256 !== inspectedExport.sha256 ||
    report.export.bytes !== inspectedExport.bytes ||
    report.export.schemaVersion !== inspectedExport.schemaVersion ||
    report.export.sensitiveScanStatus !== "clean" ||
    report.export.sensitiveScanVersion !== 1 ||
    report.export.sensitiveScanChecks !== 4 ||
    report.export.sensitiveMatches !== inspectedExport.sensitiveMatches ||
    report.export.selectedPathReturned !== false ||
    report.export.internalCopyCreated !== false ||
    report.export.automaticUpload !== false
  ) {
    return false;
  }
  return report.ready === true;
}

export function parseDiagnosticCardEvidence(reportBytes) {
  const text = Buffer.isBuffer(reportBytes)
    ? reportBytes.toString("utf8")
    : Buffer.from(reportBytes).toString("utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

async function readOrdinaryFile(absolutePath, description) {
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${description} must be an ordinary file`);
  }
  return readFile(absolutePath);
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length !== 2 || arguments_[0] !== "--report") {
    throw new Error(
      "usage: node scripts/verify_diagnostic_card_evidence.mjs --report <absolute-json>",
    );
  }
  const reportPath = arguments_[1];
  const reportName = path.basename(reportPath);
  const match = REPORT_NAME.exec(reportName);
  if (
    !path.isAbsolute(reportPath) ||
    path.dirname(path.resolve(reportPath)) !== path.resolve(evidenceRoot) ||
    !match
  ) {
    throw new Error("diagnostic card report must be in the owned evidence directory");
  }

  const reportBytes = await readOrdinaryFile(reportPath, "diagnostic card report");
  let report;
  try {
    report = parseDiagnosticCardEvidence(reportBytes);
  } catch {
    throw new Error("diagnostic card report is not valid JSON");
  }

  const screenshotNames = [
    `diagnostic-card-${match[1]}-initial.png`,
    `diagnostic-card-${match[1]}-preview.png`,
  ];
  const exportName = `diagnostic-card-${match[1]}-export.json`;
  const [application, fixture, measureScript, backdropScript, exportArtifact, ...screenshots] =
    await Promise.all([
      readOrdinaryFile(applicationPath, "runtime QA application"),
      readOrdinaryFile(fixturePath, "runtime QA fixture"),
      readOrdinaryFile(measureScriptPath, "diagnostic measure script"),
      readOrdinaryFile(backdropScriptPath, "privacy backdrop script"),
      readOrdinaryFile(path.join(evidenceRoot, exportName), "diagnostic export"),
      ...screenshotNames.map((name) =>
        readOrdinaryFile(path.join(evidenceRoot, name), "diagnostic screenshot"),
      ),
    ]);
  const expectedBindings = {
    applicationSha256: sha256(application),
    fixtureSha256: sha256(fixture),
    scriptSha256: sha256(measureScript),
    backdropScriptSha256: sha256(backdropScript),
  };
  const screenshotArtifacts = Object.fromEntries(
    screenshotNames.map((name, index) => [
      name,
      { sha256: sha256(screenshots[index]), ...inspectDiagnosticPng(screenshots[index]) },
    ]),
  );
  if (
    !validateDiagnosticCardEvidence(report, expectedBindings, {
      reportFile: reportName,
      screenshotArtifacts,
      exportArtifact,
    })
  ) {
    throw new Error("diagnostic card evidence is pending, stale, blank, or inconsistent");
  }
  console.log(
    `Diagnostic card evidence passed: ${report.display.scalePercent}% DPI, ${report.display.logicalWidth}x${report.display.logicalHeight} logical pixels.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
