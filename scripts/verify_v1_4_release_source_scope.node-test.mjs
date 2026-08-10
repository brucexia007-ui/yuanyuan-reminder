import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildV14ReleaseSourceScopeReport,
  defaultV14ReleaseSourceScopePath,
  defaultV14ReleaseSourceScopeVerifierPath,
  renderV14ChangedPaths,
  validateV14ReleaseSourceScopeContract,
  validateV14ReleaseSourceScopeReport,
  V14ReleaseSourceScopeVerificationError,
} from "./verify_v1_4_release_source_scope.mjs";

const now = new Date("2026-08-11T02:00:00.000Z");
const [contractBytes, verifierBytes] = await Promise.all([
  readFile(defaultV14ReleaseSourceScopePath),
  readFile(defaultV14ReleaseSourceScopeVerifierPath),
]);

function source(overrides = {}) {
  return {
    commit: "a".repeat(40),
    branch: "main",
    commitTimestamp: "2026-08-11T01:00:00.000Z",
    worktreeClean: true,
    baselineTagCommit: "11841b88cf7b3e6d10502fd0158401e2c02167ae",
    baselineIsAncestor: true,
    ...overrides,
  };
}

function runtimeFiles(overrides = {}) {
  const files = {
    "src-tauri/Cargo.toml": "[package]\nname = \"yuanyuan-reminder\"\n",
    "src-tauri/migrations/011_task_watch_attention_deferrals.sql": "PRAGMA user_version = 11;\n",
    "src-tauri/src/lib.rs": "pub fn run() {}\n",
    "src/main.tsx": "export const app = true;\n",
    "src/vite-env.d.ts": "/// <reference types=\"vite/client\" />\n",
    "vite.config.ts": "export default {};\n",
    ...overrides,
  };
  return Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([entryPath, text]) => ({ path: entryPath, bytes: Buffer.from(text, "utf8") }));
}

function build(overrides = {}) {
  return buildV14ReleaseSourceScopeReport(
    {
      contractBytes,
      verifierBytes,
      source: source(),
      changedPaths: ["PRIVACY.md", "src-tauri/src/local_data_cleanup.rs"],
      runtimeFiles: runtimeFiles(),
      ...overrides,
    },
    { now },
  );
}

test("accepts a clean main stable-only v1.4.0 release source", () => {
  const report = build();
  assert.equal(report.outcome.releaseScopeVerified, true);
  assert.equal(report.outcome.learningPreviewExcluded, true);
  assert.equal(report.runtimeSource.stableMainDatabaseSchemaVersion, 11);
  assert.equal(report.runtimeSource.forbiddenTermHits, 0);
  assert.equal(
    validateV14ReleaseSourceScopeReport(report, {
      contractBytes,
      verifierBytes,
      runtimeFiles: runtimeFiles(),
      now,
    }),
    report,
  );
});

test("freezes the exact source-scope policy instead of accepting a weakened copy", () => {
  const altered = JSON.parse(contractBytes.toString("utf8"));
  altered.decision.learningPreviewMayExistInReleaseCommit = true;
  assert.throws(
    () => validateV14ReleaseSourceScopeContract(altered),
    V14ReleaseSourceScopeVerificationError,
  );
  assert.throws(
    () => build({ contractBytes: Buffer.from(`${JSON.stringify(altered)}\n`) }),
    /policy drifted/u,
  );
});

test("rejects dirty, non-main, detached, or non-v1.3.2-descendant source", () => {
  for (const mutation of [
    { worktreeClean: false },
    { branch: "feat/release" },
    { branch: "" },
    { baselineTagCommit: "b".repeat(40) },
    { baselineIsAncestor: false },
  ]) {
    assert.throws(() => build({ source: source(mutation) }), V14ReleaseSourceScopeVerificationError);
  }
});

test("rejects every Learning Preview path from the release commit", () => {
  for (const excludedPath of [
    "docs/LEARNING_PREVIEW_SCOPE.md",
    "docs/learning/QA_MATRIX.md",
    "src/learning/LearningView.tsx",
    "src-tauri/src/learning/mod.rs",
    "src-tauri/migrations/012_learning_invitation_attention.sql",
  ]) {
    assert.throws(
      () =>
        build({
          changedPaths: ["PRIVACY.md", excludedPath].sort((left, right) =>
            left.localeCompare(right, "en"),
          ),
        }),
      /Learning Preview paths are excluded/u,
    );
  }
});

test("rejects Learning Preview markers hidden in shared runtime files", () => {
  for (const [entryPath, text] of [
    ["src-tauri/src/lib.rs", "#[cfg(feature = \"learning\")] mod preview;\n"],
    ["src/panel/TaskPanel.tsx", "const title = \"学习\";\n"],
    ["vite.config.ts", "const flag = \"VITE_FEATURE_LEARNING\";\n"],
  ]) {
    assert.throws(
      () => build({ runtimeFiles: runtimeFiles({ [entryPath]: text }) }),
      /runtime markers are excluded/u,
    );
  }
});

test("rejects a main database schema above the frozen v1.4.0 schema 11", () => {
  assert.throws(
    () =>
      build({
        runtimeFiles: runtimeFiles({
          "src-tauri/migrations/012_unreviewed.sql": "PRAGMA user_version = 12;\n",
        }),
      }),
    /schema must remain 11/u,
  );
});

test("rejects unsorted, duplicated, case-aliased, or escaping paths", () => {
  for (const changedPaths of [
    ["src/z.ts", "src/a.ts"],
    ["src/a.ts", "src/a.ts"],
    ["README.md", "readme.md"],
    ["../outside.txt"],
    ["src\\main.tsx"],
  ]) {
    assert.throws(() => build({ changedPaths }), V14ReleaseSourceScopeVerificationError);
  }
});

test("rejects report, policy, runtime manifest, and optimistic outcome drift", () => {
  for (const mutate of [
    (report) => {
      report.policy.sha256 = "0".repeat(64);
    },
    (report) => {
      report.changes.pathCount += 1;
    },
    (report) => {
      report.runtimeSource.files[0].sha256 = "0".repeat(64);
    },
    (report) => {
      report.runtimeSource.forbiddenTermHits = 1;
    },
    (report) => {
      report.outcome.learningPreviewExcluded = false;
    },
  ]) {
    const report = structuredClone(build());
    mutate(report);
    assert.throws(
      () => validateV14ReleaseSourceScopeReport(report, { contractBytes, verifierBytes, now }),
      V14ReleaseSourceScopeVerificationError,
    );
  }
});

test("renders a deterministic changed-path commitment", () => {
  assert.equal(
    renderV14ChangedPaths(["PRIVACY.md", "src-tauri/src/local_data_cleanup.rs"]).toString("utf8"),
    "PRIVACY.md\nsrc-tauri/src/local_data_cleanup.rs\n",
  );
  assert.throws(
    () => renderV14ChangedPaths(["src-tauri/src/local_data_cleanup.rs", "PRIVACY.md"]),
    V14ReleaseSourceScopeVerificationError,
  );
});
