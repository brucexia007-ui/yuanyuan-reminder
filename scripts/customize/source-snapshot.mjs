import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function sourceSnapshot(projectRoot, baselineCommit) {
  const canonicalRoot = await realpath(projectRoot);
  const { stdout: current } = await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd: projectRoot, encoding: "utf8" });
  if (current.trim() !== baselineCommit) throw new Error("CUSTOMIZATION_SOURCE_DRIFT: HEAD changed after the run started");
  const [{ stdout: diff }, { stdout: untrackedOutput }] = await Promise.all([
    execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], { cwd: projectRoot, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: projectRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }),
  ]);
  const untracked = untrackedOutput.toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  digest.update("yuanyuan-customization-source-v1\0", "utf8");
  digest.update(baselineCommit, "utf8");
  digest.update("\0diff\0", "utf8");
  digest.update(diff);
  const untrackedFiles = [];
  for (const relativePath of untracked) {
    const filePath = path.resolve(canonicalRoot, relativePath);
    const relative = path.relative(canonicalRoot, filePath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("CUSTOMIZATION_SOURCE_INVALID: untracked path escaped the project root");
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("CUSTOMIZATION_SOURCE_INVALID: untracked source must be an ordinary file");
    const canonicalFile = await realpath(filePath);
    const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
    if (!canonicalRelative || canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
      throw new Error("CUSTOMIZATION_SOURCE_INVALID: untracked source resolved outside the project root");
    }
    const bytes = await readFile(canonicalFile);
    digest.update("\0file\0", "utf8");
    digest.update(relativePath.replaceAll("\\", "/"), "utf8");
    digest.update("\0", "utf8");
    digest.update(bytes);
    untrackedFiles.push({ path: relativePath.replaceAll("\\", "/"), bytes: bytes.length });
  }
  return {
    sha256: digest.digest("hex"),
    diffBytes: diff.length,
    untrackedFiles,
  };
}
