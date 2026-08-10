import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureStorePublicUrls,
  defaultPrivacyPolicyPath,
  defaultStorePublicUrlsReportPath,
  defaultStorePublicUrlsVerifierPath,
} from "./verify_msix_store_public_urls.mjs";

export class StorePublicUrlsCaptureError extends Error {}

function fail(message) {
  throw new StorePublicUrlsCaptureError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export async function writeNewStorePublicUrlsReport(outputPath, report) {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  let handle;
  try {
    handle = await open(resolved, "wx");
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
      await rm(resolved, { force: true });
    }
    if (error?.code === "EEXIST") {
      fail("public URL evidence already exists; refusing to overwrite it");
    }
    fail(`unable to create public URL evidence: ${error.message}`);
  } finally {
    await handle?.close();
  }
  return resolved;
}

async function main() {
  try {
    await access(defaultStorePublicUrlsReportPath);
    fail("public URL evidence already exists; refusing to overwrite it");
  } catch (error) {
    if (error instanceof StorePublicUrlsCaptureError) throw error;
    if (error?.code !== "ENOENT") fail(`unable to inspect public URL evidence path: ${error.message}`);
  }
  const [privacyPolicyBytes, verifierBytes] = await Promise.all([
    readFile(defaultPrivacyPolicyPath),
    readFile(defaultStorePublicUrlsVerifierPath),
  ]);
  const report = await captureStorePublicUrls({
    localPrivacyBytes: privacyPolicyBytes,
    verifierSha256: sha256(verifierBytes),
  });
  const outputPath = await writeNewStorePublicUrlsReport(defaultStorePublicUrlsReportPath, report);
  process.stdout.write(`Anonymous MSIX Store public URL evidence written once: ${outputPath}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store public URL capture stopped: ${error.message}\n`);
    process.exitCode = 2;
  });
}
