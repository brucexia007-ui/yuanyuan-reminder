import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  FORBIDDEN_PATH_RULES,
  findForbiddenArtifactPaths,
  findForbiddenPaths,
  findForbiddenTextMarkers,
  isAuditedSourcePath,
  isTextFile,
  normalizeRepositoryPath,
} from "./fragment_learning_boundary_policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactFlagIndex = process.argv.indexOf("--artifact-dir");
const artifactArgument = artifactFlagIndex >= 0 ? process.argv[artifactFlagIndex + 1] : null;

if (artifactFlagIndex >= 0 && !artifactArgument) {
  throw new Error("--artifact-dir requires a directory path");
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}

function splitNul(value) {
  return value
    .split("\0")
    .map(normalizeRepositoryPath)
    .filter(Boolean);
}

function repositoryFiles() {
  return splitNul(
    runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).stdout,
  );
}

function forbiddenPathsPresentOnDisk() {
  const findings = [];
  for (const rule of FORBIDDEN_PATH_RULES) {
    if (rule.id === "personal-source-directory") continue;
    const path = normalizeRepositoryPath(rule.value).replace(/\/$/u, "");
    if (existsSync(join(repositoryRoot, path))) {
      findings.push({ path, rule: `${rule.id}:present-on-disk` });
    }
  }
  return findings;
}

function branchAudit() {
  const requestedBase = process.env.YUANYUAN_BOUNDARY_BASE || "main";
  const baseCheck = runGit(["rev-parse", "--verify", requestedBase], { allowFailure: true });
  if (baseCheck.status !== 0) {
    throw new Error(`boundary base '${requestedBase}' does not exist`);
  }
  const mergeBase = runGit(["merge-base", "HEAD", requestedBase]).stdout.trim();
  const commits = runGit(["rev-list", `${mergeBase}..HEAD`])
    .stdout.split(/\r?\n/u)
    .filter(Boolean);
  const findings = [];
  for (const commit of commits) {
    const treePaths = splitNul(
      runGit(["ls-tree", "-r", "--name-only", "-z", commit]).stdout,
    );
    for (const finding of findForbiddenPaths(treePaths)) {
      findings.push({ ...finding, commit });
    }
    const changedPaths = splitNul(
      runGit(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit])
        .stdout,
    );
    for (const path of changedPaths.filter(isAuditedSourcePath).filter(isTextFile)) {
      const blob = runGit(["show", `${commit}:${path}`], { allowFailure: true });
      if (blob.status !== 0) continue;
      for (const marker of findForbiddenTextMarkers(blob.stdout)) {
        findings.push({ path, rule: `source-marker:${marker}`, commit });
      }
    }
  }
  return { requestedBase, mergeBase, commits, findings };
}

function sourceFindings(paths) {
  const findings = [];
  for (const path of paths.filter(isAuditedSourcePath).filter(isTextFile)) {
    const absolutePath = join(repositoryRoot, path);
    if (!existsSync(absolutePath) || statSync(absolutePath).size > 16 * 1024 * 1024) continue;
    const text = readFileSync(absolutePath, "utf8");
    for (const marker of findForbiddenTextMarkers(text)) {
      findings.push({ path, rule: `source-marker:${marker}` });
    }
  }
  return findings;
}

function listFilesRecursively(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) files.push(normalizeRepositoryPath(relative(root, absolutePath)));
    }
  };
  visit(root);
  return files;
}

function artifactAudit(argument) {
  if (!argument) return { directory: null, files: [], findings: [] };
  const directory = resolve(repositoryRoot, argument);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`artifact directory does not exist: ${directory}`);
  }
  const files = listFilesRecursively(directory);
  const findings = findForbiddenArtifactPaths(files);
  for (const path of files) {
    const absolutePath = join(directory, path);
    if (statSync(absolutePath).size > 64 * 1024 * 1024) continue;
    const bytes = readFileSync(absolutePath);
    const text = bytes.toString(isTextFile(path) ? "utf8" : "latin1");
    for (const marker of findForbiddenTextMarkers(text)) {
      findings.push({ path, rule: `artifact-marker:${marker}` });
    }
  }
  return { directory, files, findings };
}

const files = repositoryFiles();
const pathFindings = [...findForbiddenPaths(files), ...forbiddenPathsPresentOnDisk()];
const textFindings = sourceFindings(files);
const history = branchAudit();
const artifacts = artifactAudit(artifactArgument);
const findings = [...pathFindings, ...textFindings, ...history.findings, ...artifacts.findings];

if (findings.length > 0) {
  console.error("SCM-001 boundary verification failed:");
  for (const finding of findings) {
    const location = finding.commit ? `${finding.commit}:${finding.path}` : finding.path;
    console.error(`- ${location} (${finding.rule})`);
  }
  process.exitCode = 1;
} else {
  console.log("SCM-001 boundary verification passed");
  console.log(`repository files audited: ${files.length}`);
  console.log(`branch commits audited: ${history.commits.length} (base ${history.mergeBase})`);
  if (artifacts.directory) {
    console.log(`artifact files audited: ${artifacts.files.length} (${artifacts.directory})`);
  }
}
