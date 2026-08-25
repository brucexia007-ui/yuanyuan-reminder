import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const packageLockPath = path.join(projectRoot, "package-lock.json");
const cargoLockPath = path.join(projectRoot, "src-tauri", "Cargo.lock");
const licensePolicyPath = path.join(
  projectRoot,
  "docs",
  "release",
  "THIRD_PARTY_LICENSE_POLICY_V1.json",
);
const outputPath = path.join(projectRoot, "THIRD_PARTY_LICENSES.txt");
const MAX_LICENSE_BYTES = 2 * 1024 * 1024;
const LICENSE_FALLBACKS = new Map([
  [
    "pkg:cargo/alloc-stdlib@0.2.4",
    {
      sourcePurl: "pkg:cargo/alloc-no-stdlib@2.0.4",
      selectedLicense: "BSD-3-Clause",
      reason: "same_upstream_repository",
    },
  ],
  [
    "pkg:cargo/selectors@0.36.1",
    {
      sourcePurl: "pkg:cargo/cssparser@0.36.0",
      selectedLicense: "MPL-2.0",
      reason: "canonical_mpl_2_0_text",
    },
  ],
  [
    "pkg:cargo/priority-queue@2.7.0",
    {
      sourcePurl: "pkg:cargo/cssparser@0.36.0",
      selectedLicense: "MPL-2.0",
      reason: "selected_standard_mpl_2_0_text",
    },
  ],
  [
    "pkg:cargo/tauri-plugin@2.6.3",
    {
      sourcePurl: "pkg:cargo/tauri-build@2.6.3",
      selectedLicense: "Apache-2.0 OR MIT",
      reason: "same_upstream_repository_and_release_family",
    },
  ],
  ...[
    "unic-char-property",
    "unic-char-range",
    "unic-common",
    "unic-ucd-ident",
    "unic-ucd-version",
  ].map((name) => [
    `pkg:cargo/${name}@0.9.0`,
    {
      sourcePurl: "pkg:cargo/bitflags@1.3.2",
      selectedLicense: "Apache-2.0",
      fileNames: ["LICENSE-APACHE"],
      reason: "selected_standard_apache_2_0_text",
    },
  ]),
  ...[
    ["webview2-com", "b74dc5e2b394044bea5191052868ce7a106c202c"],
    ["webview2-com-sys", "b74dc5e2b394044bea5191052868ce7a106c202c"],
    ["webview2-com-macros", "dffa41a8a46d3f5565eefbff2de57d38d399f158"],
  ].map(([name, commit]) => [
    `pkg:cargo/${name}@${name === "webview2-com-macros" ? "0.8.1" : "0.38.2"}`,
    {
      sourceFile: "licenses/upstream/webview2-rs-LICENSE",
      selectedLicense: "MIT",
      reason: `official_upstream_license_at_commit_${commit}`,
    },
  ]),
]);

export function licenseFallbackReviewItems() {
  return [...LICENSE_FALLBACKS.entries()]
    .map(([purl, fallback]) => ({
      purl,
      selectedLicense: fallback.selectedLicense,
      reason: fallback.reason,
      sourcePurl: fallback.sourcePurl ?? null,
      sourceFile: fallback.sourceFile ?? null,
      fileNames: fallback.fileNames ? [...fallback.fileNames] : [],
    }))
    .sort((left, right) => left.purl.localeCompare(right.purl, "en"));
}

