import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const V14_RELEASE_SOURCE_SCOPE_FILE_NAME = "V1.4.0_RELEASE_SOURCE_SCOPE_V1.json";
export const V14_RELEASE_SOURCE_SCOPE_REPORT_FILE_NAME = "release-source-scope-report.json";
export const V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME = "verify_v1_4_release_source_scope.mjs";
export const defaultV14ReleaseSourceScopePath = path.join(
  projectRoot,
  "docs",
  "release",
  V14_RELEASE_SOURCE_SCOPE_FILE_NAME,
);
export const defaultV14ReleaseSourceScopeVerifierPath = fileURLToPath(import.meta.url);

const expectedContract = Object.freeze({
  schemaVersion: 1,
  product: {
    identifier: "com.yuanyuan.reminder",
    name: "圆圆提醒",
    version: "1.4.0",
  },
  targetBranch: "main",
  baseline: {
    tag: "v1.3.2",
    commit: "11841b88cf7b3e6d10502fd0158401e2c02167ae",
  },
  decision: {
    scope: "offline_stable_core_and_release_blockers_only",
    allowedChangeClasses: [
      "release_blocker_fix",
      "regression_fix",
      "evidence_correction",
      "behavior_preserving_maintenance",
    ],
    learningPreviewDisposition: "excluded_from_v1_4_release_source",
    learningPreviewMayExistInReleaseCommit: false,
    learningPreviewMayExistInDefaultBundle: false,
    stableMainDatabaseSchemaVersion: 11,
  },
  excludedPathPrefixes: ["docs/learning/", "src/learning/", "src-tauri/src/learning/"],
  excludedPaths: [
    "docs/LEARNING_PREVIEW_SCOPE.md",
    "docs/YUANYUAN_KAOYAN_ENGLISH_LEARNING_FINAL_PLAN.md",
    "src-tauri/migrations/012_learning_invitation_attention.sql",
  ],
  runtimeSourceRoots: ["src/", "src-tauri/src/", "src-tauri/migrations/"],
  runtimeSourceFiles: ["src-tauri/Cargo.toml", "src/vite-env.d.ts", "vite.config.ts"],
  runtimeSourceExcludedPathFragments: [".test.", ".spec.", "/tests/", "/fixtures/"],
  forbiddenRuntimeTerms: ["learning", "学习"],
  requiredVerificationCommands: [
    "npm.cmd run release:source-scope:verify",
    "npm.cmd run verify",
    "cargo test (src-tauri)",
    "npm.cmd run tauri build",
    "npm.cmd run release:manifest",
  ],
});

export class V14ReleaseSourceScopeVerificationError extends Error {}

function fail(message) {
  throw new V14ReleaseSourceScopeVerificationError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields do not match the v1.4.0 release source-scope contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function validTimestamp(value, label, now) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < Date.parse("2026-08-10T00:00:00.000Z") ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future ISO timestamp`);
  }
  return parsed;
}

function parseJson(bytes, label) {
  if (!Buffer.isBuffer(bytes)) fail(`${label} must be supplied as bytes`);
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`${label} JSON is invalid: ${error.message}`);
  }
}

function normalizeRepoPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    fail(`${label} must be a normalized repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../")) {
    fail(`${label} must not escape or alias the repository root`);
  }
  return normalized;
}

function sortedUniquePaths(paths, label) {
  if (!Array.isArray(paths)) fail(`${label} must be an array`);
  const normalized = paths.map((value, index) => normalizeRepoPath(value, `${label}[${index}]`));
  const sorted = [...normalized].sort((left, right) => left.localeCompare(right, "en"));
  if (!exact(normalized, sorted) || new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    fail(`${label} must be sorted and unique, including on case-insensitive Windows filesystems`);
  }
  return normalized;
}

function isExcludedPath(contract, candidatePath) {
  const lower = candidatePath.toLowerCase();
  return (
    contract.excludedPaths.some((value) => value.toLowerCase() === lower) ||
    contract.excludedPathPrefixes.some((value) => lower.startsWith(value.toLowerCase()))
  );
}

