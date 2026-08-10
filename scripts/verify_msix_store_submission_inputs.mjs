import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import {
  defaultStoreIdentityPath,
  readAndValidateStoreIdentity,
} from "./verify_msix_store_identity.mjs";
import { readAndValidateStorePublicUrlsReport } from "./verify_msix_store_public_urls.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const submissionInputsPath = path.join(
  projectRoot,
  "docs",
  "release",
  "MSIX_STORE_SUBMISSION_INPUTS_V1.json",
);
const candidateReportPath = path.join(
  projectRoot,
  "src-tauri",
  "target",
  "msix-store",
  "msix-store-candidate-report.json",
);
const candidateVerifierPath = path.join(projectRoot, "scripts", "verify_msix_store_candidate.mjs");
const verifierPath = fileURLToPath(import.meta.url);

export const STORE_SCREENSHOTS = [
  {
    path: "docs/release/store-assets/01-today.png",
    caption: "今日喝水进度、待办事项与桌面上的圆圆",
  },
  {
    path: "docs/release/store-assets/02-focus.png",
    caption: "专注工作与由用户主动开始的离屏休息",
  },
  {
    path: "docs/release/store-assets/03-care.png",
    caption: "喂食、喝水、摸摸、逗猫棒和追球互动",
  },
  {
    path: "docs/release/store-assets/04-settings.png",
    caption: "提醒节奏、通知、自启动和本地备份设置",
  },
];

export const STORE_LISTING = {
  shortDescription: "一只完全本地运行的 Windows 桌面小猫，陪你喝水、专注、休息和安排提醒。",
  description:
    "圆圆提醒是一款完全本地运行的 Windows 桌面宠物与提醒工具。小猫会留在桌面陪伴你，在合适的时间提醒喝水、处理待办、专注工作和离屏休息。\n\n你可以创建一次性、间隔、每日和每周提醒，完成、稍后或跳过事项；也可以查看今天的喝水进度与历史记录。专注期间圆圆保持安静，离屏休息可由你主动请求 Windows 锁屏。\n\n应用支持托盘、自启动、Windows 通知、本地 SQLite 数据库、每日自动备份和手动恢复。日常使用不需要账户、云服务、遥测、广告或远程 AI，提醒和记录保存在当前 Windows 用户的本地目录。",
  features: [
    "一次性、间隔、每日和每周提醒",
    "喝水、活动、专注与离屏休息",
    "会呼吸、睡觉和互动的桌面小猫",
    "托盘、Windows 通知和登录后自启动",
    "本地 SQLite 数据与最近 14 份自动备份",
    "无需账户、云服务、遥测、广告或远程 AI",
  ],
  searchTerms: ["桌面宠物", "提醒", "喝水", "专注", "休息", "离线"],
  copyright: "© 2026 Yuanyuan Reminder contributors。圆圆素材权利保留，详见素材许可。",
  appLicenseTerms:
    "程序代码采用 MIT License；圆圆照片、图集、图标和演示图片适用单独的圆圆素材许可，仅允许官方免费分发和个人非商业使用。",
};

export const RUN_FULL_TRUST_JUSTIFICATION =
  "Yuanyuan Reminder is a packaged classic Win32/Tauri desktop application that runs at medium integrity. runFullTrust is required to launch the classic executable and provide the system tray, local SQLite data and backups, startup registration, Windows notifications, and the user-initiated LockWorkStation break flow. The app does not request elevation, install a service or driver, bypass Windows authentication, or use this capability for remote access.";

const EXPECTED_URLS = {
  privacyPolicyUrl: "https://github.com/brucexia007-ui/yuanyuan-reminder/blob/main/PRIVACY.md",
  websiteUrl: "https://github.com/brucexia007-ui/yuanyuan-reminder",
  supportUrl: "https://github.com/brucexia007-ui/yuanyuan-reminder/issues",
};

const PRE_QUESTIONNAIRE_FACTS = {
  violence: false,
  sexualContent: false,
  gambling: false,
  controlledSubstances: false,
  sharedUserGeneratedContent: false,
  unrestrictedWebAccess: false,
  inAppPurchases: false,
};

