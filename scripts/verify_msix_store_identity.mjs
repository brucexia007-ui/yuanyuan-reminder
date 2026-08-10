import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
export const defaultStoreIdentityPath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_IDENTITY_V1.json",
);

export class StoreIdentityVerificationError extends Error {}

function fail(message) {
  throw new StoreIdentityVerificationError(message);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function assertString(value, label, minLength, maxLength) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    fail(`${label} must be a trimmed string`);
  }
  if (value.length < minLength || value.length > maxLength) {
    fail(`${label} length must be ${minLength}-${maxLength}`);
  }
  return value;
}

function assertNotPlaceholder(value, label) {
  if (/pending|placeholder|example|sample|preview|replace|todo|待定|示例|占位/i.test(value)) {
    fail(`${label} still contains a placeholder value`);
  }
}

const packageStringPattern = /^[A-Za-z0-9.-]+$/;
const prohibitedPackageStrings = new Set([
  ".",
  "..",
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function assertPackageString(value, label) {
  assertString(value, label, 3, 50);
  const lower = value.toLowerCase();
  if (!packageStringPattern.test(value) || value.endsWith(".")) {
    fail(`${label} is not a valid Windows package string`);
  }
  if (
    prohibitedPackageStrings.has(lower) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value) ||
    lower.startsWith("xn--") ||
    lower.includes(".xn--")
  ) {
    fail(`${label} uses a prohibited Windows package string`);
  }
}

const distinguishedNamePattern = /^(?:(?:CN|L|O|OU|E|C|S|STREET|T|G|I|SN|DC|SERIALNUMBER|Description|PostalCode|POBox|Phone|X21Address|dnQualifier|OID\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))+)=((?:[^,+=<>"#;]+)|"[^"]*"))(?:, (?:(?:CN|L|O|OU|E|C|S|STREET|T|G|I|SN|DC|SERIALNUMBER|Description|PostalCode|POBox|Phone|X21Address|dnQualifier|OID\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))+)=((?:[^,+=<>"#;]+)|"[^"]*")))*$/;

function parseQuadVersion(value, label) {
  assertString(value, label, 7, 23);
  const match = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/.exec(
    value,
  );
  if (!match) fail(`${label} must be a four-part numeric version`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 65535)) fail(`${label} contains a component above 65535`);
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function validateStoreIdentityDocument(document, { now = new Date() } = {}) {
  assertExactKeys(
    document,
    [
      "schemaVersion",
      "status",
      "source",
      "confirmedBy",
      "confirmedAt",
      "product",
      "package",
      "platform",
    ],
    "store identity",
  );
  if (document.schemaVersion !== 1) fail("store identity schemaVersion must be 1");
  if (document.status !== "partner_center_confirmed") {
    fail("store identity status must be partner_center_confirmed");
  }
  if (document.source !== "partner_center_product_identity") {
    fail("store identity source must be partner_center_product_identity");
  }

  const confirmedBy = assertString(document.confirmedBy, "confirmedBy", 2, 128);
  if (/\b(?:ai|bot|automation|codex|chatgpt)\b/i.test(confirmedBy)) {
    fail("confirmedBy must identify the human who copied the Partner Center values");
  }
  const confirmedAt = assertString(document.confirmedAt, "confirmedAt", 20, 35);
  const confirmedTime = Date.parse(confirmedAt);
  if (!Number.isFinite(confirmedTime) || confirmedTime > now.getTime() + 5 * 60 * 1000) {
    fail("confirmedAt must be a valid, non-future ISO timestamp");
  }

  assertExactKeys(document.product, ["reservedProductName", "storeId"], "product");
  const reservedProductName = assertString(
    document.product.reservedProductName,
    "product.reservedProductName",
    1,
    256,
  );
  assertNotPlaceholder(reservedProductName, "product.reservedProductName");
  const storeId = assertString(document.product.storeId, "product.storeId", 6, 64);
  if (!/^[A-Za-z0-9]+$/.test(storeId)) fail("product.storeId must be copied from Partner Center");

  assertExactKeys(
    document.package,
    ["identityName", "publisher", "publisherDisplayName", "packageFamilyName"],
    "package",
  );
  const identityName = document.package.identityName;
  assertPackageString(identityName, "package.identityName");
  assertNotPlaceholder(identityName, "package.identityName");

  const publisher = assertString(document.package.publisher, "package.publisher", 1, 8192);
  if (!distinguishedNamePattern.test(publisher)) {
    fail("package.publisher is not a valid package-manifest distinguished name");
  }
  if (publisher.includes("OID.2.25.311729368913984317654407730594956997722=1")) {
    fail("package.publisher must be the Store publisher, not the unsigned preview marker");
  }
  assertNotPlaceholder(publisher, "package.publisher");

  const publisherDisplayName = assertString(
    document.package.publisherDisplayName,
    "package.publisherDisplayName",
    1,
    256,
  );
  assertNotPlaceholder(publisherDisplayName, "package.publisherDisplayName");

  const packageFamilyName = assertString(
    document.package.packageFamilyName,
    "package.packageFamilyName",
    identityName.length + 14,
    identityName.length + 14,
  );
  const expectedPrefix = `${identityName}_`;
  if (
    packageFamilyName.slice(0, expectedPrefix.length).toLowerCase() !== expectedPrefix.toLowerCase() ||
    !/^[a-hjkmnp-tv-z0-9]{13}$/i.test(packageFamilyName.slice(expectedPrefix.length))
  ) {
    fail("package.packageFamilyName must match the Partner Center identity name and 13-character publisher ID");
  }

  assertExactKeys(
    document.platform,
    ["version", "architecture", "targetDeviceFamily", "minVersion", "maxVersionTested"],
    "platform",
  );
  const packageVersion = parseQuadVersion(document.platform.version, "platform.version");
  if (packageVersion[0] === 0 || packageVersion[3] !== 0) {
    fail("platform.version must have a non-zero major component and Store-reserved fourth component 0");
  }
  if (document.platform.architecture !== "x64") fail("platform.architecture must be x64");
  if (document.platform.targetDeviceFamily !== "Windows.Desktop") {
    fail("platform.targetDeviceFamily must be Windows.Desktop");
  }
  const minVersion = parseQuadVersion(document.platform.minVersion, "platform.minVersion");
  const maxVersion = parseQuadVersion(document.platform.maxVersionTested, "platform.maxVersionTested");
  if (compareVersions(minVersion, maxVersion) > 0) {
    fail("platform.minVersion must not exceed platform.maxVersionTested");
  }

  return document;
}

export function readAndValidateStoreIdentity(identityPath = defaultStoreIdentityPath) {
  const absolutePath = path.resolve(identityPath);
  if (!fs.existsSync(absolutePath)) {
    fail(
      `Store identity file is missing: ${absolutePath}. Copy docs/release/MSIX_STORE_IDENTITY_V1.template.json to MSIX_STORE_IDENTITY_V1.json and fill it only with Partner Center Product identity values.`,
    );
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(`Store identity JSON is invalid: ${error.message}`);
  }
  return validateStoreIdentityDocument(document);
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const identityPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultStoreIdentityPath;
    const identity = readAndValidateStoreIdentity(identityPath);
    console.log(
      `Partner Center MSIX identity verified: ${identity.package.identityName}, ${identity.package.packageFamilyName}`,
    );
  } catch (error) {
    if (error instanceof StoreIdentityVerificationError) {
      console.error(`MSIX Store identity pending: ${error.message}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
