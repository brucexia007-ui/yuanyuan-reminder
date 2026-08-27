import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sha256Pattern = /^[0-9A-F]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(message) {
  throw new Error(`installed-candidate E2E evidence rejected: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function exactKeys(value, expected, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireValue(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys are not exact`);
}

function allTrue(value, keys, label) {
  exactKeys(value, keys, label);
  for (const key of keys) requireValue(value[key] === true, `${label}.${key} must be true`);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function sha256(file) {
  const digest = createHash("sha256");
  digest.update(await readFile(file));
  return digest.digest("hex").toUpperCase();
}

function gitText(arguments_) {
  return execFileSync("git", ["-C", projectRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function currentSource() {
  return {
    branch: gitText(["branch", "--show-current"]),
    commit: gitText(["rev-parse", "HEAD"]),
    dirty: gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0,
  };
}

export function validateInstalledE2eEvidence({
  status,
  payload,
  uninstall,
  webView,
  sourceMetadata,
  authority,
  packageJson,
  observed,
  requireClean = true,
}) {
  exactKeys(status, [
    "schemaVersion",
    "generatedAt",
    "profile",
    "sandboxUser",
    "interactiveSession",
    "syntheticDataOnly",
    "candidateUsesEmbeddedOnlineWebView2Bootstrapper",
    "mappedMicrosoftWebView2RuntimeVerified",
    "mappedMicrosoftWebView2RuntimeSha256",
    "temporaryWebView2DetectionRegistration",
    "candidateCopiedToSandboxDisk",
    "payloadInspectionPassed",
    "uninstallDataChoicePassed",
    "functional",
    "reportsCopied",
    "failureDiagnostics",
    "source",
    "sourceMetadataSha256",
    "probeScriptSha256",
    "hostScriptSha256",
    "ready",
    "failure",
  ], "status");
  requireValue(status.schemaVersion === 1, "status schemaVersion must be 1");
  requireValue(status.profile === "community-stable-installed-e2e", "status profile is wrong");
  requireValue(status.sandboxUser === "WDAGUtilityAccount", "status was not captured in Windows Sandbox");
  for (const key of [
    "interactiveSession",
    "syntheticDataOnly",
    "candidateUsesEmbeddedOnlineWebView2Bootstrapper",
    "mappedMicrosoftWebView2RuntimeVerified",
    "temporaryWebView2DetectionRegistration",
    "candidateCopiedToSandboxDisk",
    "payloadInspectionPassed",
    "uninstallDataChoicePassed",
    "reportsCopied",
    "ready",
  ]) requireValue(status[key] === true, `status.${key} must be true`);
  requireValue(status.failure === null && status.failureDiagnostics === null, "status contains a failure");
  requireValue(Number.isFinite(Date.parse(status.generatedAt)), "status generatedAt is invalid");

  exactKeys(status.source, ["schemaVersion", "capturedAt", "branch", "commit", "dirty"], "status.source");
  requireValue(status.source.schemaVersion === 1, "source schemaVersion must be 1");
  requireValue(Number.isFinite(Date.parse(status.source.capturedAt)), "source capturedAt is invalid");
  requireValue(status.source.branch === observed.source.branch && status.source.branch.length > 0, "source branch does not match current checkout");
  requireValue(commitPattern.test(status.source.commit), "source commit is invalid");
  requireValue(status.source.commit === observed.source.commit, "source commit does not match current checkout");
  requireValue(status.source.dirty === observed.source.dirty, "source dirty state does not match current checkout");
  if (requireClean) requireValue(status.source.dirty === false, "formal evidence requires a clean source checkout");
  requireValue(JSON.stringify(status.source) === JSON.stringify(sourceMetadata), "source metadata file does not match status");

  for (const [label, actual, expected] of [
    ["source metadata", status.sourceMetadataSha256, observed.sourceMetadataSha256],
    ["Sandbox probe script", status.probeScriptSha256, observed.probeScriptSha256],
    ["Sandbox host script", status.hostScriptSha256, observed.hostScriptSha256],
    ["mapped WebView2 runtime", status.mappedMicrosoftWebView2RuntimeSha256, webView.sha256],
  ]) {
    requireValue(sha256Pattern.test(actual), `${label} SHA-256 is invalid`);
    requireValue(actual === expected, `${label} SHA-256 does not match`);
  }

  requireValue(authority.version === packageJson.version, "product version authority and package disagree");
  requireValue(payload.ready === true && payload.mode === "nsis_installed_payload", "payload report is not ready");
  requireValue(payload.candidate.productVersion === authority.version, "payload product version is wrong");
  requireValue(payload.candidate.installedProductVersion === authority.version, "installed payload version is wrong");
  requireValue(payload.candidate.bothUnsigned === true, "community candidate unsigned disclosure changed");
  requireValue(payload.candidate.exactUnsignedMarkerPatch === true, "NSIS marker patch is not exact");
  requireValue(payload.bindings.inspectionScriptSha256 === observed.payloadScriptSha256, "payload inspector binding is stale");
  requireValue(payload.bindings.sourceStableCoreSha256 === observed.sourceCoreSha256, "source core binding is stale");
  requireValue(payload.bindings.installerSha256 === observed.installerSha256, "payload installer binding is stale");
  requireValue(payload.cleanup.uninstallExitCode === 0, "payload inspection uninstall failed");
  for (const key of [
    "installRootRemoved",
    "uninstallRegistrationRemoved",
    "productRegistrationPersistedAfterUninstall",
    "ownedProductRegistrationRemoved",
    "desktopShortcutStatePreserved",
    "startMenuShortcutStatePreserved",
  ]) requireValue(payload.cleanup[key] === true, `payload cleanup.${key} must be true`);
  requireValue(payload.cleanup.applicationProcessCount === 0, "payload cleanup left an application process");

  exactKeys(status.functional, [
    "installerSha256",
    "installedCoreSha256",
    "helperSha256",
    "helperSeedExitCode",
    "installExitCode",
    "scenarios",
    "reminder",
    "mutation",
    "panelDragEvidence",
    "formalUserDataUsed",
    "cleanup",
  ], "status.functional");
  requireValue(status.functional.installerSha256 === observed.installerSha256, "functional installer binding is stale");
  requireValue(status.functional.installedCoreSha256 === payload.bindings.installedCoreSha256, "functional installed core binding is stale");
  requireValue(status.functional.helperSha256 === observed.helperSha256, "functional helper binding is stale");
  requireValue(status.functional.helperSeedExitCode === 0 && status.functional.installExitCode === 0, "installation or seed exited unsuccessfully");
  requireValue(status.functional.formalUserDataUsed === false, "functional E2E used formal user data");
  allTrue(status.functional.scenarios, [
    "installAndLaunch",
    "reminderDelivery",
    "hideAndRestorePet",
    "panelDrag",
    "backupAndRestore",
    "restartPersistence",
    "uninstallKeepsDataByDefault",
  ], "status.functional.scenarios");
  allTrue(status.functional.cleanup, [
    "applicationExited",
    "installRootRemoved",
    "dataRootRemoved",
    "roamingDataRootAbsent",
    "uninstallRegistrationRemoved",
    "productRegistrationPersistedAfterUninstall",
    "ownedProductRegistrationRemoved",
    "shortcutsRemoved",
    "sandboxShutdownRequested",
  ], "status.functional.cleanup");
  requireValue(uuidPattern.test(status.functional.reminder.reminderId), "seed reminder id is invalid");
  requireValue(uuidPattern.test(status.functional.mutation.reminderId), "mutation reminder id is invalid");
  requireValue(status.functional.reminder.reminderId !== status.functional.mutation.reminderId, "seed and mutation ids are not distinct");
  requireValue(/^E2E提醒-[0-9a-f]{8}$/u.test(status.functional.reminder.title), "seed title is not synthetic");
  requireValue(/^E2E变更-[0-9a-f]{8}$/u.test(status.functional.mutation.title), "mutation title is not synthetic");
  requireValue(Number.isFinite(Date.parse(status.functional.reminder.scheduledAt)), "seed schedule is invalid");
  const drag = status.functional.panelDragEvidence;
  exactKeys(drag, ["before", "after", "moved"], "panelDragEvidence");
  requireValue(drag.moved === true, "panel drag was not observed");
  const dx = Math.abs(drag.after.left - drag.before.left);
  const dy = Math.abs(drag.after.top - drag.before.top);
  requireValue(dx >= 40 && dy >= 40, "panel drag distance is below the physical threshold");
  requireValue(drag.before.right - drag.before.left === drag.after.right - drag.after.left, "panel width changed during drag");
  requireValue(drag.before.bottom - drag.before.top === drag.after.bottom - drag.after.top, "panel height changed during drag");

  requireValue(uninstall.ready === true && uninstall.mode === "release_uninstall_data_choice_probe", "uninstall report is not ready");
  requireValue(uninstall.version === authority.version, "uninstall report version is wrong");
  requireValue(uninstall.bindings.probeScriptSha256 === observed.uninstallScriptSha256, "uninstall probe binding is stale");
  requireValue(uninstall.bindings.candidateInstallerSha256 === observed.installerSha256, "uninstall installer binding is stale");
  requireValue(uninstall.bindings.candidateInstalledCoreSha256 === status.functional.installedCoreSha256, "uninstall core binding is stale");
  requireValue(uninstall.bindings.candidateInstallerBytes === observed.installerBytes, "uninstall installer byte binding is stale");
  requireValue(uninstall.scenarios.defaultPreserve.installExitCode === 0, "default-preserve install failed");
  requireValue(uninstall.scenarios.defaultPreserve.uninstallExitCode === 0, "default-preserve uninstall failed");
  requireValue(uninstall.scenarios.defaultPreserve.installedProductVersion === authority.version, "default-preserve version is wrong");
  requireValue(uninstall.scenarios.explicitDelete.installExitCode === 0, "explicit-delete install failed");
  requireValue(uninstall.scenarios.explicitDelete.installedProductVersion === authority.version, "explicit-delete version is wrong");
  for (const value of Object.values(uninstall.scenarios.defaultPreserve)) {
    if (typeof value === "boolean") requireValue(value === true, "default-preserve uninstall scenario is incomplete");
  }
  for (const [key, value] of Object.entries(uninstall.scenarios.explicitDelete)) {
    if (typeof value === "boolean" && key !== "processTreeTimedOut") requireValue(value === true, "explicit-delete uninstall scenario is incomplete");
  }
  requireValue(uninstall.scenarios.explicitDelete.processTreeTimedOut === false, "explicit-delete uninstall timed out");
  requireValue(uninstall.dataBoundary.syntheticSentinelsOnly === true && uninstall.dataBoundary.authenticUserDataUsed === false, "uninstall probe crossed the synthetic data boundary");
  for (const value of Object.values(uninstall.cleanup)) {
    if (typeof value === "boolean") requireValue(value === true, "uninstall cleanup is incomplete");
    if (typeof value === "number") requireValue(value === 0, "uninstall cleanup process count is nonzero");
  }

  requireValue(webView.schemaVersion === 1, "WebView2 metadata schema is wrong");
  requireValue(webView.source === "installed-host-microsoft-webview2-runtime", "WebView2 source is wrong");
  requireValue(webView.signatureStatus === "Valid", "mapped WebView2 signature is invalid");
  requireValue(webView.signerSubject.includes("O=Microsoft Corporation"), "mapped WebView2 signer is not Microsoft");
  requireValue(Number.isInteger(webView.bytes) && webView.bytes > 0, "mapped WebView2 byte count is invalid");
  requireValue(typeof webView.productVersion === "string" && webView.productVersion.length > 0, "mapped WebView2 version is missing");
}

function argumentValue(name) {
  const positions = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length !== 1 || !process.argv[positions[0] + 1]) fail(`${name} must be provided exactly once`);
  return process.argv[positions[0] + 1];
}

async function main() {
  const evidenceRoot = path.resolve(argumentValue("--evidence-root"));
  const allowedRoot = path.join(projectRoot, "src-tauri", "target", "community-stable-sandbox-data") + path.sep;
  requireValue(evidenceRoot.startsWith(allowedRoot), "evidence root is outside the generated Sandbox evidence area");
  const [status, payload, uninstall, webView, sourceMetadata, authority, packageJson] = await Promise.all([
    readJson(path.join(evidenceRoot, "sandbox-data-probe-status.json")),
    readJson(path.join(evidenceRoot, "nsis-installed-payload.json")),
    readJson(path.join(evidenceRoot, "release-uninstall-data-choice-probe.json")),
    readJson(path.join(evidenceRoot, "webview2-mapped-runtime.json")),
    readJson(path.join(evidenceRoot, "source-metadata.json")),
    readJson(path.join(projectRoot, "product-version.json")),
    readJson(path.join(projectRoot, "package.json")),
  ]);
  const installers = (await readdir(path.join(projectRoot, "src-tauri", "target", "release", "bundle", "nsis")))
    .filter((name) => name.endsWith(`_${authority.version}_x64-setup.exe`));
  requireValue(installers.length === 1, "current release root must contain exactly one version-matched NSIS installer");
  const installerPath = path.join(projectRoot, "src-tauri", "target", "release", "bundle", "nsis", installers[0]);
  const installerStat = await stat(installerPath);
  const observed = {
    source: currentSource(),
    sourceMetadataSha256: await sha256(path.join(evidenceRoot, "source-metadata.json")),
    probeScriptSha256: await sha256(path.join(projectRoot, "scripts", "run_community_stable_sandbox_data_probe.ps1")),
    hostScriptSha256: await sha256(path.join(projectRoot, "scripts", "run_community_stable_sandbox_data_probe_host.ps1")),
    payloadScriptSha256: await sha256(path.join(projectRoot, "scripts", "inspect_nsis_payload.ps1")),
    uninstallScriptSha256: await sha256(path.join(projectRoot, "scripts", "probe_release_uninstall_data_choice.ps1")),
    sourceCoreSha256: await sha256(path.join(projectRoot, "src-tauri", "target", "release", "yuanyuan-reminder.exe")),
    helperSha256: await sha256(path.join(projectRoot, "src-tauri", "target", "release", "yuanyuan-installed-candidate-qa.exe")),
    installerSha256: await sha256(installerPath),
    installerBytes: installerStat.size,
  };
  validateInstalledE2eEvidence({
    status,
    payload,
    uninstall,
    webView,
    sourceMetadata,
    authority,
    packageJson,
    observed,
    requireClean: !process.argv.includes("--allow-dirty"),
  });
  requireValue(
    await readFile(path.join(evidenceRoot, "sandbox-data-probe.complete"), "utf8") ===
      "YUANYUAN_WINDOWS_SANDBOX_DATA_PROBE_COMPLETE_V1\n",
    "completion marker is invalid",
  );
  requireValue(
    await readFile(path.join(evidenceRoot, "sandbox-logon-command.started"), "utf8") ===
      "YUANYUAN_WINDOWS_SANDBOX_LOGON_STARTED_V1\n",
    "Sandbox logon marker is invalid",
  );
  const progress = await readFile(path.join(evidenceRoot, "sandbox-data-probe-progress.log"), "utf8");
  requireValue(progress.includes(" result:ready\n") && progress.trimEnd().endsWith("result:writing-status"), "progress log did not reach the final ready state");
  console.log(`Installed-candidate E2E evidence verified: ${evidenceRoot}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
