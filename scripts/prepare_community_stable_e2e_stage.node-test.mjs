import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  E2E_STAGE_MANIFEST,
  prepareCommunityStableE2eStage,
} from "./prepare_community_stable_e2e_stage.mjs";
import { verifyCommunityStableE2eStage } from "./verify_community_stable_e2e_stage.mjs";

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "jiaojiao-e2e-stage-"));
  const releaseRoot = path.join(projectRoot, "src-tauri", "target", "release");
  const nsisRoot = path.join(releaseRoot, "bundle", "nsis");
  await mkdir(nsisRoot, { recursive: true });
  await writeFile(
    path.join(projectRoot, "product-version.json"),
    JSON.stringify({
      version: "1.5.7",
      productName: "饺饺提醒",
      identifier: "com.brucexia.jiaojiao.reminder",
    }),
  );
  await writeFile(
    path.join(projectRoot, "product-brand.json"),
    JSON.stringify({
      application: {
        displayName: "饺饺提醒",
        identifier: "com.brucexia.jiaojiao.reminder",
        packageName: "jiaojiao-reminder",
      },
      artifacts: { installerBaseName: "饺饺提醒" },
    }),
  );
  await writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "jiaojiao-reminder", version: "1.5.7" }),
  );
  await writeFile(
    path.join(projectRoot, "src-tauri", "tauri.conf.json"),
    JSON.stringify({
      productName: "饺饺提醒",
      version: "1.5.7",
      identifier: "com.brucexia.jiaojiao.reminder",
    }),
  );
  await writeFile(path.join(releaseRoot, "yuanyuan-reminder.exe"), "current-app");
  await writeFile(path.join(nsisRoot, "饺饺提醒_1.5.7_x64-setup.exe"), "current-installer");
  await writeFile(path.join(nsisRoot, "饺娇提醒_1.5.7_x64-setup.exe"), "stale-installer-1");
  await writeFile(path.join(nsisRoot, "圆圆提醒_1.5.7_x64-setup.exe"), "stale-installer-2");
  return { projectRoot, releaseRoot };
}

const sourceMetadata = {
  commit: "a".repeat(40),
  branch: "feat/unified-v1-5",
  dirty: true,
};

test("creates an isolated stage containing only the exact branded installer", async (t) => {
  const { projectRoot, releaseRoot } = await fixture();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stageRoot = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "community-stable-e2e-stages",
    "test-stage",
  );
  const result = await prepareCommunityStableE2eStage({
    projectRoot,
    releaseRoot,
    stageRoot,
    sourceMetadata,
    buildStartedAt: "2000-01-01T00:00:00.000Z",
    createdAt: "2026-08-29T04:40:00.000Z",
  });
  assert.equal(result.stageRoot, stageRoot);
  assert.deepEqual(
    await readdir(path.join(stageRoot, "bundle", "nsis")),
    ["饺饺提醒_1.5.7_x64-setup.exe"],
  );
  assert.equal(await readFile(path.join(stageRoot, "yuanyuan-reminder.exe"), "utf8"), "current-app");
  const manifest = JSON.parse(
    await readFile(path.join(stageRoot, E2E_STAGE_MANIFEST), "utf8"),
  );
  assert.equal(manifest.product.name, "饺饺提醒");
  assert.equal(manifest.source.dirty, true);
  assert.deepEqual(manifest.sourceRelease.versionMatchedInstallerNames, [
    "圆圆提醒_1.5.7_x64-setup.exe",
    "饺娇提醒_1.5.7_x64-setup.exe",
    "饺饺提醒_1.5.7_x64-setup.exe",
  ]);
  assert.match(manifest.artifacts.installer.sha256, /^[A-F0-9]{64}$/u);
});

test("fails closed on identity drift and never creates the requested stage", async (t) => {
  const { projectRoot, releaseRoot } = await fixture();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const brandPath = path.join(projectRoot, "product-brand.json");
  const brand = JSON.parse(await readFile(brandPath, "utf8"));
  brand.application.identifier = "com.example.wrong";
  await writeFile(brandPath, JSON.stringify(brand));
  const stageRoot = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "community-stable-e2e-stages",
    "must-not-exist",
  );
  await assert.rejects(
    prepareCommunityStableE2eStage({
      projectRoot,
      releaseRoot,
      stageRoot,
      sourceMetadata,
      buildStartedAt: "2000-01-01T00:00:00.000Z",
    }),
    /identity must match exactly/u,
  );
  await assert.rejects(readFile(path.join(stageRoot, E2E_STAGE_MANIFEST)), /ENOENT/u);
});

