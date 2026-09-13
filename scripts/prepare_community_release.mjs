import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommunityReleaseBundle,
  communityProductFromBrand,
  CommunityReleaseContractError,
} from "./community_release_contract.mjs";
import { validateAcceptedInstallerArtifact } from "./verify_community_stable_artifact_binding.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new CommunityReleaseContractError(message);
}

function parseArguments(argumentsList) {
  const options = {
    tag: process.env.GITHUB_REF_NAME,
    sourceCommit: process.env.GITHUB_SHA,
    outputDirectory: "release-assets",
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--tag", "--commit", "--output-dir"].includes(argument) || !value) {
      fail(`unknown or incomplete community release option: ${argument}`);
    }
    if (argument === "--tag") options.tag = value;
    if (argument === "--commit") options.sourceCommit = value;
    if (argument === "--output-dir") options.outputDirectory = value;
    index += 1;
  }
  if (!options.tag || !options.sourceCommit) {
    fail("community release preparation requires an exact tag and source commit");
  }
  return options;
}

export async function prepareCommunityRelease(options) {
  const policyPath = path.join(
    projectRoot,
    "docs",
    "release",
    "COMMUNITY_STABLE_RELEASE_POLICY_V1.json",
  );
  const authorityPath = path.join(projectRoot, "product-version.json");
  const brandPath = path.join(projectRoot, "product-brand.json");
  const acceptancePath = path.join(
    projectRoot,
    "docs",
    "release",
    "COMMUNITY_STABLE_ACCEPTANCE_V1.json",
  );
  const policyBytes = await readFile(policyPath);
  const authorityBytes = await readFile(authorityPath);
  const brandBytes = await readFile(brandPath);
  const acceptanceBytes = await readFile(acceptancePath);
  const policy = JSON.parse(policyBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const authority = JSON.parse(authorityBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const brand = JSON.parse(brandBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const acceptance = JSON.parse(
    acceptanceBytes.toString("utf8").replace(/^\uFEFF/u, ""),
  );
  const expectedProduct = communityProductFromBrand(brand);
  const portablePath = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "release",
    "yuanyuan-reminder.exe",
  );
  const installerPath = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
    `${authority.productName}_${authority.version}_x64-setup.exe`,
  );
  const [portableBytes, installerBytes] = await Promise.all([
    readFile(portablePath),
    readFile(installerPath),
  ]);
  validateAcceptedInstallerArtifact({
    acceptance,
    authority,
    expectedProduct,
    installerBytes,
  });
  const bundle = buildCommunityReleaseBundle({
    policy,
    authority,
    expectedProduct,
    tag: options.tag,
    sourceCommit: options.sourceCommit,
    policyBytes,
    portableBytes,
    installerBytes,
  });
  const output = path.resolve(projectRoot, options.outputDirectory);
  const relativeOutput = path.relative(projectRoot, output);
  if (
    relativeOutput.length === 0 ||
    relativeOutput.startsWith(`..${path.sep}`) ||
    relativeOutput === ".." ||
    path.isAbsolute(relativeOutput)
  ) {
    fail("community release output directory must stay inside the project");
  }
  await mkdir(output);
  await Promise.all([
    copyFile(portablePath, path.join(output, bundle.artifacts[0].fileName)),
    copyFile(installerPath, path.join(output, bundle.artifacts[1].fileName)),
    writeFile(path.join(output, "SHA256SUMS.txt"), bundle.checksums, {
      encoding: "ascii",
      flag: "wx",
    }),
    writeFile(path.join(output, "RELEASE_NOTES.md"), bundle.notes, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(
      path.join(output, "community-release-manifest.json"),
      `${JSON.stringify(bundle.manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    ),
  ]);
  process.stdout.write(`Community stable release assets prepared: ${output}\n`);
  process.stdout.write("Code signing is advisory for this channel; warnings and SHA-256 are included.\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  prepareCommunityRelease(options).catch((error) => {
    process.stderr.write(`Community release preparation stopped: ${error.message}\n`);
    process.exitCode = 1;
  });
}
