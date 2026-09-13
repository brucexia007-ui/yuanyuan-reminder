import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  completeRequiredStep,
  canonicalRepositoryUrl,
  loadRunState,
  newRunState,
  nextRequiredStep,
  persistRunState,
  replaceRunState,
  sha256,
  validateRequest,
  validateRunId,
} from "./customization-state.mjs";

function request() {
  return {
    schemaVersion: 1,
    source: {
      repository: "https://example.com/owner/project.git",
      ref: "main",
      minimumVersion: "1.5.5",
      resolvedCommit: null,
    },
    pet: {
      customize: true,
      displayName: "糖糖",
      sex: "female",
      breed: "橘猫",
      personality: "安静",
      photoInputs: ["private/photo.png"],
      stylePreset: "soft-illustration",
    },
    learning: {
      enabled: true,
      bundledContent: false,
      importMode: "local-preview-confirm",
      agentAssistedPack: true,
      sourceInputs: ["private/notes.pdf"],
    },
    target: { platform: "windows", architecture: "x64" },
  };
}

test("checked-in request JSON Schema is parseable and mirrors the v1 contract", async () => {
  const schemaPath = path.resolve(import.meta.dirname, "../../customization/pet-request.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "source", "pet", "learning", "target"]);
  assert.deepEqual(schema.properties.pet.required, [
    "customize", "displayName", "photoInputs", "stylePreset",
  ]);
  assert.deepEqual(schema.properties.pet.properties.sex.enum, ["female", "male", "unknown"]);
  assert.deepEqual(schema.properties.learning.required, [
    "enabled", "bundledContent", "importMode", "agentAssistedPack", "sourceInputs",
  ]);
  assert.deepEqual(schema.properties.target.required, ["platform", "architecture"]);
  assert.equal(schema.allOf.length, 1);
  assert.equal(
    schema.allOf[0].then.properties.target.properties.architecture.const,
    "x64",
  );
});

test("request contract keeps learning local and targets implemented Windows x64", () => {
  assert.doesNotThrow(() => validateRequest(request()));
  const threeInputRequest = request();
  delete threeInputRequest.pet.sex;
  delete threeInputRequest.pet.breed;
  assert.doesNotThrow(() => validateRequest(threeInputRequest));
  const legacy = request();
  delete legacy.pet.sex;
  delete legacy.pet.breed;
  delete legacy.pet.personality;
  assert.doesNotThrow(() => validateRequest(legacy));
  const partialIdentity = request();
  delete partialIdentity.pet.personality;
  assert.throws(() => validateRequest(partialIdentity), /pet fields/u);
  const wrongSex = request();
  wrongSex.pet.sex = "unspecified";
  assert.throws(() => validateRequest(wrongSex), /pet fields/u);
  const missingBreed = request();
  missingBreed.pet.breed = " ";
  assert.throws(() => validateRequest(missingBreed), /breed and personality/u);
  const unsupported = request();
  unsupported.target = { platform: "macos", architecture: "arm64" };
  assert.throws(() => validateRequest(unsupported), /PLATFORM_NOT_IMPLEMENTED/u);
});

test("repository identity canonicalizes harmless git suffixes and rejects credential-bearing URLs", () => {
  assert.equal(
    canonicalRepositoryUrl("https://GitHub.com/owner/project.git/"),
    "https://github.com/owner/project",
  );
  assert.throws(
    () => canonicalRepositoryUrl("https://token@example.com/owner/project.git"),
    /credential-free/u,
  );
});

test("run state records only private input counts and exposes the next resumable step", () => {
  const state = newRunState({
    request: request(),
    requestSha256: "a".repeat(64),
    resolvedCommit: "b".repeat(40),
    now: new Date("2026-08-28T12:34:56.789Z"),
  });
  assert.equal(validateRunId(state.runId), state.runId);
  assert.equal(nextRequiredStep(state)?.id, "brand");
  assert.equal(state.request.photoInputCount, 1);
  assert.equal(state.request.petSex, "female");
  assert.equal(state.request.petBreed, "橘猫");
  assert.equal(state.request.petPersonality, "安静");
  assert.equal(state.request.learningSourceInputCount, 1);
  assert.equal(state.request.path, null);
  assert.equal(JSON.stringify(state).includes("photo.png"), false);
  assert.equal(JSON.stringify(state).includes("notes.pdf"), false);
});

test("steps require exact ordered artifact evidence and retain hashes", () => {
  const state = newRunState({
    request: request(),
    requestSha256: "a".repeat(64),
    resolvedCommit: "b".repeat(40),
    now: new Date("2026-08-28T12:34:56.789Z"),
  });
  const artifact = {
    role: "brand_config",
    path: "product-brand.json",
    sha256: "c".repeat(64),
    bytes: 100,
  };
  assert.throws(
    () => completeRequiredStep(state, { stepId: "identity_lock", artifacts: [artifact] }),
    /CUSTOMIZATION_STEP_ORDER/u,
  );
  completeRequiredStep(state, {
    stepId: "brand",
    artifacts: [artifact],
    now: new Date("2026-08-28T12:35:00.000Z"),
  });
  assert.equal(state.steps[0].status, "completed");
  assert.equal(state.artifacts[0].stepId, "brand");
  assert.equal(nextRequiredStep(state)?.id, "identity_lock");
  assert.equal(state.status, "in_progress");
});

test("persisted run state replaces atomically and remains resumable", async () => {
  const input = request();
  const requestBytes = Buffer.from(`${JSON.stringify(input, null, 2)}\n`);
  const state = newRunState({
    request: input,
    requestSha256: sha256(requestBytes),
    resolvedCommit: "b".repeat(40),
  });
  const outputPath = await persistRunState(state, requestBytes);
  const runDirectory = path.dirname(outputPath);
  try {
    let loaded = await loadRunState(state.runId);
    assert.equal(loaded.status, "prepared");
    completeRequiredStep(loaded, {
      stepId: "brand",
      artifacts: [{
        role: "brand_config",
        path: "product-brand.json",
        sha256: "c".repeat(64),
        bytes: 100,
      }],
    });
    await replaceRunState(loaded, new Date("2026-08-29T02:00:00.000Z"));
    loaded = await loadRunState(state.runId);
    assert.equal(loaded.status, "in_progress");
    assert.equal(loaded.steps[0].status, "completed");
    assert.equal(loaded.updatedAt, "2026-08-29T02:00:00.000Z");
    assert.deepEqual(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("unknown request fields fail closed", () => {
  const candidate = request();
  candidate.learning.remoteUrl = "https://example.com/content.json";
  assert.throws(() => validateRequest(candidate), /learning fields/u);
});

test("platform reservation covers every desktop integration without claiming macOS support", async () => {
  const document = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../customization/platforms.json"), "utf8"));
  const expected = [
    "globalPointer", "systemIdle", "lockAndWake", "loginStart", "notifications",
    "trayOrMenuBar", "transparentWindow", "alwaysOnTop", "clickThrough", "packaging",
    "signing", "notarization",
  ];
  assert.deepEqual(document.interfaces, expected);
  for (const target of ["windows-x64", "macos-arm64", "macos-x64"]) {
    assert.deepEqual(Object.keys(document.targets[target].interfaces), expected);
  }
  for (const target of ["macos-arm64", "macos-x64"]) {
    assert.equal(document.targets[target].status, "not_implemented");
    assert.equal(document.targets[target].errorCode, "PLATFORM_NOT_IMPLEMENTED");
    assert.deepEqual(new Set(Object.values(document.targets[target].interfaces)), new Set(["reserved"]));
  }
});
