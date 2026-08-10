import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const executablePath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "yuanyuan-reminder.exe",
);
const installedExecutablePath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "nsis-payload",
  "yuanyuan-reminder.exe",
);
const aiPrototypePath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "yuanyuan-ai.exe",
);

export const forbiddenQaMarkers = [
  "YUANYUAN_RUNTIME_QA_ROOT",
  "YUANYUAN_RUNTIME_QA_EXIT_AFTER_SECONDS",
  "YUANYUAN_RUNTIME_QA_PROFILE",
  ".yuanyuan-runtime-qa-v1",
  "yuanyuan-task-watch-fixture",
  "yuanyuan-runtime-qa-fixture",
  "baseline-ai-off",
  "reminder-latency",
  "task-failure-motion",
  "yuanyuan-database-migration-qa",
  "yuanyuan-store-data-lifecycle-qa",
  ".yuanyuan-store-data-lifecycle-v1.json",
  "yuanyuan-v132-migration-qa-",
  "operator_attested_copy_plus_schema_version_6",
  "yuanyuan-retention-qa",
  "annual-175200-v1",
  "yuanyuan-retention-qa-",
  "yuanyuan-pid-reuse-qa",
  "YUANYUAN_SUPPORT_SORT_PRIVATE_TEXT_CANARY_7F2C19A4",
];

export const forbiddenAiQaMarkers = [
  "--test-support-sort-canary-provider",
  "--test-support-sort-crash-after-submit",
  "privacy-canary-provider",
  "YUANYUAN_SUPPORT_SORT_PRIVATE_TEXT_CANARY_7F2C19A4",
  "YUANYUAN_CRASH_PRIVACY_CANARY_V1_",
];
export const requiredAiCrashPrivacyMarkers = [
  "WerSetFlags",
  "WerGetFlags",
  "Windows Error Reporting\\LocalDumps",
];
export function verifyReleaseBinaryBoundary({ executable, installedExecutable, aiPrototype }) {
  for (const [id, binary] of [
    ["portable release executable", executable],
    ["NSIS-installed release executable", installedExecutable],
  ]) {
    for (const marker of forbiddenQaMarkers) {
      if (binary.includes(Buffer.from(marker, "ascii"))) {
        throw new Error(`${id} contains non-production QA marker ${marker}`);
      }
    }
  }

  for (const marker of forbiddenAiQaMarkers) {
    if (aiPrototype.includes(Buffer.from(marker, "ascii"))) {
      throw new Error(`release AI prototype contains non-production QA marker ${marker}`);
    }
  }

  for (const marker of requiredAiCrashPrivacyMarkers) {
    if (!aiPrototype.includes(Buffer.from(marker, "ascii"))) {
      throw new Error(`release AI prototype is missing crash-privacy marker ${marker}`);
    }
  }

  return {
    forbiddenMainMarkers: forbiddenQaMarkers.length,
    mainBinariesScanned: 2,
    forbiddenAiQaMarkers: forbiddenAiQaMarkers.length,
    requiredAiCrashPrivacyMarkers: requiredAiCrashPrivacyMarkers.length,
  };
}

async function main() {
  const result = verifyReleaseBinaryBoundary({
    executable: await readFile(executablePath),
    installedExecutable: await readFile(installedExecutablePath),
    aiPrototype: await readFile(aiPrototypePath),
  });
  console.log(
    `Release binary boundary OK: ${result.forbiddenMainMarkers} main markers are absent from ${result.mainBinariesScanned} shipped main-binary variants; ${result.forbiddenAiQaMarkers} AI prototype QA markers are absent; ${result.requiredAiCrashPrivacyMarkers} AI crash-privacy markers are present.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
