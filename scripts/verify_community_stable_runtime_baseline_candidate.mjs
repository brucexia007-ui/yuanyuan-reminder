import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRuntimeBaselineEvidence,
  validateRuntimeBaselineEvidence,
} from "./verify_runtime_baseline_evidence.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "runtime-qa-learning", "release");
const evidenceRoot = path.join(releaseRoot, "evidence");
const commitPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[A-F0-9]{64}$/u;
const expectedConfiguration = [
  "product-version.json",
  "product-brand.json",
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
];
const expectedArtifacts = {
  application: "src-tauri/target/runtime-qa-learning/release/yuanyuan-reminder.exe",
  fixture: "src-tauri/target/runtime-qa-learning/release/yuanyuan-runtime-qa-fixture.exe",
  measureScript: "scripts/measure_runtime_baseline.ps1",
};
const expectedTools = {
  buildScript: "scripts/build_community_stable_runtime_baseline_candidate.ps1",
  runScript: "scripts/run_community_stable_runtime_baseline.ps1",
  exclusivityScript: "scripts/assert_runtime_qa_exclusive.ps1",
  prepareScript: "scripts/prepare_community_stable_runtime_baseline_candidate.mjs",
  verifyScript: "scripts/verify_community_stable_runtime_baseline_candidate.mjs",
  sourceBindingVerifyScript: "scripts/verify_community_stable_runtime_source_binding.mjs",
};

