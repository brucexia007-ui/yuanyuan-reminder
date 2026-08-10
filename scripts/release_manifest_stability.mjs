function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function selectStableGeneratedAt(existingManifest, manifestMaterial, freshGeneratedAt) {
  const materialKeys = Object.keys(manifestMaterial);
  if (
    !hasExactKeys(existingManifest, [...materialKeys, "generatedAt"]) ||
    typeof existingManifest.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(existingManifest.generatedAt)) ||
    typeof freshGeneratedAt !== "string" ||
    !Number.isFinite(Date.parse(freshGeneratedAt))
  ) {
    return freshGeneratedAt;
  }
  const existingMaterial = { ...existingManifest };
  delete existingMaterial.generatedAt;
  return JSON.stringify(canonical(existingMaterial)) ===
    JSON.stringify(canonical(manifestMaterial))
    ? existingManifest.generatedAt
    : freshGeneratedAt;
}
