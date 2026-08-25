import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "runtime-qa-learning-accessibility",
  "release",
);
const applicationPath = path.join(runtimeRoot, "yuanyuan-reminder.exe");
const fixturePath = path.join(runtimeRoot, "yuanyuan-runtime-qa-fixture.exe");
const stylesheetPath = path.join(projectRoot, "src", "learning", "learningDesktop.css");
const scriptPath = path.join(
  projectRoot,
  "scripts",
  "measure_learning_accessibility_matrix.ps1",
);

const SHA256 = /^[A-F0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MODES = ["standard", "reduced-motion", "forced-colors"];
const BROWSER_ARGUMENTS = {
  standard: "",
  "reduced-motion": "--force-prefers-reduced-motion",
  "forced-colors": "--force-high-contrast --enable-blink-features=ForcedColors",
};
const PANEL_SIZES = [
  { width: 360, height: 560 },
  { width: 390, height: 620 },
  { width: 480, height: 760 },
];
const CAPTURE_NAMES = [
  "standard-panel-360x560.png",
  "standard-panel-390x620.png",
  "standard-panel-480x760.png",
  "standard-blackboard-520x420.png",
  "reduced-motion-blackboard-520x420.png",
  "forced-colors-blackboard-520x420.png",
];
const REQUIRED_ACCESSIBLE_NAMES = [
  "圆圆桌面英语复习",
  "请选择中文释义",
  "结束本轮",
];
const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The five cards are deterministic synthetic content and contain no personal learning material.",
  "The window sizes are measured in Tauri logical pixels at the current real Windows DPI; other physical DPI settings, multiple displays, and negative coordinates remain manual checks.",
  "The runtime-QA panel starts at an allowlisted in-work-area logical position, and every measured native window must remain fully inside its current Windows work area.",
  "Reduced motion and forced colors use allowlisted arguments injected programmatically by the runtime-QA Tauri WebView builder, and each matching media state is confirmed in the accessibility tree; a human Windows setting and Narrator review remain manual checks.",
  "Windows UI Automation proves that the first answer can receive focus and exposes the required names; DOM auto-focus is covered separately, and a complete physical keyboard session remains manual.",
  "PrintWindow captures are restricted to isolated application-owned windows and do not capture the desktop.",
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

export function syntheticAccessibilityFixtureSha256() {
  let csv = "headword,meanings_zh\n";
  for (let index = 0; index < 5; index += 1) {
    csv += `qa${alphabeticIndex(index)},合成释义 ${index + 1}\n`;
  }
  return sha256(Buffer.from(csv, "utf8"));
}

function pngDimensions(bytes) {
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("capture is not a PNG with an IHDR header");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validateMetrics(metrics, expectedWidth, expectedHeight, errors, label) {
  if (
    !exactKeys(metrics, [
      "dpi",
      "scalePercent",
      "clientPhysicalWidth",
      "clientPhysicalHeight",
      "clientLogicalWidth",
      "clientLogicalHeight",
      "windowPhysicalWidth",
      "windowPhysicalHeight",
      "left",
      "top",
      "right",
      "bottom",
      "workAreaLeft",
      "workAreaTop",
      "workAreaRight",
      "workAreaBottom",
      "fullyWithinWorkArea",
    ])
  ) {
    errors.push(`${label} metrics schema is not exact`);
    return;
  }
  if (
    !Number.isInteger(metrics.dpi) ||
    metrics.dpi < 96 ||
    metrics.dpi > 768 ||
    !Number.isFinite(metrics.scalePercent) ||
    Math.abs(metrics.scalePercent - (metrics.dpi / 96) * 100) > 0.11 ||
    !Number.isInteger(metrics.clientPhysicalWidth) ||
    !Number.isInteger(metrics.clientPhysicalHeight) ||
    !Number.isInteger(metrics.windowPhysicalWidth) ||
    !Number.isInteger(metrics.windowPhysicalHeight) ||
    metrics.clientPhysicalWidth < 1 ||
    metrics.clientPhysicalHeight < 1 ||
    Math.abs(metrics.clientLogicalWidth - expectedWidth) > 1 ||
    Math.abs(metrics.clientLogicalHeight - expectedHeight) > 1 ||
    metrics.right <= metrics.left ||
    metrics.bottom <= metrics.top ||
    !Number.isInteger(metrics.workAreaLeft) ||
    !Number.isInteger(metrics.workAreaTop) ||
    !Number.isInteger(metrics.workAreaRight) ||
    !Number.isInteger(metrics.workAreaBottom) ||
    metrics.workAreaRight <= metrics.workAreaLeft ||
    metrics.workAreaBottom <= metrics.workAreaTop ||
    metrics.fullyWithinWorkArea !== true ||
    metrics.left < metrics.workAreaLeft ||
    metrics.top < metrics.workAreaTop ||
    metrics.right > metrics.workAreaRight ||
    metrics.bottom > metrics.workAreaBottom
  ) {
    errors.push(`${label} dimensions, DPI, or work-area placement are invalid`);
  }
}

export function validateLearningAccessibilityMatrixReport(
  report,
  expectedBindings,
  expectedCaptures,
) {
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
      "samples",
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
    report.profile !== "learning-accessibility-matrix" ||
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
  const bindingKeys = [
    "applicationSha256",
    "fixtureExecutableSha256",
    "fixtureContentSha256",
    "stylesheetSha256",
    "scriptSha256",
  ];
  if (
    !exactKeys(report.bindings, bindingKeys) ||
    bindingKeys.some((key) => !SHA256.test(report.bindings?.[key] ?? ""))
  ) {
    errors.push("binding schema is invalid");
  } else {
    for (const key of [
      "applicationSha256",
      "fixtureExecutableSha256",
      "stylesheetSha256",
      "scriptSha256",
    ]) {
      if (report.bindings[key] !== expectedBindings[key]) {
        errors.push("report bindings are stale or do not match the measured artifacts");
        break;
      }
    }
    if (report.bindings.fixtureContentSha256 !== syntheticAccessibilityFixtureSha256()) {
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
    !exactKeys(report.request, [
      "exitAfterSeconds",
      "cardCount",
      "modes",
      "standardPanelSizes",
      "blackboardSize",
      "panelPlacement",
    ]) ||
    !Number.isInteger(report.request?.exitAfterSeconds) ||
    report.request.exitAfterSeconds < 30 ||
    report.request.exitAfterSeconds > 120 ||
    report.request.cardCount !== 5 ||
    JSON.stringify(report.request.modes) !== JSON.stringify(MODES) ||
    JSON.stringify(report.request.standardPanelSizes) !== JSON.stringify(PANEL_SIZES) ||
    JSON.stringify(report.request.blackboardSize) !== JSON.stringify({ width: 520, height: 420 }) ||
    report.request.panelPlacement !== "work-area-top-left"
  ) {
    errors.push("request contract is invalid");
  }

  if (!Array.isArray(report.samples) || report.samples.length !== MODES.length) {
    errors.push("mode samples are incomplete");
  } else {
    report.samples.forEach((sample, index) => {
      const mode = MODES[index];
      if (
        !exactKeys(sample, [
          "mode",
          "browserArguments",
          "fixtureDatabaseSha256",
          "panelMeasurements",
          "blackboard",
          "focusedElement",
          "accessibilityNames",
          "controlledExit",
          "exitCode",
          "rootRemoved",
          "passed",
          "failure",
        ]) ||
        sample.mode !== mode ||
        sample.browserArguments !== BROWSER_ARGUMENTS[mode] ||
        !SHA256.test(sample.fixtureDatabaseSha256 ?? "")
      ) {
        errors.push(`${mode} sample identity is invalid`);
        return;
      }
      const expectedPanelSizes = mode === "standard" ? PANEL_SIZES : [PANEL_SIZES[1]];
      if (
        !Array.isArray(sample.panelMeasurements) ||
        sample.panelMeasurements.length !== expectedPanelSizes.length
      ) {
        errors.push(`${mode} panel measurements are incomplete`);
      } else {
        sample.panelMeasurements.forEach((measurement, panelIndex) => {
          const expected = expectedPanelSizes[panelIndex];
          if (
            !exactKeys(measurement, [
              "requestedLogicalWidth",
              "requestedLogicalHeight",
              "actual",
              "learningPageAccessible",
              "captureName",
            ]) ||
            measurement.requestedLogicalWidth !== expected.width ||
            measurement.requestedLogicalHeight !== expected.height ||
            measurement.learningPageAccessible !== true ||
            measurement.captureName !==
              (mode === "standard" ? `standard-panel-${expected.width}x${expected.height}.png` : null)
          ) {
            errors.push(`${mode} panel measurement ${panelIndex + 1} is invalid`);
          } else {
            validateMetrics(
              measurement.actual,
              expected.width,
              expected.height,
              errors,
              `${mode} panel ${panelIndex + 1}`,
            );
          }
        });
      }
      if (
        !exactKeys(sample.blackboard, [
          "expectedLogicalWidth",
          "expectedLogicalHeight",
          "actual",
          "captureName",
        ]) ||
        sample.blackboard.expectedLogicalWidth !== 520 ||
        sample.blackboard.expectedLogicalHeight !== 420 ||
        sample.blackboard.captureName !== `${mode}-blackboard-520x420.png`
      ) {
        errors.push(`${mode} blackboard contract is invalid`);
      } else {
        validateMetrics(sample.blackboard.actual, 520, 420, errors, `${mode} blackboard`);
      }
      if (
        !exactKeys(sample.focusedElement, [
          "hostProcessId",
          "elementProcessId",
          "name",
          "controlType",
          "left",
          "top",
          "width",
          "height",
          "insideBlackboard",
          "belongsToBlackboardWindow",
          "keyboardFocusable",
          "setFocusRequested",
          "globalFocusObserved",
          "method",
        ]) ||
        !Number.isInteger(sample.focusedElement.hostProcessId) ||
        sample.focusedElement.hostProcessId < 1 ||
        !Number.isInteger(sample.focusedElement.elementProcessId) ||
        sample.focusedElement.elementProcessId < 1 ||
        typeof sample.focusedElement.name !== "string" ||
        !sample.focusedElement.name.includes("合成释义") ||
        sample.focusedElement.controlType !== "button" ||
        sample.focusedElement.method !== "uia-set-focus-request" ||
        sample.focusedElement.insideBlackboard !== true ||
        sample.focusedElement.belongsToBlackboardWindow !== true ||
        sample.focusedElement.keyboardFocusable !== true ||
        sample.focusedElement.setFocusRequested !== true ||
        typeof sample.focusedElement.globalFocusObserved !== "boolean" ||
        sample.focusedElement.width < 1 ||
        sample.focusedElement.height < 1
      ) {
        errors.push(`${mode} answer focus target evidence is invalid`);
      }
      if (
        !Array.isArray(sample.accessibilityNames) ||
        REQUIRED_ACCESSIBLE_NAMES.some((name) => !sample.accessibilityNames.includes(name))
      ) {
        errors.push(`${mode} accessible names are incomplete`);
      }
      const reducedStatusFound = sample.accessibilityNames?.includes("已减少动态效果") === true;
      const forcedColorsStatusFound =
        sample.accessibilityNames?.includes("已启用 Windows 强制颜色") === true;
      if (
        (mode === "standard" && (reducedStatusFound || forcedColorsStatusFound)) ||
        (mode === "reduced-motion" && (!reducedStatusFound || forcedColorsStatusFound)) ||
        (mode === "forced-colors" && (reducedStatusFound || !forcedColorsStatusFound))
      ) {
        errors.push(`${mode} media-state accessibility evidence is invalid`);
      }
      if (
        sample.controlledExit !== true ||
        sample.exitCode !== 0 ||
        sample.rootRemoved !== true ||
        sample.passed !== true ||
        sample.failure !== null
      ) {
        errors.push(`${mode} execution did not finish cleanly`);
      }
    });
  }

  if (!Array.isArray(report.captures) || report.captures.length !== CAPTURE_NAMES.length) {
    errors.push("capture evidence is incomplete");
  } else {
    if (JSON.stringify(report.captures.map((capture) => capture?.name)) !== JSON.stringify(CAPTURE_NAMES)) {
      errors.push("capture names or order are invalid");
    }
    for (const capture of report.captures) {
      const expected = expectedCaptures?.[capture?.name];
      if (
        !exactKeys(capture, [
          "name",
          "mode",
          "scene",
          "physicalWidth",
          "physicalHeight",
          "bytes",
          "sha256",
        ]) ||
        !MODES.includes(capture.mode) ||
        !["panel", "blackboard"].includes(capture.scene) ||
        !Number.isInteger(capture.physicalWidth) ||
        !Number.isInteger(capture.physicalHeight) ||
        !Number.isInteger(capture.bytes) ||
        capture.bytes < 1_000 ||
        !SHA256.test(capture.sha256 ?? "") ||
        expected?.bytes !== capture.bytes ||
        expected?.sha256 !== capture.sha256 ||
        expected?.width !== capture.physicalWidth ||
        expected?.height !== capture.physicalHeight
      ) {
        errors.push("a capture is missing, stale, dimension-mismatched, or hash-mismatched");
        break;
      }
    }
    if (new Set(report.captures.map((capture) => capture.sha256)).size < 5) {
      errors.push("captures do not prove distinct panel and accessibility surfaces");
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
  const [raw, application, fixture, stylesheet, script, ...captureBytes] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(applicationPath),
    readFile(fixturePath),
    readFile(stylesheetPath),
    readFile(scriptPath),
    ...CAPTURE_NAMES.map((name) => readFile(path.join(captureDirectory, name))),
  ]);
  const report = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const expectedCaptures = Object.fromEntries(
    CAPTURE_NAMES.map((name, index) => {
      const dimensions = pngDimensions(captureBytes[index]);
      return [
        name,
        {
          bytes: captureBytes[index].length,
          sha256: sha256(captureBytes[index]),
          ...dimensions,
        },
      ];
    }),
  );
  const errors = validateLearningAccessibilityMatrixReport(
    report,
    {
      applicationSha256: sha256(application),
      fixtureExecutableSha256: sha256(fixture),
      stylesheetSha256: sha256(stylesheet),
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
    "Learning accessibility matrix evidence passed: 3 display modes, 3 panel sizes, 520x420 blackboard, and 6 captures verified.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
