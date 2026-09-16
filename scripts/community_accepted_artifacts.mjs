import { sha256 } from "./community_release_contract.mjs";

function fail(message) {
  throw new Error(`accepted release artifacts rejected: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} fields are not exact`);
  }
}

export function validateAcceptedArtifactManifest({ manifest, acceptance, authority, source, files }) {
  exactKeys(manifest, ["schemaVersion", "status", "product", "testedCommit", "artifacts"], "manifest");
  exactKeys(manifest.product, ["name", "identifier", "version"], "manifest.product");
  if (manifest.schemaVersion !== 1 || manifest.status !== "ACCEPTED_FOR_STABLE_RELEASE"
    || acceptance?.status !== "accepted" || authority?.channel !== "stable") {
    fail("the stable release or its human-reviewed acceptance is pending");
  }
  if (manifest.product.name !== authority.productName
    || manifest.product.identifier !== authority.identifier
    || manifest.product.version !== authority.version
    || manifest.testedCommit !== acceptance.candidate?.testedCommit) {
    fail("candidate identity, version, or frozen commit differs from acceptance");
  }
  exactKeys(source, ["schemaVersion", "donorCommit", "packageFileName", "packageSha256", "embeddedLicenseFileName", "embeddedLicenseSha256", "sourceLicenseFile"], "pet source");
  if (source.schemaVersion !== 1 || source.packageFileName !== "饺饺.yuanyuan-pet"
    || source.embeddedLicenseFileName !== "LICENSE.txt"
    || source.sourceLicenseFile !== "docs/pet-packs/JIAOJIAO_STANDALONE_ASSETS_LICENSE.md"
    || !/^[0-9a-f]{40}$/u.test(source.donorCommit)) {
    fail("pet package source identity is invalid");
  }
  const expected = [
    ["portable", `圆圆提醒_${authority.version}_windows-x64-portable.exe`],
    ["setup", `圆圆提醒_${authority.version}_x64-setup.exe`],
    ["jiaojiao-pet-pack", source.packageFileName],
  ];
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expected.length) {
    fail("exactly three accepted candidate artifacts are required");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const entry = manifest.artifacts[index];
    exactKeys(entry, ["id", "fileName", "bytes", "sha256"], `artifacts[${index}]`);
    const [id, fileName] = expected[index];
    const bytes = files[id];
    if (entry.id !== id || entry.fileName !== fileName
      || !Buffer.isBuffer(bytes) || bytes.length === 0 || entry.bytes !== bytes.length
      || entry.sha256 !== sha256(bytes)) {
      fail(`${id} name, size, or SHA-256 differs from the accepted original bytes`);
    }
  }
  if (manifest.artifacts[1].sha256 !== acceptance.candidate?.installerSha256) {
    fail("installer differs from the installed E2E acceptance");
  }
  if (manifest.artifacts[2].sha256 !== source.packageSha256) {
    fail("pet package differs from the frozen donor package");
  }
  if (!Buffer.isBuffer(files.sourceLicense)
    || sha256(files.sourceLicense) !== source.embeddedLicenseSha256) {
    fail("the original embedded pet license was changed");
  }
  return expected;
}

export function petPackSourceSummary(source) {
  return [
    "# 饺饺独立宠物包来源与许可",
    "",
    `来源提交：\`${source.donorCommit}\`。`,
    `宠物包原始 SHA-256：\`${source.packageSha256}\`。`,
    `包内 \`${source.embeddedLicenseFileName}\` 与随附原许可的 SHA-256：\`${source.embeddedLicenseSha256}\`。`,
    "",
    "圆圆仍是统一主程序的默认形象、图标和应用身份。饺饺素材只通过独立宠物包交付。",
    "原许可限制了素材用途；公开分发前须由权利人确认授权范围。原始照片及用户数据不随附。",
    "",
  ].join("\n");
}
