import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { validateRequest } from "./customization-state.mjs";

export const SUPPORTED_AGENT_IDS = Object.freeze(["codex", "kimi", "workbuddy"]);
const SUPPORTED_PHOTO_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

export function parseAutoCustomizationArguments(argumentsList) {
  const result = { photoInputs: [], dryRun: false, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else if (["--photos", "--name", "--personality"].includes(argument)) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`CUSTOMIZATION_INPUT_INVALID: ${argument} requires a value`);
      index += 1;
      if (argument === "--photos") result.photoInputs.push(value);
      else if (argument === "--name") result.displayName = value;
      else result.personality = value;
    } else {
      throw new Error(`CUSTOMIZATION_INPUT_INVALID: unknown argument ${argument}`);
    }
  }
  if (!result.help) validateMinimalPetInputs(result);
  return result;
}

export function validateMinimalPetInputs({ displayName, personality, photoInputs }) {
  if (
    typeof displayName !== "string"
    || displayName.trim().length < 1
    || displayName.length > 40
    || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(displayName)
  ) {
    throw new Error("CUSTOMIZATION_INPUT_INVALID: name must be 1-40 safe display characters");
  }
  if (
    typeof personality !== "string"
    || personality.trim().length < 1
    || personality.length > 120
    || /[\u0000-\u001f\u007f]/u.test(personality)
  ) {
    throw new Error("CUSTOMIZATION_INPUT_INVALID: personality must be 1-120 display characters");
  }
  if (!Array.isArray(photoInputs) || photoInputs.length < 1) {
    throw new Error("CUSTOMIZATION_INPUT_INVALID: at least one --photos file or directory is required");
  }
}

export async function discoverPhotoInputs(inputPaths, { projectRoot = null } = {}) {
  const canonicalProjectRoot = projectRoot ? await realpath(projectRoot) : null;
  const candidates = [];
  for (const inputPath of inputPaths) {
    const absolute = path.resolve(inputPath);
    const metadata = await safeLstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error("CUSTOMIZATION_PHOTO_INVALID: symbolic links are not accepted");
    if (metadata.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        if (entry.isSymbolicLink()) throw new Error("CUSTOMIZATION_PHOTO_INVALID: symbolic links are not accepted");
        if (entry.isFile() && SUPPORTED_PHOTO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          candidates.push(path.join(absolute, entry.name));
        }
      }
    } else if (metadata.isFile()) {
      candidates.push(absolute);
    } else {
      throw new Error("CUSTOMIZATION_PHOTO_INVALID: photo input must be an ordinary file or directory");
    }
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const extension = path.extname(candidate).toLowerCase();
    if (!SUPPORTED_PHOTO_EXTENSIONS.has(extension)) {
      throw new Error(`CUSTOMIZATION_PHOTO_INVALID: unsupported photo extension ${extension || "(none)"}`);
    }
    const canonical = await realpath(candidate);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    await validatePhotoSignature(canonical, extension);
    assertPrivatePhotoLocation(canonical, canonicalProjectRoot);
    unique.push(canonical);
  }
  if (unique.length < 1 || unique.length > 16) {
    throw new Error("CUSTOMIZATION_PHOTO_INVALID: provide between 1 and 16 supported photos");
  }
  return unique;
}

async function safeLstat(value) {
  try {
    return await lstat(value);
  } catch {
    throw new Error("CUSTOMIZATION_PHOTO_INVALID: a photo input does not exist");
  }
}

async function validatePhotoSignature(filePath, extension) {
  const bytes = await readFile(filePath);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  const valid = extension === ".png" ? png : ([".jpg", ".jpeg"].includes(extension) ? jpeg : webp);
  if (!valid) throw new Error("CUSTOMIZATION_PHOTO_INVALID: a photo extension does not match its file content");
}

function assertPrivatePhotoLocation(photoPath, projectRoot) {
  if (!projectRoot) return;
  const relative = path.relative(path.resolve(projectRoot), photoPath).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return;
  if (relative !== "work" && !relative.startsWith("work/")) {
    throw new Error("CUSTOMIZATION_PHOTO_PRIVATE: photos inside the repository must be placed under work/");
  }
}