function isRuntimeSourcePath(contract, candidatePath) {
  const lower = candidatePath.toLowerCase();
  const included =
    contract.runtimeSourceFiles.some((value) => value.toLowerCase() === lower) ||
    contract.runtimeSourceRoots.some((value) => lower.startsWith(value.toLowerCase()));
  return (
    included &&
    !contract.runtimeSourceExcludedPathFragments.some((value) =>
      lower.includes(value.toLowerCase()),
    )
  );
}

export function validateV14ReleaseSourceScopeContract(contract) {
  if (!exact(contract, expectedContract)) {
    fail("source-scope policy drifted from the frozen v1.4.0 stable-only decision");
  }
  return contract;
}

export function renderV14ChangedPaths(changedPaths) {
  const normalized = sortedUniquePaths(changedPaths, "changedPaths");
  return Buffer.from(normalized.length === 0 ? "" : `${normalized.join("\n")}\n`, "utf8");
}

function validateSourceIdentity(source, contract, now) {
  exactKeys(
    source,
    [
      "commit",
      "branch",
      "commitTimestamp",
      "worktreeClean",
      "baselineTagCommit",
      "baselineIsAncestor",
    ],
    "source",
  );
  if (!/^[0-9a-f]{40}$/u.test(source.commit)) fail("source.commit must be a canonical SHA-1 Git commit");
  if (source.branch !== contract.targetBranch) fail("v1.4.0 release source must be on main");
  if (source.worktreeClean !== true) fail("v1.4.0 release source requires a clean worktree");
  validTimestamp(source.commitTimestamp, "source.commitTimestamp", now);
  if (
    source.baselineTagCommit !== contract.baseline.commit ||
    source.baselineIsAncestor !== true
  ) {
    fail("v1.3.2 baseline tag or ancestry does not match the frozen source scope");
  }
}

function normalizeRuntimeFiles(runtimeFiles, contract) {
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length === 0) {
    fail("runtimeFiles must contain every tracked release-runtime source file");
  }
  const normalized = runtimeFiles.map((entry, index) => {
    exactKeys(entry, ["path", "bytes"], `runtimeFiles[${index}]`);
    const entryPath = normalizeRepoPath(entry.path, `runtimeFiles[${index}].path`);
    if (!Buffer.isBuffer(entry.bytes)) fail(`runtimeFiles[${index}].bytes must be a Buffer`);
    if (!isRuntimeSourcePath(contract, entryPath)) {
      fail(`runtime file is outside the frozen scan boundary: ${entryPath}`);
    }
    return { path: entryPath, bytes: entry.bytes };
  });
  const paths = normalized.map((entry) => entry.path);
  sortedUniquePaths(paths, "runtime file paths");
  return normalized;
}

function observedMainDatabaseSchemaVersion(runtimeFiles) {
  const versions = [];
  for (const entry of runtimeFiles) {
    if (!entry.path.startsWith("src-tauri/migrations/") || !entry.path.endsWith(".sql")) continue;
    const text = entry.bytes.toString("utf8").replace(/^\uFEFF/u, "");
    for (const match of text.matchAll(/\bPRAGMA\s+user_version\s*=\s*(\d+)\s*;/giu)) {
      versions.push(Number.parseInt(match[1], 10));
    }
  }
  if (versions.length === 0 || versions.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    fail("runtime source does not expose a valid main database schema migration version");
  }
  return Math.max(...versions);
}

