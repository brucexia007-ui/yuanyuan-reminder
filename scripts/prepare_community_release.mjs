import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommunityReleaseBundle,
  communityProductFromBrand,
  CommunityReleaseContractError,
} from "./community_release_contract.mjs";
import {
  petPackSourceSummary,
  validateAcceptedArtifactManifest,
} from "./community_accepted_artifacts.mjs";
import { validateCommunityStableAcceptance } from "./community_stable_acceptance_contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new CommunityReleaseContractError(message);
}

function parseArguments(argumentsList) {
  const options = {};
  const allowed = new Set(["--tag", "--commit", "--accepted-dir", "--output-dir"]);
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!allowed.has(key) || !value || options[key]) fail(`unknown, duplicate, or incomplete option: ${key}`);
    options[key] = value;
  }
  for (const key of allowed) if (!options[key]) fail(`${key} is required`);
  return {
    tag: options["--tag"],
    sourceCommit: options["--commit"],
    acceptedDirectory: options["--accepted-dir"],
    outputDirectory: options["--output-dir"],
  };
}

async function json(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

function git(...argumentsList) {
  return execFileSync("git", argumentsList, { cwd: projectRoot, encoding: "utf8" }).trim();
}

function outputInsideProject(outputDirectory) {
  const output = path.resolve(projectRoot, outputDirectory);
  const relative = path.relative(projectRoot, output);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("community release output directory must stay inside the project");
  }
  return output;
}

async function readOrdinaryFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
    fail(`accepted artifact is not an ordinary non-empty file: ${path.basename(filePath)}`);
  }
  return readFile(filePath);
}

export async function prepareCommunityRelease(options) {
  const output = outputInsideProject(options.outputDirectory);
  const acceptedDirectory = path.resolve(options.acceptedDirectory);
  if (git("rev-parse", "HEAD") !== options.sourceCommit || git("status", "--porcelain=v1")) {
    fail("release source must be the exact clean tagged commit");
  }
  const [policyBytes, authority, brand, acceptance, source, manifest] = await Promise.all([
    readFile(path.join(projectRoot, "docs/release/COMMUNITY_STABLE_RELEASE_POLICY_V1.json")),
    json(path.join(projectRoot, "product-version.json")),
    json(path.join(projectRoot, "product-brand.json")),
    json(path.join(projectRoot, "docs/release/COMMUNITY_STABLE_ACCEPTANCE_V1.json")),
    json(path.join(projectRoot, "docs/pet-packs/JIAOJIAO_PACKAGE_SOURCE.json")),
    json(path.join(acceptedDirectory, "accepted-artifacts.json")),
  ]);
  const expectedProduct = communityProductFromBrand(brand);
  if (!/^[0-9a-f]{40}$/u.test(acceptance?.candidate?.testedCommit ?? "")) {
    fail("stable acceptance evidence is pending or invalid");
  }
  const changedPaths = git("diff", "--name-only", acceptance.candidate.testedCommit, options.sourceCommit, "--")
    .split(/\r?\n/u).filter(Boolean);
  validateCommunityStableAcceptance(acceptance, {
    authority, expectedProduct, releaseCommit: options.sourceCommit, changedPaths,
  });
  const [portableBytes, installerBytes, petPackBytes, sourceLicenseBytes] = await Promise.all([
    readOrdinaryFile(path.join(acceptedDirectory, `圆圆提醒_${authority.version}_windows-x64-portable.exe`)),
    readOrdinaryFile(path.join(acceptedDirectory, `圆圆提醒_${authority.version}_x64-setup.exe`)),
    readOrdinaryFile(path.join(acceptedDirectory, "饺饺.yuanyuan-pet")),
    readOrdinaryFile(path.join(projectRoot, source.sourceLicenseFile)),
  ]);
  validateAcceptedArtifactManifest({
    manifest, acceptance, authority, source,
    files: { portable: portableBytes, setup: installerBytes, "jiaojiao-pet-pack": petPackBytes, sourceLicense: sourceLicenseBytes },
  });
  const sourceInfoBytes = Buffer.from(petPackSourceSummary(source), "utf8");
  const bundle = buildCommunityReleaseBundle({
    policy: JSON.parse(policyBytes.toString("utf8")), authority, expectedProduct,
    tag: options.tag, sourceCommit: options.sourceCommit, policyBytes,
    portableBytes, installerBytes, petPackBytes, sourceLicenseBytes, sourceInfoBytes,
  });
  await mkdir(output);
  const bytesById = {
    portable: portableBytes,
    setup: installerBytes,
    "jiaojiao-pet-pack": petPackBytes,
    "jiaojiao-source-license": sourceLicenseBytes,
    "pet-pack-source": sourceInfoBytes,
  };
  for (const artifact of bundle.artifacts) {
    await writeFile(path.join(output, artifact.fileName), bytesById[artifact.id], { flag: "wx" });
  }
  await writeFile(path.join(output, "SHA256SUMS.txt"), bundle.checksums, { encoding: "ascii", flag: "wx" });
  await writeFile(path.join(output, "RELEASE_NOTES.md"), bundle.notes, { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(output, "community-release-manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Accepted original release bytes staged: ${output}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareCommunityRelease(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`Community release preparation stopped: ${error.message}\n`);
    process.exitCode = 1;
  });
}
