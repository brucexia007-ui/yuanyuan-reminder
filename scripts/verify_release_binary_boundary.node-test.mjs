import assert from "node:assert/strict";
import test from "node:test";

import {
  forbiddenAiQaMarkers,
  forbiddenQaMarkers,
  requiredAiCrashPrivacyMarkers,
  verifyReleaseBinaryBoundary,
} from "./verify_release_binary_boundary.mjs";

function joinedMarkers(markers) {
  return Buffer.from(markers.join("\0"), "ascii");
}

const safeMain = Buffer.alloc(0);
const safeAi = joinedMarkers(requiredAiCrashPrivacyMarkers);

test("accepts only an AI release with every crash-privacy marker", () => {
  assert.deepEqual(
    verifyReleaseBinaryBoundary({
      executable: safeMain,
      installedExecutable: safeMain,
      aiPrototype: safeAi,
    }),
    {
      forbiddenMainMarkers: forbiddenQaMarkers.length,
      mainBinariesScanned: 2,
      forbiddenAiQaMarkers: forbiddenAiQaMarkers.length,
      requiredAiCrashPrivacyMarkers: requiredAiCrashPrivacyMarkers.length,
    },
  );
});

test("rejects every missing AI crash-privacy marker", () => {
  for (const missing of requiredAiCrashPrivacyMarkers) {
    const incomplete = joinedMarkers(
      requiredAiCrashPrivacyMarkers.filter((marker) => marker !== missing),
    );
    assert.throws(
      () =>
        verifyReleaseBinaryBoundary({
          executable: safeMain,
          installedExecutable: safeMain,
          aiPrototype: incomplete,
        }),
      new RegExp(`missing crash-privacy marker ${missing.replaceAll("\\", "\\\\")}`),
    );
  }
});

test("rejects every forbidden marker in the main release", () => {
  for (const marker of forbiddenQaMarkers) {
    assert.throws(() =>
      verifyReleaseBinaryBoundary({
        executable: Buffer.from(marker, "ascii"),
        installedExecutable: safeMain,
        aiPrototype: safeAi,
      }),
    );
    assert.throws(() =>
      verifyReleaseBinaryBoundary({
        executable: safeMain,
        installedExecutable: Buffer.from(marker, "ascii"),
        aiPrototype: safeAi,
      }),
    );
  }
});

test("rejects every forbidden marker in the AI release", () => {
  for (const marker of forbiddenAiQaMarkers) {
    assert.throws(() =>
      verifyReleaseBinaryBoundary({
        executable: safeMain,
        installedExecutable: safeMain,
        aiPrototype: Buffer.concat([safeAi, Buffer.from(marker, "ascii")]),
      }),
    );
  }
});
