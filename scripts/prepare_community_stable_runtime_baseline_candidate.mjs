import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "runtime-qa-learning", "release");
const evidenceRoot = path.join(releaseRoot, "evidence");
const commitPattern = /^[0-9a-f]{40}$/u;

const configurationPaths = [
  "product-version.json",
  "product-brand.json",
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
];
const artifactPaths = {
  application: "src-tauri/target/runtime-qa-learning/release/yuanyuan-reminder.exe",
  fixture: "src-tauri/target/runtime-qa-learning/release/yuanyuan-runtime-qa-fixture.exe",
  measureScript: "scripts/measure_runtime_baseline.ps1",
};
const toolPaths = {
  buildScript: "scripts/build_community_stable_runtime_baseline_candidate.ps1",
  runScript: "scripts/run_community_stable_runtime_baseline.ps1",
  exclusivityScript: "scripts/assert_runtime_qa_exclusive.ps1",
  prepareScript: "scripts/prepare_community_stable_runtime_baseline_candidate.mjs",
  verifyScript: "scripts/verify_community_stable_runtime_baseline_candidate.mjs",
  sourceBindingVerifyScript: "scripts/verify_community_stable_runtime_source_binding.mjs",
};

function fail(message) {
  throw new Error(`community stable runtime baseline candidate rejected: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

async function ordinaryFile(relativePath, { builtAfter } = {}) {
  const absolutePath = path.join(projectRoot, relativePath);
  const metadata = await lstat(absolutePath);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink(), `${relativePath} must be an ordinary file`);
  if (builtAfter !== undefined) {
    requireValue(metadata.mtimeMs + 2_000 >= builtAfter, `${relativePath} predates the controlled build`);
  }
  const bytes = await readFile(absolutePath);
  requireValue(bytes.length > 0, `${relativePath} is empty`);
  return { path: relativePath.replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) };
}

function gitText(arguments_) {
  return execFileSync("git", arguments_, { cwd: projectRoot, encoding: "utf8" }).trim();
}

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--output" ||
    !argv[1] ||
    argv[2] !== "--build-started-at" ||
    !argv[3]
  ) {
    fail("usage: --output <absolute-json> --build-started-at <ISO-8601>");
  }
  return { output: path.resolve(argv[1]), buildStartedAt: argv[3] };
}

export async function buildRuntimeBaselineCandidateManifest({ output, buildStartedAt, now = new Date() }) {
  const buildStartedMs = Date.parse(buildStartedAt);
  requireValue(Number.isFinite(buildStartedMs) && buildStartedMs <= now.getTime() + 300_000, "build start is invalid");
  requireValue(path.dirname(output) === evidenceRoot, "output must be in the learning-on runtime evidence directory");
  requireValue(/^runtime-baseline-candidate-\d{8}T\d{6}Z\.json$/u.test(path.basename(output)), "output filename is invalid");

  const dirtyText = gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
  requireValue(dirtyText.length === 0, "formal candidate preparation requires a clean checkout");
  const commit = gitText(["rev-parse", "HEAD"]);
  const branch = gitText(["branch", "--show-current"]);
  requireValue(commitPattern.test(commit) && branch.length > 0, "source identity is invalid");

  const [authorityBytes, brandBytes] = await Promise.all([
    readFile(path.join(projectRoot, "product-version.json")),
    readFile(path.join(projectRoot, "product-brand.json")),
  ]);
  const authority = JSON.parse(authorityBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const brand = JSON.parse(brandBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  requireValue(authority.productName === brand?.application?.displayName, "product name and brand disagree");
  requireValue(authority.identifier === brand?.application?.identifier, "product identifier and brand disagree");

  const configurationEntries = await Promise.all(
    configurationPaths.map(async (relativePath) => [relativePath, await ordinaryFile(relativePath)]),
  );
  const artifactEntries = await Promise.all(
    Object.entries(artifactPaths).map(async ([key, relativePath]) => [
      key,
      await ordinaryFile(relativePath, key === "application" || key === "fixture" ? { builtAfter: buildStartedMs } : {}),
    ]),
  );
  const toolEntries = await Promise.all(
    Object.entries(toolPaths).map(async ([key, relativePath]) => [key, await ordinaryFile(relativePath)]),
  );

  return {
    schemaVersion: 1,
    capturedAt: now.toISOString(),
    buildStartedAt: new Date(buildStartedMs).toISOString(),
    buildVariant: "runtime-qa-learning",
    source: { commit, branch, dirty: false },
    product: {
      name: authority.productName,
      identifier: authority.identifier,
      version: authority.version,
    },
    configuration: Object.fromEntries(configurationEntries.map(([relativePath, value]) => [relativePath, value.sha256])),
    artifacts: Object.fromEntries(artifactEntries),
    tools: Object.fromEntries(toolEntries),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(evidenceRoot, { recursive: true });
  requireValue(await realpath(path.dirname(options.output)) === await realpath(evidenceRoot), "output parent resolves outside the owned evidence directory");
  const manifest = await buildRuntimeBaselineCandidateManifest(options);
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Community stable learning-on runtime candidate prepared: ${options.output}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