export function isLicenseFileName(name) {
  return (
    /^(licen[cs]e|copying|notice|unlicense)([._-].*)?$/i.test(name) &&
    !/\.(cjs|js|json|mjs|py|rs|sh|toml|ts|ya?ml|bat|cmd|ps1)$/i.test(name)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function npmPackageName(packagePath, metadata) {
  if (typeof metadata.name === "string") return metadata.name;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) throw new Error("cannot derive an npm package name from the lock path");
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

function normalizeLicenseText(bytes, purl, fileName) {
  if (bytes.length === 0 || bytes.length > MAX_LICENSE_BYTES || bytes.includes(0)) {
    throw new Error(`license file is empty, binary, or too large: ${purl} ${fileName}`);
  }
  return bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

export function renderLicenseArchive(entries, lockHashes) {
  const ordered = [...entries].sort((left, right) => left.purl.localeCompare(right.purl, "en"));
  const parts = [
    "YUANYUAN THIRD-PARTY LICENSE ARCHIVE",
    "",
    "This archive contains license, copyright, copying, and notice files from the locked",
    "third-party production dependency graph for the Windows x64 release. Development-only",
    "dependencies and first-party Yuanyuan workspace packages are excluded.",
    "",
    `package-lock.json SHA-256: ${lockHashes.packageLockSha256}`,
    `src-tauri/Cargo.lock SHA-256: ${lockHashes.cargoLockSha256}`,
    `License policy SHA-256: ${lockHashes.licensePolicySha256}`,
    `Third-party production components: ${ordered.length}`,
  ];
  for (const entry of ordered) {
    parts.push("", "=".repeat(80), entry.purl, `Declared license: ${entry.license}`);
    if (entry.selectedLicense) parts.push(`Selected distribution license: ${entry.selectedLicense}`);
    if (entry.sourceUrl) parts.push(`Exact source form: ${entry.sourceUrl}`);
    for (const file of [...entry.files].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      parts.push("", `--- ${file.name} ---`);
      if (file.origin) parts.push(`License text provenance: ${file.origin}`);
      parts.push(file.text);
    }
  }
  return `${parts.join("\n")}\n`;
}

export function validateLicensePolicy(policy, entries) {
  const expectedPolicyKeys = [
    "noticeArchiveRequired",
    "permittedProductionLicenseExpressions",
    "releaseTarget",
    "schemaVersion",
    "sourceAvailability",
  ];
  if (
    policy === null ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(expectedPolicyKeys) ||
    policy.schemaVersion !== 1 ||
    policy.releaseTarget !== "x86_64-pc-windows-msvc" ||
    policy.noticeArchiveRequired !== true ||
    !Array.isArray(policy.permittedProductionLicenseExpressions) ||
    !Array.isArray(policy.sourceAvailability)
  ) {
    return false;
  }
  const expressions = [...new Set(entries.map((entry) => entry.license))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (
    JSON.stringify(policy.permittedProductionLicenseExpressions) !== JSON.stringify(expressions)
  ) {
    return false;
  }
  const mplPurls = entries
    .filter(
      (entry) => entry.license === "MPL-2.0" || entry.selectedLicense === "MPL-2.0",
    )
    .map((entry) => entry.purl)
    .sort((left, right) => left.localeCompare(right, "en"));
  const sourcePurls = [];
  for (const item of policy.sourceAvailability) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["purl", "url"]) ||
      typeof item.purl !== "string" ||
      typeof item.url !== "string" ||
      item.url !==
        `https://crates.io/api/v1/crates/${item.purl.match(/^pkg:cargo\/([^@]+)@(.+)$/)?.[1]}/${item.purl.match(/^pkg:cargo\/([^@]+)@(.+)$/)?.[2]}/download`
    ) {
      return false;
    }
    sourcePurls.push(item.purl);
  }
  sourcePurls.sort((left, right) => left.localeCompare(right, "en"));
  return JSON.stringify(sourcePurls) === JSON.stringify(mplPurls);
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

function productionCargoPackageIds(metadata, productVersion) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.packages.find(
    (pkg) => pkg.name === "yuanyuan-reminder" && pkg.version === productVersion,
  );
  if (!root) throw new Error("release Cargo package is missing from metadata");
  const production = new Set([root.id]);
  const pending = [root.id];
  while (pending.length > 0) {
    const node = nodes.get(pending.pop());
    for (const dependency of node?.deps ?? []) {
      const productionEdge =
        dependency.dep_kinds.length === 0 ||
        dependency.dep_kinds.some((kind) => kind.kind !== "dev");
      if (!productionEdge || production.has(dependency.pkg)) continue;
      production.add(dependency.pkg);
      pending.push(dependency.pkg);
    }
  }
  return production;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectLicenseFiles(packageRoot, purl, explicitLicenseFile = null) {
  const canonicalRoot = await realpath(packageRoot);
  const candidates = new Set();
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (entry.isFile() && isLicenseFileName(entry.name)) {
      candidates.add(path.join(canonicalRoot, entry.name));
    }
  }
  if (typeof explicitLicenseFile === "string" && explicitLicenseFile.length > 0) {
    candidates.add(
      path.isAbsolute(explicitLicenseFile)
        ? explicitLicenseFile
        : path.resolve(canonicalRoot, explicitLicenseFile),
    );
  }

  const files = [];
  for (const candidate of [...candidates].sort((left, right) => left.localeCompare(right, "en"))) {
    const [metadata, canonicalFile] = await Promise.all([lstat(candidate), realpath(candidate)]);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !isInside(canonicalRoot, canonicalFile)) {
      throw new Error(`license file escapes its package root: ${purl}`);
    }
    files.push({
      name: path.basename(candidate),
      text: normalizeLicenseText(await readFile(canonicalFile), purl, path.basename(candidate)),
    });
  }
  return files;
}

