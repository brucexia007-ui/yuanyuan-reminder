import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyUnifiedPetIdentity } from "./verify_unified_pet_identity.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const write = process.argv.includes("--write");
const expectedArguments = write ? ["--write"] : ["--check"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArguments)) {
  throw new Error("usage: node scripts/sync_product_brand.mjs --check|--write");
}

// Unified builds keep their identity and original assets. Standalone synchronization
// below applies only to a separately configured application checkout.
const authority = JSON.parse(await readFile(path.join(projectRoot, "product-version.json"), "utf8"));
if (authority.brandConfig === undefined) {
  await verifyUnifiedPetIdentity(projectRoot);
  process.stdout.write("Unified application identity verified; no branding or asset files changed.\n");
  process.exit(0);
}

async function json(relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  return [filePath, JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""))];
}

function validateBrand(brand) {
  const exactKeys = (value, expected, location) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
      throw new Error(`product-brand.json ${location} fields do not match schema v1`);
    }
  };
  exactKeys(brand, ["schemaVersion", "pet", "application", "storage", "artifacts", "assets"], "root");
  exactKeys(brand.pet, ["displayName", "sex", "breed", "personality"], "pet");
  exactKeys(brand.application, ["displayName", "identifier", "packageName", "windowTitles", "notificationSender"], "application");
  exactKeys(brand.application.windowTitles, ["pet", "panel", "tray"], "application.windowTitles");
  exactKeys(brand.storage, ["directoryName", "mainDatabaseFile", "learningDatabaseFile", "logFile"], "storage");
  exactKeys(brand.artifacts, ["installerBaseName", "portableBaseName"], "artifacts");
  exactKeys(brand.assets, ["petDirectory", "iconDirectory", "licenseFile"], "assets");
  if (brand?.schemaVersion !== 1) throw new Error("product-brand.json schemaVersion must be 1");
  const values = [
    brand.pet?.displayName,
    brand.pet?.sex,
    brand.pet?.breed,
    brand.pet?.personality,
    brand.application?.displayName,
    brand.application?.identifier,
    brand.application?.packageName,
    brand.application?.windowTitles?.pet,
    brand.application?.windowTitles?.panel,
    brand.application?.windowTitles?.tray,
    brand.application?.notificationSender,
    brand.storage?.directoryName,
    brand.storage?.mainDatabaseFile,
    brand.storage?.learningDatabaseFile,
    brand.storage?.logFile,
    brand.artifacts?.installerBaseName,
    brand.artifacts?.portableBaseName,
    brand.assets?.licenseFile,
  ];
  if (values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("product-brand.json contains an empty required brand value");
  }
  if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*){2,}$/u.test(brand.application.identifier)) {
    throw new Error("product-brand.json application.identifier is invalid");
  }
  if (!["female", "male", "unknown"].includes(brand.pet.sex)) {
    throw new Error("product-brand.json pet.sex is invalid");
  }
  if (brand.storage.directoryName !== brand.application.identifier) {
    throw new Error("brand storage directory must equal the unique application identifier");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(brand.application.packageName)) {
    throw new Error("product-brand.json application.packageName is invalid");
  }
  for (const fileName of [brand.storage.mainDatabaseFile, brand.storage.learningDatabaseFile, brand.storage.logFile, brand.assets.licenseFile]) {
    if (fileName.length > 128 || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(fileName)) {
      throw new Error("product-brand.json contains an unsafe file name");
    }
  }
  if (brand.assets.petDirectory !== "public/assets/pet" || brand.assets.iconDirectory !== "src-tauri/icons") {
    throw new Error("product-brand.json runtime asset directories are fixed by schema v1");
  }
  if (brand.artifacts.installerBaseName !== brand.application.displayName) {
    throw new Error("installerBaseName must equal application.displayName because Tauri derives the NSIS name from productName");
  }
  for (const baseName of [brand.artifacts.installerBaseName, brand.artifacts.portableBaseName]) {
    if (/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(baseName)) {
      throw new Error("product-brand.json artifact base names must be safe Windows file names");
    }
  }
}

