import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = 2;
export const EXPECTED_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_VERIFIER_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 1024;
const PLATFORMS = Object.freeze(["win32-x64", "win32-arm64"]);
const TRUST_ROOTS = Object.freeze([
  Object.freeze({
    fingerprint: EXPECTED_FINGERPRINT,
    validFromVersion: "2.1.89",
    validThroughVersion: null,
  }),
]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = resolve(
  repoRoot,
  "src-tauri/resources/connector-trust/claude-code-release-attestations-v2.json",
);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactObjectKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    return null;
  }
  const parts = version.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) throw new Error("Invalid release version");
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function validVersion(version) {
  return parseVersion(version) !== null && compareVersions(version, "2.1.89") >= 0;
}

function normalizeFingerprint(value) {
  return String(value).replace(/\s+/g, "").toUpperCase();
}

export function validateTrustRootPolicies(roots) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error("At least one release trust root is required");
  const fingerprints = new Set();
  for (const [index, root] of roots.entries()) {
    if (
      !exactObjectKeys(root, ["fingerprint", "validFromVersion", "validThroughVersion"]) ||
      normalizeFingerprint(root.fingerprint) !== root.fingerprint ||
      !/^[0-9A-F]{40,64}$/.test(root.fingerprint) ||
      !validVersion(root.validFromVersion) ||
      (root.validThroughVersion !== null &&
        (!validVersion(root.validThroughVersion) ||
          compareVersions(root.validThroughVersion, root.validFromVersion) < 0))
    ) {
      throw new Error("Release trust-root policy is malformed");
    }
    if (fingerprints.has(root.fingerprint)) throw new Error("Release trust-root fingerprint is duplicated");
    fingerprints.add(root.fingerprint);
    if (index > 0) {
      const previous = roots[index - 1];
      if (
        compareVersions(previous.validFromVersion, root.validFromVersion) >= 0 ||
        previous.validThroughVersion === null ||
        compareVersions(previous.validThroughVersion, root.validFromVersion) >= 0
      ) {
        throw new Error("Release trust-root version ranges overlap or are not canonical");
      }
    }
  }
  return roots;
}

validateTrustRootPolicies(TRUST_ROOTS);

function trustRootFor(version, fingerprint) {
  const normalized = normalizeFingerprint(fingerprint);
  const applicable = TRUST_ROOTS.filter(
    (root) =>
      compareVersions(version, root.validFromVersion) >= 0 &&
      (root.validThroughVersion === null || compareVersions(version, root.validThroughVersion) <= 0),
  );
  return applicable.length === 1 && applicable[0].fingerprint === normalized ? applicable[0] : undefined;
}

function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function entryOrder(left, right) {
  return compareVersions(left.version, right.version) || left.platform.localeCompare(right.platform, "en");
}

export function validateEvidencePack(pack) {
  if (!exactObjectKeys(pack, ["entries", "schemaVersion"])) {
    throw new Error("Evidence pack must contain only schemaVersion and entries");
  }
  if (pack.schemaVersion !== EVIDENCE_SCHEMA_VERSION || !Array.isArray(pack.entries)) {
    throw new Error("Evidence pack schema is unsupported");
  }
  if (pack.entries.length > MAX_ENTRIES) throw new Error("Evidence pack entry limit exceeded");
  const identities = new Set();
  for (const entry of pack.entries) {
    if (
      !exactObjectKeys(entry, [
        "manifestSha256",
        "platform",
        "sha256",
        "signingKeyFingerprint",
        "version",
      ])
    ) {
      throw new Error("Evidence entry contains missing or unknown fields");
    }
    if (!validVersion(entry.version) || !PLATFORMS.includes(entry.platform)) {
      throw new Error("Evidence entry has an unsupported release or platform");
    }
    if (!validSha256(entry.sha256) || !validSha256(entry.manifestSha256)) {
      throw new Error("Evidence entry has a non-canonical SHA-256 value");
    }
    if (
      normalizeFingerprint(entry.signingKeyFingerprint) !== entry.signingKeyFingerprint ||
      !trustRootFor(entry.version, entry.signingKeyFingerprint)
    ) {
      throw new Error("Evidence entry is outside the reviewed signing-key policy");
    }
    const identity = `${entry.version}\0${entry.platform}`;
    if (identities.has(identity)) throw new Error("Evidence pack contains a duplicate release platform");
    identities.add(identity);
  }
  const sorted = [...pack.entries].sort(entryOrder);
  if (sorted.some((entry, index) => entry !== pack.entries[index])) {
    throw new Error("Evidence pack entries are not in canonical order");
  }
  return pack;
}

