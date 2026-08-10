import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildStoreIdentityDocument,
  parseStoreIdentityArguments,
  StoreIdentityPreparationError,
  writeNewStoreIdentity,
} from "./prepare_msix_store_identity.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = JSON.parse(
  await readFile(
    path.join(projectRoot, "docs", "release", "MSIX_STORE_IDENTITY_V1.template.json"),
    "utf8",
  ),
);

function validArguments() {
  return [
    "--reserved-product-name",
    "Yuanyuan Reminder",
    "--store-id",
    "9N1234567890",
    "--identity-name",
    "12345Yuanyuan.Reminder",
    "--publisher",
    "CN=12345678-1234-1234-1234-1234567890AB",
    "--publisher-display-name",
    "Yuanyuan Project",
    "--package-family-name",
    "12345Yuanyuan.Reminder_abcdefghjkmnp",
    "--confirmed-by",
    "Release Maintainer",
    "--attest-copied-from-partner-center",
    "--attest-public-values-only",
  ];
}

function rejects(action, pattern) {
  assert.throws(
    action,
    (error) => error instanceof StoreIdentityPreparationError && pattern.test(error.message),
  );
}

test("builds the exact confirmed identity from six public Partner Center values", () => {
  const values = parseStoreIdentityArguments(validArguments());
  const document = buildStoreIdentityDocument(template, values, {
    now: new Date("2026-08-11T02:00:00.000Z"),
  });
  assert.equal(document.status, "partner_center_confirmed");
  assert.equal(document.confirmedAt, "2026-08-11T02:00:00.000Z");
  assert.equal(document.product.storeId, "9N1234567890");
  assert.equal(document.package.packageFamilyName, "12345Yuanyuan.Reminder_abcdefghjkmnp");
  assert.equal(document.platform.version, "1.4.0.0");
});

test("requires both explicit human safety attestations", () => {
  for (const missing of [
    "--attest-copied-from-partner-center",
    "--attest-public-values-only",
  ]) {
    rejects(
      () => parseStoreIdentityArguments(validArguments().filter((value) => value !== missing)),
      /both .* required/u,
    );
  }
});

test("rejects duplicate, unknown, and incomplete options", () => {
  rejects(
    () =>
      parseStoreIdentityArguments([
        ...validArguments(),
        "--store-id",
        "9N0000000000",
      ]),
    /duplicate/u,
  );
  rejects(() => parseStoreIdentityArguments([...validArguments(), "--token", "secret"]), /unknown/u);
  rejects(
    () =>
      parseStoreIdentityArguments(
        validArguments().filter((value, index, all) => {
          const optionIndex = all.indexOf("--package-family-name");
          return index !== optionIndex && index !== optionIndex + 1;
        }),
      ),
    /package-family-name .* required/u,
  );
});

test("reuses the strict verifier to reject preview or automated identity claims", () => {
  const preview = parseStoreIdentityArguments(validArguments());
  preview.publisher =
    "CN=YuanyuanReminderPreview, OID.2.25.311729368913984317654407730594956997722=1";
  rejects(
    () =>
      buildStoreIdentityDocument(template, preview, {
        now: new Date("2026-08-11T02:00:00.000Z"),
      }),
    /unsigned preview marker/u,
  );

  const automated = parseStoreIdentityArguments(validArguments());
  automated.confirmedBy = "Codex automation";
  rejects(
    () =>
      buildStoreIdentityDocument(template, automated, {
        now: new Date("2026-08-11T02:00:00.000Z"),
      }),
    /human/u,
  );
});

test("creates once and preserves an existing identity byte-for-byte", async () => {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "yuanyuan-store-identity-")),
  );
  const output = path.join(directory, "MSIX_STORE_IDENTITY_V1.json");
  const document = buildStoreIdentityDocument(
    template,
    parseStoreIdentityArguments(validArguments()),
    { now: new Date("2026-08-11T02:00:00.000Z") },
  );
  await writeNewStoreIdentity(output, document);
  const original = await readFile(output);
  await assert.rejects(
    writeNewStoreIdentity(output, { ...document, confirmedBy: "Another Human" }),
    (error) => error instanceof StoreIdentityPreparationError && /refusing to overwrite/u.test(error.message),
  );
  assert.deepEqual(await readFile(output), original);
  await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
});
