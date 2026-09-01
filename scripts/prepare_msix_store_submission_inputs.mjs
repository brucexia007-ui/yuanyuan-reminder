import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultStoreIdentityPath, readAndValidateStoreIdentity } from "./verify_msix_store_identity.mjs";
import { readAndValidateStorePublicUrlsReport } from "./verify_msix_store_public_urls.mjs";
import {
  createStoreSubmissionInputsDraft,
  inspectPng,
  STORE_SCREENSHOTS,
} from "./verify_msix_store_submission_inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SUBMISSION_INPUTS_V1.template.json",
);
const targetRoot = path.join(projectRoot, "src-tauri", "target", "msix-store");
const candidateReportPath = path.join(targetRoot, "msix-store-candidate-report.json");
const draftPath = path.join(targetRoot, "msix-store-submission-inputs.draft.json");
const candidateVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_candidate.mjs");
const submissionVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_submission_inputs.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

function runCandidateVerifier() {
  const result = spawnSync(process.execPath, [candidateVerifierPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "MSIX Store candidate verification failed");
  }
}

async function main() {
  readAndValidateStoreIdentity(defaultStoreIdentityPath);
  runCandidateVerifier();
  const publicUrlsEvidence = await readAndValidateStorePublicUrlsReport();
  const [templateBytes, identityBytes, candidateReportBytes] = await Promise.all([
    readFile(templatePath),
    readFile(defaultStoreIdentityPath),
    readFile(candidateReportPath),
  ]);
  const template = JSON.parse(templateBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const candidateReport = JSON.parse(candidateReportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const candidatePath = path.resolve(projectRoot, candidateReport.candidate.path);
  const screenshotArtifacts = Object.fromEntries(
    await Promise.all(
      STORE_SCREENSHOTS.map(async (item) => [
        item.path,
        inspectPng(await readFile(path.resolve(projectRoot, item.path))),
      ]),
    ),
  );
  const expectedBindings = {
    storeCandidateReportSha256: sha256(candidateReportBytes),
    unsignedStoreCandidateSha256: await hashFile(candidatePath),
    privacyPolicySha256: await hashFile(path.join(projectRoot, "PRIVACY.md")),
    publicUrlsReportSha256: sha256(publicUrlsEvidence.reportBytes),
    publicUrlsVerifierSha256: sha256(publicUrlsEvidence.verifierBytes),
    readmeSha256: await hashFile(path.join(projectRoot, "README.md")),
    tauriConfigSha256: await hashFile(path.join(projectRoot, "src-tauri", "tauri.conf.json")),
    storeManifestTemplateSha256: await hashFile(
      path.join(projectRoot, "src-tauri", "msix", "AppxManifest.store.xml"),
    ),
    assetLicenseSha256: await hashFile(path.join(
      projectRoot,
      JSON.parse(await readFile(path.join(projectRoot, "product-brand.json"), "utf8")).assets.licenseFile,
    )),
    verifierSha256: await hashFile(submissionVerifierPath),
  };
  const draft = createStoreSubmissionInputsDraft(template, {
    expectedIdentitySha256: sha256(identityBytes),
    expectedBindings,
    screenshotArtifacts,
    publicUrlsReportCheckedAt: publicUrlsEvidence.report.checkedAt,
  });
  await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  process.stdout.write(`Prepared machine-bound Store submission draft: ${draftPath}\n`);
  process.stdout.write(
    "Review every human field, copy the draft to docs/release/MSIX_STORE_SUBMISSION_INPUTS_V1.json, and never change status to ready before the named human approvals are complete.\n",
  );
}

main().catch((error) => {
  process.stderr.write(`MSIX Store submission draft pending: ${error.message}\n`);
  process.exitCode = 2;
});