export function buildCustomizationRequest({ repository, ref = "HEAD", minimumVersion, displayName, personality, photoInputs }) {
  validateMinimalPetInputs({ displayName, personality, photoInputs });
  const request = {
    schemaVersion: 1,
    source: { repository, ref, minimumVersion, resolvedCommit: null },
    pet: {
      customize: true,
      displayName: displayName.trim(),
      personality: personality.trim(),
      photoInputs: [...photoInputs],
      stylePreset: "auto",
    },
    learning: {
      enabled: true,
      bundledContent: false,
      importMode: "local-preview-confirm",
      agentAssistedPack: false,
      sourceInputs: [],
    },
    target: { platform: "windows", architecture: "x64" },
  };
  validateRequest(request);
  return request;
}

export function customizationIdentity(displayName) {
  const suffix = createHash("sha256").update(displayName.normalize("NFC"), "utf8").digest("hex").slice(0, 12);
  return {
    applicationDisplayName: `${displayName}提醒`,
    packageName: `pet-${suffix}-reminder`,
    identifier: `com.yuanyuan.custom.pet-${suffix}`,
    licenseFile: `PET_${suffix.toUpperCase()}_ASSETS_LICENSE.md`,
  };
}

export function buildBrandDraft({ displayName, personality }) {
  const identity = customizationIdentity(displayName);
  return {
    schemaVersion: 1,
    pet: {
      displayName,
      sex: "unknown",
      breed: "由参考照片识别",
      personality,
    },
    application: {
      displayName: identity.applicationDisplayName,
      identifier: identity.identifier,
      packageName: identity.packageName,
      windowTitles: { pet: displayName, panel: identity.applicationDisplayName, tray: identity.applicationDisplayName },
      notificationSender: identity.applicationDisplayName,
    },
    storage: {
      directoryName: identity.identifier,
      mainDatabaseFile: `${identity.packageName}.sqlite3`,
      learningDatabaseFile: `${identity.packageName}-learning.sqlite3`,
      logFile: `${identity.packageName}.log`,
    },
    artifacts: {
      installerBaseName: identity.applicationDisplayName,
      portableBaseName: identity.applicationDisplayName,
    },
    assets: {
      petDirectory: "public/assets/pet",
      iconDirectory: "src-tauri/icons",
      licenseFile: identity.licenseFile,
    },
  };
}

export async function hashPhotoInputs(photoInputs) {
  return Promise.all(photoInputs.map(async (photoPath) => createHash("sha256").update(await readFile(photoPath)).digest("hex")));
}

export function buildIdentityLockDraft({ displayName, photoHashes }) {
  return {
    schemaVersion: 1,
    profile: "yuanyuan-custom-pet-identity-lock",
    petDisplayName: displayName,
    sex: "unknown",
    stylePreset: "auto",
    createdAt: null,
    sourcePhotoCount: photoHashes.length,
    sourcePhotoSha256: photoHashes,
    referenceImage: { path: null, sha256: null, bytes: null },
    visualIdentity: {
      speciesAndAge: "",
      coatAndGradient: "",
      faceShape: "",
      eyes: "",
      noseMuzzleAndEars: "",
      bodyAndProportions: "",
      markings: "",
      signatureTraits: "",
      motionPersonality: "",
    },
    mustPreserve: [],
    mustAvoid: [],
  };
}

export function buildAgentHandoff({ runId, displayName, personality, photoCount }) {
  return {
    schemaVersion: 1,
    profile: "yuanyuan-three-input-pet-customization",
    supportedAgents: [...SUPPORTED_AGENT_IDS],
    runId,
    userInputs: { displayName, personality, photoCount },
    privatePhotoPaths: "request_snapshot_only",
    agentPrompt: "customization/PET_CUSTOMIZATION_AGENT_PROMPT.zh-CN.md",
    resumeCommand: `npm.cmd run customize:resume -- --run-id ${runId}`,
    completionContract: {
      standardAtlas: "8x11-v2",
      sleepRows: 3,
      lifeRows: 21,
      learningRows: 4,
      windowsPackage: true,
      manualJsonEditingRequiredFromUser: false,
    },
  };
}
