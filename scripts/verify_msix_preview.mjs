import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-preview",
  "msix-preview-report.json",
);
const packagePath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-preview",
  "YuanyuanReminder_1.4.0_x64-preview.msix",
);
const executablePath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-preview",
  "cargo-target",
  "release",
  "yuanyuan-reminder.exe",
);
const manifestPath = path.join(
  projectRoot,
  "src-tauri",
  "msix",
  "AppxManifest.preview.xml",
);
const buildScriptPath = path.join(projectRoot, "scripts", "build_msix_preview.ps1");
const iconPath = path.join(projectRoot, "src-tauri", "icons", "128x128@2x.png");
const releasePolicyPath = path.join(
  projectRoot,
  "docs",
  "release",
  "RELEASE_POLICY_V1.json",
);

const EXPECTED_PAYLOAD_FILES = [
  "AppxBlockMap.xml",
  "AppxManifest.xml",
  "Assets/Square150x150Logo.png",
  "Assets/Square44x44Logo.png",
  "Assets/StoreLogo.png",
  "licenses/ASSETS_LICENSE.md",
  "licenses/LICENSE.txt",
  "licenses/THIRD_PARTY_LICENSES.txt",
  "licenses/THIRD_PARTY_NOTICES.md",
  "yuanyuan-reminder.exe",
];
const EXPECTED_LICENSE_FILES = [
  "ASSETS_LICENSE.md",
  "LICENSE.txt",
  "THIRD_PARTY_LICENSES.txt",
  "THIRD_PARTY_NOTICES.md",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exact(Object.keys(value).sort(), [...keys].sort())
  );
}

function canonicalHash(value) {
  return typeof value === "string" && /^[A-F0-9]{64}$/.test(value);
}

function validText(value, minimum = 1, maximum = 300) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

