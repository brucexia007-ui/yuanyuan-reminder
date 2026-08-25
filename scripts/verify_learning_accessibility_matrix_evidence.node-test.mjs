import assert from "node:assert/strict";
import test from "node:test";

import {
  syntheticAccessibilityFixtureSha256,
  validateLearningAccessibilityMatrixReport,
} from "./verify_learning_accessibility_matrix_evidence.mjs";

const HASHES = {
  applicationSha256: "A".repeat(64),
  fixtureExecutableSha256: "B".repeat(64),
  stylesheetSha256: "C".repeat(64),
  scriptSha256: "D".repeat(64),
};
const MODES = ["standard", "reduced-motion", "forced-colors"];
const ARGUMENTS = [
  "",
  "--force-prefers-reduced-motion",
  "--force-high-contrast --enable-blink-features=ForcedColors",
];
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
const LIMITATIONS = [
  "The application and fixture are an isolated learning runtime-QA build, not a signed production candidate.",
  "The five cards are deterministic synthetic content and contain no personal learning material.",
  "The window sizes are measured in Tauri logical pixels at the current real Windows DPI; other physical DPI settings, multiple displays, and negative coordinates remain manual checks.",
  "The runtime-QA panel starts at an allowlisted in-work-area logical position, and every measured native window must remain fully inside its current Windows work area.",
  "Reduced motion and forced colors use allowlisted arguments injected programmatically by the runtime-QA Tauri WebView builder, and each matching media state is confirmed in the accessibility tree; a human Windows setting and Narrator review remain manual checks.",
  "Windows UI Automation proves that the first answer can receive focus and exposes the required names; DOM auto-focus is covered separately, and a complete physical keyboard session remains manual.",
  "PrintWindow captures are restricted to isolated application-owned windows and do not capture the desktop.",
];
const expectedCaptures = Object.fromEntries(
  CAPTURE_NAMES.map((name, index) => [
    name,
    {
      bytes: 2_000 + index,
      sha256: `${index + 1}`.repeat(64),
      width: index < 3 ? PANEL_SIZES[index].width : 520,
      height: index < 3 ? PANEL_SIZES[index].height : 420,
    },
  ]),
);

function metrics(width, height) {
  return {
    dpi: 96,
    scalePercent: 100,
    clientPhysicalWidth: width,
    clientPhysicalHeight: height,
    clientLogicalWidth: width,
    clientLogicalHeight: height,
    windowPhysicalWidth: width,
    windowPhysicalHeight: height,
    left: 100,
    top: 100,
    right: 100 + width,
    bottom: 100 + height,
    workAreaLeft: 0,
    workAreaTop: 0,
    workAreaRight: 1920,
    workAreaBottom: 1080,
    fullyWithinWorkArea: true,
  };
}

function makeReport() {
  const captures = CAPTURE_NAMES.map((name, index) => ({
    name,
    mode: index < 4 ? "standard" : MODES[index - 3],
    scene: index < 3 ? "panel" : "blackboard",
    physicalWidth: expectedCaptures[name].width,
    physicalHeight: expectedCaptures[name].height,
    bytes: expectedCaptures[name].bytes,
    sha256: expectedCaptures[name].sha256,
  }));
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-21T13:00:00.000Z",
    profile: "learning-accessibility-matrix",
    source: {
      branch: "feat/fragment-learning-stage-0-1",
      commit: "a".repeat(40),
      dirty: true,
    },
    bindings: {
      ...HASHES,
      fixtureContentSha256: syntheticAccessibilityFixtureSha256(),
    },
    device: {
      windowsProductName: "Windows",
      windowsDisplayVersion: "24H2",
      windowsBuild: "26100.1",
      processorArchitecture: "AMD64",
      logicalProcessors: 8,
      webView2RuntimeVersion: "1.2.3.4",
    },
    request: {
      exitAfterSeconds: 30,
      cardCount: 5,
      modes: MODES,
      standardPanelSizes: PANEL_SIZES,
      blackboardSize: { width: 520, height: 420 },
      panelPlacement: "work-area-top-left",
    },
    samples: MODES.map((mode, index) => ({
      mode,
      browserArguments: ARGUMENTS[index],
      fixtureDatabaseSha256: "E".repeat(64),
      panelMeasurements: (mode === "standard" ? PANEL_SIZES : [PANEL_SIZES[1]]).map(
        (size) => ({
          requestedLogicalWidth: size.width,
          requestedLogicalHeight: size.height,
          actual: metrics(size.width, size.height),
          learningPageAccessible: true,
          captureName:
            mode === "standard" ? `standard-panel-${size.width}x${size.height}.png` : null,
        }),
      ),
      blackboard: {
        expectedLogicalWidth: 520,
        expectedLogicalHeight: 420,
        actual: metrics(520, 420),
        captureName: `${mode}-blackboard-520x420.png`,
      },
      focusedElement: {
        hostProcessId: 123,
        elementProcessId: 456,
        name: "1 合成释义 1",
        controlType: "button",
        left: 110,
        top: 180,
        width: 120,
        height: 50,
        insideBlackboard: true,
        belongsToBlackboardWindow: true,
        keyboardFocusable: true,
        setFocusRequested: true,
        globalFocusObserved: false,
        method: "uia-set-focus-request",
      },
      accessibilityNames: [
        "圆圆桌面英语复习",
        "请选择中文释义",
        "结束本轮",
        ...(mode === "reduced-motion" ? ["已减少动态效果"] : []),
        ...(mode === "forced-colors" ? ["已启用 Windows 强制颜色"] : []),
      ],
      controlledExit: true,
      exitCode: 0,
      rootRemoved: true,
      passed: true,
      failure: null,
    })),
    captures,
    ready: true,
    limitations: LIMITATIONS,
    failure: null,
  };
}

test("accepts a complete accessibility matrix", () => {
  assert.deepEqual(
    validateLearningAccessibilityMatrixReport(makeReport(), HASHES, expectedCaptures),
    [],
  );
});

for (const [name, mutate, expected] of [
  ["rejects extra report fields", (report) => { report.extra = true; }, "schema"],
  ["rejects stale application bindings", (report) => { report.bindings.applicationSha256 = "F".repeat(64); }, "stale"],
  ["rejects browser argument drift", (report) => { report.samples[1].browserArguments = ""; }, "identity"],
  ["rejects missing panel sizes", (report) => { report.samples[0].panelMeasurements.pop(); }, "panel"],
  ["rejects an incorrect blackboard size", (report) => { report.samples[0].blackboard.actual.clientLogicalWidth = 517; }, "dimensions"],
  ["rejects an offscreen evidence window", (report) => { report.samples[0].panelMeasurements[2].actual.fullyWithinWorkArea = false; }, "work-area"],
  ["rejects missing first-option focus", (report) => { report.samples[0].focusedElement.controlType = "document"; }, "focus"],
  ["rejects incomplete accessible names", (report) => { report.samples[0].accessibilityNames.pop(); }, "names"],
  ["rejects stale capture hashes", (report) => { report.captures[0].sha256 = "F".repeat(64); }, "capture"],
  ["rejects changed limitations", (report) => { report.limitations.pop(); }, "limitations"],
  ["rejects a non-ready report", (report) => { report.ready = false; report.failure = "failed"; }, "readiness"],
]) {
  test(name, () => {
    const report = makeReport();
    mutate(report);
    assert.ok(
      validateLearningAccessibilityMatrixReport(report, HASHES, expectedCaptures).some((error) =>
        error.includes(expected),
      ),
    );
  });
}
