import path from "node:path";
import { loadAndValidateLearningPack } from "./learning-pack-validation.mjs";

const input = process.argv[2];
if (!input) {
  process.stderr.write("usage: node validate-learning-pack.mjs <pack.json>\n");
  process.exitCode = 1;
} else {
  const filePath = path.resolve(input);
  loadAndValidateLearningPack(filePath).then(({ pack, bytes, result }) => {
    const output = {
      schemaVersion: 1,
      valid: result.valid,
      file: path.basename(filePath),
      byteCount: bytes.length,
      packId: pack?.packId ?? null,
      version: pack?.version ?? null,
      cardCount: Array.isArray(pack?.cards) ? pack.cards.length : 0,
      contentSha256: result.computedContentSha256,
      problems: result.problems
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