export function buildV14ReleaseSourceScopeReport(
  { contractBytes, verifierBytes, source, changedPaths, runtimeFiles },
  { now = new Date() } = {},
) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("now must be a valid date");
  if (!Buffer.isBuffer(verifierBytes)) fail("verifierBytes must be supplied as bytes");
  const contract = validateV14ReleaseSourceScopeContract(parseJson(contractBytes, "source-scope policy"));
  validateSourceIdentity(source, contract, now);
  const normalizedChangedPaths = sortedUniquePaths(changedPaths, "changedPaths");
  const excludedChanges = normalizedChangedPaths.filter((value) => isExcludedPath(contract, value));
  if (excludedChanges.length > 0) {
    fail(`Learning Preview paths are excluded from v1.4.0 release source: ${excludedChanges.join(", ")}`);
  }
  const normalizedRuntimeFiles = normalizeRuntimeFiles(runtimeFiles, contract);
  const observedSchemaVersion = observedMainDatabaseSchemaVersion(normalizedRuntimeFiles);
  if (observedSchemaVersion !== contract.decision.stableMainDatabaseSchemaVersion) {
    fail(
      `v1.4.0 main database schema must remain ${contract.decision.stableMainDatabaseSchemaVersion}; observed ${observedSchemaVersion}`,
    );
  }
  const forbiddenHits = [];
  for (const entry of normalizedRuntimeFiles) {
    const text = entry.bytes.toString("utf8").replace(/^\uFEFF/u, "");
    for (const term of contract.forbiddenRuntimeTerms) {
      if (text.toLocaleLowerCase("en-US").includes(term.toLocaleLowerCase("en-US"))) {
        forbiddenHits.push({ path: entry.path, term });
      }
    }
  }
  if (forbiddenHits.length > 0) {
    fail(
      `Learning Preview runtime markers are excluded from v1.4.0 release source: ${forbiddenHits
        .map((entry) => `${entry.path}:${entry.term}`)
        .join(", ")}`,
    );
  }
  const changedPathsBytes = renderV14ChangedPaths(normalizedChangedPaths);
  const runtimeFileHashes = normalizedRuntimeFiles.map((entry) => ({
    path: entry.path,
    sha256: sha256(entry.bytes),
  }));
  const runtimeManifestBytes = Buffer.from(
    runtimeFileHashes.map((entry) => `${entry.sha256} *${entry.path}\n`).join(""),
    "utf8",
  );
  const report = {
    schemaVersion: 1,
    status: "v1_4_release_source_scope_verified",
    verifiedAt: now.toISOString(),
    source: {
      commit: source.commit,
      branch: source.branch,
      commitTimestamp: source.commitTimestamp,
      worktreeClean: true,
    },
    baseline: {
      tag: contract.baseline.tag,
      commit: contract.baseline.commit,
      tagResolvesToCommit: true,
      baselineIsAncestor: true,
    },
    policy: {
      fileName: V14_RELEASE_SOURCE_SCOPE_FILE_NAME,
      sha256: sha256(contractBytes),
      verifierFileName: V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME,
      verifierSha256: sha256(verifierBytes),
    },
    changes: {
      pathCount: normalizedChangedPaths.length,
      pathsSha256: sha256(changedPathsBytes),
      paths: normalizedChangedPaths,
    },
    runtimeSource: {
      fileCount: runtimeFileHashes.length,
      manifestSha256: sha256(runtimeManifestBytes),
      files: runtimeFileHashes,
      forbiddenTermHits: 0,
      stableMainDatabaseSchemaVersion: observedSchemaVersion,
    },
    outcome: {
      releaseScopeVerified: true,
      learningPreviewExcluded: true,
      readyForUnsignedBetaFreeze: true,
    },
  };
  validateV14ReleaseSourceScopeReport(report, { contractBytes, verifierBytes, runtimeFiles, now });
  return report;
}

