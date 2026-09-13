import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  communityProductFromBrand,
  sha256,
  validateCommunityStableAuthority,
} from "./community_release_contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256Pattern = /^[A-F0-9]{64}$/u;

function fail(message) {
  throw new Error(`community stable artifact binding rejected: ${message}`);
}

function exactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) {
    fail(`${label} fields are not exact`);
  }
}

export function validateAcceptedInstallerArtifact({
  acceptance,
  authority,
  expectedProduct,
  installerBytes,
}) {
  validateCommunityStableAuthority(authority, expectedProduct);
  if (!Buffer.isBuffer(installerBytes) || installerBytes.length === 0) {
    fail("installer bytes are missing");
  }
  exactKeys(
    acceptance,
    ["schemaVersion", "status", "product", "candidate", "checks", "review"],
    "acceptance",
  );
  if (acceptance.schemaVersion !== 1 || acceptance.status !== "accepted") {
    fail("community acceptance is not complete");
  }
  exactKeys(acceptance.product, ["name", "identifier", "version"], "acceptance.product");
  if (
    acceptance.product.name !== authority.productName ||
    acceptance.product.identifier !== authority.identifier ||
    acceptance.product.version !== authority.version
  ) {
    fail("accepted product identity does not match the stable authority");
  }
  exactKeys(acceptance.candidate, ["testedCommit", "installerSha256"], "acceptance.candidate");
  const installedCheck = acceptance.checks?.installedCandidateE2e;
  if (!installedCheck || typeof installedCheck !== "object" || Array.isArray(installedCheck)) {
    fail("installed-candidate E2E acceptance is missing");
  }
  if (
    installedCheck.status !== "passed" ||
    !sha256Pattern.test(acceptance.candidate.installerSha256) ||
    installedCheck.installerSha256 !== acceptance.candidate.installerSha256
  ) {
    fail("installed-candidate E2E is not bound to the accepted installer");
  }
  const observedInstallerSha256 = sha256(installerBytes);
  if (observedInstallerSha256 !== acceptance.candidate.installerSha256) {
    fail("current release installer bytes differ from the accepted installer");
  }
  return {
    installerSha256: observedInstallerSha256,
    installerBytes: installerBytes.length,
  };
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function main() {
  const [acceptance, authority, brand] = await Promise.all([
    readJson(path.join(projectRoot, "docs", "release", "COMMUNITY_STABLE_ACCEPTANCE_V1.json")),
    readJson(path.join(projectRoot, "product-version.json")),
    readJson(path.join(projectRoot, "product-brand.json")),
  ]);
  const expectedProduct = communityProductFromBrand(brand);
  const installerPath = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
    `${expectedProduct.installerBaseName}_${authority.version}_x64-setup.exe`,
  );
  const result = validateAcceptedInstallerArtifact({
    acceptance,
    authority,
    expectedProduct,
    installerBytes: await readFile(installerPath),
  });
  process.stdout.write(
    `Accepted community installer binding verified: ${result.installerSha256} (${result.installerBytes} bytes).\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
