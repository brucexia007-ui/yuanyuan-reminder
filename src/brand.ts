import brandDocument from "../product-brand.json";

export type PetSex = "female" | "male" | "unknown";

export const productBrand = brandDocument;
export const petDisplayName = productBrand.pet.displayName;
export const petSex = productBrand.pet.sex as PetSex;
export const petBreed = productBrand.pet.breed;
export const petPersonality = productBrand.pet.personality;
export const petSexLabel: Record<PetSex, string>[PetSex] = {
  female: "母猫",
  male: "公猫",
  unknown: "猫咪",
}[petSex];
export const petIdentityDescription = `${petDisplayName}：${petBreed}${petSexLabel}，性格${petPersonality}`;
export const applicationDisplayName = productBrand.application.displayName;
export const applicationPackageName = productBrand.application.packageName;

export function petText(value: string): string {
  return value
    .replaceAll("圆圆提醒", applicationDisplayName)
    .replaceAll("圆圆", petDisplayName);
}