export function validateV14ReleaseSourceScopeReport(
  report,
  { contractBytes, verifierBytes, runtimeFiles, now = new Date() } = {},
) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("now must be a valid date");
  if (!Buffer.isBuffer(verifierBytes)) fail("verifierBytes must be supplied as bytes");
  const contract = validateV14ReleaseSourceScopeContract(parseJson(contractBytes, "source-scope policy"));
  exactKeys(
    report,
    ["schemaVersion", "status", "verifiedAt", "source", "baseline", "policy", "changes", "runtimeSource", "outcome"],
    "source-scope report",
  );
  if (report.schemaVersion !== 1 || report.status !== "v1_4_release_source_scope_verified") {
    fail("source-scope report schema or status is invalid");
  }
  const verifiedTime = validTimestamp(report.verifiedAt, "verifiedAt", now);
  exactKeys(report.source, ["commit", "branch", "commitTimestamp", "worktreeClean"], "source-scope report source");
  validateSourceIdentity(
    {
      ...report.source,
      baselineTagCommit: contract.baseline.commit,
      baselineIsAncestor: true,
    },
    contract,
    now,
  );
  if (verifiedTime < Date.parse(report.source.commitTimestamp)) {
    fail("source-scope verification predates the candidate source commit");
  }
  exactKeys(report.baseline, ["tag", "commit", "tagResolvesToCommit", "baselineIsAncestor"], "baseline");
  if (
    report.baseline.tag !== contract.baseline.tag ||
    report.baseline.commit !== contract.baseline.commit ||
    report.baseline.tagResolvesToCommit !== true ||
    report.baseline.baselineIsAncestor !== true
  ) {
    fail("source-scope report baseline drifted");
  }
  exactKeys(report.policy, ["fileName", "sha256", "verifierFileName", "verifierSha256"], "policy");
  canonicalHash(report.policy.sha256, "policy.sha256");
  canonicalHash(report.policy.verifierSha256, "policy.verifierSha256");
  if (
    report.policy.fileName !== V14_RELEASE_SOURCE_SCOPE_FILE_NAME ||
    report.policy.sha256 !== sha256(contractBytes) ||
    report.policy.verifierFileName !== V14_RELEASE_SOURCE_SCOPE_VERIFIER_FILE_NAME ||
    report.policy.verifierSha256 !== sha256(verifierBytes)
  ) {
    fail("source-scope policy or verifier binding drifted");
  }
  exactKeys(report.changes, ["pathCount", "pathsSha256", "paths"], "changes");
  const changedPaths = sortedUniquePaths(report.changes.paths, "changes.paths");
  canonicalHash(report.changes.pathsSha256, "changes.pathsSha256");
  if (
    report.changes.pathCount !== changedPaths.length ||
    report.changes.pathsSha256 !== sha256(renderV14ChangedPaths(changedPaths)) ||
    changedPaths.some((value) => isExcludedPath(contract, value))
  ) {
    fail("source-scope changed paths contain excluded preview work or drifted metadata");
  }
  exactKeys(
    report.runtimeSource,
    ["fileCount", "manifestSha256", "files", "forbiddenTermHits", "stableMainDatabaseSchemaVersion"],
    "runtimeSource",
  );
  if (!Array.isArray(report.runtimeSource.files) || report.runtimeSource.files.length === 0) {
    fail("runtimeSource.files must bind every tracked runtime source file");
  }
  const runtimePaths = report.runtimeSource.files.map((entry, index) => {
    exactKeys(entry, ["path", "sha256"], `runtimeSource.files[${index}]`);
    canonicalHash(entry.sha256, `runtimeSource.files[${index}].sha256`);
    const entryPath = normalizeRepoPath(entry.path, `runtimeSource.files[${index}].path`);
    if (!isRuntimeSourcePath(contract, entryPath) || isExcludedPath(contract, entryPath)) {
      fail(`runtime source manifest escaped or included preview source: ${entryPath}`);
    }
    return entryPath;
  });
  sortedUniquePaths(runtimePaths, "runtimeSource file paths");
  const runtimeManifestBytes = Buffer.from(
    report.runtimeSource.files.map((entry) => `${entry.sha256} *${entry.path}\n`).join(""),
    "utf8",
  );
  canonicalHash(report.runtimeSource.manifestSha256, "runtimeSource.manifestSha256");
  if (
    report.runtimeSource.fileCount !== report.runtimeSource.files.length ||
    report.runtimeSource.manifestSha256 !== sha256(runtimeManifestBytes) ||
    report.runtimeSource.forbiddenTermHits !== 0 ||
    report.runtimeSource.stableMainDatabaseSchemaVersion !== 11
  ) {
    fail("runtime source boundary drifted from the stable-only scope");
  }
  if (runtimeFiles !== undefined) {
    const normalizedRuntimeFiles = normalizeRuntimeFiles(runtimeFiles, contract);
    const expectedFiles = normalizedRuntimeFiles.map((entry) => ({
      path: entry.path,
      sha256: sha256(entry.bytes),
    }));
    if (!exact(report.runtimeSource.files, expectedFiles)) {
      fail("runtime source manifest does not match the supplied source bytes");
    }
    if (
      observedMainDatabaseSchemaVersion(normalizedRuntimeFiles) !==
      report.runtimeSource.stableMainDatabaseSchemaVersion
    ) {
      fail("runtime source migrations do not match the reported stable schema version");
    }
    for (const entry of normalizedRuntimeFiles) {
      const text = entry.bytes.toString("utf8").replace(/^\uFEFF/u, "");
      if (
        contract.forbiddenRuntimeTerms.some((term) =>
          text.toLocaleLowerCase("en-US").includes(term.toLocaleLowerCase("en-US")),
        )
      ) {
        fail(`runtime source contains an excluded Learning Preview marker: ${entry.path}`);
      }
    }
  }
  exactKeys(report.outcome, ["releaseScopeVerified", "learningPreviewExcluded", "readyForUnsignedBetaFreeze"], "outcome");
  if (
    report.outcome.releaseScopeVerified !== true ||
    report.outcome.learningPreviewExcluded !== true ||
    report.outcome.readyForUnsignedBetaFreeze !== true
  ) {
    fail("source-scope report cannot weaken the stable-only release decision");
  }
  return report;
}

