import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256Pattern = /^[A-F0-9]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(`community stable acceptance draft rejected: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function checkPassed(report, id) {
  return report.checks?.some((check) => check.id === id && check.passed === true) === true;
}

export function buildCommunityStableAcceptanceDraft({
  authority,
  brand,
  testedCommit,
  installerBytes,
  endurance,
  enduranceSha256,
  enduranceBinding,
  enduranceBindingSha256,
  installedStatus,
  installedStatusSha256,
  v132Status,
  v132StatusSha256,
  v132Capture,
  v132Migration,
  learningEnvelope,
  learningEnvelopeSha256,
  learningRuntime,
}) {
  requireValue(authority?.schemaVersion === 1, "version authority is invalid");
  requireValue(/^\d+\.\d+\.\d+$/u.test(authority.version), "acceptance draft version is invalid");
  requireValue(authority.productName === brand?.application?.displayName, "product name and brand disagree");
  requireValue(authority.identifier === brand?.application?.identifier, "product identifier and brand disagree");
  requireValue(commitPattern.test(testedCommit), "tested commit is invalid");
  requireValue(Buffer.isBuffer(installerBytes) && installerBytes.length > 0, "installer bytes are missing");
  const installerSha256 = sha256(installerBytes);
  for (const [label, digest] of [
    ["endurance report", enduranceSha256],
    ["endurance source binding", enduranceBindingSha256],
    ["installed E2E status", installedStatusSha256],
    ["v1.3.2 status", v132StatusSha256],
    ["learning envelope", learningEnvelopeSha256],
  ]) requireValue(sha256Pattern.test(digest), `${label} SHA-256 is invalid`);

  requireValue(endurance?.ready === true && endurance.acceptanceGate?.passed === true, "endurance report is not accepted");
  requireValue(endurance.request?.acceptanceGateRequested === true, "endurance acceptance gate was not requested");
  requireValue(enduranceBinding?.schemaVersion === 1 && enduranceBinding.buildVariant === "runtime-qa-learning", "endurance source binding is not learning-on");
  requireValue(enduranceBinding.source?.commit === testedCommit && enduranceBinding.source?.dirty === false, "endurance source binding differs from the tested commit");
  requireValue(enduranceBinding.product?.version === authority.version, "endurance source binding version differs from the product");
  requireValue(enduranceBinding.product?.name === authority.productName && enduranceBinding.product?.identifier === authority.identifier, "endurance source binding product differs from the product");
  requireValue(enduranceBinding.artifacts?.application?.sha256 === endurance.bindings?.applicationSha256, "endurance application differs from the source binding");
  requireValue(enduranceBinding.artifacts?.fixture?.sha256 === endurance.bindings?.fixtureSha256, "endurance fixture differs from the source binding");
  requireValue(enduranceBinding.artifacts?.measureScript?.sha256 === endurance.bindings?.scriptSha256, "endurance script differs from the source binding");
  requireValue(installedStatus?.schemaVersion === 2 && installedStatus.ready === true, "installed E2E status is not ready");
  requireValue(installedStatus.source?.commit === testedCommit, "installed E2E commit differs from the tested commit");
  requireValue(installedStatus.candidateStage?.installerSha256 === installerSha256, "installed E2E used a different installer");
  requireValue(installedStatus.functional?.installerSha256 === installerSha256, "functional E2E used a different installer");
  requireValue(v132Status?.ready === true && v132Status.source?.commit === testedCommit, "v1.3.2 evidence commit differs from the tested commit");
  requireValue(learningEnvelope?.status === "passed" && learningEnvelope.sourceCommit === testedCommit, "learning evidence commit differs from the tested commit");
  requireValue(learningEnvelope.sourceBindingSha256 === enduranceBindingSha256, "learning evidence used a different source binding");
  requireValue(learningRuntime?.status === "passed", "learning runtime report is not passed");
  requireValue(v132Capture?.status === "passed" && v132Migration?.status === "passed", "v1.3.2 reports are not passed");
  requireValue(v132Capture.fixtureLogicalSha256 === v132Migration.sourceLogicalSha256, "v1.3.2 normalized source digest changed");
  requireValue(v132Migration.migratedMatchedSourceRowsSha256 === v132Migration.sourceLogicalSha256, "v1.3.2 rows changed during migration");
  requireValue(checkPassed(v132Migration, "backup_restore"), "v1.3.2 backup/restore did not pass");
  requireValue(checkPassed(v132Migration, "failed_restore_rollback"), "v1.3.2 failure rollback did not pass");

  return {
    schemaVersion: 1,
    status: "pending",
    product: {
      name: authority.productName,
      identifier: authority.identifier,
      version: authority.version,
    },
    candidate: {
      testedCommit,
      installerSha256,
    },
    checks: {
      endurance24h: {
        status: "passed",
        reportSha256: enduranceSha256,
        sourceBindingSha256: enduranceBindingSha256,
        observedSeconds: endurance.clock.wallClockObservedSeconds,
        activeCoverageSeconds: endurance.clock.activeSampleCoverageSeconds,
        suspendResumeObserved: endurance.transitions.powerSuspendResumeObserved,
        lockUnlockObserved: endurance.transitions.sessionLockUnlockObserved,
        controlledExit: endurance.process.controlledExit,
        applicationErrorCount: endurance.isolation.applicationErrorCount,
        formalUserFilesWritten: endurance.storage.formalUserFilesWritten,
      },
      installedCandidateE2e: {
        status: "passed",
        reportSha256: installedStatusSha256,
        installerSha256,
        scenarios: structuredClone(installedStatus.functional.scenarios),
        formalUserDataUsed: installedStatus.functional.formalUserDataUsed,
        cleanupVerified: Object.values(installedStatus.functional.cleanup).every((value) => value === true),
      },
      legacyDataCompatibility: {
        status: "passed",
        sourceVersion: "1.3.2",
        normalizedSourceSha256: v132Capture.fixtureLogicalSha256,
        reportSha256: v132StatusSha256,
        sourceUnchanged: v132Capture.sourceStableDuringCapture === true,
        allRowsPreserved: v132Migration.migratedMatchedSourceRowsSha256 === v132Migration.sourceLogicalSha256,
        backupRestorePassed: true,
        failureRollbackPassed: true,
      },
      learningRuntime: {
        status: "passed",
        reportSha256: learningEnvelopeSha256,
        sourceBindingSha256: enduranceBindingSha256,
        tauriImportPassed: learningRuntime.tauriImportPassed,
        cancellationPassed: learningRuntime.cancellationPassed,
        importedCards: learningRuntime.importedCards,
        paginationPassed: learningRuntime.paginationPassed,
        answersApplied: learningRuntime.answersApplied,
        databaseGrowthWithinLimit: learningRuntime.databaseGrowthWithinLimit,
        backupRestorePassed: learningRuntime.backupRestorePassed,
      },
    },
    review: {
      operator: null,
      completedAt: null,
      unresolvedFindings: [],
    },
  };
}

function parseArguments(argv) {
  const allowed = new Set([
    "--tested-commit",
    "--installer",
    "--endurance-report",
    "--endurance-binding",
    "--installed-evidence-root",
    "--v132-evidence-root",
    "--learning-report",
    "--output-dir",
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(argument) || !value || options[argument]) fail(`unknown, duplicate, or incomplete option: ${argument}`);
    options[argument] = value;
    index += 1;
  }
  for (const key of allowed) requireValue(options[key], `${key} is required`);
  return options;
}

async function readJsonDocument(filePath) {
  const bytes = await readFile(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")) };
}

function relativeEvidencePath(absolutePath) {
  const relative = path.relative(projectRoot, absolutePath);
  requireValue(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "evidence path is outside the project");
  return relative.replaceAll(path.sep, "/");
}

function isInsideOrEqual(basePath, candidatePath) {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function validateOwnedAcceptanceOutputPath(
  outputDir,
  ownedBase = path.join(projectRoot, "work", "customization"),
) {
  const [resolvedBase, resolvedParent] = await Promise.all([
    realpath(ownedBase),
    realpath(path.dirname(outputDir)),
  ]);
  requireValue(
    isInsideOrEqual(resolvedBase, resolvedParent),
    "output parent resolves outside work/customization",
  );
  requireValue(
    path.basename(outputDir).length > 0 && path.resolve(outputDir) !== resolvedBase,
    "output directory must be a new child of work/customization",
  );
  return resolvedBase;
}

function runVerifier(script, arguments_) {
  execFileSync(process.execPath, [path.join(projectRoot, "scripts", script), ...arguments_], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const testedCommit = options["--tested-commit"];
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  requireValue(testedCommit === currentCommit && commitPattern.test(testedCommit), "tested commit must equal the current HEAD");
  const installerPath = path.resolve(options["--installer"]);
  const endurancePath = path.resolve(options["--endurance-report"]);
  const enduranceBindingPath = path.resolve(options["--endurance-binding"]);
  const installedRoot = path.resolve(options["--installed-evidence-root"]);
  const v132Root = path.resolve(options["--v132-evidence-root"]);
  const learningPath = path.resolve(options["--learning-report"]);
  const outputDir = path.resolve(options["--output-dir"]);
  const resolvedOutputBase = await validateOwnedAcceptanceOutputPath(outputDir);
  runVerifier("verify_community_stable_runtime_baseline_candidate.mjs", [
    "--binding",
    enduranceBindingPath,
    "--report",
    endurancePath,
    "--tested-commit",
    testedCommit,
  ]);
  runVerifier("verify_community_stable_installed_e2e.mjs", ["--evidence-root", installedRoot]);
  runVerifier("verify_community_stable_v132_evidence.mjs", ["--evidence-root", v132Root]);
  runVerifier("verify_community_stable_learning_runtime_evidence.mjs", [
    "--report",
    learningPath,
    "--binding",
    enduranceBindingPath,
  ]);

  const [
    authority,
    brand,
    installerBytes,
    endurance,
    enduranceBinding,
    installedStatus,
    v132Status,
    v132Capture,
    v132Migration,
    learningEnvelope,
  ] = await Promise.all([
    readJsonDocument(path.join(projectRoot, "product-version.json")),
    readJsonDocument(path.join(projectRoot, "product-brand.json")),
    readFile(installerPath),
    readJsonDocument(endurancePath),
    readJsonDocument(enduranceBindingPath),
    readJsonDocument(path.join(installedRoot, "sandbox-data-probe-status.json")),
    readJsonDocument(path.join(v132Root, "v132-sandbox-status.json")),
    readJsonDocument(path.join(v132Root, "v132-capture-report.json")),
    readJsonDocument(path.join(v132Root, "current-migration-report.json")),
    readJsonDocument(learningPath),
  ]);
  const learningRuntimePath = path.join(path.dirname(learningPath), learningEnvelope.value.runtimeReportFile);
  const learningRuntime = await readJsonDocument(learningRuntimePath);
  const draft = buildCommunityStableAcceptanceDraft({
    authority: authority.value,
    brand: brand.value,
    testedCommit,
    installerBytes,
    endurance: endurance.value,
    enduranceSha256: sha256(endurance.bytes),
    enduranceBinding: enduranceBinding.value,
    enduranceBindingSha256: sha256(enduranceBinding.bytes),
    installedStatus: installedStatus.value,
    installedStatusSha256: sha256(installedStatus.bytes),
    v132Status: v132Status.value,
    v132StatusSha256: sha256(v132Status.bytes),
    v132Capture: v132Capture.value,
    v132Migration: v132Migration.value,
    learningEnvelope: learningEnvelope.value,
    learningEnvelopeSha256: sha256(learningEnvelope.bytes),
    learningRuntime: learningRuntime.value,
  });
  const draftBytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, "utf8");
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    testedCommit,
    productVersion: authority.value.version,
    acceptanceDraftSha256: sha256(draftBytes),
    installer: { path: relativeEvidencePath(installerPath), bytes: installerBytes.length, sha256: draft.candidate.installerSha256 },
    evidence: {
      endurance24h: {
        path: relativeEvidencePath(endurancePath),
        sha256: draft.checks.endurance24h.reportSha256,
        buildVariant: "runtime-qa-learning",
        sourceBinding: {
          path: relativeEvidencePath(enduranceBindingPath),
          sha256: draft.checks.endurance24h.sourceBindingSha256,
        },
      },
      installedCandidateE2e: { path: relativeEvidencePath(path.join(installedRoot, "sandbox-data-probe-status.json")), sha256: draft.checks.installedCandidateE2e.reportSha256 },
      legacyDataCompatibility: { path: relativeEvidencePath(path.join(v132Root, "v132-sandbox-status.json")), sha256: draft.checks.legacyDataCompatibility.reportSha256 },
      learningRuntime: { path: relativeEvidencePath(learningPath), sha256: draft.checks.learningRuntime.reportSha256 },
    },
  };
  await mkdir(outputDir);
  requireValue(
    isInsideOrEqual(resolvedOutputBase, await realpath(outputDir)),
    "created output directory resolves outside work/customization",
  );
  await Promise.all([
    writeFile(path.join(outputDir, "COMMUNITY_STABLE_ACCEPTANCE_V1.draft.json"), draftBytes, { flag: "wx" }),
    writeFile(path.join(outputDir, "community-stable-acceptance-evidence.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
  ]);
  process.stdout.write(`Community stable acceptance draft prepared: ${outputDir}\n`);
  process.stdout.write("The draft remains pending and requires Brucexia's explicit review.\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