function replaceCargoDescription(source, brand) {
  const next = source.replace(
    /^description = ".*"$/mu,
    `description = "独立运行的${brand.application.displayName}桌面提醒工具"`,
  );
  if (next === source && !source.includes(`description = "独立运行的${brand.application.displayName}桌面提醒工具"`)) {
    throw new Error("src-tauri/Cargo.toml description field was not found");
  }
  return next;
}

function brandPetText(value, brand) {
  return value
    .replaceAll("圆圆提醒", brand.application.displayName)
    .replaceAll("圆圆", brand.pet.displayName);
}

function replaceMsixManifestBrand(source, brand, preview) {
  const displayName = preview
    ? `${brand.application.displayName}（MSIX 预览）`
    : brand.application.displayName;
  const propertiesDescription = preview
    ? `${brand.application.displayName}的本地 MSIX 技术验证包`
    : `${brand.pet.displayName}陪你喝水、安排工作和准时休息`;
  let next = source
    .replace(
      /(<Properties>[\s\S]*?<DisplayName>)[^<]*(<\/DisplayName>)/u,
      `$1${displayName}$2`,
    )
    .replace(
      /(<Properties>[\s\S]*?<Description>)[^<]*(<\/Description>)/u,
      `$1${propertiesDescription}$2`,
    )
    .replace(
      /(<uap:VisualElements[\s\S]*?\n\s*DisplayName=")[^"]*(")/u,
      `$1${brand.application.displayName}$2`,
    )
    .replace(
      /(<uap:VisualElements[\s\S]*?\n\s*Description=")[^"]*(")/u,
      `$1${brand.pet.displayName}陪你喝水、安排工作和准时休息$2`,
    );
  if (preview) {
    next = next.replace(
      /(<PublisherDisplayName>)[^<]*(<\/PublisherDisplayName>)/u,
      `$1${brand.application.displayName} Preview$2`,
    );
  }
  return next;
}

function replaceCurrentStoreRunbookBrand(source, brand) {
  return source
    .replace(
      /(--reserved-product-name ")[^"]*(" `)/u,
      `$1${brand.application.displayName}$2`,
    )
    .replace(
      /(在“设置 → 删除全部本地数据”中逐字输入“删除)[^”]*(全部本地数据”、勾选)/u,
      `$1${brand.pet.displayName}$2`,
    )
    .replace(
      /(再由受限清理模式仅删除固定的 `LOCALAPPDATA\/)[^`]+(` 数据根)/u,
      `$1${brand.storage.directoryName}$2`,
    );
}

const [brandPath, brand] = await json("product-brand.json");
validateBrand(brand);
const brandLicensePath = path.join(projectRoot, brand.assets.licenseFile);
const brandLicenseMetadata = await lstat(brandLicensePath);
const brandLicenseText = await readFile(brandLicensePath, "utf8");
if (
  !brandLicenseMetadata.isFile()
  || brandLicenseMetadata.isSymbolicLink()
  || brandLicenseMetadata.size < 1
  || !brandLicenseText.includes(brand.application.displayName)
) {
  throw new Error("product brand asset license must be a non-empty ordinary file naming the application");
}
const [versionPath, version] = await json("product-version.json");
const [packagePath, packageJson] = await json("package.json");
const [packageLockPath, packageLock] = await json("package-lock.json");
const [tauriPath, tauri] = await json("src-tauri/tauri.conf.json");
const [petManifestPath, petManifest] = await json("public/assets/pet/pet-manifest.json");
const [communityPolicyPath, communityPolicy] = await json("docs/release/COMMUNITY_STABLE_RELEASE_POLICY_V1.json");
const [communityAcceptancePath, communityAcceptance] = await json("docs/release/COMMUNITY_STABLE_ACCEPTANCE_V1.json");
const [communityAcceptanceTemplatePath, communityAcceptanceTemplate] = await json("docs/release/COMMUNITY_STABLE_ACCEPTANCE_V1.template.json");
const [storeSubmissionTemplatePath, storeSubmissionTemplate] = await json("docs/release/MSIX_STORE_SUBMISSION_INPUTS_V1.template.json");
const [capabilityPath, capability] = await json("src-tauri/capabilities/default.json");
const cargoPath = path.join(projectRoot, "src-tauri", "Cargo.toml");
const cargo = await readFile(cargoPath, "utf8");
const indexPath = path.join(projectRoot, "index.html");
const previewManifestPath = path.join(projectRoot, "src-tauri", "msix", "AppxManifest.preview.xml");
const storeManifestPath = path.join(projectRoot, "src-tauri", "msix", "AppxManifest.store.xml");
const storeRunbookPath = path.join(projectRoot, "docs", "release", "MSIX_STORE_ONBOARDING_RUNBOOK.md");
const [
  readme,
  readmeEnglish,
  privacyPolicy,
  securityPolicy,
  changelog,
  previewManifest,
  storeManifest,
  storeRunbook,
  indexHtml,
] = await Promise.all([
  readFile(path.join(projectRoot, "README.md"), "utf8"),
  readFile(path.join(projectRoot, "README.en.md"), "utf8"),
  readFile(path.join(projectRoot, "PRIVACY.md"), "utf8"),
  readFile(path.join(projectRoot, "SECURITY.md"), "utf8"),
  readFile(path.join(projectRoot, "CHANGELOG.md"), "utf8"),
  readFile(previewManifestPath, "utf8"),
  readFile(storeManifestPath, "utf8"),
  readFile(storeRunbookPath, "utf8"),
  readFile(indexPath, "utf8"),
]);

const desiredVersion = structuredClone(version);
desiredVersion.productName = brand.application.displayName;
desiredVersion.identifier = brand.application.identifier;
desiredVersion.brandConfig = "product-brand.json";

const desiredPackage = structuredClone(packageJson);
desiredPackage.name = brand.application.packageName;
desiredPackage.description = `独立运行的${brand.application.displayName}桌面提醒工具`;

const desiredPackageLock = structuredClone(packageLock);
desiredPackageLock.name = brand.application.packageName;
if (desiredPackageLock.packages?.[""]) {
  desiredPackageLock.packages[""].name = brand.application.packageName;
  desiredPackageLock.packages[""].description = desiredPackage.description;
}

const desiredTauri = structuredClone(tauri);
desiredTauri.productName = brand.application.displayName;
desiredTauri.identifier = brand.application.identifier;
for (const window of desiredTauri.app.windows) {
  if (window.label === "pet") window.title = brand.application.windowTitles.pet;
  if (window.label === "panel") window.title = brand.application.windowTitles.panel;
}
desiredTauri.bundle.shortDescription = `${brand.pet.displayName}陪你喝水、安排工作和准时休息`;
desiredTauri.bundle.resources ??= {};
for (const [source, destination] of Object.entries(desiredTauri.bundle.resources ?? {})) {
  if (destination === "licenses/ASSETS_LICENSE.md") delete desiredTauri.bundle.resources[source];
}
desiredTauri.bundle.resources[`../${brand.assets.licenseFile}`] = "licenses/ASSETS_LICENSE.md";
const desiredPetManifest = structuredClone(petManifest);
desiredPetManifest.id = brand.application.packageName;
desiredPetManifest.displayName = brand.pet.displayName;
desiredPetManifest.sex = brand.pet.sex;
desiredPetManifest.breed = brand.pet.breed;
desiredPetManifest.personality = brand.pet.personality;
const petSexLabel = { female: "母猫", male: "公猫", unknown: "猫咪" }[brand.pet.sex];
desiredPetManifest.description = `${brand.pet.displayName}是一只${brand.pet.breed}${petSexLabel}，性格${brand.pet.personality}；陪你喝水、专注、休息和玩耍`;
desiredPetManifest.assetLicense = brand.assets.licenseFile;
const desiredCommunityPolicy = structuredClone(communityPolicy);
desiredCommunityPolicy.product.name = brand.application.displayName;
desiredCommunityPolicy.product.identifier = brand.application.identifier;
const desiredCommunityAcceptance = structuredClone(communityAcceptance);
desiredCommunityAcceptance.product.name = brand.application.displayName;
desiredCommunityAcceptance.product.identifier = brand.application.identifier;
const desiredCommunityAcceptanceTemplate = structuredClone(communityAcceptanceTemplate);
desiredCommunityAcceptanceTemplate.product.name = brand.application.displayName;
desiredCommunityAcceptanceTemplate.product.identifier = brand.application.identifier;
const desiredStoreSubmissionTemplate = structuredClone(storeSubmissionTemplate);
desiredStoreSubmissionTemplate.product.name = brand.application.displayName;
desiredStoreSubmissionTemplate.listing.description = brandPetText(
  "圆圆提醒是一款完全本地运行的 Windows 桌面宠物与提醒工具。小猫会留在桌面陪伴你，在合适的时间提醒喝水、处理待办、专注工作和离屏休息。\n\n你可以创建一次性、间隔、每日和每周提醒，完成、稍后或跳过事项；也可以查看今天的喝水进度与历史记录。专注期间圆圆保持安静，离屏休息可由你主动请求 Windows 锁屏。\n\n应用支持托盘、自启动、Windows 通知、本地 SQLite 数据库、每日自动备份和手动恢复。日常使用不需要账户、云服务、遥测、广告或远程 AI，提醒和记录保存在当前 Windows 用户的本地目录。",
  brand,
);
desiredStoreSubmissionTemplate.listing.copyright = `© 2026 ${brand.application.displayName} contributors。${brand.pet.displayName}素材权利保留，详见素材许可。`;
desiredStoreSubmissionTemplate.listing.appLicenseTerms = `程序代码采用 MIT License；${brand.pet.displayName}照片、图集、图标和演示图片适用单独的${brand.pet.displayName}素材许可，仅允许官方免费分发和个人非商业使用。`;
desiredStoreSubmissionTemplate.listing.screenshots[0].caption = `今日喝水进度、待办事项与桌面上的${brand.pet.displayName}`;
desiredStoreSubmissionTemplate.declarations.restrictedCapabilities[0].justification = `${brand.application.displayName} is a packaged classic Win32/Tauri desktop application that runs at medium integrity. runFullTrust is required to launch the classic executable and provide the system tray, local SQLite data and backups, startup registration, Windows notifications, and the user-initiated LockWorkStation break flow. The app does not request elevation, install a service or driver, bypass Windows authentication, or use this capability for remote access.`;
const desiredCapability = structuredClone(capability);
desiredCapability.description = `${brand.application.displayName}应用窗口的最小权限`;
const desiredCargo = replaceCargoDescription(cargo, brand);
const desiredPreviewManifest = replaceMsixManifestBrand(previewManifest, brand, true);
const desiredStoreManifest = replaceMsixManifestBrand(storeManifest, brand, false);
const desiredStoreRunbook = replaceCurrentStoreRunbookBrand(storeRunbook, brand);
const desiredIndexHtml = indexHtml.replace(
  /(<title>)[^<]*(<\/title>)/u,
  `$1${brand.application.displayName}$2`,
);

const publicDocumentExpectations = [
  [
    "README.md",
    readme,
    [
      `<h1 align="center">${brand.application.displayName}</h1>`,
      `Version ${version.version}`,
      `version-${version.version}-`,
      `${brand.artifacts.installerBaseName}_*_x64-setup.exe`,
      `${brand.artifacts.portableBaseName}_*_windows-x64-portable.exe`,
      `%LOCALAPPDATA%\\${brand.storage.directoryName}\\`,
      `](${brand.assets.licenseFile})`,
      "public/assets/pet/fallback.png",
    ],
  ],
  [
    "README.en.md",
    readmeEnglish,
    [brand.application.displayName, `](${brand.assets.licenseFile})`, "public/assets/pet/fallback.png"],
  ],
  [
    "PRIVACY.md",
    privacyPolicy,
    [
      `# ${brand.application.displayName}隐私政策`,
      `适用版本：${brand.application.displayName} ${version.version}`,
      `%LOCALAPPDATA%\\${brand.storage.directoryName}\\`,
      "通用学习包内容",
      "答题进度",
    ],
  ],
  ["SECURITY.md", securityPolicy, [brand.application.displayName]],
];
for (const [relativePath, document, expectedFragments] of publicDocumentExpectations) {
  for (const fragment of expectedFragments) {
    if (!document.includes(fragment)) {
      throw new Error(`${relativePath} is missing product brand fragment ${JSON.stringify(fragment)}`);
    }
  }
  if (brand.pet.displayName !== "圆圆" && /圆圆/u.test(document)) {
    throw new Error(`${relativePath} still contains the previous public pet name`);
  }
}
if (/docs\/images\//u.test(readme) || /docs\/images\//u.test(readmeEnglish)) {
  throw new Error("public README files still reference the previous pet screenshots");
}
for (const fragment of [
  `## ${version.version} -`,
  brand.application.displayName,
  brand.pet.displayName,
  brand.pet.breed,
  petSexLabel,
  brand.pet.personality,
]) {
  if (!changelog.includes(fragment)) {
    throw new Error(`CHANGELOG.md is missing current product fragment ${JSON.stringify(fragment)}`);
  }
}

const documents = [
  [versionPath, version, desiredVersion],
  [packagePath, packageJson, desiredPackage],
  [packageLockPath, packageLock, desiredPackageLock],
  [tauriPath, tauri, desiredTauri],
  [petManifestPath, petManifest, desiredPetManifest],
  [communityPolicyPath, communityPolicy, desiredCommunityPolicy],
  [communityAcceptancePath, communityAcceptance, desiredCommunityAcceptance],
  [communityAcceptanceTemplatePath, communityAcceptanceTemplate, desiredCommunityAcceptanceTemplate],
  [storeSubmissionTemplatePath, storeSubmissionTemplate, desiredStoreSubmissionTemplate],
  [capabilityPath, capability, desiredCapability],
];
const drift = documents.filter(([, actual, desired]) => JSON.stringify(actual) !== JSON.stringify(desired));
const textDocuments = [
  [cargoPath, cargo, desiredCargo],
  [previewManifestPath, previewManifest, desiredPreviewManifest],
  [storeManifestPath, storeManifest, desiredStoreManifest],
  [storeRunbookPath, storeRunbook, desiredStoreRunbook],
  [indexPath, indexHtml, desiredIndexHtml],
];
const textDrift = textDocuments.filter(([, actual, desired]) => actual !== desired);
const allDrift = [...drift, ...textDrift];

if (!write && allDrift.length > 0) {
  throw new Error(`product brand mirrors are stale: ${allDrift.map(([file]) => path.relative(projectRoot, file).replaceAll("\\", "/")).join(", ")}`);
}
if (write) {
  for (const [filePath, , desired] of documents) await writeFile(filePath, `${JSON.stringify(desired, null, 2)}\n`, "utf8");
  for (const [filePath, actual, desired] of textDocuments) {
    if (actual !== desired) await writeFile(filePath, desired, "utf8");
  }
}
process.stdout.write(`Product brand ${write ? "synchronized" : "verified"}: ${brand.application.displayName} (${brand.application.identifier}); source ${path.basename(brandPath)}.\n`);