function fail(message) {
  throw new Error(`community stable runtime baseline binding rejected: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) fail(`${label} fields are invalid`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function gitText(arguments_) {
  return execFileSync("git", arguments_, { cwd: projectRoot, encoding: "utf8" }).trim();
}

async function readOrdinary(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const metadata = await lstat(absolutePath);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink(), `${relativePath} must remain an ordinary file`);
  const bytes = await readFile(absolutePath);
  return { bytes, metadata };
}

function validateFileBinding(binding, expectedPath, observed, label) {
  exactKeys(binding, ["path", "bytes", "sha256"], label);
  requireValue(binding.path === expectedPath, `${label} path changed`);
  requireValue(Number.isSafeInteger(binding.bytes) && binding.bytes === observed.bytes.length, `${label} size changed`);
  requireValue(sha256Pattern.test(binding.sha256) && binding.sha256 === sha256(observed.bytes), `${label} SHA-256 changed`);
}

export function validateRuntimeBaselineSourceBindingManifest({
  binding,
  testedCommit,
  currentSource,
  authority,
  brand,
  observedConfiguration,
  observedArtifacts,
  observedTools,
}) {
  exactKeys(binding, ["schemaVersion", "capturedAt", "buildStartedAt", "buildVariant", "source", "product", "configuration", "artifacts", "tools"], "binding");
  requireValue(binding.schemaVersion === 1 && binding.buildVariant === "runtime-qa-learning", "binding is not the integrated learning build");
  requireValue(Number.isFinite(Date.parse(binding.capturedAt)) && Number.isFinite(Date.parse(binding.buildStartedAt)), "binding timestamps are invalid");
  requireValue(Date.parse(binding.buildStartedAt) <= Date.parse(binding.capturedAt), "binding predates its controlled build");
  exactKeys(binding.source, ["commit", "branch", "dirty"], "binding.source");
  requireValue(commitPattern.test(testedCommit) && binding.source.commit === testedCommit, "binding commit differs from testedCommit");
  requireValue(binding.source.dirty === false && currentSource.dirty === false, "formal runtime binding requires a clean source");
  requireValue(JSON.stringify(binding.source) === JSON.stringify(currentSource), "binding source differs from the current checkout");
  exactKeys(binding.product, ["name", "identifier", "version"], "binding.product");
  requireValue(binding.product.name === authority.productName && binding.product.name === brand.application.displayName, "binding product name drifted");
  requireValue(binding.product.identifier === authority.identifier && binding.product.identifier === brand.application.identifier, "binding identifier drifted");
  requireValue(binding.product.version === authority.version, "binding version drifted");
  exactKeys(binding.configuration, expectedConfiguration, "binding.configuration");
  for (const relativePath of expectedConfiguration) {
    requireValue(binding.configuration[relativePath] === sha256(observedConfiguration[relativePath].bytes), `${relativePath} configuration changed`);
  }
  exactKeys(binding.artifacts, Object.keys(expectedArtifacts), "binding.artifacts");
  for (const [key, relativePath] of Object.entries(expectedArtifacts)) {
    validateFileBinding(binding.artifacts[key], relativePath, observedArtifacts[key], `binding.artifacts.${key}`);
  }
  exactKeys(binding.tools, Object.keys(expectedTools), "binding.tools");
  for (const [key, relativePath] of Object.entries(expectedTools)) {
    validateFileBinding(binding.tools[key], relativePath, observedTools[key], `binding.tools.${key}`);
  }
  return binding;
}

export function validateRuntimeBaselineCandidateManifest({ report, ...sourceBindingInput }) {
  const binding = validateRuntimeBaselineSourceBindingManifest(sourceBindingInput);
  requireValue(Date.parse(report.clock.launchUtc) >= Date.parse(binding.capturedAt), "runtime report started before candidate binding");
  requireValue(report.bindings.applicationSha256 === binding.artifacts.application.sha256, "runtime application differs from binding");
  requireValue(report.bindings.fixtureSha256 === binding.artifacts.fixture.sha256, "runtime fixture differs from binding");
  requireValue(report.bindings.scriptSha256 === binding.artifacts.measureScript.sha256, "runtime script differs from binding");
  return binding;
}

export async function verifyRuntimeBaselineSourceBinding({ bindingPath, testedCommit, observedAt }) {
  const resolvedBinding = path.resolve(bindingPath);
  requireValue(path.dirname(resolvedBinding) === evidenceRoot && /^runtime-baseline-candidate-\d{8}T\d{6}Z\.json$/u.test(path.basename(resolvedBinding)), "binding path is outside the owned evidence directory");
  requireValue(await realpath(path.dirname(resolvedBinding)) === await realpath(evidenceRoot), "evidence directory resolves outside the owned root");
  const bindingMetadata = await lstat(resolvedBinding);
  requireValue(bindingMetadata.isFile() && !bindingMetadata.isSymbolicLink(), "binding must be an ordinary file");

  const dirty = gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0;
  const currentSource = {
    commit: gitText(["rev-parse", "HEAD"]),
    branch: gitText(["branch", "--show-current"]),
    dirty,
  };
  const [bindingBytes, authorityBytes, brandBytes, configurationEntries, artifactEntries, toolEntries] = await Promise.all([
    readFile(resolvedBinding),
    readFile(path.join(projectRoot, "product-version.json")),
    readFile(path.join(projectRoot, "product-brand.json")),
    Promise.all(expectedConfiguration.map(async (relativePath) => [relativePath, await readOrdinary(relativePath)])),
    Promise.all(Object.entries(expectedArtifacts).map(async ([key, relativePath]) => [key, await readOrdinary(relativePath)])),
    Promise.all(Object.entries(expectedTools).map(async ([key, relativePath]) => [key, await readOrdinary(relativePath)])),
  ]);
  const binding = JSON.parse(bindingBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  validateRuntimeBaselineSourceBindingManifest({
    binding,
    testedCommit,
    currentSource,
    authority: JSON.parse(authorityBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    brand: JSON.parse(brandBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    observedConfiguration: Object.fromEntries(configurationEntries),
    observedArtifacts: Object.fromEntries(artifactEntries),
    observedTools: Object.fromEntries(toolEntries),
  });
  requireValue(Number.isFinite(Date.parse(observedAt)) && Date.parse(observedAt) >= Date.parse(binding.capturedAt), "observation predates candidate binding");
  return { binding, bindingSha256: sha256(bindingBytes) };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--binding", "--report", "--tested-commit"]).has(key) || !value || options[key]) fail(`unknown, duplicate, or incomplete option: ${key}`);
    options[key] = value;
  }
  for (const key of ["--binding", "--report", "--tested-commit"]) requireValue(options[key], `${key} is required`);
  return options;
}

export async function verifyRuntimeBaselineCandidate({ bindingPath, reportPath, testedCommit }) {
  const resolvedBinding = path.resolve(bindingPath);
  const resolvedReport = path.resolve(reportPath);
  requireValue(path.dirname(resolvedBinding) === evidenceRoot && /^runtime-baseline-candidate-\d{8}T\d{6}Z\.json$/u.test(path.basename(resolvedBinding)), "binding path is outside the owned evidence directory");
  requireValue(path.dirname(resolvedReport) === evidenceRoot && /^runtime-baseline-\d{8}T\d{6}Z\.json$/u.test(path.basename(resolvedReport)), "report path is outside the owned evidence directory");
  requireValue(await realpath(path.dirname(resolvedBinding)) === await realpath(evidenceRoot), "evidence directory resolves outside the owned root");
  const [bindingMetadata, reportMetadata] = await Promise.all([lstat(resolvedBinding), lstat(resolvedReport)]);
  requireValue(bindingMetadata.isFile() && !bindingMetadata.isSymbolicLink(), "binding must be an ordinary file");
  requireValue(reportMetadata.isFile() && !reportMetadata.isSymbolicLink(), "report must be an ordinary file");

  const dirty = gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0;
  const currentSource = {
    commit: gitText(["rev-parse", "HEAD"]),
    branch: gitText(["branch", "--show-current"]),
    dirty,
  };
  const [bindingBytes, reportBytes, authorityBytes, brandBytes, configurationEntries, artifactEntries, toolEntries] = await Promise.all([
    readFile(resolvedBinding),
    readFile(resolvedReport),
    readFile(path.join(projectRoot, "product-version.json")),
    readFile(path.join(projectRoot, "product-brand.json")),
    Promise.all(expectedConfiguration.map(async (relativePath) => [relativePath, await readOrdinary(relativePath)])),
    Promise.all(Object.entries(expectedArtifacts).map(async ([key, relativePath]) => [key, await readOrdinary(relativePath)])),
    Promise.all(Object.entries(expectedTools).map(async ([key, relativePath]) => [key, await readOrdinary(relativePath)])),
  ]);
  const binding = JSON.parse(bindingBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const report = parseRuntimeBaselineEvidence(reportBytes);
  const observedArtifacts = Object.fromEntries(artifactEntries);
  const expectedBindings = {
    applicationSha256: sha256(observedArtifacts.application.bytes),
    fixtureSha256: sha256(observedArtifacts.fixture.bytes),
    scriptSha256: sha256(observedArtifacts.measureScript.bytes),
  };
  requireValue(validateRuntimeBaselineEvidence(report, expectedBindings, { requireAcceptance: true }), "runtime report is pending, stale, or inconsistent");
  validateRuntimeBaselineCandidateManifest({
    binding,
    testedCommit,
    currentSource,
    authority: JSON.parse(authorityBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    brand: JSON.parse(brandBytes.toString("utf8").replace(/^\uFEFF/u, "")),
    observedConfiguration: Object.fromEntries(configurationEntries),
    observedArtifacts,
    observedTools: Object.fromEntries(toolEntries),
    report,
  });
  return { binding, bindingSha256: sha256(bindingBytes), report, reportSha256: sha256(reportBytes) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await verifyRuntimeBaselineCandidate({
    bindingPath: options["--binding"],
    reportPath: options["--report"],
    testedCommit: options["--tested-commit"],
  });
  process.stdout.write(`Community stable learning-on runtime baseline binding passed: ${result.bindingSha256}.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