export function msixPreviewEvidenceMatches({
  report,
  releasePolicy,
  packageBytes,
  executableBytes,
  manifestBytes,
  buildScriptBytes,
  iconBytes,
  now = new Date(),
}) {
  if (
    !exactKeys(report, [
      "schemaVersion",
      "mode",
      "generatedAt",
      "candidate",
      "policy",
      "sources",
      "manifest",
      "payload",
      "validation",
      "limitations",
    ]) ||
    report.schemaVersion !== 1 ||
    report.mode !== "msix_preview_candidate"
  ) {
    return false;
  }

  const generatedAt = Date.parse(report.generatedAt);
  if (
    !Number.isFinite(generatedAt) ||
    generatedAt > now.getTime() + 5 * 60 * 1000 ||
    generatedAt < Date.parse("2026-08-10T00:00:00.000Z")
  ) {
    return false;
  }

  const distribution = releasePolicy?.distribution;
  if (
    releasePolicy?.schemaVersion !== 1 ||
    distribution?.strategy !== "low_cost_staged" ||
    distribution.selectedChannel !== "pending" ||
    distribution.previewChannel !== "github_releases" ||
    distribution.previewArtifactPolicy !== "unsigned_beta_with_sha256" ||
    distribution.plannedStableChannel !== "microsoft_store" ||
    !exact(report.policy, {
      strategy: distribution.strategy,
      selectedChannel: distribution.selectedChannel,
      previewArtifactPolicy: distribution.previewArtifactPolicy,
      plannedStableChannel: distribution.plannedStableChannel,
    })
  ) {
    return false;
  }

  if (
    !exactKeys(report.candidate, [
      "version",
      "architecture",
      "path",
      "bytes",
      "sha256",
      "signatureStatus",
      "structureReady",
      "storeSubmissionReady",
    ]) ||
    report.candidate.version !== "1.4.0.0" ||
    report.candidate.architecture !== "x64" ||
    report.candidate.path !==
      "src-tauri/target/msix-preview/YuanyuanReminder_1.4.0_x64-preview.msix" ||
    !Number.isInteger(report.candidate.bytes) ||
    report.candidate.bytes <= 0 ||
    report.candidate.bytes !== packageBytes.length ||
    !canonicalHash(report.candidate.sha256) ||
    report.candidate.sha256 !== sha256(packageBytes) ||
    report.candidate.signatureStatus !== "NotSigned" ||
    report.candidate.structureReady !== true ||
    report.candidate.storeSubmissionReady !== false
  ) {
    return false;
  }

  if (
    !exactKeys(report.sources, [
      "executableBytes",
      "executableSha256",
      "executableSignatureStatus",
      "manifestSha256",
      "buildScriptSha256",
      "iconSha256",
      "makeAppxVersion",
      "makeAppxSha256",
    ]) ||
    report.sources.executableBytes !== executableBytes.length ||
    report.sources.executableSha256 !== sha256(executableBytes) ||
    report.sources.executableSignatureStatus !== "NotSigned" ||
    report.sources.manifestSha256 !== sha256(manifestBytes) ||
    report.sources.buildScriptSha256 !== sha256(buildScriptBytes) ||
    report.sources.iconSha256 !== sha256(iconBytes) ||
    !validText(report.sources.makeAppxVersion, 3, 120) ||
    !canonicalHash(report.sources.makeAppxSha256)
  ) {
    return false;
  }

  if (
    !exact(report.manifest, {
      identityName: "Yuanyuan.Reminder.Preview",
      identityPublisher:
        "CN=YuanyuanReminderPreview, OID.2.25.311729368913984317654407730594956997722=1",
      identityIsPreviewPlaceholder: true,
      applicationId: "YuanyuanReminder",
      executable: "yuanyuan-reminder.exe",
      runtimeBehavior: "packagedClassicApp",
      trustLevel: "mediumIL",
      targetDeviceFamily: "Windows.Desktop",
      minimumWindowsVersion: "10.0.19041.0",
      runFullTrust: true,
    })
  ) {
    return false;
  }

  if (
    !exactKeys(report.payload, [
      "fileCount",
      "files",
      "exactBoundaryVerified",
      "prototypeSidecarsExcluded",
      "nestedInstallerExcluded",
      "licenseFiles",
    ]) ||
    report.payload.fileCount !== EXPECTED_PAYLOAD_FILES.length ||
    !exact(report.payload.files, EXPECTED_PAYLOAD_FILES) ||
    report.payload.exactBoundaryVerified !== true ||
    report.payload.prototypeSidecarsExcluded !== true ||
    report.payload.nestedInstallerExcluded !== true ||
    !exact(report.payload.licenseFiles, EXPECTED_LICENSE_FILES)
  ) {
    return false;
  }

  if (
    !exact(report.validation, {
      makeAppxPackPassed: true,
      makeAppxUnpackPassed: true,
      packageUnsignedByDesign: true,
      looseRegistration: "not_performed",
      applicationLaunch: "not_performed",
      storeIdentityReserved: false,
      storeCertification: "not_performed",
    }) ||
    !Array.isArray(report.limitations) ||
    report.limitations.length !== 3 ||
    !report.limitations.every((limitation) => validText(limitation, 20, 500))
  ) {
    return false;
  }

  return true;
}

async function main() {
  const [
    reportBytes,
    releasePolicyBytes,
    packageBytes,
    executableBytes,
    manifestBytes,
    buildScriptBytes,
    iconBytes,
  ] = await Promise.all([
    readFile(reportPath),
    readFile(releasePolicyPath),
    readFile(packagePath),
    readFile(executablePath),
    readFile(manifestPath),
    readFile(buildScriptPath),
    readFile(iconPath),
  ]);
  const report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const releasePolicy = JSON.parse(
    releasePolicyBytes.toString("utf8").replace(/^\uFEFF/, ""),
  );
  if (
    !msixPreviewEvidenceMatches({
      report,
      releasePolicy,
      packageBytes,
      executableBytes,
      manifestBytes,
      buildScriptBytes,
      iconBytes,
    })
  ) {
    throw new Error("msix_preview_evidence_mismatch");
  }
  process.stdout.write(
    `MSIX preview evidence verified: ${report.candidate.sha256}, storeSubmissionReady=false.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX preview verification failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
