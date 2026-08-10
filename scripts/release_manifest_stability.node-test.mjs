import assert from "node:assert/strict";
import test from "node:test";

import { selectStableGeneratedAt } from "./release_manifest_stability.mjs";

const previous = "2026-08-08T20:00:00.000Z";
const fresh = "2026-08-08T21:00:00.000Z";

function material() {
  return {
    schemaVersion: 1,
    productName: "圆圆提醒",
    productVersion: "1.4.0",
    signatureVerification: "not_performed",
    installerBoundary: {
      externalBin: [],
      resources: { "../LICENSE": "licenses/LICENSE.txt" },
      experimentalSidecarsIncluded: false,
    },
    artifacts: [
      {
        id: "stable_core",
        path: "yuanyuan-reminder.exe",
        bytes: 10,
        sha256: "A".repeat(64),
        bundleDisposition: "primary_application",
      },
    ],
  };
}

test("preserves generatedAt only when the complete manifest material is unchanged", () => {
  const current = material();
  const existing = { ...current, generatedAt: previous };
  assert.equal(selectStableGeneratedAt(existing, current, fresh), previous);

  const changed = material();
  changed.artifacts[0].sha256 = "B".repeat(64);
  assert.equal(selectStableGeneratedAt(existing, changed, fresh), fresh);
});

test("rejects unknown fields and invalid existing timestamps", () => {
  const current = material();
  assert.equal(
    selectStableGeneratedAt({ ...current, generatedAt: previous, machineName: "forbidden" }, current, fresh),
    fresh,
  );
  assert.equal(
    selectStableGeneratedAt({ ...current, generatedAt: "invalid" }, current, fresh),
    fresh,
  );
});
