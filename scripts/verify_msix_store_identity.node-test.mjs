import test from "node:test";
import assert from "node:assert/strict";

import {
  StoreIdentityVerificationError,
  validateStoreIdentityDocument,
} from "./verify_msix_store_identity.mjs";

function validIdentity() {
  return {
    schemaVersion: 1,
    status: "partner_center_confirmed",
    source: "partner_center_product_identity",
    confirmedBy: "Release Maintainer",
    confirmedAt: "2026-08-10T12:00:00.000Z",
    product: {
      reservedProductName: "Yuanyuan Reminder",
      storeId: "9N1234567890",
    },
    package: {
      identityName: "12345Yuanyuan.Reminder",
      publisher: "CN=12345678-1234-1234-1234-1234567890AB",
      publisherDisplayName: "Yuanyuan Project",
      packageFamilyName: "12345Yuanyuan.Reminder_abcdefghjkmnp",
    },
    platform: {
      version: "1.4.0.0",
      architecture: "x64",
      targetDeviceFamily: "Windows.Desktop",
      minVersion: "10.0.19041.0",
      maxVersionTested: "10.0.26100.0",
    },
  };
}

function rejects(mutator, expectedPattern) {
  const identity = validIdentity();
  mutator(identity);
  assert.throws(
    () => validateStoreIdentityDocument(identity, { now: new Date("2026-08-11T00:00:00.000Z") }),
    (error) => error instanceof StoreIdentityVerificationError && expectedPattern.test(error.message),
  );
}

test("accepts an exact human-confirmed Partner Center identity", () => {
  const identity = validIdentity();
  assert.equal(
    validateStoreIdentityDocument(identity, { now: new Date("2026-08-11T00:00:00.000Z") }),
    identity,
  );
});

test("rejects the pending template and automated confirmation", () => {
  rejects((identity) => {
    identity.status = "pending_partner_center";
  }, /partner_center_confirmed/);
  rejects((identity) => {
    identity.confirmedBy = "Codex automation";
  }, /human/);
});

test("rejects preview, placeholder, and malformed package identities", () => {
  rejects((identity) => {
    identity.package.identityName = "Yuanyuan.Reminder.Preview";
  }, /placeholder/);
  rejects((identity) => {
    identity.package.publisher =
      "CN=YuanyuanReminderPreview, OID.2.25.311729368913984317654407730594956997722=1";
  }, /unsigned preview marker/);
  rejects((identity) => {
    identity.package.publisher = "not a distinguished name";
  }, /distinguished name/);
});

test("rejects a package family name not bound to the Store identity", () => {
  rejects((identity) => {
    identity.package.packageFamilyName = "Different.Package_abcdefghjkmnp";
  }, /packageFamilyName/);
  rejects((identity) => {
    identity.package.packageFamilyName = "12345Yuanyuan.Reminder_8wekyb3d8bbwi";
  }, /13-character publisher ID/);
});

test("rejects Store-incompatible version and platform drift", () => {
  rejects((identity) => {
    identity.platform.version = "1.4.0.1";
  }, /fourth component 0/);
  rejects((identity) => {
    identity.platform.architecture = "arm64";
  }, /must be x64/);
  rejects((identity) => {
    identity.platform.minVersion = "10.0.30000.0";
  }, /must not exceed/);
});

test("rejects unknown fields instead of silently widening the identity contract", () => {
  rejects((identity) => {
    identity.package.guessedPublisher = true;
  }, /fields must be exactly/);
});
