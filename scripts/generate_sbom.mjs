import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
const sbomPath = path.join(releaseRoot, "sbom.cdx.json");
const licensePath = path.join(releaseRoot, "third-party-licenses.json");

function npmPackageName(packagePath, metadata) {
  if (typeof metadata.name === "string") return metadata.name;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) throw new Error(`cannot derive npm package name from ${packagePath}`);
  return packagePath.slice(index + marker.length);
}

function npmPurl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function cargoPurl(name, version) {
  return `pkg:cargo/${encodeURIComponent(name)}@${version}`;
}

function licenseEntry(expression) {
  return typeof expression === "string" && expression.trim().length > 0
    ? [{ expression }]
    : [];
}

function loadCargoMetadata() {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
    ],
    {
      cwd: path.join(projectRoot, "src-tauri"),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || "no diagnostic output").trim();
    throw new Error(`cargo metadata failed with exit code ${result.status}: ${diagnostic}`);
  }
  return JSON.parse(result.stdout);
}

const [packageJson, packageLock] = await Promise.all([
  readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "package-lock.json"), "utf8").then(JSON.parse),
]);
const cargoMetadata = loadCargoMetadata();

const cargoNodes = new Map(cargoMetadata.resolve.nodes.map((node) => [node.id, node]));
const releaseCargoRoot = cargoMetadata.packages.find(
  (pkg) => pkg.name === "yuanyuan-reminder" && pkg.version === packageJson.version,
);
if (!releaseCargoRoot) throw new Error("release Cargo package is missing from metadata");
const productionCargoIds = new Set([releaseCargoRoot.id]);
const pendingCargoIds = [releaseCargoRoot.id];
while (pendingCargoIds.length > 0) {
  const current = pendingCargoIds.pop();
  const node = cargoNodes.get(current);
  for (const dependency of node?.deps ?? []) {
    const isProductionEdge =
      dependency.dep_kinds.length === 0 ||
      dependency.dep_kinds.some((kind) => kind.kind !== "dev");
    if (!isProductionEdge || productionCargoIds.has(dependency.pkg)) continue;
    productionCargoIds.add(dependency.pkg);
    pendingCargoIds.push(dependency.pkg);
  }
}

const components = new Map();
for (const [packagePath, metadata] of Object.entries(packageLock.packages ?? {})) {
  if (packagePath === "") continue;
  const name = npmPackageName(packagePath, metadata);
  const purl = npmPurl(name, metadata.version);
  if (components.has(purl)) continue;
  components.set(purl, {
    type: "library",
    name,
    version: metadata.version,
    scope: metadata.dev === true ? "excluded" : "required",
    licenses: licenseEntry(metadata.license),
    purl,
    "bom-ref": purl,
    properties: [
      { name: "yuanyuan:ecosystem", value: "npm" },
      { name: "yuanyuan:lockIntegrityPresent", value: String(Boolean(metadata.integrity)) },
    ],
  });
}

for (const pkg of cargoMetadata.packages) {
  const purl = cargoPurl(pkg.name, pkg.version);
  if (components.has(purl)) continue;
  components.set(purl, {
    type: pkg.source === null ? "application" : "library",
    name: pkg.name,
    version: pkg.version,
    scope: productionCargoIds.has(pkg.id) ? "required" : "excluded",
    licenses: licenseEntry(pkg.license),
    purl,
    "bom-ref": purl,
    properties: [
      { name: "yuanyuan:ecosystem", value: "cargo" },
      { name: "yuanyuan:source", value: pkg.source ?? "workspace" },
    ],
  });
}

const componentList = [...components.values()].sort((left, right) =>
  left.purl.localeCompare(right.purl, "en"),
);
const unresolved = componentList.filter((component) => component.licenses.length === 0);
const licenseExpressions = [...new Set(
  componentList.flatMap((component) => component.licenses.map((entry) => entry.expression)),
)].sort((left, right) => left.localeCompare(right, "en"));

const generatedAt = new Date().toISOString();
const applicationPurl = `pkg:generic/yuanyuan-reminder@${packageJson.version}`;
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:00000000-0000-4000-8000-${Date.now().toString().padStart(12, "0").slice(-12)}`,
  version: 1,
  metadata: {
    timestamp: generatedAt,
    component: {
      type: "application",
      name: packageJson.name,
      version: packageJson.version,
      licenses: licenseEntry(packageJson.license),
      purl: applicationPurl,
      "bom-ref": applicationPurl,
    },
    properties: [
      { name: "yuanyuan:lockfiles", value: "package-lock.json;src-tauri/Cargo.lock" },
      {
        name: "yuanyuan:scope",
        value: "x86_64-pc-windows-msvc release graph plus locked development dependencies",
      },
    ],
  },
  components: componentList,
};

const licenseInventory = {
  schemaVersion: 1,
  generatedAt,
  productVersion: packageJson.version,
  reviewStatus: "not_performed",
  summary: {
    components: componentList.length,
    unresolved: unresolved.length,
    uniqueLicenseExpressions: licenseExpressions.length,
  },
  licenseExpressions,
  unresolvedComponents: unresolved.map((component) => component.purl),
  components: componentList.map((component) => ({
    purl: component.purl,
    scope: component.scope,
    licenses: component.licenses.map((entry) => entry.expression),
  })),
};

await Promise.all([
  writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8"),
  writeFile(licensePath, `${JSON.stringify(licenseInventory, null, 2)}\n`, "utf8"),
]);
console.log(
  `SBOM written: ${componentList.length} components, ${unresolved.length} unresolved license declarations.`,
);
console.log(`CycloneDX: ${sbomPath}`);
console.log(`License inventory: ${licensePath}`);
