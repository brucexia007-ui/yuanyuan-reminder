import assert from "node:assert/strict";
import test from "node:test";

import {
  findForbiddenArtifactPaths,
  findForbiddenPaths,
  findForbiddenTextMarkers,
  isAuditedSourcePath,
  normalizeRepositoryPath,
} from "./fragment_learning_boundary_policy.mjs";

test("normalizes Windows repository paths before applying the denylist", () => {
  assert.equal(
    normalizeRepositoryPath("src-tauri\\resources\\personal-learning\\cards.csv"),
    "src-tauri/resources/personal-learning/cards.csv",
  );
  assert.deepEqual(
    findForbiddenPaths(["src-tauri\\resources\\personal-learning\\cards.csv"]),
    [
      {
        path: "src-tauri/resources/personal-learning/cards.csv",
        rule: "personal-resource-directory",
      },
    ],
  );
});

test("rejects personal build files, private archives, and captured user databases", () => {
  const findings = findForbiddenPaths([
    "src-tauri/tauri.learning-personal.conf.json",
    "work/personal-sources/source-kajweb.zip",
    "captures/yuanyuan-learning.sqlite3-wal",
  ]);
  assert.deepEqual(
    findings.map(({ rule }) => rule),
    ["personal-tauri-config", "personal-source-directory", "private-upstream-archive", "user-runtime-database"],
  );
});

test("rejects personal edition markers and user-specific absolute paths in source", () => {
  assert.deepEqual(findForbiddenTextMarkers('feature = "personal-kajweb"'), ["personal-kajweb"]);
  assert.deepEqual(findForbiddenTextMarkers("C:\\Users\\alice\\AppData\\Local\\Yuanyuan"), [
    "user-absolute-data-path",
  ]);
  assert.deepEqual(findForbiddenTextMarkers("com.yuanyuan.reminder.learning-preview"), []);
});

test("keeps policy and documentation references outside source marker scanning", () => {
  assert.equal(isAuditedSourcePath("docs/learning/SCM_001_CHANNEL_ISOLATION_AUDIT.md"), false);
  assert.equal(isAuditedSourcePath("scripts/fragment_learning_boundary_policy.mjs"), false);
  assert.equal(isAuditedSourcePath("src-tauri/Cargo.toml"), true);
});

test("rejects personal identifiers from build artifact names", () => {
  assert.deepEqual(findForbiddenArtifactPaths(["assets/learning-personal.js", "assets/app.js"]), [
    { path: "assets/learning-personal.js", rule: "personal-artifact-name" },
  ]);
});