async function resolveLicenseFallback(purl, cargoPackagesByPurl) {
  const fallback = LICENSE_FALLBACKS.get(purl);
  if (!fallback) return null;
  let files;
  let origin;
  if (fallback.sourcePurl) {
    const sourcePackage = cargoPackagesByPurl.get(fallback.sourcePurl);
    if (!sourcePackage) throw new Error(`license fallback source is missing: ${fallback.sourcePurl}`);
    files = await collectLicenseFiles(
      path.dirname(sourcePackage.manifest_path),
      fallback.sourcePurl,
      sourcePackage.license_file,
    );
    if (fallback.fileNames) {
      const allowed = new Set(fallback.fileNames);
      files = files.filter((file) => allowed.has(file.name));
    }
    origin = `${fallback.reason}; ${fallback.sourcePurl}`;
  } else {
    const sourcePath = path.resolve(projectRoot, fallback.sourceFile);
    const canonicalProjectRoot = await realpath(projectRoot);
    const [metadata, canonicalSource] = await Promise.all([lstat(sourcePath), realpath(sourcePath)]);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !isInside(canonicalProjectRoot, canonicalSource)
    ) {
      throw new Error(`vendored license fallback is unsafe: ${purl}`);
    }
    files = [
      {
        name: path.basename(sourcePath),
        text: normalizeLicenseText(await readFile(canonicalSource), purl, path.basename(sourcePath)),
      },
    ];
    origin = `${fallback.reason}; ${fallback.sourceFile}`;
  }
  if (files.length === 0) throw new Error(`license fallback has no selected files: ${purl}`);
  return {
    selectedLicense: fallback.selectedLicense,
    files: files.map((file) => ({ ...file, origin })),
  };
}

