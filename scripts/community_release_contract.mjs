import { createHash } from "node:crypto";

export const COMMUNITY_RELEASE_SCHEMA_VERSION = 2;

export class CommunityReleaseContractError extends Error {}

function fail(message) {
  throw new CommunityReleaseContractError(message);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    fail(`${label} fields do not match the community release contract`);
  }
}

function exactStringArray(value, expected, label) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} does not match the frozen community release policy`);
  }
}

export function sha256(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("SHA-256 input must be bytes");
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function communityProductFromBrand(brand) {
  if (
    brand?.schemaVersion !== 1 ||
    typeof brand.application?.displayName !== "string" ||
    brand.application.displayName.trim().length === 0 ||
    typeof brand.application?.identifier !== "string" ||
    brand.application.identifier.trim().length === 0 ||
    typeof brand.artifacts?.installerBaseName !== "string" ||
    brand.artifacts.installerBaseName.trim().length === 0 ||
    typeof brand.artifacts?.portableBaseName !== "string" ||
    brand.artifacts.portableBaseName.trim().length === 0 ||
    brand.artifacts.installerBaseName !== brand.application.displayName ||
    [brand.artifacts.installerBaseName, brand.artifacts.portableBaseName]
      .some((value) => /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value))
  ) {
    fail("community release product brand is invalid");
  }
  return {
    name: brand.application.displayName,
    identifier: brand.application.identifier,
    installerBaseName: brand.artifacts.installerBaseName,
    portableBaseName: brand.artifacts.portableBaseName,
  };
}

function validateExpectedProduct(product) {
  exactKeys(
    product,
    ["name", "identifier", "installerBaseName", "portableBaseName"],
    "expectedProduct",
  );
  if (
    [product.name, product.identifier, product.installerBaseName, product.portableBaseName]
      .some((value) => typeof value !== "string" || value.trim().length === 0)
  ) {
    fail("expected community release product is invalid");
  }
}

export function validateCommunityStablePolicy(policy, expectedProduct) {
  validateExpectedProduct(expectedProduct);
  exactKeys(
    policy,
    [
      "schemaVersion",
      "channel",
      "audience",
      "product",
      "artifactPolicy",
      "acceptanceContract",
      "blockingCommands",
      "blockingQualityGates",
      "permittedWaivers",
      "advisoryOnly",
      "requiredWarnings",
    ],
    "policy",
  );
  if (
    policy.schemaVersion !== COMMUNITY_RELEASE_SCHEMA_VERSION ||
    policy.channel !== "github_releases" ||
    policy.audience !== "open_source_community"
  ) {
    fail("community release identity is invalid");
  }
  exactKeys(policy.product, ["name", "identifier"], "policy.product");
  if (
    policy.product.name !== expectedProduct.name ||
    policy.product.identifier !== expectedProduct.identifier
  ) {
    fail("community release product identity is invalid");
  }
  exactKeys(
    policy.artifactPolicy,
    [
      "installerFormat",
      "portableFormat",
      "codeSigningRequired",
      "unsignedDisclosureRequired",
      "sha256Required",
      "sourceTagRequired",
    ],
    "policy.artifactPolicy",
  );
  if (
    policy.artifactPolicy.installerFormat !== "nsis-exe" ||
    policy.artifactPolicy.portableFormat !== "windows-pe" ||
    policy.artifactPolicy.codeSigningRequired !== false ||
    policy.artifactPolicy.unsignedDisclosureRequired !== true ||
    policy.artifactPolicy.sha256Required !== true ||
    policy.artifactPolicy.sourceTagRequired !== true
  ) {
    fail("community artifact policy must allow disclosed unsigned GitHub binaries");
  }
  exactKeys(
    policy.acceptanceContract,
    ["file", "template", "codeSigningEvidenceRequired"],
    "policy.acceptanceContract",
  );
  if (
    policy.acceptanceContract.file !==
      "docs/release/COMMUNITY_STABLE_ACCEPTANCE_V2.json" ||
    policy.acceptanceContract.template !==
      "docs/release/COMMUNITY_STABLE_ACCEPTANCE_V2.template.json" ||
    policy.acceptanceContract.codeSigningEvidenceRequired !== false
  ) {
    fail("community acceptance contract must stay focused on product stability");
  }
  exactStringArray(
    policy.blockingCommands,
    [
      "npm.cmd run release:community:authority",
      "npm.cmd run release:community:acceptance",
      "npm.cmd run product:version:check",
      "npm.cmd run verify",
      "cargo test --manifest-path src-tauri/Cargo.toml --locked",
      "npm.cmd run tauri build",
      "npm.cmd run release:community:artifact-binding",
    ],
    "policy.blockingCommands",
  );
  exactStringArray(
    policy.blockingQualityGates,
    [
      "clean-main-tag",
      "version-tag-match",
      "current-candidate-24-hour-endurance-with-exact-two-event-waivers",
      "current-installer-critical-e2e",
      "official-v132-synthetic-and-real-v1527-upgrade-backup-rollback",
      "integrated-learning-real-runtime",
      "system-stability-regressions",
      "critical-e2e",
      "database-migration-and-backup",
      "offline-boundary",
      "license-archive",
      "artifact-hashes",
    ],
    "policy.blockingQualityGates",
  );
  exactStringArray(policy.permittedWaivers, [
    "power_suspend_resume_pair_missing",
    "session_lock_unlock_pair_missing",
    "real_1_3_2_user_history_unavailable",
  ], "policy.permittedWaivers");
  exactStringArray(
    policy.advisoryOnly,
    [
      "commercial-code-signing-certificate",
      "rfc3161-timestamp",
      "smartscreen-reputation",
      "third-party-antivirus-matrix",
      "microsoft-store-certification",
      "named-commercial-release-attestations",
    ],
    "policy.advisoryOnly",
  );
  exactStringArray(
    policy.requiredWarnings,
    [
      "Windows may show an unknown-publisher or SmartScreen warning for this community release.",
      "Smart App Control or organization policy may block unsigned executables.",
      "Download only from the official GitHub Release and verify SHA256SUMS.txt, or build from the matching source tag.",
      "Sleep/resume and lock/unlock were not observed during the 24-hour run and are explicitly waived.",
      "Real 1.3.2 user history was unavailable and remains unverified; official 1.3.2 synthetic data and real 1.5.27 upgrade/rollback are substitute coverage.",
      "Database rollback requires restoring the matching pre-upgrade complete application data directory.",
    ],
    "policy.requiredWarnings",
  );
  return policy;
}

function validateCommit(commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) {
    fail("source commit must be a canonical lowercase Git commit ID");
  }
}

export function validateCommunityStableAuthority(authority, expectedProduct) {
  validateExpectedProduct(expectedProduct);
  if (
    authority?.schemaVersion !== 1 ||
    authority.productName !== expectedProduct.name ||
    authority.identifier !== expectedProduct.identifier ||
    typeof authority.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(authority.version) ||
    authority.releaseTrain !== "unified-product" ||
    authority.channel !== "stable"
  ) {
    fail("community stable assets require a stable unified product manifest");
  }
  return authority;
}

export function buildCommunityReleaseBundle({
  policy,
  authority,
  expectedProduct,
  tag,
  sourceCommit,
  policyBytes,
  portableBytes,
  installerBytes,
  petPackBytes,
  sourceLicenseBytes,
  supplementalPermissionBytes,
  sourceInfoBytes,
}) {
  validateCommunityStablePolicy(policy, expectedProduct);
  validateCommunityStableAuthority(authority, expectedProduct);
  validateCommit(sourceCommit);
  if (tag !== `v${authority.version}`) {
    fail("release tag must exactly match the stable product version");
  }
  if (
    !Buffer.isBuffer(policyBytes) ||
    !Buffer.isBuffer(portableBytes) ||
    !Buffer.isBuffer(installerBytes) ||
    !Buffer.isBuffer(petPackBytes) ||
    !Buffer.isBuffer(sourceLicenseBytes) ||
    !Buffer.isBuffer(supplementalPermissionBytes) ||
    !Buffer.isBuffer(sourceInfoBytes) ||
    portableBytes.length === 0 ||
    installerBytes.length === 0 ||
    petPackBytes.length === 0 ||
    sourceLicenseBytes.length === 0 ||
    supplementalPermissionBytes.length === 0 ||
    sourceInfoBytes.length === 0
  ) {
    fail("community release inputs must be non-empty bytes");
  }

  const artifacts = [
    {
      id: "portable",
      fileName: `${expectedProduct.portableBaseName}_${authority.version}_windows-x64-portable.exe`,
      bytes: portableBytes.length,
      sha256: sha256(portableBytes),
    },
    {
      id: "setup",
      fileName: `${expectedProduct.installerBaseName}_${authority.version}_x64-setup.exe`,
      bytes: installerBytes.length,
      sha256: sha256(installerBytes),
    },
    {
      id: "jiaojiao-pet-pack",
      fileName: "饺饺.yuanyuan-pet",
      bytes: petPackBytes.length,
      sha256: sha256(petPackBytes),
    },
    {
      id: "jiaojiao-source-license",
      fileName: "JIAOJIAO_STANDALONE_ASSETS_LICENSE.md",
      bytes: sourceLicenseBytes.length,
      sha256: sha256(sourceLicenseBytes),
    },
    {
      id: "jiaojiao-release-permission",
      fileName: "JIAOJIAO_RELEASE_PERMISSION_SUPPLEMENT.md",
      bytes: supplementalPermissionBytes.length,
      sha256: sha256(supplementalPermissionBytes),
    },
    {
      id: "pet-pack-source",
      fileName: "PET_PACK_SOURCE.md",
      bytes: sourceInfoBytes.length,
      sha256: sha256(sourceInfoBytes),
    },
  ];
  const checksums = `${artifacts
    .map((artifact) => `${artifact.sha256.toLowerCase()}  ${artifact.fileName}`)
    .join("\n")}\n`;
  const notes = [
    `# ${authority.productName} ${tag}`,
    "",
    "这是面向开源社区、可自行下载和从源码构建的 Windows 稳定版本。稳定表示本项目的自动回归、Rust 后端、数据迁移/备份、关键 E2E 与正式构建门已经通过；商业代码签名不是此社区渠道的阻断条件。",
    "",
    "## Windows 下载提示",
    "",
    "- 当前社区发布不要求商业代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。",
    "- Smart App Control 或组织安全策略可能阻止未签名程序运行；这种环境请从对应标签自行构建，或等待未来签名/商店渠道。",
    "- 只从本项目的官方 GitHub Release 下载，并核对 `SHA256SUMS.txt`；也可以从完全对应的源码标签自行构建。",
    "- 饺饺作为独立宠物包安装，圆圆仍是主程序的默认形象。来源与许可见随附文件。",
    "- 饺饺原许可限定素材用途；本次仅依随附的权利人补充许可免费分发原字节宠物包，不授予图片再利用权。",
    "- 数据库升级后如需回退，须同时恢复升级前的完整应用数据目录，不能只降级程序。",
    "- 24 小时运行观察未覆盖系统睡眠恢复和锁屏解锁，这两项获得明确豁免，并未被记录为已通过。",
    "- 真实 1.3.2 用户历史数据未取得、未验证；官方 1.3.2 程序生成的合成数据和真实 1.5.27 升级回退仅提供替代覆盖。",
    "",
    "## 文件校验",
    "",
    "```text",
    checksums.trimEnd(),
    "```",
    "",
    `源码提交：\`${sourceCommit}\``,
    "",
  ].join("\n");
  const manifest = {
    schemaVersion: COMMUNITY_RELEASE_SCHEMA_VERSION,
    channel: policy.channel,
    audience: policy.audience,
    product: {
      name: authority.productName,
      identifier: authority.identifier,
      version: authority.version,
      tag,
    },
    source: { commit: sourceCommit },
    codeSigning: {
      required: false,
      releaseGate: "advisory-only",
      userDisclosureIncluded: true,
    },
    policySha256: sha256(policyBytes),
    artifacts,
  };
  return { artifacts, checksums, notes, manifest };
}
