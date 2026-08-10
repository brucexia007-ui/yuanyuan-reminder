import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultStorePublicUrlsReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-public-urls-report.json",
);
export const defaultPrivacyPolicyPath = path.join(projectRoot, "PRIVACY.md");
export const defaultStorePublicUrlsVerifierPath = fileURLToPath(import.meta.url);

export const STORE_PUBLIC_URL_TARGETS = Object.freeze({
  privacyPolicy: Object.freeze({
    url: "https://github.com/brucexia007-ui/yuanyuan-reminder/blob/main/PRIVACY.md",
    origin: "https://github.com",
    contentType: "text/html",
    markers: Object.freeze(["brucexia007-ui", "yuanyuan-reminder", "PRIVACY.md"]),
  }),
  website: Object.freeze({
    url: "https://github.com/brucexia007-ui/yuanyuan-reminder",
    origin: "https://github.com",
    contentType: "text/html",
    markers: Object.freeze(["brucexia007-ui", "yuanyuan-reminder"]),
  }),
  support: Object.freeze({
    url: "https://github.com/brucexia007-ui/yuanyuan-reminder/issues",
    origin: "https://github.com",
    contentType: "text/html",
    markers: Object.freeze(["brucexia007-ui", "yuanyuan-reminder", "issues"]),
  }),
  privacyPolicySource: Object.freeze({
    url: "https://raw.githubusercontent.com/brucexia007-ui/yuanyuan-reminder/main/PRIVACY.md",
    origin: "https://raw.githubusercontent.com",
    contentType: "text/plain",
    markers: Object.freeze([]),
  }),
});

const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export class StorePublicUrlsVerificationError extends Error {}

function fail(message) {
  throw new StorePublicUrlsVerificationError(message);
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
    fail(`${label} fields do not match the public URL evidence contract`);
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
  if (now.getTime() - parsed > REPORT_MAX_AGE_MS) {
    fail(`${label} is older than seven days; recapture anonymous URL evidence`);
  }
}

function normalizeContentType(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function ensureAllowedUrl(value, target, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== target.origin) {
    fail(`${label} escaped the fixed HTTPS origin`);
  }
  return parsed;
}

async function readBoundedResponse(response, label) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail(`${label} response exceeds the 5 MB evidence limit`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    fail(`${label} response must contain 1 byte to 5 MB`);
  }
  return bytes;
}

