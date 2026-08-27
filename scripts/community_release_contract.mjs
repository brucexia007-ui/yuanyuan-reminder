import { createHash } from "node:crypto";

export const COMMUNITY_RELEASE_SCHEMA_VERSION = 1;

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

export function validateCommunityStablePolicy(policy) {
  exactKeys(
    policy,
    [
      "schemaVersion",
      "channel",
      "audience",
      "product",
      "artifactPolicy",
      "blockingCommands",
      "blockingQualityGates",
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
    policy.product.name !== "圆圆提醒" ||
    policy.product.identifier !== "com.yuanyuan.reminder"
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
  exactStringArray(
    policy.blockingCommands,
    [
      "npm.cmd run release:community:authority",
      "npm.cmd run product:version:check",
      "npm.cmd run verify",
      "cargo test --manifest-path src-tauri/Cargo.toml --locked",
      "npm.cmd run tauri build",
    ],
    "policy.blockingCommands",
  );
  exactStringArray(
    policy.blockingQualityGates,
    [
      "clean-main-tag",
      "version-tag-match",
      "system-stability-regressions",
      "critical-e2e",
      "database-migration-and-backup",
      "offline-boundary",
      "license-archive",
      "artifact-hashes",
    ],
    "policy.blockingQualityGates",
  );
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

export function validateCommunityStableAuthority(authority) {
  if (
    authority?.schemaVersion !== 1 ||
    authority.productName !== "圆圆提醒" ||
    authority.identifier !== "com.yuanyuan.reminder" ||
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
  tag,
  sourceCommit,
  policyBytes,
  portableBytes,
  installerBytes,
}) {
  validateCommunityStablePolicy(policy);
  validateCommunityStableAuthority(authority);
  validateCommit(sourceCommit);
  if (tag !== `v${authority.version}`) {
    fail("release tag must exactly match the stable product version");
  }
  if (
    !Buffer.isBuffer(policyBytes) ||
    !Buffer.isBuffer(portableBytes) ||
    !Buffer.isBuffer(installerBytes) ||
    portableBytes.length === 0 ||
    installerBytes.length === 0
  ) {
    fail("community release inputs must be non-empty bytes");
  }

  const artifacts = [
    {
      id: "portable",
      fileName: `Yuanyuan-Reminder-${authority.version}-x64-Portable.exe`,
      bytes: portableBytes.length,
      sha256: sha256(portableBytes),
    },
    {
      id: "setup",
      fileName: `Yuanyuan-Reminder-${authority.version}-x64-Setup.exe`,
      bytes: installerBytes.length,
      sha256: sha256(installerBytes),
    },
  ];
  const checksums = `${artifacts
    .map((artifact) => `${artifact.sha256.toLowerCase()}  ${artifact.fileName}`)
    .join("\n")}\n`;
  const notes = [
    `# 圆圆提醒 ${tag}`,
    "",
    "这是面向开源社区、可自行下载和从源码构建的 Windows 稳定版本。稳定表示本项目的自动回归、Rust 后端、数据迁移/备份、关键 E2E 与正式构建门已经通过；商业代码签名不是此社区渠道的阻断条件。",
    "",
    "## Windows 下载提示",
    "",
    "- 当前社区发布不要求商业代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。",
    "- Smart App Control 或组织安全策略可能阻止未签名程序运行；这种环境请从对应标签自行构建，或等待未来签名/商店渠道。",
    "- 只从本项目的官方 GitHub Release 下载，并核对 `SHA256SUMS.txt`；也可以从完全对应的源码标签自行构建。",
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
