import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RIGHTS = new Set(["self_authored", "public_domain", "open_license", "authorized", "personal_use_only", "unknown"]);
const ROOT_KEYS = ["schemaVersion", "packId", "version", "title", "description", "rights", "sources", "contentSha256", "cards"];
const CARD_KEYS = ["cardId", "exerciseKind", "prompt", "answer", "choices", "explanation", "tags", "sourceRefs", "scheduleEpoch", "extensions"];

function problem(problems, code, location, message) {
  problems.push({ code, location, message });
}

function exactKeys(problems, value, allowed, required, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problem(problems, "invalid_object", location, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problem(problems, "unknown_field", `${location}.${key}`, "unknown fields are rejected");
  for (const key of required) if (!(key in value)) problem(problems, "missing_field", `${location}.${key}`, "required field is missing");
  return true;
}

function safeText(problems, value, maximum, location, { required = true } = {}) {
  if (typeof value !== "string" || (required && value.trim().length === 0) || [...(value ?? "")].length > maximum) {
    problem(problems, "invalid_text", location, `must be ${required ? "non-empty " : ""}text of at most ${maximum} characters`);
    return;
  }
  if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value)) {
    problem(problems, "unsafe_text", location, "control and bidirectional override characters are rejected");
  }
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = [...left].map((value) => value.codePointAt(0));
  const rightPoints = [...right].map((value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareUnicodeCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasUnpairedSurrogate(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });
}

function validateExtensionPayload(problems, value, location) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      problem(problems, "invalid_extension_number", location, "extension numbers must be safe integers and must not be negative zero");
    }
    return;
  }
  if (typeof value === "string") {
    if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value) || hasUnpairedSurrogate(value)) {
      problem(problems, "unsafe_extension_text", location, "extension text must contain valid Unicode without unsafe control characters");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateExtensionPayload(problems, entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (hasUnpairedSurrogate(key)) problem(problems, "unsafe_extension_key", `${location}.${key}`, "extension keys must contain valid Unicode");
      validateExtensionPayload(problems, entry, `${location}.${key}`);
    }
    return;
  }
  problem(problems, "invalid_extension_value", location, "extension payload contains a non-JSON value");
}

export function contentSha256(pack) {
  const copy = structuredClone(pack);
  delete copy.contentSha256;
  return createHash("sha256").update(canonicalize(copy), "utf8").digest("hex");
}

