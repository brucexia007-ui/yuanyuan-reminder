import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRuntimeBaselineSourceBinding } from "./verify_community_stable_runtime_baseline_candidate.mjs";

function fail(message) {
  throw new Error(`community stable runtime source binding rejected: ${message}`);
}

function parseArguments(argv) {
  const allowed = new Set(["--binding", "--tested-commit", "--observed-at"]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || options[key]) fail(`unknown, duplicate, or incomplete option: ${key}`);
    options[key] = value;
  }
  for (const key of allowed) if (!options[key]) fail(`${key} is required`);
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await verifyRuntimeBaselineSourceBinding({
    bindingPath: path.resolve(options["--binding"]),
    testedCommit: options["--tested-commit"],
    observedAt: options["--observed-at"],
  });
  process.stdout.write(`Community stable runtime source binding passed: ${result.bindingSha256}.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
