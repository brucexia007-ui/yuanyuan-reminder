import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_TABLES = [
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

const ATTESTATION = "synthetic_fresh_first_start";

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();
}

async function ordinaryFile(filePath, label) {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new Error(`${label}_path_must_be_absolute_and_normalized`);
  }
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label}_must_be_an_ordinary_file`);
  }
  return { path: filePath, bytes: metadata.size };
}

async function newOutput(filePath, extension, label) {
  if (
    !path.isAbsolute(filePath) ||
    path.normalize(filePath) !== filePath ||
    path.extname(filePath).toLowerCase() !== extension
  ) {
    throw new Error(`${label}_path_is_invalid`);
  }
  const parent = path.dirname(filePath);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error(`${label}_parent_must_be_an_ordinary_directory`);
  }
  const parsed = path.parse(parent);
  let cursor = parsed.root;
  for (const segment of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label}_parent_must_not_traverse_a_reparse_point`);
    }
  }
  try {
    await lstat(filePath);
    throw new Error(`${label}_already_exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return filePath;
}

function pragmaScalar(database, pragma) {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  return Object.values(row ?? {})[0];
}

export function inspectFirstStartDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try {
    const quickCheckRows = database.prepare("PRAGMA quick_check").all();
    const quickCheck = quickCheckRows.map((row) => String(Object.values(row)[0]));
    const schemaVersion = Number(pragmaScalar(database, "user_version"));
    const journalMode = String(pragmaScalar(database, "journal_mode"));
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const requiredTablesPresent = REQUIRED_TABLES.every((table) => tables.includes(table));
    const settingsRows = Number(database.prepare("SELECT COUNT(*) AS count FROM settings").get().count);
    const reminderRows = Number(
      database.prepare("SELECT COUNT(*) AS count FROM reminders").get().count,
    );
    return {
      quickCheck,
      schemaVersion,
      journalMode,
      tables,
      requiredTablesPresent,
      settingsRows,
      reminderRows,
    };
  } finally {
    database.close();
  }
}

function healthPassed(health, expectedJournalMode = null) {
  return (
    JSON.stringify(health.quickCheck) === JSON.stringify(["ok"]) &&
    health.schemaVersion === 11 &&
    health.requiredTablesPresent === true &&
    JSON.stringify(health.tables) === JSON.stringify(REQUIRED_TABLES) &&
    health.settingsRows === 1 &&
    health.reminderRows >= 2 &&
    (expectedJournalMode === null || health.journalMode.toLowerCase() === expectedJournalMode)
  );
}

export async function captureFirstStartRecoveryDatabase({
  sourcePath,
  fixturePath,
  reportPath,
  attestation,
}) {
  if (attestation !== ATTESTATION) throw new Error("source_attestation_is_required");
  const source = await ordinaryFile(sourcePath, "source_database");
  if (source.bytes <= 0 || source.bytes > 64 * 1024 * 1024) {
    throw new Error("source_database_size_is_invalid");
  }
  await newOutput(fixturePath, ".sqlite3", "fixture");
  await newOutput(reportPath, ".json", "report");
  if (new Set([sourcePath, fixturePath, reportPath].map((value) => value.toLowerCase())).size !== 3) {
    throw new Error("input_and_output_paths_must_be_distinct");
  }

  const sourceHealthBefore = inspectFirstStartDatabase(sourcePath);
  if (!healthPassed(sourceHealthBefore)) throw new Error("source_database_health_check_failed");

  const database = new DatabaseSync(sourcePath, { timeout: 5_000 });
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const escapedFixture = fixturePath.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escapedFixture}'`);
  } finally {
    database.close();
  }

  const fixture = await ordinaryFile(fixturePath, "fixture");
  const fixtureHealth = inspectFirstStartDatabase(fixturePath);
  if (!healthPassed(fixtureHealth, "delete")) throw new Error("fixture_health_check_failed");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(`${fixturePath}${suffix}`);
      throw new Error("fixture_sidecar_must_not_exist");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "synthetic_first_start_recovery_database_capture",
    ready: true,
    attestation,
    source: {
      fileName: path.basename(sourcePath),
      bytesBeforeCheckpoint: source.bytes,
      healthBeforeCheckpoint: sourceHealthBefore,
    },
    fixture: {
      fileName: path.basename(fixturePath),
      bytes: fixture.bytes,
      sha256: await sha256(fixturePath),
      health: fixtureHealth,
      sidecarCount: 0,
    },
    privacy:
      "Synthetic fresh-profile defaults only; contains no imported, historical, or user-authored content and records no source path.",
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return report;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("invalid_arguments");
    }
    values.set(key, value);
  }
  const allowed = new Set(["--source", "--fixture", "--report", "--attest-source"]);
  if (values.size !== allowed.size || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("invalid_arguments");
  }
  return {
    sourcePath: path.resolve(values.get("--source")),
    fixturePath: path.resolve(values.get("--fixture")),
    reportPath: path.resolve(values.get("--report")),
    attestation: values.get("--attest-source"),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  captureFirstStartRecoveryDatabase(parseArguments(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(
        `First-start recovery database captured: ${report.fixture.sha256}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`First-start recovery database capture failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