test("never merges with or overwrites an existing stage directory", async (t) => {
  const { projectRoot, releaseRoot } = await fixture();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stageRoot = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "community-stable-e2e-stages",
    "existing",
  );
  await mkdir(stageRoot, { recursive: true });
  await writeFile(path.join(stageRoot, "sentinel.txt"), "preserve");
  await assert.rejects(
    prepareCommunityStableE2eStage({
      projectRoot,
      releaseRoot,
      stageRoot,
      sourceMetadata,
      buildStartedAt: "2000-01-01T00:00:00.000Z",
    }),
    /already exists/u,
  );
  assert.equal(await readFile(path.join(stageRoot, "sentinel.txt"), "utf8"), "preserve");
});

test("rejects an installer that predates the controlled build receipt", async (t) => {
  const { projectRoot, releaseRoot } = await fixture();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await assert.rejects(
    prepareCommunityStableE2eStage({
      projectRoot,
      releaseRoot,
      stageRoot: path.join(
        projectRoot,
        "src-tauri",
        "target",
        "community-stable-e2e-stages",
        "stale-build",
      ),
      sourceMetadata,
      buildStartedAt: "2999-01-01T00:00:00.000Z",
    }),
    /predates the controlled Tauri build/u,
  );
});

test("the public staging command rebuilds before issuing the build receipt", async () => {
  const [wrapper, host, sandboxWrapper, sandboxHelperWrapper, packageJson] = await Promise.all([
    readFile(new URL("./build_community_stable_e2e_stage.ps1", import.meta.url), "utf8"),
    readFile(new URL("./run_community_stable_sandbox_data_probe_host.ps1", import.meta.url), "utf8"),
    readFile(new URL("./run_community_stable_sandbox_data_probe_guarded.ps1", import.meta.url), "utf8"),
    readFile(new URL("./build_community_stable_sandbox_helper_guarded.ps1", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const buildIndex = wrapper.indexOf("& npm.cmd run tauri build");
  const stageIndex = wrapper.indexOf("& node @arguments");
  const stageVerifierIndex = wrapper.indexOf("verify_community_stable_e2e_stage.mjs");
  assert.ok(buildIndex >= 0 && stageIndex > buildIndex && stageVerifierIndex > stageIndex);
  assert.match(wrapper, /"--build-started-at"/u);
  assert.match(wrapper, /Community stable E2E stage created: /u);
  assert.match(wrapper, /stageMarkers\.Count -ne 1/u);
  assert.match(wrapper, /\[IO\.Path\]::IsPathRooted\(\$stagedRoot\)/u);
  assert.match(
    packageJson.scripts["release:community:e2e-stage"],
    /build_community_stable_e2e_stage\.ps1/u,
  );
  const exclusiveIndex = sandboxWrapper.indexOf("Assert-YuanyuanRuntimeQaExclusive");
  const helperIndex = sandboxWrapper.indexOf("& npm.cmd run release:community:sandbox-e2e:helper");
  const hostIndex = sandboxWrapper.indexOf("& powershell.exe");
  const installedVerifierIndex = sandboxWrapper.indexOf(
    '"scripts/verify_community_stable_installed_e2e.mjs"',
  );
  const allowDirtyConditionIndex = sandboxWrapper.indexOf("if ($AllowDirty)");
  const allowDirtyForwardIndex = sandboxWrapper.indexOf(
    '$verificationArguments += "--allow-dirty"',
  );
  assert.ok(
    exclusiveIndex >= 0 &&
      helperIndex > exclusiveIndex &&
      hostIndex > helperIndex &&
      installedVerifierIndex > hostIndex,
  );
  assert.ok(allowDirtyConditionIndex >= 0 && allowDirtyForwardIndex > allowDirtyConditionIndex);
  assert.match(sandboxWrapper, /-ReleaseRoot \$ReleaseRoot/u);
  assert.match(sandboxWrapper, /-TimeoutSeconds \$TimeoutSeconds/u);
  assert.match(sandboxWrapper, /YUANYUAN_INSTALLED_E2E_EVIDENCE_ROOT=/u);
  assert.match(sandboxWrapper, /evidenceMarkers\.Count -ne 1/u);
  assert.match(sandboxWrapper, /\[IO\.Path\]::IsPathRooted\(\$evidenceRoot\)/u);
  assert.match(sandboxWrapper, /if \(\$AllowDirty\)/u);
  assert.match(sandboxWrapper, /\$verificationArguments \+= "--allow-dirty"/u);
  assert.match(
    packageJson.scripts["release:community:sandbox-e2e"],
    /run_community_stable_sandbox_data_probe_guarded\.ps1/u,
  );
  assert.match(
    packageJson.scripts["release:community:sandbox-data"],
    /run_community_stable_sandbox_data_probe_guarded\.ps1/u,
  );
  const helperExclusiveIndex = sandboxHelperWrapper.indexOf("Assert-YuanyuanRuntimeQaExclusive");
  const helperBuildIndex = sandboxHelperWrapper.indexOf("& cargo build");
  assert.ok(helperExclusiveIndex >= 0 && helperBuildIndex > helperExclusiveIndex);
  assert.match(sandboxHelperWrapper, /--features runtime-qa/u);
  assert.match(sandboxHelperWrapper, /--bin yuanyuan-installed-candidate-qa/u);
  assert.match(
    packageJson.scripts["release:community:sandbox-e2e:helper"],
    /build_community_stable_sandbox_helper_guarded\.ps1/u,
  );
  const hostExclusiveIndex = host.indexOf("Assert-YuanyuanRuntimeQaExclusive");
  const hostSandboxIndex = host.indexOf("WindowsSandbox.exe");
  assert.ok(hostExclusiveIndex >= 0 && hostSandboxIndex > hostExclusiveIndex);
  assert.match(host, /verify_community_stable_e2e_stage\.mjs/u);
  assert.match(host, /candidate-stage-manifest\.json/u);
  assert.match(host, /candidate-stage-binding\.json/u);
  assert.match(host, /stageManifestSha256/u);
  assert.match(host, /stageVerifierSha256/u);
  assert.match(host, /YUANYUAN_INSTALLED_E2E_EVIDENCE_ROOT=\$outputRoot/u);
  assert.match(
    host,
    /<SandboxFolder>C:\\YuanyuanRelease<\/SandboxFolder>\s*<ReadOnly>true<\/ReadOnly>/u,
  );
});

test("independent verification accepts the exact stage and rejects artifact tampering", async (t) => {
  const { projectRoot, releaseRoot } = await fixture();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stageRoot = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "community-stable-e2e-stages",
    "verified-stage",
  );
  await prepareCommunityStableE2eStage({
    projectRoot,
    releaseRoot,
    stageRoot,
    sourceMetadata,
    buildStartedAt: "2000-01-01T00:00:00.000Z",
    createdAt: "2026-08-29T04:50:00.000Z",
  });
  const verified = await verifyCommunityStableE2eStage({
    projectRoot,
    stageRoot,
    sourceMetadata,
  });
  assert.match(verified.manifestSha256, /^[A-F0-9]{64}$/u);
  await writeFile(
    path.join(stageRoot, "bundle", "nsis", "饺饺提醒_1.5.7_x64-setup.exe"),
    "tampered",
  );
  await assert.rejects(
    verifyCommunityStableE2eStage({ projectRoot, stageRoot, sourceMetadata }),
    /installer bytes or SHA-256 changed/u,
  );
});

test("independent verification rejects source and manifest drift", async (t) => {
  const { projectRoot, releaseRoot } = await fixture();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stageRoot = path.join(
    projectRoot,
    "src-tauri",
    "target",
    "community-stable-e2e-stages",
    "drift-stage",
  );
  await prepareCommunityStableE2eStage({
    projectRoot,
    releaseRoot,
    stageRoot,
    sourceMetadata,
    buildStartedAt: "2000-01-01T00:00:00.000Z",
    createdAt: "2026-08-29T04:50:00.000Z",
  });
  await assert.rejects(
    verifyCommunityStableE2eStage({
      projectRoot,
      stageRoot,
      sourceMetadata: { ...sourceMetadata, commit: "b".repeat(40) },
    }),
    /Git source state changed/u,
  );
  const manifestPath = path.join(stageRoot, E2E_STAGE_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.optimistic = true;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyCommunityStableE2eStage({ projectRoot, stageRoot, sourceMetadata }),
    /manifest fields must be exact/u,
  );
});
