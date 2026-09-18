import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baselineInstallerSha256 = "424E2D607E08CA274672DFF343D12393DE3CF9C4FBC7BA3789FC7A8ACFFF4C7E";
const shaPattern = /^[A-F0-9]{64}$/u;
const evidenceIds = ["guestLog", "upgradeScreenshot", "rollbackScreenshot", "databaseAudit"];

function requireValue(condition, message) {
  if (!condition) throw new Error(`1.5.27 upgrade evidence rejected: ${message}`);
}

async function hashOrdinary(file) {
  const info = await lstat(file);
  requireValue(info.isFile() && !info.isSymbolicLink(), `not an ordinary file: ${file}`);
  return createHash("sha256").update(await readFile(file)).digest("hex").toUpperCase();
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function validateV1527UpgradeReport(report, { testedCommit, installerSha256, bindings }) {
  requireValue(report?.schemaVersion === 1 && report.status === "passed", "report is not passed");
  requireValue(report.candidateCommit === testedCommit && report.candidateInstallerSha256 === installerSha256,
    "candidate commit or installer differs");
  requireValue(report.baselineInstallerSha256 === baselineInstallerSha256 &&
    bindings.installerSha256.toUpperCase() === baselineInstallerSha256, "baseline installer differs");
  requireValue(report.baselineFileCount === 218 &&
    Object.keys(bindings.fullBaselineHashes ?? {}).length === 218, "complete baseline manifest is missing");
  requireValue(report.databaseMigration7to8Passed === true && report.oldRowsAndSettingsPreserved === true &&
    report.petPackRecoveryPassed === true && report.rollbackBothDatabasesIntegrityPassed === true &&
    report.rollbackVisibleStatePassed === true, "upgrade or paired rollback did not pass");
  requireValue(report.syntheticDataOnly === true && report.actualInstallersUsed === true &&
    report.olderProgramRestored === true && report.completePreUpgradeDataRestored === true,
    "real installer and full paired-data restoration are required");
  requireValue(Array.isArray(report.evidenceFiles) && report.evidenceFiles.length === evidenceIds.length &&
    report.evidenceFiles.every((entry, index) => entry?.id === evidenceIds[index] &&
      typeof entry.file === "string" && !path.isAbsolute(entry.file) &&
      shaPattern.test(entry.sha256)), "screenshot, log, and database audit references are incomplete");
  return report;
}

export async function verifyV1527UpgradeEvidence({ inputRoot, reportPath, installerPath, testedCommit }) {
  const input = path.resolve(inputRoot);
  const reportFile = path.resolve(reportPath);
  const evidenceRoot = path.dirname(reportFile);
  const [bindingsBytes, reportBytes, installerSha256, oldInstallerSha256] = await Promise.all([
    readFile(path.join(input, "bindings.json")), readFile(reportFile),
    hashOrdinary(path.resolve(installerPath)), hashOrdinary(path.join(input, "candidate.exe")),
  ]);
  const bindings = JSON.parse(bindingsBytes.toString("utf8"));
  const report = JSON.parse(reportBytes.toString("utf8"));
  requireValue(oldInstallerSha256 === baselineInstallerSha256, "baseline installer bytes changed");
  validateV1527UpgradeReport(report, { testedCommit, installerSha256, bindings });
  const actualBaselineFiles = Object.entries(bindings.fullBaselineHashes);
  const realBaselineRoot = await realpath(path.join(input, "full-baseline-data"));
  const realEvidenceRoot = await realpath(evidenceRoot);
  for (const [relative, expected] of actualBaselineFiles) {
    const target = path.resolve(input, "full-baseline-data", relative);
    requireValue(inside(path.join(input, "full-baseline-data"), target), "baseline path escapes its directory");
    requireValue(inside(realBaselineRoot, await realpath(target)), "baseline symlink escapes its directory");
    requireValue((await hashOrdinary(target)) === expected.toUpperCase(), `baseline file hash changed: ${relative}`);
  }
  for (const entry of report.evidenceFiles) {
    const target = path.resolve(evidenceRoot, entry.file);
    requireValue(inside(evidenceRoot, target), "evidence path escapes its directory");
    requireValue(inside(realEvidenceRoot, await realpath(target)), "evidence symlink escapes its directory");
    requireValue((await hashOrdinary(target)) === entry.sha256, `evidence hash changed: ${entry.id}`);
  }
  return { report, reportSha256: createHash("sha256").update(reportBytes).digest("hex").toUpperCase() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const names = ["--input-root", "--report", "--installer", "--tested-commit"];
  if (args.length !== 8 || names.some((name, index) => args[index * 2] !== name || !args[index * 2 + 1])) {
    process.stderr.write(`usage: node ${path.basename(process.argv[1])} --input-root <dir> --report <json> --installer <exe> --tested-commit <sha>\n`);
    process.exitCode = 2;
  } else {
    verifyV1527UpgradeEvidence({ inputRoot: args[1], reportPath: args[3], installerPath: args[5], testedCommit: args[7] })
      .then((result) => process.stdout.write(`1.5.27 upgrade and rollback evidence verified: ${result.reportSha256}\n`))
      .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}