export class StoreSubmissionInputsVerificationError extends Error {}

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) !== 0 ? 0xEDB88320 ^ (current >>> 1) : current >>> 1;
  }
  return current >>> 0;
});

function fail(message) {
  throw new StoreSubmissionInputsVerificationError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function pngCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(Object.keys(value).sort(), [...keys].sort())
  ) {
    fail(`${label} fields do not match the Store submission contract`);
  }
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !/^[A-F0-9]{64}$/u.test(value)) {
    fail(`${label} must be an uppercase SHA-256 digest`);
  }
}

function humanName(value, label) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 2 || value.length > 128) {
    fail(`${label} must identify a human`);
  }
  if (/\b(?:ai|bot|automation|codex|chatgpt)\b/iu.test(value)) {
    fail(`${label} must identify a human`);
  }
}

function validTimestamp(value, label, now) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < Date.parse("2026-08-10T00:00:00.000Z") ||
    parsed > now.getTime() + 5 * 60 * 1000
  ) {
    fail(`${label} must be a valid, non-future ISO timestamp`);
  }
}

export function inspectPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 45 ||
    bytes.length > 50 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(signature)
  ) {
    fail("Store screenshot must be a complete PNG no larger than 50 MB");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  const idatChunks = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("Store screenshot contains a truncated PNG chunk");
    const dataLength = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) fail("Store screenshot contains a truncated PNG chunk");
    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = pngCrc32(bytes.subarray(typeStart, dataEnd));
    if (expectedCrc !== actualCrc) fail(`Store screenshot PNG chunk ${type} failed CRC validation`);

    if (!sawIhdr && type !== "IHDR") fail("Store screenshot PNG must start with IHDR");
    if (type === "IHDR") {
      if (sawIhdr || offset !== 8 || dataLength !== 13) fail("Store screenshot has an invalid IHDR chunk");
      sawIhdr = true;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      bytesPerPixel = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
      if (
        width === 0 ||
        height === 0 ||
        width > 3840 ||
        height > 2160 ||
        bitDepth !== 8 ||
        bytesPerPixel === 0 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        fail("Store screenshot must be a non-interlaced 8-bit RGB/RGBA PNG no larger than 4K");
      }
    } else if (type === "IDAT") {
      if (!sawIhdr || sawIend) fail("Store screenshot has an out-of-order IDAT chunk");
      sawIdat = true;
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (!sawIdat || sawIend || dataLength !== 0) fail("Store screenshot has an invalid IEND chunk");
      sawIend = true;
      if (chunkEnd !== bytes.length) fail("Store screenshot contains data after IEND");
    }
    offset = chunkEnd;
  }
  if (!sawIhdr || !sawIdat || !sawIend) fail("Store screenshot PNG is missing IHDR, IDAT, or IEND");

  const expectedInflatedBytes = height * (1 + width * bytesPerPixel);
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedInflatedBytes });
  } catch {
    fail("Store screenshot PNG image data could not be decoded safely");
  }
  if (inflated.length !== expectedInflatedBytes) fail("Store screenshot PNG image data has the wrong length");
  const rowBytes = 1 + width * bytesPerPixel;
  for (let row = 0; row < height; row += 1) {
    if (inflated[row * rowBytes] > 4) fail("Store screenshot PNG contains an invalid row filter");
  }
  return { format: "png", width, height, byteLength: bytes.length, sha256: sha256(bytes) };
}

