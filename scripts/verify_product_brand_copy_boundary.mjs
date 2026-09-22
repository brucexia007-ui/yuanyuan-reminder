import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { verifyUnifiedPetIdentity } from "./verify_unified_pet_identity.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

const authority = JSON.parse(await readFile(path.join(projectRoot, "product-version.json"), "utf8"));
if (authority.brandConfig === undefined) {
  await verifyUnifiedPetIdentity(projectRoot);
  process.stdout.write("Unified pet naming and application identity boundary verified.\n");
  process.exit(0);
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) return [];
    return [path.relative(projectRoot, filePath).replaceAll("\\", "/")];
  }));
  return files.flat();
}

const productionFiles = (await sourceFiles(path.join(projectRoot, "src")))
  .filter((relativePath) => relativePath !== "src/brand.ts")
  .sort();

const failures = [];
for (const relativePath of productionFiles) {
  const source = await readFile(path.join(projectRoot, relativePath), "utf8");
  source.split(/\r?\n/u).forEach((line, index) => {
    if (!line.includes("圆圆")) return;
    if (line.includes("petText(") || line.includes("petDisplayName")) return;
    failures.push(`${relativePath}:${index + 1}`);
  });
}

const main = await readFile(path.join(projectRoot, "src/main.tsx"), "utf8");
const brand = await readFile(path.join(projectRoot, "src/brand.ts"), "utf8");
if (/MutationObserver|createTreeWalker|installLegacyBrandCopyAdapter/u.test(main + brand)) {
  failures.push("global DOM brand rewriting is forbidden because it mutates user content");
}

const agentPromptPath = "customization/learning/LEARNING_IMPORT_PROMPT.zh-CN.md";
const agentPrompt = await readFile(path.join(projectRoot, agentPromptPath), "utf8");
if (agentPrompt.includes("圆圆")) {
  failures.push(`${agentPromptPath}: reusable agent prompt must not freeze the legacy brand`);
}
if (!agentPrompt.includes("learning-pack v1")) {
  failures.push(`${agentPromptPath}: reusable agent prompt must identify the supported protocol`);
}
for (const relativePath of [
  "docs/release/MSIX_STORE_SUBMISSION_INPUTS_V1.template.json",
  "index.html",
  "src-tauri/capabilities/default.json",
  "src-tauri/msix/AppxManifest.preview.xml",
  "src-tauri/msix/AppxManifest.store.xml",
]) {
  const source = await readFile(path.join(projectRoot, relativePath), "utf8");
  if (source.includes("圆圆")) {
    failures.push(`${relativePath}: current release surface still contains the legacy pet name`);
  }
}
if (failures.length > 0) {
  throw new Error(`product-owned brand copy is not explicit: ${failures.join(", ")}`);
}
process.stdout.write(`Product brand copy boundary verified across all ${productionFiles.length} non-test TypeScript modules; user content has no DOM rewrite path.\n`);