function primaryFingerprintFromValidSig(line) {
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== "[GNUPG:]" || fields[1] !== "VALIDSIG") return null;
  const signingFingerprint = fields[2];
  if (!/^[0-9A-Fa-f]{40,64}$/.test(signingFingerprint ?? "")) return null;
  const finalField = fields.at(-1);
  const primaryFingerprint = /^[0-9A-Fa-f]{40,64}$/.test(finalField ?? "")
    ? finalField
    : signingFingerprint;
  return normalizeFingerprint(primaryFingerprint);
}

export function verifiedSignerFromStatus(statusOutput, version) {
  if (!validVersion(version)) throw new Error("Release version is outside the signed-manifest range");
  const lines = String(statusOutput).split(/\r?\n/);
  const rejectedStatuses = new Set(["BADSIG", "ERRSIG", "EXPSIG", "EXPKEYSIG", "REVKEYSIG"]);
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "[GNUPG:]" && rejectedStatuses.has(fields[1])) {
      throw new Error("gpgv reported a rejected signature status");
    }
  }
  const fingerprints = lines.map(primaryFingerprintFromValidSig).filter(Boolean);
  if (fingerprints.length !== 1) throw new Error("Exactly one valid manifest signature is required");
  const [fingerprint] = fingerprints;
  if (!trustRootFor(version, fingerprint)) {
    throw new Error("Manifest signer is outside the reviewed signing-key policy");
  }
  return fingerprint;
}

function argumentsByName(argv) {
  const allowed = new Set(["--gpgv", "--manifest", "--signature", "--keyring", "--version"]);
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || !value || value.startsWith("--")) {
      throw new Error("Usage: --gpgv FILE --manifest FILE --signature FILE --keyring FILE --version X.Y.Z");
    }
    if (parsed.has(name)) throw new Error(`Duplicate argument: ${name}`);
    parsed.set(name, value);
  }
  return parsed;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeSnapshot(inputPath, label, maximumBytes = MAX_INPUT_BYTES) {
  const absolute = resolve(inputPath);
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size === 0n || before.size > BigInt(maximumBytes)) {
    throw new Error(`${label} must be a non-link regular file within its size limit`);
  }
  const descriptor = openSync(absolute, constants.O_RDONLY);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size !== before.size) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after) || after.size !== opened.size || BigInt(bytes.length) !== opened.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return { absolute, bytes, digest: sha256(bytes) };
  } finally {
    closeSync(descriptor);
  }
}

function checksumAt(manifest, platform) {
  const value = manifest?.platforms?.[platform]?.checksum;
  if (typeof value === "undefined") return null;
  if (!validSha256(String(value).toLowerCase())) {
    throw new Error(`Manifest lacks a valid platforms.${platform}.checksum`);
  }
  return String(value).toLowerCase();
}

function readEvidencePack(packPath = evidencePath) {
  const snapshot = safeSnapshot(packPath, "Existing Claude evidence pack");
  let pack;
  try {
    pack = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new Error("Existing Claude evidence pack is invalid JSON");
  }
  return validateEvidencePack(pack);
}

function verifyPackOnly() {
  const pack = readEvidencePack();
  process.stdout.write(`Claude release evidence pack v${pack.schemaVersion} is valid (${pack.entries.length} entries).\n`);
}

