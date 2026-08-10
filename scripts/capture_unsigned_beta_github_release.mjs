import { access, open, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  captureUnsignedBetaGithubRelease,
  defaultUnsignedBetaGithubReportPath,
  validateUnsignedBetaGithubReport,
} from "./verify_unsigned_beta_github_release.mjs";
import {
  defaultUnsignedBetaStageRoot,
  readAndValidateUnsignedBetaFreezeReport,
} from "./verify_unsigned_beta_candidate.mjs";

export class UnsignedBetaGithubCaptureError extends Error {}

function fail(message) {
  throw new UnsignedBetaGithubCaptureError(message);
}

export async function writeNewUnsignedBetaGithubReport(
  outputPath,
  report,
  { freezeEvidence, now = new Date() } = {},
) {
  validateUnsignedBetaGithubReport(report, { freezeEvidence, now });
  let handle;
  try {
    handle = await open(outputPath, "wx");
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
      await rm(outputPath, { force: true });
    }
    if (error?.code === "EEXIST") {
      fail("GitHub publication evidence already exists; refusing to overwrite it");
    }
    fail(`unable to create GitHub publication evidence: ${error.message}`);
  } finally {
    await handle?.close();
  }
  return outputPath;
}

async function main() {
  try {
    await access(defaultUnsignedBetaGithubReportPath);
    fail("GitHub publication evidence already exists; refusing to overwrite it");
  } catch (error) {
    if (error instanceof UnsignedBetaGithubCaptureError) throw error;
    if (error?.code !== "ENOENT") fail(`unable to inspect GitHub evidence path: ${error.message}`);
  }
  const freezeEvidence = await readAndValidateUnsignedBetaFreezeReport(defaultUnsignedBetaStageRoot);
  const report = await captureUnsignedBetaGithubRelease({ freezeEvidence });
  await writeNewUnsignedBetaGithubReport(defaultUnsignedBetaGithubReportPath, report, {
    freezeEvidence,
  });
  process.stdout.write(
    `Anonymous GitHub prerelease evidence written once: ${defaultUnsignedBetaGithubReportPath}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Unsigned beta GitHub capture stopped: ${error.message}\n`);
    process.exitCode = 2;
  });
}
