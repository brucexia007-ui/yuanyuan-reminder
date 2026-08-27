import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  validateCommunityStableAuthority,
  validateCommunityStablePolicy,
} from "./community_release_contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function readJson(filePath) {
  const bytes = await readFile(filePath, "utf8");
  return JSON.parse(bytes.replace(/^\uFEFF/u, ""));
}

async function main() {
  const [policy, authority] = await Promise.all([
    readJson(
      path.join(
        projectRoot,
        "docs",
        "release",
        "COMMUNITY_STABLE_RELEASE_POLICY_V1.json",
      ),
    ),
    readJson(path.join(projectRoot, "product-version.json")),
  ]);

  validateCommunityStablePolicy(policy);
  validateCommunityStableAuthority(authority);
  process.stdout.write(
    `Community stable authority OK: ${authority.productName} ${authority.version}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Community stable authority stopped: ${error.message}\n`);
  process.exitCode = 1;
});