export function generateEvidence(
  argv,
  {
    spawnVerifier = spawnSync,
    evidenceFile = evidencePath,
    temporaryRoot = tmpdir(),
    report = (message) => process.stdout.write(message),
  } = {},
) {
  const args = argumentsByName(argv);
  for (const required of ["--gpgv", "--manifest", "--signature", "--keyring", "--version"]) {
    if (!args.has(required)) throw new Error(`Missing argument: ${required}`);
  }
  const version = args.get("--version");
  if (!validVersion(version)) throw new Error("Version must be an Anthropic signed-manifest release (>= 2.1.89)");
  if (!isAbsolute(args.get("--gpgv"))) throw new Error("gpgv executable path must be absolute");

  const manifest = safeSnapshot(args.get("--manifest"), "Manifest");
  const signature = safeSnapshot(args.get("--signature"), "Signature");
  const keyring = safeSnapshot(args.get("--keyring"), "Keyring");
  const verifierBefore = safeSnapshot(args.get("--gpgv"), "gpgv executable", MAX_VERIFIER_BYTES);
  const scratch = mkdtempSync(join(temporaryRoot, "yuanyuan-claude-evidence-"));
  let verification;
  try {
    const manifestCopy = join(scratch, "manifest.json");
    const signatureCopy = join(scratch, "manifest.json.sig");
    const keyringCopy = join(scratch, "release-keyring.gpg");
    writeFileSync(manifestCopy, manifest.bytes, { flag: "wx", mode: 0o600 });
    writeFileSync(signatureCopy, signature.bytes, { flag: "wx", mode: 0o600 });
    writeFileSync(keyringCopy, keyring.bytes, { flag: "wx", mode: 0o600 });
    verification = spawnVerifier(
      verifierBefore.absolute,
      ["--status-fd=1", "--keyring", keyringCopy, signatureCopy, manifestCopy],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const verifierAfter = safeSnapshot(args.get("--gpgv"), "gpgv executable", MAX_VERIFIER_BYTES);
  if (verifierBefore.digest !== verifierAfter.digest) throw new Error("gpgv executable changed during verification");
  if (verification.error) throw new Error(`gpgv could not run: ${verification.error.message}`);
  if (verification.status !== 0) throw new Error("Anthropic manifest signature verification failed");
  const signingKeyFingerprint = verifiedSignerFromStatus(verification.stdout, version);

  let parsedManifest;
  try {
    parsedManifest = JSON.parse(manifest.bytes.toString("utf8"));
  } catch {
    throw new Error("Manifest is not valid JSON");
  }
  if (parsedManifest.version !== undefined && parsedManifest.version !== version) {
    throw new Error("Requested version does not match manifest.version");
  }
  const additions = PLATFORMS.flatMap((platform) => {
    const checksum = checksumAt(parsedManifest, platform);
    return checksum === null
      ? []
      : [{
          version,
          platform,
          sha256: checksum,
          manifestSha256: manifest.digest,
          signingKeyFingerprint,
        }];
  });
  if (additions.length === 0) throw new Error("Manifest contains no supported Windows platform");

  const current = readEvidencePack(evidenceFile);
  const merged = current.entries.filter(
    (entry) => !additions.some((candidate) => candidate.version === entry.version && candidate.platform === entry.platform),
  );
  merged.push(...additions);
  merged.sort(entryOrder);
  const next = validateEvidencePack({ schemaVersion: EVIDENCE_SCHEMA_VERSION, entries: merged });
  const output = `${JSON.stringify(next, null, 2)}\n`;
  const temporaryPath = `${evidenceFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, output, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, evidenceFile);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  report(`Claude release evidence updated for ${version}; review the diff before release.\n`);
  return next;
}

export function run(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--verify-pack") {
    verifyPackOnly();
    return;
  }
  generateEvidence(argv);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : "Claude evidence generation failed");
  }
}
