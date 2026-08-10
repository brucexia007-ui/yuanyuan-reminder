import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeNewStorePublicUrlsReport } from "./capture_msix_store_public_urls.mjs";
import {
  captureStorePublicUrls,
  STORE_PUBLIC_URL_TARGETS,
  StorePublicUrlsVerificationError,
  validateStorePublicUrlsReport,
} from "./verify_msix_store_public_urls.mjs";

const verifierSha256 = "A".repeat(64);
const localPrivacyBytes = Buffer.from("# 圆圆提醒隐私政策\n\n本政策用于测试。\n", "utf8");
const now = new Date("2026-08-11T00:00:00.000Z");

function response(status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const normalizedHeaders = new Headers(headers);
  return {
    status,
    headers: normalizedHeaders,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function goodBodies() {
  return new Map([
    [
      STORE_PUBLIC_URL_TARGETS.privacyPolicy.url,
      response(
        200,
        "<html>brucexia007-ui yuanyuan-reminder PRIVACY.md</html>",
        { "content-type": "text/html; charset=utf-8" },
      ),
    ],
    [
      STORE_PUBLIC_URL_TARGETS.website.url,
      response(200, "<html>brucexia007-ui yuanyuan-reminder</html>", {
        "content-type": "text/html; charset=utf-8",
      }),
    ],
    [
      STORE_PUBLIC_URL_TARGETS.support.url,
      response(200, "<html>brucexia007-ui yuanyuan-reminder issues</html>", {
        "content-type": "text/html; charset=utf-8",
      }),
    ],
    [
      STORE_PUBLIC_URL_TARGETS.privacyPolicySource.url,
      response(200, localPrivacyBytes, { "content-type": "text/plain; charset=utf-8" }),
    ],
  ]);
}

function fetchFrom(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const value = responses.get(url);
    if (!value) throw new Error(`unexpected URL ${url}`);
    return value;
  };
}

async function validReport() {
  return captureStorePublicUrls({
    fetchImpl: fetchFrom(goodBodies()),
    localPrivacyBytes,
    verifierSha256,
    now,
  });
}

test("captures and validates exact anonymous Store public URL evidence", async () => {
  const calls = [];
  const report = await captureStorePublicUrls({
    fetchImpl: fetchFrom(goodBodies(), calls),
    localPrivacyBytes,
    verifierSha256,
    now,
  });
  assert.equal(report.status, "anonymous_public_urls_verified");
  assert.equal(report.outcome.allUrlsPublic, true);
  assert.equal(report.requests.privacyPolicySource.sha256, report.privacyPolicySha256);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "manual");
    assert.equal(Object.hasOwn(call.options.headers, "Authorization"), false);
    assert.equal(Object.hasOwn(call.options.headers, "Cookie"), false);
  }
});

test("rejects a public URL that returns anything other than HTTP 200", async () => {
  const responses = goodBodies();
  responses.set(
    STORE_PUBLIC_URL_TARGETS.privacyPolicy.url,
    response(404, "not found", { "content-type": "text/html" }),
  );
  await assert.rejects(
    captureStorePublicUrls({
      fetchImpl: fetchFrom(responses),
      localPrivacyBytes,
      verifierSha256,
      now,
    }),
    (error) => error instanceof StorePublicUrlsVerificationError && /HTTP 200/.test(error.message),
  );
});

test("rejects redirects outside the reviewed HTTPS origin", async () => {
  const responses = goodBodies();
  responses.set(
    STORE_PUBLIC_URL_TARGETS.privacyPolicy.url,
    response(302, "", { location: "https://example.com/login", "content-type": "text/html" }),
  );
  await assert.rejects(
    captureStorePublicUrls({
      fetchImpl: fetchFrom(responses),
      localPrivacyBytes,
      verifierSha256,
      now,
    }),
    /escaped the fixed HTTPS origin/,
  );
});

test("rejects unexpected content types and missing repository markers", async () => {
  const wrongType = goodBodies();
  wrongType.set(
    STORE_PUBLIC_URL_TARGETS.website.url,
    response(200, "brucexia007-ui yuanyuan-reminder", { "content-type": "text/plain" }),
  );
  await assert.rejects(
    captureStorePublicUrls({
      fetchImpl: fetchFrom(wrongType),
      localPrivacyBytes,
      verifierSha256,
      now,
    }),
    /unexpected content type/,
  );

  const missingMarker = goodBodies();
  missingMarker.set(
    STORE_PUBLIC_URL_TARGETS.website.url,
    response(200, "<html>generic GitHub page</html>", { "content-type": "text/html" }),
  );
  await assert.rejects(
    captureStorePublicUrls({
      fetchImpl: fetchFrom(missingMarker),
      localPrivacyBytes,
      verifierSha256,
      now,
    }),
    /expected brucexia007-ui marker/,
  );
});

test("rejects a published privacy policy that differs from local PRIVACY.md", async () => {
  const responses = goodBodies();
  responses.set(
    STORE_PUBLIC_URL_TARGETS.privacyPolicySource.url,
    response(200, "different policy", { "content-type": "text/plain" }),
  );
  await assert.rejects(
    captureStorePublicUrls({
      fetchImpl: fetchFrom(responses),
      localPrivacyBytes,
      verifierSha256,
      now,
    }),
    /does not exactly match/,
  );
});

test("rejects stale evidence and verifier or privacy-policy drift", async () => {
  const report = await validReport();
  assert.throws(
    () =>
      validateStorePublicUrlsReport(report, {
        expectedPrivacyPolicySha256: report.privacyPolicySha256,
        expectedVerifierSha256: verifierSha256,
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    /older than seven days/,
  );
  assert.throws(
    () =>
      validateStorePublicUrlsReport(report, {
        expectedPrivacyPolicySha256: "B".repeat(64),
        expectedVerifierSha256: verifierSha256,
        now,
      }),
    /drifted/,
  );
});

test("rejects unknown fields, optimistic outcomes, and URL drift", async () => {
  const report = await validReport();
  const unknown = structuredClone(report);
  unknown.cookies = [];
  assert.throws(
    () =>
      validateStorePublicUrlsReport(unknown, {
        expectedPrivacyPolicySha256: report.privacyPolicySha256,
        expectedVerifierSha256: verifierSha256,
        now,
      }),
    /fields do not match/,
  );
  const partial = structuredClone(report);
  partial.outcome.allUrlsPublic = false;
  assert.throws(
    () =>
      validateStorePublicUrlsReport(partial, {
        expectedPrivacyPolicySha256: report.privacyPolicySha256,
        expectedVerifierSha256: verifierSha256,
        now,
      }),
    /partial or mismatched/,
  );
  const drift = structuredClone(report);
  drift.requests.support.finalUrl = "https://github.com/login";
  assert.throws(
    () =>
      validateStorePublicUrlsReport(drift, {
        expectedPrivacyPolicySha256: report.privacyPolicySha256,
        expectedVerifierSha256: verifierSha256,
        now,
      }),
    /exact anonymous public URL/,
  );
});

test("creates public URL evidence once and preserves the original bytes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-public-urls-"));
  const outputPath = path.join(temporaryRoot, "nested", "report.json");
  try {
    const report = await validReport();
    await writeNewStorePublicUrlsReport(outputPath, report);
    const original = await readFile(outputPath);
    await assert.rejects(writeNewStorePublicUrlsReport(outputPath, { replacement: true }), /overwrite/);
    assert.deepEqual(await readFile(outputPath), original);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
