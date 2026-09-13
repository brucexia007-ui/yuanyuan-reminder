import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { validateCommunityStableAcceptance } from "./community_stable_acceptance_contract.mjs";
import { communityProductFromBrand } from "./community_release_contract.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

async function readJson(filePath) {
  const bytes = await readFile(filePath, "utf8");
  return JSON.parse(bytes.replace(/^\uFEFF/u, ""));
}

function parseArguments(argumentsList) {
  if (argumentsList.length === 0) return { releaseCommit: "HEAD" };
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--release-commit" ||
    !argumentsList[1]
  ) {
    throw new Error(
      "usage: node scripts/verify_community_stable_acceptance.mjs [--release-commit <commit>]",
    );
  }
  return { releaseCommit: argumentsList[1] };
}

async function resolveCommit(revision) {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", `${revision}^{commit}`],
    { cwd: projectRoot, encoding: "utf8" },
  );
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("release revision did not resolve to a canonical Git commit");
  }
  return commit;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const acceptancePath = path.join(
    projectRoot,
    "docs",
    "release",
    "COMMUNITY_STABLE_ACCEPTANCE_V1.json",
  );
  const authorityPath = path.join(projectRoot, "product-version.json");
  const [acceptance, authority, brand, releaseCommit] = await Promise.all([
    readJson(acceptancePath),
    readJson(authorityPath),
    readJson(path.join(projectRoot, "product-brand.json")),
    resolveCommit(options.releaseCommit),
  ]);
  const testedCommit = acceptance?.candidate?.testedCommit;
  if (typeof testedCommit !== "string" || !/^[0-9a-f]{40}$/u.test(testedCommit)) {
    throw new Error("community stable acceptance does not name a canonical tested commit");
  }
  try {
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", testedCommit, releaseCommit],
      { cwd: projectRoot, encoding: "utf8" },
    );
  } catch {
    throw new Error("accepted test commit is not an ancestor of the release commit");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", testedCommit, releaseCommit, "--"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  const changedPaths = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  validateCommunityStableAcceptance(acceptance, {
    authority,
    expectedProduct: communityProductFromBrand(brand),
    releaseCommit,
    changedPaths,
  });
  process.stdout.write(
    `Community stable acceptance OK: ${authority.productName} ${authority.version}, tested at ${testedCommit}.\n`,
  );
}

main().catch((error) => {
  const detail = error?.code === "ENOENT"
    ? "docs/release/COMMUNITY_STABLE_ACCEPTANCE_V1.json is missing"
    : error.message;
  process.stderr.write(`Community stable acceptance stopped: ${detail}\n`);
  process.exitCode = 1;
});
