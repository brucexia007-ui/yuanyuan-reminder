import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAgentHandoff,
  buildBrandDraft,
  buildCustomizationRequest,
  discoverPhotoInputs,
  parseAutoCustomizationArguments,
  SUPPORTED_AGENT_IDS,
} from "./auto-customization-core.mjs";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("public customization starts with one paste-ready prompt and no user-run command", async () => {
  const [prompt, readme, tutorial, customizationReadme, agentContract] = await Promise.all([
    readFile(path.join(projectRoot, "AI_CUSTOMIZATION_PROMPT.md"), "utf8"),
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "docs", "CUSTOMIZE_YOUR_PET.md"), "utf8"),
    readFile(path.join(projectRoot, "customization", "README.md"), "utf8"),
    readFile(path.join(projectRoot, "customization", "PET_CUSTOMIZATION_AGENT_PROMPT.zh-CN.md"), "utf8"),
  ]);

  assert.match(prompt, /Kimi Code/u);
  assert.match(prompt, /WorkBuddy/u);
  assert.match(prompt, /宠物名：<填写宠物名>/u);
  assert.match(prompt, /宠物性格：<填写宠物性格>/u);
  assert.match(prompt, /不要让我运行命令/u);
  assert.match(prompt, /随本消息附上的全部照片/u);
  assert.match(prompt, /https:\/\/github\.com\/brucexia007-ui\/yuanyuan-reminder/u);
  assert.match(prompt, /没有预先下载这个项目/u);
  assert.match(prompt, /不要让我下载项目/u);
  assert.doesNotMatch(prompt, /当前打开的 yuanyuan-reminder/u);
  assert.doesNotMatch(prompt, /npm\.cmd/u);
  assert.doesNotMatch(prompt, /应用名称：<|Windows identifier：</u);

  assert.match(readme, /一段提示词制作自己的桌面宠物/u);
  assert.match(readme, /即使电脑上没有本项目/u);
  assert.doesNotMatch(readme, /在 Codex、Kimi Code 或 WorkBuddy 中运行 `npm\.cmd/u);
  assert.match(tutorial, /这就是普通用户需要完成的全部操作/u);
  assert.match(tutorial, /github\.com\/brucexia007-ui\/yuanyuan-reminder/u);
  assert.doesNotMatch(tutorial, /npm\.cmd --silent run customize:auto/u);
  assert.match(customizationReadme, /智能体内部入口（普通用户不要运行）/u);
  assert.match(agentContract, /零源码引导/u);
  assert.match(agentContract, /获取默认分支的最新完整 Git 工作副本/u);
  assert.match(agentContract, /用户绝不能被要求执行它/u);
  assert.match(agentContract, /npm\.cmd --silent run customize:auto/u);
  assert.match(agentContract, /resumeCommand/u);
});

test("three user inputs produce one valid agent-neutral request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-three-input-"));
  try {
    const photos = path.join(root, "photos");
    await mkdir(photos);
    await Promise.all(["front.png", "left.png", "right.png"].map((name) => writeFile(path.join(photos, name), PNG)));
    const argumentsResult = parseAutoCustomizationArguments([
      "--photos", photos,
      "--name", "糖糖",
      "--personality", "安静但好奇",
    ]);
    const discovered = await discoverPhotoInputs(argumentsResult.photoInputs);
    const requests = SUPPORTED_AGENT_IDS.map(() => buildCustomizationRequest({
      repository: "https://example.com/owner/project",
      minimumVersion: "1.5.10",
      displayName: argumentsResult.displayName,
      personality: argumentsResult.personality,
      photoInputs: discovered,
    }));
    assert.equal(discovered.length, 3);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(requests[1], requests[2]);
    assert.deepEqual(Object.keys(requests[0].pet).sort(), ["customize", "displayName", "personality", "photoInputs", "stylePreset"]);
    assert.equal(requests[0].pet.stylePreset, "auto");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brand identity is inferred safely without asking for an identifier", () => {
  const first = buildBrandDraft({ displayName: "饺饺", personality: "乖巧高冷" });
  const second = buildBrandDraft({ displayName: "饺饺", personality: "乖巧高冷" });
  assert.deepEqual(first, second);
  assert.match(first.application.identifier, /^com\.yuanyuan\.custom\.pet-[a-f0-9]{12}$/u);
  assert.match(first.application.packageName, /^pet-[a-f0-9]{12}-reminder$/u);
  assert.equal(first.application.displayName, "饺饺提醒");
  assert.equal(first.pet.sex, "unknown");
  assert.equal(first.pet.breed, "由参考照片识别");
});

test("handoff advertises the same completion contract to Codex, Kimi, and WorkBuddy", () => {
  const handoff = buildAgentHandoff({ runId: "20260828T123456789Z-abcdef12", displayName: "糖糖", personality: "安静", photoCount: 3 });
  assert.deepEqual(handoff.supportedAgents, ["codex", "kimi", "workbuddy"]);
  assert.equal(handoff.completionContract.manualJsonEditingRequiredFromUser, false);
  assert.equal(handoff.completionContract.standardAtlas, "8x11-v2");
  assert.equal(handoff.completionContract.lifeRows, 21);
  assert.equal(JSON.stringify(handoff).includes("front.png"), false);
});

test("photo discovery rejects disguised files and repository-visible private photos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yuanyuan-photo-boundary-"));
  try {
    const visible = path.join(root, "visible");
    const privateDirectory = path.join(root, "work", "photos");
    await mkdir(visible, { recursive: true });
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(path.join(visible, "pet.png"), PNG);
    await writeFile(path.join(privateDirectory, "pet.png"), PNG);
    await writeFile(path.join(privateDirectory, "fake.png"), Buffer.from("not a png"));
    await assert.rejects(discoverPhotoInputs([visible], { projectRoot: root }), /CUSTOMIZATION_PHOTO_PRIVATE/u);
    await assert.rejects(discoverPhotoInputs([path.join(privateDirectory, "fake.png")], { projectRoot: root }), /file content/u);
    assert.equal((await discoverPhotoInputs([path.join(privateDirectory, "pet.png")], { projectRoot: root })).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown switches and missing required inputs fail closed", () => {
  assert.throws(() => parseAutoCustomizationArguments(["--photos", "x", "--name", "猫", "--personality", "乖", "--agent", "other"]), /unknown argument/u);
  assert.throws(() => parseAutoCustomizationArguments(["--photos", "x", "--name", "猫"]), /personality/u);
  assert.throws(() => parseAutoCustomizationArguments(["--photos", "x", "--name", "bad/name", "--personality", "乖"]), /name/u);
});