export function validateLearningPack(pack, { requireFinalRights = true } = {}) {
  const problems = [];
  if (!exactKeys(problems, pack, ROOT_KEYS, ROOT_KEYS, "pack")) return { valid: false, problems, computedContentSha256: null };
  if (pack.schemaVersion !== 1) problem(problems, "schema_version", "pack.schemaVersion", "only schemaVersion 1 is supported");
  if (!ID.test(pack.packId ?? "")) problem(problems, "invalid_id", "pack.packId", "must match [A-Za-z0-9._:-] and be 1-128 characters");
  if (!/^\d+\.\d+\.\d+$/u.test(pack.version ?? "")) problem(problems, "invalid_version", "pack.version", "must be semantic version X.Y.Z");
  safeText(problems, pack.title, 256, "pack.title");
  safeText(problems, pack.description, 1000, "pack.description", { required: false });

  if (exactKeys(problems, pack.rights, ["basis", "statement", "redistributable"], ["basis", "statement", "redistributable"], "pack.rights")) {
    if (!RIGHTS.has(pack.rights.basis)) problem(problems, "rights_basis", "pack.rights.basis", "unsupported rights basis");
    safeText(problems, pack.rights.statement, 2000, "pack.rights.statement");
    if (typeof pack.rights.redistributable !== "boolean") problem(problems, "rights_distribution", "pack.rights.redistributable", "must be boolean");
    if (requireFinalRights && pack.rights.basis === "unknown") problem(problems, "rights_unknown", "pack.rights.basis", "unknown rights block final pack generation");
    if (pack.rights.basis === "personal_use_only" && pack.rights.redistributable !== false) problem(problems, "rights_distribution", "pack.rights.redistributable", "personal_use_only must not be redistributable");
  }

  const sourceIds = new Set();
  if (!Array.isArray(pack.sources) || pack.sources.length < 1 || pack.sources.length > 128) {
    problem(problems, "source_budget", "pack.sources", "must contain 1-128 sources");
  } else {
    pack.sources.forEach((source, index) => {
      const location = `pack.sources[${index}]`;
      if (!exactKeys(problems, source, ["sourceRef", "label", "url", "license"], ["sourceRef", "label"], location)) return;
      if (!ID.test(source.sourceRef ?? "")) problem(problems, "invalid_id", `${location}.sourceRef`, "invalid sourceRef");
      if (sourceIds.has(source.sourceRef)) problem(problems, "duplicate_id", `${location}.sourceRef`, "duplicate sourceRef");
      sourceIds.add(source.sourceRef);
      safeText(problems, source.label, 256, `${location}.label`);
      if (source.url !== undefined && (typeof source.url !== "string" || source.url.length > 2048 || !/^https?:\/\//u.test(source.url))) problem(problems, "invalid_url", `${location}.url`, "only bounded http(s) source references are accepted");
      if (source.license !== undefined) safeText(problems, source.license, 256, `${location}.license`, { required: false });
    });
  }

  const cardIds = new Set();
  if (!Array.isArray(pack.cards) || pack.cards.length < 1 || pack.cards.length > 20_000) {
    problem(problems, "card_budget", "pack.cards", "must contain 1-20000 cards");
  } else {
    pack.cards.forEach((card, index) => {
      const location = `pack.cards[${index}]`;
      if (!exactKeys(problems, card, CARD_KEYS, ["cardId", "exerciseKind", "prompt", "answer", "sourceRefs", "scheduleEpoch"], location)) return;
      if (!ID.test(card.cardId ?? "")) problem(problems, "invalid_id", `${location}.cardId`, "invalid cardId");
      if (cardIds.has(card.cardId)) problem(problems, "duplicate_id", `${location}.cardId`, "duplicate cardId");
      cardIds.add(card.cardId);
      if (!new Set(["recall", "choice"]).has(card.exerciseKind)) problem(problems, "invalid_exercise", `${location}.exerciseKind`, "must be recall or choice");
      safeText(problems, card.prompt, 2000, `${location}.prompt`);
      safeText(problems, card.answer, 4000, `${location}.answer`);
      if (card.explanation !== undefined) safeText(problems, card.explanation, 8000, `${location}.explanation`, { required: false });
      if (card.exerciseKind === "choice") {
        if (!Array.isArray(card.choices) || card.choices.length < 2 || card.choices.length > 4) problem(problems, "invalid_choices", `${location}.choices`, "choice cards require 2-4 options");
        else {
          const unique = new Set(card.choices);
          if (unique.size !== card.choices.length || !unique.has(card.answer)) problem(problems, "invalid_choices", `${location}.choices`, "choices must be unique and contain the exact answer once");
          card.choices.forEach((choice, choiceIndex) => safeText(problems, choice, 1000, `${location}.choices[${choiceIndex}]`));
        }
      } else if (card.choices !== undefined && (!Array.isArray(card.choices) || card.choices.length !== 0)) {
        problem(problems, "invalid_choices", `${location}.choices`, "recall cards must omit choices or use an empty array");
      }
      if (card.tags !== undefined) {
        if (!Array.isArray(card.tags) || card.tags.length > 32 || new Set(card.tags).size !== card.tags.length) problem(problems, "invalid_tags", `${location}.tags`, "tags must be a unique array of at most 32 values");
        else card.tags.forEach((tag, tagIndex) => safeText(problems, tag, 64, `${location}.tags[${tagIndex}]`));
      }
      if (!Array.isArray(card.sourceRefs) || card.sourceRefs.length < 1 || card.sourceRefs.length > 8 || new Set(card.sourceRefs).size !== card.sourceRefs.length) problem(problems, "invalid_sources", `${location}.sourceRefs`, "must contain 1-8 unique sourceRefs");
      else for (const sourceRef of card.sourceRefs) if (!sourceIds.has(sourceRef)) problem(problems, "unknown_source", `${location}.sourceRefs`, `unknown sourceRef ${JSON.stringify(sourceRef)}`);
      if (!Number.isSafeInteger(card.scheduleEpoch) || card.scheduleEpoch < 1 || card.scheduleEpoch > 4_294_967_295) problem(problems, "invalid_epoch", `${location}.scheduleEpoch`, "must be an integer from 1 to 4294967295");
      if (card.extensions !== undefined) {
        if (!card.extensions || typeof card.extensions !== "object" || Array.isArray(card.extensions)) problem(problems, "invalid_extensions", `${location}.extensions`, "must be an object");
        else {
          if (Buffer.byteLength(canonicalize(card.extensions), "utf8") > 16 * 1024) problem(problems, "extension_budget", `${location}.extensions`, "extensions exceed 16 KiB");
          for (const [namespace, extension] of Object.entries(card.extensions)) {
            const extensionLocation = `${location}.extensions.${namespace}`;
            if (!/^[A-Za-z][A-Za-z0-9.-]{0,63}$/u.test(namespace)) {
              problem(problems, "invalid_extension_namespace", extensionLocation, "extension namespace is invalid");
              continue;
            }
            if (!exactKeys(problems, extension, ["version", "payload"], ["version", "payload"], extensionLocation)) continue;
            if (!Number.isSafeInteger(extension.version) || extension.version < 1 || extension.version > 4_294_967_295) {
              problem(problems, "invalid_extension_version", `${extensionLocation}.version`, "extension version must be a positive 32-bit integer");
            }
            if (extension.payload === null) problem(problems, "invalid_extension_payload", `${extensionLocation}.payload`, "extension payload must not be null");
            else validateExtensionPayload(problems, extension.payload, `${extensionLocation}.payload`);
          }
        }
      }
    });
  }

  const computedContentSha256 = contentSha256(pack);
  if (!SHA256.test(pack.contentSha256 ?? "") || pack.contentSha256 !== computedContentSha256) problem(problems, "content_hash", "pack.contentSha256", `must equal ${computedContentSha256}`);
  return { valid: problems.length === 0, problems, computedContentSha256 };
}

export async function loadAndValidateLearningPack(filePath, options) {
  const bytes = await readFile(filePath);
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) return { pack: null, bytes, result: { valid: false, computedContentSha256: null, problems: [{ code: "byte_budget", location: "file", message: "file must be 1 byte to 25 MiB" }] } };
  let pack;
  try { pack = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return { pack: null, bytes, result: { valid: false, computedContentSha256: null, problems: [{ code: "malformed_json", location: "file", message: "file is not valid UTF-8 JSON" }] } }; }
  return { pack, bytes, result: validateLearningPack(pack, options) };
}
