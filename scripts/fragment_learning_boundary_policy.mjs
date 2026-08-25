export const FORBIDDEN_PATH_RULES = Object.freeze([
  {
    id: "personal-resource-directory",
    kind: "prefix",
    value: "src-tauri/resources/personal-learning/",
  },
  {
    id: "personal-source-directory",
    kind: "prefix",
    value: "work/personal-sources/",
  },
  {
    id: "personal-tauri-config",
    kind: "exact",
    value: "src-tauri/tauri.learning-personal.conf.json",
  },
  {
    id: "personal-pack-preparer",
    kind: "exact",
    value: "scripts/prepare_personal_kajweb_pack.mjs",
  },
  {
    id: "personal-pack-loader",
    kind: "exact",
    value: "src-tauri/src/learning/personal_pack.rs",
  },
]);

export const FORBIDDEN_SOURCE_MARKERS = Object.freeze([
  "personal-kajweb",
  "learning-personal",
  "resources/personal-learning",
  "prepare_personal_kajweb_pack",
]);

const PRIVATE_ARCHIVE_PATTERN = /(?:kajweb|kaoyan)[^/]*\.(?:7z|gz|rar|tar|tgz|zip)$/iu;
const USER_DATABASE_PATTERN = /(?:^|\/)(?:yuanyuan-learning|yuanyuan-reminder)\.sqlite3(?:-(?:shm|wal))?$/iu;
const USER_ABSOLUTE_PATH_PATTERN = /[a-z]:[\\/]users[\\/]([^\\/\s]+)/giu;
const SYNTHETIC_USER_NAMES = new Set(["example", "fixture", "test", "user"]);
const ARTIFACT_PERSONAL_PATH_PATTERN =
  /(?:personal[-_]?learning|learning[-_]?personal|personal[-_]?kajweb|kajweb|kaoyan)/iu;

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
]);

export function normalizeRepositoryPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function findForbiddenPaths(paths) {
  const findings = [];
  for (const originalPath of paths) {
    const path = normalizeRepositoryPath(originalPath);
    const lowerPath = path.toLowerCase();
    for (const rule of FORBIDDEN_PATH_RULES) {
      const ruleValue = rule.value.toLowerCase();
      const matched =
        rule.kind === "exact" ? lowerPath === ruleValue : lowerPath.startsWith(ruleValue);
      if (matched) {
        findings.push({ path, rule: rule.id });
      }
    }
    if (PRIVATE_ARCHIVE_PATTERN.test(path)) {
      findings.push({ path, rule: "private-upstream-archive" });
    }
    if (USER_DATABASE_PATTERN.test(path)) {
      findings.push({ path, rule: "user-runtime-database" });
    }
  }
  return findings;
}

export function findForbiddenTextMarkers(text) {
  const lowerText = String(text).toLowerCase();
  const findings = FORBIDDEN_SOURCE_MARKERS.filter((marker) =>
    lowerText.includes(marker.toLowerCase()),
  );
  for (const match of String(text).matchAll(USER_ABSOLUTE_PATH_PATTERN)) {
    if (!SYNTHETIC_USER_NAMES.has(match[1].toLowerCase())) {
      findings.push("user-absolute-data-path");
      break;
    }
  }
  return findings;
}

const LEGACY_MIGRATION_IDENTIFIER_PATHS = new Set([
  "product-version.json",
  "scripts/sync_unified_product_version.mjs",
  "scripts/sync_unified_product_version.node-test.mjs",
  "scripts/verify_unified_product_boundary.mjs",
  "scripts/verify_unified_product_boundary.node-test.mjs",
]);

export function findForbiddenSourceMarkers(path, text) {
  const normalized = normalizeRepositoryPath(path);
  const auditedText = LEGACY_MIGRATION_IDENTIFIER_PATHS.has(normalized)
    ? String(text).replaceAll("com.yuanyuan.reminder.learning-personal", "")
    : text;
  return findForbiddenTextMarkers(auditedText);
}

export function isTextFile(path) {
  const normalized = normalizeRepositoryPath(path).toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(normalized.slice(dot));
}

export function isAuditedSourcePath(path) {
  const normalized = normalizeRepositoryPath(path);
  if (
    normalized.startsWith("docs/") ||
    normalized === "scripts/fragment_learning_boundary_policy.mjs" ||
    normalized === "scripts/verify_fragment_learning_boundary.mjs" ||
    normalized === "scripts/verify_fragment_learning_boundary.node-test.mjs"
  ) {
    return false;
  }
  return (
    normalized === "package.json" ||
    normalized === "vite.config.ts" ||
    normalized.startsWith("public/") ||
    normalized.startsWith("scripts/") ||
    normalized.startsWith("src/") ||
    normalized.startsWith("src-tauri/")
  );
}

export function findForbiddenArtifactPaths(paths) {
  return paths
    .map(normalizeRepositoryPath)
    .filter((path) => ARTIFACT_PERSONAL_PATH_PATTERN.test(path))
    .map((path) => ({ path, rule: "personal-artifact-name" }));
}
