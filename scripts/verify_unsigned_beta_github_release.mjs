import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultUnsignedBetaStageRoot,
  readAndValidateUnsignedBetaFreezeReport,
  UNSIGNED_BETA_FILE_NAME,
  UNSIGNED_BETA_TAG,
} from "./verify_unsigned_beta_candidate.mjs";

export const UNSIGNED_BETA_REPOSITORY = "brucexia007-ui/yuanyuan-reminder";
export const UNSIGNED_BETA_RELEASE_API_URL =
  `https://api.github.com/repos/${UNSIGNED_BETA_REPOSITORY}/releases/tags/${UNSIGNED_BETA_TAG}`;
export const UNSIGNED_BETA_TAG_REF_API_URL =
  `https://api.github.com/repos/${UNSIGNED_BETA_REPOSITORY}/git/ref/tags/${UNSIGNED_BETA_TAG}`;
export const defaultUnsignedBetaGithubReportPath = path.join(
  defaultUnsignedBetaStageRoot,
  "github-prerelease-publication-report.json",
);

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const API_ORIGINS = new Set(["https://api.github.com"]);
const ASSET_ORIGINS = new Set([
  "https://github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
]);

export class UnsignedBetaGithubVerificationError extends Error {}

function fail(message) {
  throw new UnsignedBetaGithubVerificationError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields do not match the GitHub prerelease evidence contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function validTimestamp(value, label, now) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < Date.parse("2026-08-10T00:00:00.000Z") ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future ISO timestamp`);
  }
}

function normalizeContentType(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function parseHttpsUrl(value, allowedOrigins, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" || !allowedOrigins.has(parsed.origin)) {
    fail(`${label} escaped the fixed GitHub HTTPS origins`);
  }
  return parsed;
}

async function anonymousGet(
  url,
  { fetchImpl, allowedOrigins, accept, maxBytes, timeoutMs, label },
) {
  let current = parseHttpsUrl(url, allowedOrigins, `${label}.url`);
  const visited = new Set();
  const redirectOrigins = [];
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const currentUrl = current.toString();
    if (visited.has(currentUrl)) fail(`${label} contains a redirect loop`);
    visited.add(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: accept, "User-Agent": "yuanyuan-release-audit" },
      });
    } catch (error) {
      fail(`${label} anonymous GET failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (REDIRECT_STATUS_CODES.has(response.status)) {
      if (attempt === MAX_REDIRECTS) fail(`${label} exceeded five redirects`);
      const location = response.headers?.get?.("location");
      if (!location) fail(`${label} redirect omitted Location`);
      const next = parseHttpsUrl(
        new URL(location, current).toString(),
        allowedOrigins,
        `${label}.redirect`,
      );
      redirectOrigins.push(next.origin);
      current = next;
      continue;
    }
    if (response.status !== 200) {
      fail(`${label} must return anonymous HTTP 200; received ${response.status}`);
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      fail(`${label} response exceeds the evidence size limit`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) {
      fail(`${label} response is empty or exceeds the evidence size limit`);
    }
    return {
      bytes,
      contentType: normalizeContentType(response.headers?.get?.("content-type")),
      redirectOrigins,
    };
  }
  fail(`${label} could not be downloaded`);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function expectedAssetDownloadUrl(fileName) {
  return `https://github.com/${UNSIGNED_BETA_REPOSITORY}/releases/download/${UNSIGNED_BETA_TAG}/${encodeURIComponent(fileName)}`;
}

function validateExternalRelease(release, freezeEvidence) {
  const expectedHtmlUrl = `https://github.com/${UNSIGNED_BETA_REPOSITORY}/releases/tag/${UNSIGNED_BETA_TAG}`;
  if (
    !Number.isInteger(release?.id) ||
    release.id <= 0 ||
    release.tag_name !== UNSIGNED_BETA_TAG ||
    release.draft !== false ||
    release.prerelease !== true ||
    release.html_url !== expectedHtmlUrl ||
    typeof release.name !== "string" ||
    !/(?:测试版|beta)/iu.test(release.name) ||
    typeof release.body !== "string" ||
    release.body.trimEnd() !== freezeEvidence.releaseNotesBytes.toString("utf8").trimEnd() ||
    !Array.isArray(release.assets)
  ) {
    fail("GitHub release is not the exact public unsigned prerelease contract");
  }
  const expectedNames = [UNSIGNED_BETA_FILE_NAME, "SHA256SUMS.txt"].sort();
  const actualNames = release.assets.map((asset) => asset?.name).sort();
  if (!exact(actualNames, expectedNames)) {
    fail("GitHub prerelease must contain exactly the installer and SHA256SUMS.txt");
  }
  return release;
}

function validateExternalAsset(asset, expected, label) {
  const allowedTypes =
    label === "candidate"
      ? new Set([
          "application/octet-stream",
          "application/x-msdownload",
          "application/vnd.microsoft.portable-executable",
        ])
      : new Set(["application/octet-stream", "text/plain"]);
  if (
    !Number.isInteger(asset?.id) ||
    asset.id <= 0 ||
    asset.name !== expected.fileName ||
    asset.state !== "uploaded" ||
    asset.size !== expected.bytes ||
    asset.digest !== `sha256:${expected.sha256.toLowerCase()}` ||
    asset.browser_download_url !== expectedAssetDownloadUrl(expected.fileName) ||
    !allowedTypes.has(normalizeContentType(asset.content_type))
  ) {
    fail(`GitHub ${label} asset metadata drifted from the frozen candidate`);
  }
  return asset;
}

async function resolveTagCommit(ref, fetchImpl, timeoutMs) {
  const object = ref?.object;
  if (!object || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(object.sha)) {
    fail("GitHub tag ref does not contain a canonical object SHA");
  }
  if (object.type === "commit") return object.sha;
  if (object.type !== "tag") fail("GitHub tag ref must target a commit or annotated tag");
  const tagApiUrl = `https://api.github.com/repos/${UNSIGNED_BETA_REPOSITORY}/git/tags/${object.sha}`;
  const response = await anonymousGet(tagApiUrl, {
    fetchImpl,
    allowedOrigins: API_ORIGINS,
    accept: "application/vnd.github+json",
    maxBytes: MAX_JSON_BYTES,
    timeoutMs,
    label: "annotatedTag",
  });
  const tag = parseJson(response.bytes, "annotatedTag");
  if (
    tag?.object?.type !== "commit" ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(tag.object.sha)
  ) {
    fail("annotated GitHub tag does not target a canonical commit");
  }
  return tag.object.sha;
}

export async function captureUnsignedBetaGithubRelease({
  fetchImpl = globalThis.fetch,
  freezeEvidence,
  now = new Date(),
  timeoutMs = 30_000,
} = {}) {
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  if (!freezeEvidence?.report || !Buffer.isBuffer(freezeEvidence?.reportBytes)) {
    fail("validated freeze evidence is required before GitHub capture");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("now must be a valid date");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    fail("timeoutMs must be between 1000 and 60000 milliseconds");
  }

  const [releaseResponse, refResponse] = await Promise.all([
    anonymousGet(UNSIGNED_BETA_RELEASE_API_URL, {
      fetchImpl,
      allowedOrigins: API_ORIGINS,
      accept: "application/vnd.github+json",
      maxBytes: MAX_JSON_BYTES,
      timeoutMs,
      label: "releaseApi",
    }),
    anonymousGet(UNSIGNED_BETA_TAG_REF_API_URL, {
      fetchImpl,
      allowedOrigins: API_ORIGINS,
      accept: "application/vnd.github+json",
      maxBytes: MAX_JSON_BYTES,
      timeoutMs,
      label: "tagRefApi",
    }),
  ]);
  const release = validateExternalRelease(
    parseJson(releaseResponse.bytes, "releaseApi"),
    freezeEvidence,
  );
  const tagCommit = await resolveTagCommit(parseJson(refResponse.bytes, "tagRefApi"), fetchImpl, timeoutMs);
  if (tagCommit !== freezeEvidence.report.source.commit) {
    fail("GitHub prerelease tag does not resolve to the frozen source commit");
  }

  const candidateMetadata = validateExternalAsset(
    release.assets.find((asset) => asset.name === UNSIGNED_BETA_FILE_NAME),
    freezeEvidence.report.artifacts.candidate,
    "candidate",
  );
  const checksumMetadata = validateExternalAsset(
    release.assets.find((asset) => asset.name === "SHA256SUMS.txt"),
    freezeEvidence.report.artifacts.checksums,
    "checksums",
  );
  const [candidateDownload, checksumDownload] = await Promise.all([
    anonymousGet(candidateMetadata.browser_download_url, {
      fetchImpl,
      allowedOrigins: ASSET_ORIGINS,
      accept: "application/octet-stream",
      maxBytes: freezeEvidence.candidateBytes.length,
      timeoutMs,
      label: "candidateDownload",
    }),
    anonymousGet(checksumMetadata.browser_download_url, {
      fetchImpl,
      allowedOrigins: ASSET_ORIGINS,
      accept: "application/octet-stream",
      maxBytes: freezeEvidence.checksumBytes.length,
      timeoutMs,
      label: "checksumDownload",
    }),
  ]);
  if (!candidateDownload.bytes.equals(freezeEvidence.candidateBytes)) {
    fail("anonymous GitHub installer download differs from the frozen candidate bytes");
  }
  if (!checksumDownload.bytes.equals(freezeEvidence.checksumBytes)) {
    fail("anonymous GitHub checksum download differs from the frozen checksum bytes");
  }

  const report = {
    schemaVersion: 1,
    status: "github_unsigned_beta_prerelease_verified",
    verifiedAt: now.toISOString(),
    repository: UNSIGNED_BETA_REPOSITORY,
    release: {
      id: release.id,
      tag: UNSIGNED_BETA_TAG,
      name: release.name,
      htmlUrl: release.html_url,
      prerelease: true,
      tagCommit,
    },
    freeze: {
      reportSha256: sha256(freezeEvidence.reportBytes),
      sourceCommit: freezeEvidence.report.source.commit,
      candidateSha256: freezeEvidence.report.artifacts.candidate.sha256,
      checksumsSha256: freezeEvidence.report.artifacts.checksums.sha256,
      releaseNotesSha256: freezeEvidence.report.artifacts.releaseNotes.sha256,
    },
    assets: {
      candidate: {
        url: candidateMetadata.browser_download_url,
        bytes: candidateDownload.bytes.length,
        sha256: sha256(candidateDownload.bytes),
        apiDigest: candidateMetadata.digest,
        contentType: candidateDownload.contentType,
        redirectOrigins: candidateDownload.redirectOrigins,
      },
      checksums: {
        url: checksumMetadata.browser_download_url,
        bytes: checksumDownload.bytes.length,
        sha256: sha256(checksumDownload.bytes),
        apiDigest: checksumMetadata.digest,
        contentType: checksumDownload.contentType,
        redirectOrigins: checksumDownload.redirectOrigins,
      },
    },
    checks: {
      anonymousApi: true,
      anonymousDownloads: true,
      releaseNotesExact: true,
      tagCommitExact: true,
    },
    outcome: {
      publishedAsGithubPrerelease: true,
      readyForUnsignedBetaDistribution: true,
      stableRelease: false,
    },
  };
  return validateUnsignedBetaGithubReport(report, { freezeEvidence, now });
}

export function validateUnsignedBetaGithubReport(report, { freezeEvidence, now = new Date() } = {}) {
  exactKeys(
    report,
    ["schemaVersion", "status", "verifiedAt", "repository", "release", "freeze", "assets", "checks", "outcome"],
    "GitHub report",
  );
  if (report.schemaVersion !== 1 || report.status !== "github_unsigned_beta_prerelease_verified") {
    fail("GitHub report schema or status is invalid");
  }
  validTimestamp(report.verifiedAt, "verifiedAt", now);
  if (report.repository !== UNSIGNED_BETA_REPOSITORY) fail("GitHub report repository drifted");
  if (!freezeEvidence?.report || !Buffer.isBuffer(freezeEvidence?.reportBytes)) {
    fail("validated freeze evidence is required to verify GitHub publication");
  }

  exactKeys(report.release, ["id", "tag", "name", "htmlUrl", "prerelease", "tagCommit"], "release");
  if (
    !Number.isInteger(report.release.id) ||
    report.release.id <= 0 ||
    report.release.tag !== UNSIGNED_BETA_TAG ||
    !/(?:测试版|beta)/iu.test(report.release.name) ||
    report.release.htmlUrl !==
      `https://github.com/${UNSIGNED_BETA_REPOSITORY}/releases/tag/${UNSIGNED_BETA_TAG}` ||
    report.release.prerelease !== true ||
    report.release.tagCommit !== freezeEvidence.report.source.commit
  ) {
    fail("GitHub report release identity or tag commit drifted");
  }
  exactKeys(
    report.freeze,
    ["reportSha256", "sourceCommit", "candidateSha256", "checksumsSha256", "releaseNotesSha256"],
    "freeze",
  );
  for (const [key, value] of Object.entries(report.freeze)) {
    if (key !== "sourceCommit") canonicalHash(value, `freeze.${key}`);
  }
  if (
    report.freeze.reportSha256 !== sha256(freezeEvidence.reportBytes) ||
    report.freeze.sourceCommit !== freezeEvidence.report.source.commit ||
    report.freeze.candidateSha256 !== freezeEvidence.report.artifacts.candidate.sha256 ||
    report.freeze.checksumsSha256 !== freezeEvidence.report.artifacts.checksums.sha256 ||
    report.freeze.releaseNotesSha256 !== freezeEvidence.report.artifacts.releaseNotes.sha256
  ) {
    fail("GitHub report drifted from the frozen candidate evidence");
  }

  exactKeys(report.assets, ["candidate", "checksums"], "assets");
  const expectedAssets = {
    candidate: {
      fileName: UNSIGNED_BETA_FILE_NAME,
      bytes: freezeEvidence.candidateBytes.length,
      sha256: sha256(freezeEvidence.candidateBytes),
    },
    checksums: {
      fileName: "SHA256SUMS.txt",
      bytes: freezeEvidence.checksumBytes.length,
      sha256: sha256(freezeEvidence.checksumBytes),
    },
  };
  for (const [name, expected] of Object.entries(expectedAssets)) {
    const asset = report.assets[name];
    const allowedDownloadTypes =
      name === "candidate"
        ? new Set([
            "application/octet-stream",
            "application/x-msdownload",
            "application/vnd.microsoft.portable-executable",
          ])
        : new Set(["application/octet-stream", "text/plain"]);
    exactKeys(
      asset,
      ["url", "bytes", "sha256", "apiDigest", "contentType", "redirectOrigins"],
      `assets.${name}`,
    );
    canonicalHash(asset.sha256, `assets.${name}.sha256`);
    if (
      asset.url !== expectedAssetDownloadUrl(expected.fileName) ||
      asset.bytes !== expected.bytes ||
      asset.sha256 !== expected.sha256 ||
      asset.apiDigest !== `sha256:${expected.sha256.toLowerCase()}` ||
      !allowedDownloadTypes.has(asset.contentType) ||
      !Array.isArray(asset.redirectOrigins) ||
      asset.redirectOrigins.some((origin) => !ASSET_ORIGINS.has(origin))
    ) {
      fail(`assets.${name} does not prove the exact anonymous GitHub download`);
    }
  }
  exactKeys(report.checks, ["anonymousApi", "anonymousDownloads", "releaseNotesExact", "tagCommitExact"], "checks");
  if (Object.values(report.checks).some((value) => value !== true)) {
    fail("GitHub report cannot claim incomplete anonymous publication checks");
  }
  exactKeys(
    report.outcome,
    ["publishedAsGithubPrerelease", "readyForUnsignedBetaDistribution", "stableRelease"],
    "outcome",
  );
  if (
    report.outcome.publishedAsGithubPrerelease !== true ||
    report.outcome.readyForUnsignedBetaDistribution !== true ||
    report.outcome.stableRelease !== false
  ) {
    fail("GitHub report cannot promote the unsigned beta to a stable release");
  }
  return report;
}

export async function readAndValidateUnsignedBetaGithubReport({ now = new Date() } = {}) {
  const freezeEvidence = await readAndValidateUnsignedBetaFreezeReport(defaultUnsignedBetaStageRoot, {
    now,
  });
  let reportBytes;
  try {
    reportBytes = await readFile(defaultUnsignedBetaGithubReportPath);
  } catch (error) {
    fail(`GitHub prerelease evidence is missing or unreadable: ${error.message}`);
  }
  let report;
  try {
    report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`GitHub prerelease evidence JSON is invalid: ${error.message}`);
  }
  validateUnsignedBetaGithubReport(report, { freezeEvidence, now });
  return { report, reportBytes, freezeEvidence };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readAndValidateUnsignedBetaGithubReport()
    .then(({ report }) => {
      process.stdout.write(
        `Unsigned beta GitHub prerelease verified: ${report.release.htmlUrl}; stable release remains false.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`Unsigned beta GitHub publication pending: ${error.message}\n`);
      process.exitCode = 2;
    });
}
