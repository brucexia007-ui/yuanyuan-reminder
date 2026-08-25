import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const assetsRoot = path.join(projectRoot, "dist", "assets");
const assets = await readdir(assetsRoot, { withFileTypes: true });
const javascript = await Promise.all(
  assets
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => readFile(path.join(assetsRoot, entry.name), "utf8")),
);
const bundle = javascript.join("\n");
for (const marker of [
  "get_learning_home",
  "preview_learning_import",
  "export_learning_data",
  "delete_learning_data",
]) {
  if (!bundle.includes(marker)) {
    throw new Error(`learning-enabled bundle is missing ${marker}`);
  }
}
if (javascript.length < 2) {
  throw new Error("learning-enabled UI must remain a separately loaded chunk");
}
console.log(
  `Learning-enabled bundle OK: ${javascript.length} JavaScript chunks contain the gated learning UI and data commands.`,
);