function gitText(argumentsList) {
  try {
    return execFileSync("git", argumentsList, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(`unable to inspect Git source state: ${error.stderr?.trim?.() || error.message}`);
  }
}

function gitNullSeparated(argumentsList) {
  try {
    const output = execFileSync("git", argumentsList, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.split("\0").filter(Boolean);
  } catch (error) {
    fail(`unable to enumerate Git source paths: ${error.stderr?.trim?.() || error.message}`);
  }
}

function baselineIsAncestor(baselineCommit) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", baselineCommit, "HEAD"], {
    cwd: projectRoot,
    stdio: "ignore",
  });
  if (result.error) fail(`unable to verify Git ancestry: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    fail(`unable to verify Git ancestry: git exited ${result.status}`);
  }
  return result.status === 0;
}

export async function collectCurrentV14ReleaseSourceScope({ now = new Date() } = {}) {
  const [contractBytes, verifierBytes] = await Promise.all([
    readFile(defaultV14ReleaseSourceScopePath),
    readFile(defaultV14ReleaseSourceScopeVerifierPath),
  ]);
  const contract = validateV14ReleaseSourceScopeContract(parseJson(contractBytes, "source-scope policy"));
  const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
  const source = {
    commit: gitText(["rev-parse", "HEAD"]).toLowerCase(),
    branch: gitText(["branch", "--show-current"]),
    commitTimestamp: gitText(["show", "-s", "--format=%cI", "HEAD"]),
    worktreeClean: status.length === 0,
    baselineTagCommit: gitText(["rev-parse", `${contract.baseline.tag}^{commit}`]).toLowerCase(),
    baselineIsAncestor: baselineIsAncestor(contract.baseline.commit),
  };
  const changedPaths = gitNullSeparated([
    "diff",
    "--name-only",
    "-z",
    `${contract.baseline.commit}..HEAD`,
  ]).sort((left, right) => left.localeCompare(right, "en"));
  const runtimePaths = gitNullSeparated([
    "ls-files",
    "-z",
    "--",
    ...contract.runtimeSourceRoots,
    ...contract.runtimeSourceFiles,
  ])
    .filter((entryPath) => isRuntimeSourcePath(contract, entryPath.replaceAll("\\", "/")))
    .sort((left, right) => left.localeCompare(right, "en"));
  const runtimeFiles = await Promise.all(
    runtimePaths.map(async (entryPath) => ({
      path: entryPath.replaceAll("\\", "/"),
      bytes: await readFile(path.join(projectRoot, ...entryPath.split("/"))),
    })),
  );
  const report = buildV14ReleaseSourceScopeReport(
    { contractBytes, verifierBytes, source, changedPaths, runtimeFiles },
    { now },
  );
  return { report, contractBytes, verifierBytes, runtimeFiles };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  collectCurrentV14ReleaseSourceScope()
    .then(({ report }) => {
      process.stdout.write(
        `v1.4.0 release source scope verified: ${report.source.commit}; Learning Preview excluded; ${report.changes.pathCount} changed paths bound.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`v1.4.0 release source scope pending: ${error.message}\n`);
      process.exitCode = 2;
    });
}