export async function buildLicenseArchive() {
  const [packageJsonBytes, packageLockBytes, cargoLockBytes, licensePolicyBytes] = await Promise.all([
    readFile(path.join(projectRoot, "package.json")),
    readFile(packageLockPath),
    readFile(cargoLockPath),
    readFile(licensePolicyPath),
  ]);
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  const packageLock = JSON.parse(packageLockBytes.toString("utf8"));
  const licensePolicy = JSON.parse(licensePolicyBytes.toString("utf8"));
  const cargoMetadata = loadCargoMetadata();
  const productionCargoIds = productionCargoPackageIds(cargoMetadata, packageJson.version);
  const cargoPackagesByPurl = new Map(
    cargoMetadata.packages.map((pkg) => [cargoPurl(pkg.name, pkg.version), pkg]),
  );
  const entries = [];
  const missingLicenseFiles = [];
  const usedFallbacks = new Set();

  for (const [packagePath, metadata] of Object.entries(packageLock.packages ?? {})) {
    if (packagePath === "" || metadata.dev === true) continue;
    const name = npmPackageName(packagePath, metadata);
    const purl = npmPurl(name, metadata.version);
    if (typeof metadata.license !== "string" || metadata.license.trim().length === 0) {
      throw new Error(`required npm dependency has no declared license: ${purl}`);
    }
    const files = await collectLicenseFiles(path.join(projectRoot, packagePath), purl);
    if (files.length === 0) missingLicenseFiles.push(purl);
    entries.push({
      purl,
      license: metadata.license,
      files,
    });
  }

  for (const pkg of cargoMetadata.packages) {
    if (!productionCargoIds.has(pkg.id) || pkg.source === null) continue;
    const purl = cargoPurl(pkg.name, pkg.version);
    if (typeof pkg.license !== "string" || pkg.license.trim().length === 0) {
      throw new Error(`required Cargo dependency has no declared license: ${purl}`);
    }
    let files = await collectLicenseFiles(
      path.dirname(pkg.manifest_path),
      purl,
      pkg.license_file,
    );
    let selectedLicense = null;
    if (files.length === 0) {
      const fallback = await resolveLicenseFallback(purl, cargoPackagesByPurl);
      if (fallback) {
        files = fallback.files;
        selectedLicense = fallback.selectedLicense;
        usedFallbacks.add(purl);
      } else {
        missingLicenseFiles.push(purl);
      }
    }
    entries.push({
      purl,
      license: pkg.license,
      selectedLicense,
      files,
    });
  }

  if (missingLicenseFiles.length > 0) {
    throw new Error(
      `no distributable license file found for: ${missingLicenseFiles.sort().join(", ")}`,
    );
  }
  const unusedFallbacks = [...LICENSE_FALLBACKS.keys()].filter((purl) => !usedFallbacks.has(purl));
  if (unusedFallbacks.length > 0) {
    throw new Error(`stale license fallback mappings require review: ${unusedFallbacks.join(", ")}`);
  }

  const purls = new Set(entries.map((entry) => entry.purl));
  if (purls.size !== entries.length) throw new Error("duplicate production dependency purl");
  if (!validateLicensePolicy(licensePolicy, entries)) {
    const expectedExpressions = [...new Set(entries.map((entry) => entry.license))].sort(
      (left, right) => left.localeCompare(right, "en"),
    );
    const expectedSourcePurls = entries
      .filter(
        (entry) => entry.license === "MPL-2.0" || entry.selectedLicense === "MPL-2.0",
      )
      .map((entry) => entry.purl)
      .sort((left, right) => left.localeCompare(right, "en"));
    throw new Error(
      `third-party production license policy is stale or inconsistent; expected expressions ${JSON.stringify(expectedExpressions)}; expected source purls ${JSON.stringify(expectedSourcePurls)}`,
    );
  }
  const sourceAvailability = new Map(
    licensePolicy.sourceAvailability.map((item) => [item.purl, item.url]),
  );
  for (const entry of entries) entry.sourceUrl = sourceAvailability.get(entry.purl) ?? null;
  return renderLicenseArchive(entries, {
    packageLockSha256: sha256(packageLockBytes),
    cargoLockSha256: sha256(cargoLockBytes),
    licensePolicySha256: sha256(licensePolicyBytes),
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((argument) => argument !== "--check") || args.length > 1) {
    throw new Error("usage: node scripts/generate_third_party_licenses.mjs [--check]");
  }
  const archive = await buildLicenseArchive();
  if (args.includes("--check")) {
    let existing;
    try {
      existing = await readFile(outputPath, "utf8");
    } catch {
      throw new Error("THIRD_PARTY_LICENSES.txt is missing; run npm run release:licenses");
    }
    if (existing !== archive) {
      throw new Error("THIRD_PARTY_LICENSES.txt is stale; run npm run release:licenses");
    }
    console.log(`Third-party license archive is current: ${sha256(Buffer.from(archive))}.`);
    return;
  }
  await writeFile(outputPath, archive, "utf8");
  console.log(`Third-party license archive written: ${outputPath}`);
  console.log(`Archive SHA-256: ${sha256(Buffer.from(archive))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
