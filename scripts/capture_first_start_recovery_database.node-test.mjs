import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureFirstStartRecoveryDatabase,
  inspectFirstStartDatabase,
} from "./capture_first_start_recovery_database.mjs";

const tables = [
  "activity_tracking_state",
  "companion_attention_budget",
  "companion_proactive_attention",
  "focus_sessions",
  "occurrences",
  "pet_interactions",
  "reminders",
  "settings",
  "task_watch_attention_deferrals",
  "water_log",
];

async function createHealthySource(root) {
  const source = path.join(root, "yuanyuan-reminder.sqlite3");
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=11;");
    for (const table of tables) database.exec(`CREATE TABLE ${table}(id TEXT)`);
    database.exec(
      "INSERT INTO settings VALUES ('settings'); INSERT INTO reminders VALUES ('water'), ('activity');",
    );
  } finally {
    database.close();
  }
  return source;
}

test("captures a canonical sidecar-free synthetic first-start fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-first-start-capture-"));
  const source = await createHealthySource(root);
  const fixture = path.join(root, "fixture.sqlite3");
  const report = path.join(root, "capture.json");
  const result = await captureFirstStartRecoveryDatabase({
    sourcePath: source,
    fixturePath: fixture,
    reportPath: report,
    attestation: "synthetic_fresh_first_start",
  });
  assert.equal(result.ready, true);
  assert.equal(result.fixture.health.schemaVersion, 11);
  assert.equal(result.fixture.health.journalMode, "delete");
  assert.equal(inspectFirstStartDatabase(fixture).requiredTablesPresent, true);
  assert.equal(JSON.parse(await readFile(report, "utf8")).fixture.sha256, result.fixture.sha256);
});

test("rejects wrong attestation, unhealthy schemas, and existing outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-first-start-reject-"));
  const source = await createHealthySource(root);
  const fixture = path.join(root, "fixture.sqlite3");
  const report = path.join(root, "capture.json");
  await assert.rejects(
    captureFirstStartRecoveryDatabase({
      sourcePath: source,
      fixturePath: fixture,
      reportPath: report,
      attestation: "user_database",
    }),
    /attestation/,
  );
  const database = new DatabaseSync(source);
  database.exec("PRAGMA user_version=10");
  database.close();
  await assert.rejects(
    captureFirstStartRecoveryDatabase({
      sourcePath: source,
      fixturePath: fixture,
      reportPath: report,
      attestation: "synthetic_fresh_first_start",
    }),
    /health/,
  );
});
