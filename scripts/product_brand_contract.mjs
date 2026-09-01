import { readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

export const productBrand = JSON.parse(
  readFileSync(path.join(projectRoot, "product-brand.json"), "utf8").replace(/^\uFEFF/u, ""),
);

if (
  productBrand.schemaVersion !== 1
  || typeof productBrand.pet?.displayName !== "string"
  || typeof productBrand.application?.displayName !== "string"
) {
  throw new Error("product-brand.json is not a supported brand contract");
}

export const petDisplayName = productBrand.pet.displayName;
export const applicationDisplayName = productBrand.application.displayName;

export function brandPetText(value) {
  return value
    .replaceAll("圆圆提醒", applicationDisplayName)
    .replaceAll("圆圆", petDisplayName);
}
