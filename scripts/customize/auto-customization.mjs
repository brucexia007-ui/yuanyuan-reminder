import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildAgentHandoff,
  buildBrandDraft,
  buildCustomizationRequest,
  buildIdentityLockDraft,
  discoverPhotoInputs,
  hashPhotoInputs,
  parseAutoCustomizationArguments,
  SUPPORTED_AGENT_IDS,
} from "./auto-customization-core.mjs";
import { canonicalRepositoryUrl, projectRoot } from "./customization-state.mjs";

const execFileAsync = promisify(execFile);

const HELP = `只需三个输入即可开始宠物定制：

  npm.cmd --silent run customize:standalone -- --photos <照片目录或照片> --name <宠物名> --personality <性格>

可重复使用 --photos；目录只读取第一层的 PNG、JPEG 和 WebP，合计 1-16 张。
仓库内照片必须放在被 Git 忽略的 work/ 目录。--silent 避免 npm 回显照片路径；使用 --dry-run 仅校验输入，不创建任务。`;

async function git(argumentsList) {
  const result = await execFileAsync("git", argumentsList, { cwd: projectRoot, encoding: "utf8" });
  return result.stdout.trim();
}

async function main() {
  const options = parseAutoCustomizationArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const photoInputs = await discoverPhotoInputs(options.photoInputs, { projectRoot });
  const [version, origin] = await Promise.all([
    JSON.parse(await readFile(path.join(projectRoot, "product-version.json"), "utf8")),
    git(["remote", "get-url", "origin"]),
  ]);
  const request = buildCustomizationRequest({
    repository: canonicalRepositoryUrl(origin),
    ref: "HEAD",
    minimumVersion: version.version,
    displayName: options.displayName,
    personality: options.personality,
    photoInputs,
  });
  const photoHashes = await hashPhotoInputs(photoInputs);
  const brandDraft = buildBrandDraft(request.pet);

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      status: "validated",
      userInputs: {
        displayName: request.pet.displayName,
        personality: request.pet.personality,
        photoCount: request.pet.photoInputs.length,
      },
      inferred: {
        stylePreset: request.pet.stylePreset,
        sex: brandDraft.pet.sex,
        breed: brandDraft.pet.breed,
        applicationDisplayName: brandDraft.application.displayName,
        identifier: brandDraft.application.identifier,
      },
      compatibleAgents: SUPPORTED_AGENT_IDS,
      privatePhotoPathsPrinted: false,
    })}\n`);
    return;
  }

  const requestDirectory = path.join(projectRoot, "work", "customization", "requests");
  await mkdir(requestDirectory, { recursive: true });
  const requestName = `request-${Date.now()}-${brandDraft.application.packageName}.json`;
  const requestPath = path.join(requestDirectory, requestName);
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  const started = await execFileAsync(process.execPath, [
    path.join(projectRoot, "scripts", "customize", "start-customization.mjs"),
    "--request",
    requestPath,
  ], { cwd: projectRoot, encoding: "utf8" });
  const startResult = JSON.parse(started.stdout.trim());
  const runDirectory = path.join(projectRoot, "work", "customization", startResult.runId);
  const handoff = buildAgentHandoff({
    runId: startResult.runId,
    displayName: request.pet.displayName,
    personality: request.pet.personality,
    photoCount: request.pet.photoInputs.length,
  });
  const privateManifest = {
    schemaVersion: 1,
    profile: "yuanyuan-private-photo-manifest",
    photoCount: photoInputs.length,
    photos: photoInputs.map((photoPath, index) => ({ path: photoPath, sha256: photoHashes[index] })),
  };
  await Promise.all([
    writeFile(path.join(runDirectory, "brand-config.draft.json"), `${JSON.stringify(brandDraft, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(runDirectory, "identity-lock.draft.json"), `${JSON.stringify(buildIdentityLockDraft({ displayName: request.pet.displayName, photoHashes }), null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(runDirectory, "private-photo-manifest.json"), `${JSON.stringify(privateManifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    writeFile(path.join(runDirectory, "agent-handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
  ]);

  process.stdout.write(`${JSON.stringify({
    status: "prepared",
    runId: startResult.runId,
    nextStep: "brand",
    agentPrompt: handoff.agentPrompt,
    resumeCommand: handoff.resumeCommand,
    compatibleAgents: handoff.supportedAgents,
    userInputRequiredAfterStart: false,
    privatePhotoPathsPrinted: false,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