export function validateStoreSubmissionInputs(
  document,
  {
    expectedIdentitySha256,
    expectedBindings,
    screenshotArtifacts,
    publicUrlsReportCheckedAt,
    now = new Date(),
  } = {},
) {
  exactKeys(
    document,
    [
      "schemaVersion",
      "status",
      "product",
      "listing",
      "properties",
      "availability",
      "declarations",
      "ageRating",
      "sourceBindings",
      "outcome",
    ],
    "submission inputs",
  );
  if (document.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (document.status !== "human_confirmed_ready_for_partner_center_entry") {
    fail("status must be human_confirmed_ready_for_partner_center_entry");
  }

  exactKeys(
    document.product,
    ["identityFile", "identitySha256", "name", "version", "primaryLanguage", "category"],
    "product",
  );
  canonicalHash(document.product.identitySha256, "product.identitySha256");
  if (
    document.product.identityFile !== "docs/release/MSIX_STORE_IDENTITY_V1.json" ||
    document.product.identitySha256 !== expectedIdentitySha256 ||
    document.product.name !== "圆圆提醒" ||
    document.product.version !== "1.4.0.0" ||
    document.product.primaryLanguage !== "zh-CN" ||
    document.product.category !== "Productivity"
  ) {
    fail("product identity, language, version, or category drifted");
  }

  exactKeys(
    document.listing,
    [
      "shortDescription",
      "description",
      "whatsNew",
      "features",
      "searchTerms",
      "copyright",
      "appLicenseTerms",
      "screenshots",
    ],
    "listing",
  );
  if (
    document.listing.shortDescription !== STORE_LISTING.shortDescription ||
    document.listing.shortDescription.length > 270 ||
    document.listing.description !== STORE_LISTING.description ||
    document.listing.description.length > 10_000 ||
    document.listing.whatsNew !== null ||
    !exact(document.listing.features, STORE_LISTING.features) ||
    document.listing.features.length > 20 ||
    document.listing.features.some((item) => item.length > 200 || /^[-*•]/u.test(item)) ||
    !exact(document.listing.searchTerms, STORE_LISTING.searchTerms) ||
    document.listing.searchTerms.length > 7 ||
    document.listing.copyright !== STORE_LISTING.copyright ||
    document.listing.appLicenseTerms !== STORE_LISTING.appLicenseTerms
  ) {
    fail("Store listing copy drifted from the reviewed offline release facts");
  }

  if (!Array.isArray(document.listing.screenshots) || document.listing.screenshots.length !== 4) {
    fail("exactly four candidate-bound desktop screenshots are required");
  }
  for (let index = 0; index < STORE_SCREENSHOTS.length; index += 1) {
    const screenshot = document.listing.screenshots[index];
    const expected = STORE_SCREENSHOTS[index];
    exactKeys(
      screenshot,
      ["path", "sha256", "width", "height", "caption", "capturedFromCandidateSha256"],
      `listing.screenshots[${index}]`,
    );
    canonicalHash(screenshot.sha256, `listing.screenshots[${index}].sha256`);
    canonicalHash(
      screenshot.capturedFromCandidateSha256,
      `listing.screenshots[${index}].capturedFromCandidateSha256`,
    );
    const artifact = screenshotArtifacts?.[expected.path];
    if (
      screenshot.path !== expected.path ||
      screenshot.caption !== expected.caption ||
      screenshot.caption.length > 200 ||
      artifact?.format !== "png" ||
      artifact.width < 1366 ||
      artifact.height < 768 ||
      artifact.width <= artifact.height ||
      artifact.byteLength > 50 * 1024 * 1024 ||
      screenshot.width !== artifact.width ||
      screenshot.height !== artifact.height ||
      screenshot.sha256 !== artifact.sha256 ||
      screenshot.capturedFromCandidateSha256 !== expectedBindings?.unsignedStoreCandidateSha256
    ) {
      fail(`listing.screenshots[${index}] is missing, noncompliant, or not bound to the candidate`);
    }
  }

  exactKeys(
    document.properties,
    [
      "accessesPersonalInformation",
      "storesPersonalInformationLocally",
      "transmitsPersonalInformation",
      "privacyPolicyUrl",
      "websiteUrl",
      "supportUrl",
      "publicUrlsVerifiedBy",
      "publicUrlsVerifiedAt",
    ],
    "properties",
  );
  if (
    document.properties.accessesPersonalInformation !== true ||
    document.properties.storesPersonalInformationLocally !== true ||
    document.properties.transmitsPersonalInformation !== false ||
    document.properties.privacyPolicyUrl !== EXPECTED_URLS.privacyPolicyUrl ||
    document.properties.websiteUrl !== EXPECTED_URLS.websiteUrl ||
    document.properties.supportUrl !== EXPECTED_URLS.supportUrl
  ) {
    fail("privacy or support properties do not match the reviewed release behavior");
  }
  humanName(document.properties.publicUrlsVerifiedBy, "properties.publicUrlsVerifiedBy");
  validTimestamp(document.properties.publicUrlsVerifiedAt, "properties.publicUrlsVerifiedAt", now);
  validTimestamp(publicUrlsReportCheckedAt, "publicUrlsReportCheckedAt", now);
  if (Date.parse(document.properties.publicUrlsVerifiedAt) < Date.parse(publicUrlsReportCheckedAt)) {
    fail("properties.publicUrlsVerifiedAt must not predate the anonymous public URL evidence");
  }

  exactKeys(
    document.availability,
    ["basePrice", "freeTrial", "visibility", "marketSelection", "confirmedBy", "confirmedAt"],
    "availability",
  );
  exactKeys(document.availability.marketSelection, ["mode", "markets"], "availability.marketSelection");
  const marketMode = document.availability.marketSelection.mode;
  const markets = document.availability.marketSelection.markets;
  const validSelectedMarkets =
    marketMode === "selected_markets" &&
    Array.isArray(markets) &&
    markets.length > 0 &&
    markets.length === new Set(markets).size &&
    markets.every((market) => /^[A-Z]{2}$/u.test(market));
  if (
    document.availability.basePrice !== "free" ||
    document.availability.freeTrial !== "none" ||
    !["discoverable", "not_discoverable_direct_link_only"].includes(document.availability.visibility) ||
    !(
      (marketMode === "all_available_markets" && Array.isArray(markets) && markets.length === 0) ||
      validSelectedMarkets
    )
  ) {
    fail("availability must contain a human-confirmed free launch, visibility, and market selection");
  }
  humanName(document.availability.confirmedBy, "availability.confirmedBy");
  validTimestamp(document.availability.confirmedAt, "availability.confirmedAt", now);

  exactKeys(
    document.declarations,
    [
      "accountRequired",
      "appNetworkTransport",
      "telemetry",
      "advertising",
      "inAppPurchases",
      "sharedUserGeneratedContent",
      "generativeAi",
      "preciseLocation",
      "camera",
      "microphone",
      "healthRelatedRecordsStoredLocally",
      "localDeveloperToolDiscovery",
      "developerToolTaskContentRead",
      "restrictedCapabilities",
      "confirmedBy",
      "confirmedAt",
    ],
    "declarations",
  );
  const expectedDeclarations = {
    accountRequired: false,
    appNetworkTransport: false,
    telemetry: false,
    advertising: false,
    inAppPurchases: false,
    sharedUserGeneratedContent: false,
    generativeAi: false,
    preciseLocation: false,
    camera: false,
    microphone: false,
    healthRelatedRecordsStoredLocally: true,
    localDeveloperToolDiscovery: true,
    developerToolTaskContentRead: false,
  };
  if (
    Object.entries(expectedDeclarations).some(([key, value]) => document.declarations[key] !== value) ||
    !exact(document.declarations.restrictedCapabilities, [
      { name: "runFullTrust", justification: RUN_FULL_TRUST_JUSTIFICATION },
    ])
  ) {
    fail("product declarations or runFullTrust justification drifted from the packaged desktop app");
  }
  humanName(document.declarations.confirmedBy, "declarations.confirmedBy");
  validTimestamp(document.declarations.confirmedAt, "declarations.confirmedAt", now);

  exactKeys(
    document.ageRating,
    [
      "questionnaireStatus",
      "preQuestionnaireFacts",
      "contentFactsConfirmedBy",
      "contentFactsConfirmedAt",
      "ratingId",
    ],
    "ageRating",
  );
  if (
    document.ageRating.questionnaireStatus !== "pending_partner_center_completion" ||
    !exact(document.ageRating.preQuestionnaireFacts, PRE_QUESTIONNAIRE_FACTS) ||
    document.ageRating.ratingId !== null
  ) {
    fail("IARC must remain pending without a fabricated rating while source facts stay exact");
  }
  humanName(document.ageRating.contentFactsConfirmedBy, "ageRating.contentFactsConfirmedBy");
  validTimestamp(document.ageRating.contentFactsConfirmedAt, "ageRating.contentFactsConfirmedAt", now);

  exactKeys(
    document.sourceBindings,
    [
      "storeCandidateReportSha256",
      "unsignedStoreCandidateSha256",
      "privacyPolicySha256",
      "publicUrlsReportSha256",
      "publicUrlsVerifierSha256",
      "readmeSha256",
      "tauriConfigSha256",
      "storeManifestTemplateSha256",
      "assetLicenseSha256",
      "verifierSha256",
    ],
    "sourceBindings",
  );
  for (const [name, digest] of Object.entries(document.sourceBindings)) {
    canonicalHash(digest, `sourceBindings.${name}`);
  }
  if (!exact(document.sourceBindings, expectedBindings)) {
    fail("Store submission inputs are stale relative to the candidate, privacy policy, or source facts");
  }

  exactKeys(
    document.outcome,
    ["readyForPartnerCenterEntry", "partnerCenterSubmissionComplete", "approvedBy", "approvedAt"],
    "outcome",
  );
  if (
    document.outcome.readyForPartnerCenterEntry !== true ||
    document.outcome.partnerCenterSubmissionComplete !== false
  ) {
    fail("inputs may be ready for entry but cannot claim Partner Center submission completion");
  }
  humanName(document.outcome.approvedBy, "outcome.approvedBy");
  validTimestamp(document.outcome.approvedAt, "outcome.approvedAt", now);
  return document;
}

export function createStoreSubmissionInputsDraft(
  template,
  {
    expectedIdentitySha256,
    expectedBindings,
    screenshotArtifacts,
    publicUrlsReportCheckedAt,
    now = new Date(),
  } = {},
) {
  if (
    template?.status !== "pending" ||
    template?.product?.identitySha256 !== null ||
    template?.properties?.publicUrlsVerifiedBy !== null ||
    template?.properties?.publicUrlsVerifiedAt !== null ||
    template?.availability?.visibility !== null ||
    template?.availability?.marketSelection?.mode !== null ||
    !exact(template?.availability?.marketSelection?.markets, []) ||
    template?.availability?.confirmedBy !== null ||
    template?.availability?.confirmedAt !== null ||
    template?.declarations?.confirmedBy !== null ||
    template?.declarations?.confirmedAt !== null ||
    template?.ageRating?.contentFactsConfirmedBy !== null ||
    template?.ageRating?.contentFactsConfirmedAt !== null ||
    template?.ageRating?.ratingId !== null ||
    template?.outcome?.readyForPartnerCenterEntry !== false ||
    template?.outcome?.partnerCenterSubmissionComplete !== false ||
    template?.outcome?.approvedBy !== null ||
    template?.outcome?.approvedAt !== null ||
    !Object.values(template?.sourceBindings ?? {}).every((value) => value === null)
  ) {
    fail("Store submission template must remain an unapproved, machine-unbound template");
  }
  const draft = structuredClone(template);
  draft.product.identitySha256 = expectedIdentitySha256;
  for (let index = 0; index < STORE_SCREENSHOTS.length; index += 1) {
    const expected = STORE_SCREENSHOTS[index];
    const artifact = screenshotArtifacts?.[expected.path];
    if (!artifact) fail(`Store screenshot is missing before draft preparation: ${expected.path}`);
    const screenshot = draft.listing.screenshots[index];
    screenshot.sha256 = artifact.sha256;
    screenshot.width = artifact.width;
    screenshot.height = artifact.height;
    screenshot.capturedFromCandidateSha256 = expectedBindings?.unsignedStoreCandidateSha256;
  }
  draft.sourceBindings = structuredClone(expectedBindings);

  const proof = structuredClone(draft);
  const proofTime = now.toISOString();
  proof.status = "human_confirmed_ready_for_partner_center_entry";
  proof.properties.publicUrlsVerifiedBy = "Template Validation Maintainer";
  proof.properties.publicUrlsVerifiedAt = proofTime;
  proof.availability.visibility = "not_discoverable_direct_link_only";
  proof.availability.marketSelection.mode = "selected_markets";
  proof.availability.marketSelection.markets = ["CN"];
  proof.availability.confirmedBy = "Template Validation Maintainer";
  proof.availability.confirmedAt = proofTime;
  proof.declarations.confirmedBy = "Template Validation Maintainer";
  proof.declarations.confirmedAt = proofTime;
  proof.ageRating.contentFactsConfirmedBy = "Template Validation Maintainer";
  proof.ageRating.contentFactsConfirmedAt = proofTime;
  proof.outcome.readyForPartnerCenterEntry = true;
  proof.outcome.approvedBy = "Template Validation Maintainer";
  proof.outcome.approvedAt = proofTime;
  validateStoreSubmissionInputs(proof, {
    expectedIdentitySha256,
    expectedBindings,
    screenshotArtifacts,
    publicUrlsReportCheckedAt,
    now,
  });
  return draft;
}

function runCandidateVerifier() {
  const result = spawnSync(process.execPath, [candidateVerifierPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || "MSIX Store candidate verification failed");
  }
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function main() {
  readAndValidateStoreIdentity(defaultStoreIdentityPath);
  runCandidateVerifier();
  const publicUrlsEvidence = await readAndValidateStorePublicUrlsReport();
  const [inputsBytes, identityBytes, candidateReportBytes] = await Promise.all([
    readFile(submissionInputsPath),
    readFile(defaultStoreIdentityPath),
    readFile(candidateReportPath),
  ]);
  const document = JSON.parse(inputsBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const candidateReport = JSON.parse(candidateReportBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const candidatePath = path.resolve(projectRoot, candidateReport.candidate.path);
  const screenshotArtifacts = Object.fromEntries(
    await Promise.all(
      STORE_SCREENSHOTS.map(async (item) => {
        const absolutePath = path.resolve(projectRoot, item.path);
        const ownedRoot = path.resolve(projectRoot, "docs", "release", "store-assets");
        if (!absolutePath.startsWith(`${ownedRoot}${path.sep}`)) {
          fail(`Store screenshot escaped the owned asset directory: ${item.path}`);
        }
        return [item.path, inspectPng(await readFile(absolutePath))];
      }),
    ),
  );
  const expectedBindings = {
    storeCandidateReportSha256: sha256(candidateReportBytes),
    unsignedStoreCandidateSha256: await hashFile(candidatePath),
    privacyPolicySha256: await hashFile(path.join(projectRoot, "PRIVACY.md")),
    publicUrlsReportSha256: sha256(publicUrlsEvidence.reportBytes),
    publicUrlsVerifierSha256: sha256(publicUrlsEvidence.verifierBytes),
    readmeSha256: await hashFile(path.join(projectRoot, "README.md")),
    tauriConfigSha256: await hashFile(path.join(projectRoot, "src-tauri", "tauri.conf.json")),
    storeManifestTemplateSha256: await hashFile(
      path.join(projectRoot, "src-tauri", "msix", "AppxManifest.store.xml"),
    ),
    assetLicenseSha256: await hashFile(path.join(projectRoot, "ASSETS_LICENSE.md")),
    verifierSha256: await hashFile(verifierPath),
  };
  validateStoreSubmissionInputs(document, {
    expectedIdentitySha256: sha256(identityBytes),
    expectedBindings,
    screenshotArtifacts,
    publicUrlsReportCheckedAt: publicUrlsEvidence.report.checkedAt,
  });
  process.stdout.write(
    `MSIX Store submission inputs verified for ${expectedBindings.unsignedStoreCandidateSha256}; IARC and Partner Center completion remain pending.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`MSIX Store submission inputs pending: ${error.message}\n`);
    process.exitCode = 2;
  });
}