async function captureTarget(name, target, fetchImpl, timeoutMs) {
  let current = ensureAllowedUrl(target.url, target, `${name}.url`);
  const redirects = [];
  const visited = new Set();
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const currentUrl = current.toString();
    if (visited.has(currentUrl)) fail(`${name} contains a redirect loop`);
    visited.add(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: target.contentType },
      });
    } catch (error) {
      fail(`${name} anonymous GET failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (REDIRECT_STATUS_CODES.has(response.status)) {
      if (attempt === MAX_REDIRECTS) fail(`${name} exceeded five redirects`);
      const location = response.headers?.get?.("location");
      if (!location) fail(`${name} redirect omitted Location`);
      const next = ensureAllowedUrl(new URL(location, current).toString(), target, `${name}.redirect`);
      redirects.push({ statusCode: response.status, from: currentUrl, to: next.toString() });
      current = next;
      continue;
    }
    if (response.status !== 200) {
      fail(`${name} must return anonymous HTTP 200; received ${response.status}`);
    }
    if (current.toString() !== target.url) {
      fail(`${name} final URL drifted from the reviewed Store URL`);
    }
    const contentType = normalizeContentType(response.headers?.get?.("content-type"));
    if (contentType !== target.contentType) {
      fail(`${name} returned unexpected content type ${contentType || "missing"}`);
    }
    const bytes = await readBoundedResponse(response, name);
    const text = target.markers.length > 0 ? bytes.toString("utf8") : "";
    for (const marker of target.markers) {
      if (!text.toLowerCase().includes(marker.toLowerCase())) {
        fail(`${name} response is missing the expected ${marker} marker`);
      }
    }
    return {
      url: target.url,
      finalUrl: current.toString(),
      statusCode: response.status,
      contentType,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      redirects,
    };
  }
  fail(`${name} could not be captured`);
}

export async function captureStorePublicUrls({
  fetchImpl = globalThis.fetch,
  localPrivacyBytes,
  verifierSha256,
  now = new Date(),
  timeoutMs = 20_000,
} = {}) {
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  if (!Buffer.isBuffer(localPrivacyBytes) || localPrivacyBytes.length === 0) {
    fail("localPrivacyBytes must contain the reviewed privacy policy");
  }
  canonicalHash(verifierSha256, "verifierSha256");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("now must be a valid date");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    fail("timeoutMs must be between 1000 and 60000 milliseconds");
  }

  const requests = {};
  for (const [name, target] of Object.entries(STORE_PUBLIC_URL_TARGETS)) {
    requests[name] = await captureTarget(name, target, fetchImpl, timeoutMs);
  }
  const privacyPolicySha256 = sha256(localPrivacyBytes);
  if (requests.privacyPolicySource.sha256 !== privacyPolicySha256) {
    fail("published privacy policy does not exactly match local PRIVACY.md");
  }
  const report = {
    schemaVersion: 1,
    status: "anonymous_public_urls_verified",
    checkedAt: now.toISOString(),
    verifierSha256,
    privacyPolicySha256,
    requests,
    outcome: {
      allUrlsPublic: true,
      remotePrivacyMatchesLocal: true,
    },
  };
  return validateStorePublicUrlsReport(report, {
    expectedPrivacyPolicySha256: privacyPolicySha256,
    expectedVerifierSha256: verifierSha256,
    now,
  });
}

export function validateStorePublicUrlsReport(
  report,
  { expectedPrivacyPolicySha256, expectedVerifierSha256, now = new Date() } = {},
) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "status",
      "checkedAt",
      "verifierSha256",
      "privacyPolicySha256",
      "requests",
      "outcome",
    ],
    "public URL report",
  );
  if (report.schemaVersion !== 1) fail("public URL report schemaVersion must be 1");
  if (report.status !== "anonymous_public_urls_verified") {
    fail("public URL report status must be anonymous_public_urls_verified");
  }
  validTimestamp(report.checkedAt, "checkedAt", now);
  canonicalHash(report.verifierSha256, "verifierSha256");
  canonicalHash(report.privacyPolicySha256, "privacyPolicySha256");
  if (
    report.verifierSha256 !== expectedVerifierSha256 ||
    report.privacyPolicySha256 !== expectedPrivacyPolicySha256
  ) {
    fail("public URL report drifted from the verifier or local privacy policy");
  }

  exactKeys(report.requests, Object.keys(STORE_PUBLIC_URL_TARGETS), "requests");
  for (const [name, target] of Object.entries(STORE_PUBLIC_URL_TARGETS)) {
    const evidence = report.requests[name];
    exactKeys(
      evidence,
      ["url", "finalUrl", "statusCode", "contentType", "byteLength", "sha256", "redirects"],
      `requests.${name}`,
    );
    canonicalHash(evidence.sha256, `requests.${name}.sha256`);
    if (
      evidence.url !== target.url ||
      evidence.finalUrl !== target.url ||
      evidence.statusCode !== 200 ||
      evidence.contentType !== target.contentType ||
      !Number.isInteger(evidence.byteLength) ||
      evidence.byteLength < 1 ||
      evidence.byteLength > MAX_RESPONSE_BYTES ||
      !Array.isArray(evidence.redirects)
    ) {
      fail(`requests.${name} does not prove the exact anonymous public URL`);
    }
    for (const [index, redirect] of evidence.redirects.entries()) {
      exactKeys(redirect, ["statusCode", "from", "to"], `requests.${name}.redirects[${index}]`);
      if (!REDIRECT_STATUS_CODES.has(redirect.statusCode)) {
        fail(`requests.${name}.redirects[${index}] has an invalid status`);
      }
      ensureAllowedUrl(redirect.from, target, `requests.${name}.redirects[${index}].from`);
      ensureAllowedUrl(redirect.to, target, `requests.${name}.redirects[${index}].to`);
    }
  }
  if (report.requests.privacyPolicySource.sha256 !== expectedPrivacyPolicySha256) {
    fail("remote privacy source hash does not match local PRIVACY.md");
  }

  exactKeys(report.outcome, ["allUrlsPublic", "remotePrivacyMatchesLocal"], "outcome");
  if (report.outcome.allUrlsPublic !== true || report.outcome.remotePrivacyMatchesLocal !== true) {
    fail("public URL report cannot claim a partial or mismatched outcome");
  }
  return report;
}

export async function readAndValidateStorePublicUrlsReport({
  reportPath = defaultStorePublicUrlsReportPath,
  privacyPolicyPath = defaultPrivacyPolicyPath,
  verifierPath = defaultStorePublicUrlsVerifierPath,
  now = new Date(),
} = {}) {
  let reportBytes;
  let privacyPolicyBytes;
  let verifierBytes;
  try {
    [reportBytes, privacyPolicyBytes, verifierBytes] = await Promise.all([
      readFile(reportPath),
      readFile(privacyPolicyPath),
      readFile(verifierPath),
    ]);
  } catch (error) {
    fail(`public URL evidence is missing or unreadable: ${error.message}`);
  }
  let report;
  try {
    report = JSON.parse(reportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`public URL evidence JSON is invalid: ${error.message}`);
  }
  validateStorePublicUrlsReport(report, {
    expectedPrivacyPolicySha256: sha256(privacyPolicyBytes),
    expectedVerifierSha256: sha256(verifierBytes),
    now,
  });
  return { report, reportBytes, privacyPolicyBytes, verifierBytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readAndValidateStorePublicUrlsReport()
    .then(({ report }) => {
      process.stdout.write(
        `MSIX Store public URLs verified from anonymous evidence captured at ${report.checkedAt}.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`MSIX Store public URL evidence pending: ${error.message}\n`);
      process.exitCode = 2;
    });
}
