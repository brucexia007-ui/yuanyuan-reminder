import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultStoreIdentityPath,
  validateStoreIdentityDocument,
} from "./verify_msix_store_identity.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_IDENTITY_V1.template.json",
);

const valueOptions = new Map([
  ["--reserved-product-name", "reservedProductName"],
  ["--store-id", "storeId"],
  ["--identity-name", "identityName"],
  ["--publisher", "publisher"],
  ["--publisher-display-name", "publisherDisplayName"],
  ["--package-family-name", "packageFamilyName"],
  ["--confirmed-by", "confirmedBy"],
]);

export class StoreIdentityPreparationError extends Error {}

function fail(message) {
  throw new StoreIdentityPreparationError(message);
}

function usage() {
  return "usage: npm.cmd run msix:store:identity:prepare -- --reserved-product-name <name> --store-id <id> --identity-name <name> --publisher <dn> --publisher-display-name <name> --package-family-name <pfn> --confirmed-by <human> --attest-copied-from-partner-center --attest-public-values-only";
}

export function parseStoreIdentityArguments(argumentsList) {
  if (!Array.isArray(argumentsList)) fail("identity arguments must be an array");
  const values = {};
  let copiedFromPartnerCenter = false;
  let publicValuesOnly = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--attest-copied-from-partner-center") {
      if (copiedFromPartnerCenter) fail("duplicate Partner Center source attestation");
      copiedFromPartnerCenter = true;
      continue;
    }
    if (argument === "--attest-public-values-only") {
      if (publicValuesOnly) fail("duplicate public-values-only attestation");
      publicValuesOnly = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") fail(usage());
    const field = valueOptions.get(argument);
    if (!field) fail(`unknown identity option: ${argument}`);
    if (Object.hasOwn(values, field)) fail(`duplicate identity option: ${argument}`);
    const value = argumentsList[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      fail(`${argument} requires one value`);
    }
    values[field] = value;
    index += 1;
  }
  for (const [option, field] of valueOptions) {
    if (!Object.hasOwn(values, field)) fail(`${option} is required`);
  }
  if (!copiedFromPartnerCenter || !publicValuesOnly) {
    fail(
      "both --attest-copied-from-partner-center and --attest-public-values-only are required",
    );
  }
  return values;
}

export function buildStoreIdentityDocument(template, values, { now = new Date() } = {}) {
  if (
    template === null ||
    typeof template !== "object" ||
    Array.isArray(template) ||
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values)
  ) {
    fail("identity template and values must be objects");
  }
  const expectedValueKeys = [...valueOptions.values()].sort();
  const actualValueKeys = Object.keys(values).sort();
  if (
    actualValueKeys.length !== expectedValueKeys.length ||
    actualValueKeys.some((key, index) => key !== expectedValueKeys[index])
  ) {
    fail("identity values do not match the exact public Partner Center field set");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("now must be a valid date");
  const document = structuredClone(template);
  document.status = "partner_center_confirmed";
  document.source = "partner_center_product_identity";
  document.confirmedBy = values.confirmedBy;
  document.confirmedAt = now.toISOString();
  document.product.reservedProductName = values.reservedProductName;
  document.product.storeId = values.storeId;
  document.package.identityName = values.identityName;
  document.package.publisher = values.publisher;
  document.package.publisherDisplayName = values.publisherDisplayName;
  document.package.packageFamilyName = values.packageFamilyName;
  try {
    return validateStoreIdentityDocument(document, { now });
  } catch (error) {
    fail(error.message);
  }
}

export async function writeNewStoreIdentity(outputPath, document) {
  const resolved = path.resolve(outputPath);
  let handle;
  try {
    handle = await open(resolved, "wx");
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
      await rm(resolved, { force: true });
    }
    if (error?.code === "EEXIST") {
      fail("confirmed Store identity already exists; refusing to overwrite or merge it");
    }
    fail(`unable to create the confirmed Store identity: ${error.message}`);
  } finally {
    await handle?.close();
  }
  return resolved;
}

async function main() {
  const values = parseStoreIdentityArguments(process.argv.slice(2));
  const templateBytes = await readFile(templatePath);
  let template;
  try {
    template = JSON.parse(templateBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`Store identity template is invalid: ${error.message}`);
  }
  const document = buildStoreIdentityDocument(template, values);
  const outputPath = await writeNewStoreIdentity(defaultStoreIdentityPath, document);
  process.stdout.write(
    `Confirmed Partner Center public identity written without overwrite: ${outputPath}\n`,
  );
  process.stdout.write(
    "Review the six public values, commit the identity file, and rerun msix:store:identity:verify before building.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message =
      error instanceof StoreIdentityPreparationError ? error.message : error.message;
    process.stderr.write(`MSIX Store identity preparation stopped: ${message}\n`);
    process.exitCode = 2;
  });
}
