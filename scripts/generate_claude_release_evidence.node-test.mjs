import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  EVIDENCE_SCHEMA_VERSION,
  EXPECTED_FINGERPRINT,
  generateEvidence,
  parseVersion,
  validVersion,
  validateEvidencePack,
  validateTrustRootPolicies,
  verifiedSignerFromStatus,
} from "./generate_claude_release_evidence.mjs";

const HASH_A = "ab".repeat(32);
const HASH_B = "22".repeat(32);

function entry(overrides = {}) {
  return {
    version: "2.1.89",
    platform: "win32-x64",
    sha256: HASH_A,
    manifestSha256: HASH_B,
    signingKeyFingerprint: EXPECTED_FINGERPRINT,
    ...overrides,
  };
}

test("release versions are canonical and cannot predate signed manifests", () => {
  assert.deepEqual(parseVersion("2.1.89"), [2, 1, 89]);
  assert.equal(validVersion("2.1.89"), true);
  assert.equal(validVersion("2.1.211"), true);
  for (const invalid of ["2.1.88", "02.1.89", "2.01.89", "2.1", "latest", "2.1.89.0"]) {
    assert.equal(validVersion(invalid), false, invalid);
  }
});

test("gpg status accepts the reviewed primary key directly", () => {
  const status = `[GNUPG:] VALIDSIG ${EXPECTED_FINGERPRINT} 2026-01-01 0 0 4 0 1 10 00`;
  assert.equal(verifiedSignerFromStatus(status, "2.1.89"), EXPECTED_FINGERPRINT);
});

test("gpg status resolves a signing subkey to the reviewed primary key", () => {
  const subkey = "A1".repeat(20);
  const status = `[GNUPG:] VALIDSIG ${subkey} 2026-01-01 0 0 4 0 1 10 00 ${EXPECTED_FINGERPRINT}`;
  assert.equal(verifiedSignerFromStatus(status, "2.1.211"), EXPECTED_FINGERPRINT);
});

test("ambiguous, revoked, or unreviewed signatures fail closed", () => {
  const valid = `[GNUPG:] VALIDSIG ${EXPECTED_FINGERPRINT} 2026-01-01 0 0 4 0 1 10 00`;
  assert.throws(() => verifiedSignerFromStatus(`${valid}\n${valid}`, "2.1.89"), /Exactly one/);
  assert.throws(() => verifiedSignerFromStatus(`[GNUPG:] REVKEYSIG ${EXPECTED_FINGERPRINT}`, "2.1.89"), /rejected/);
  assert.throws(
    () => verifiedSignerFromStatus(`[GNUPG:] VALIDSIG ${"FF".repeat(20)} 2026-01-01 0 0 4 0 1 10 00`, "2.1.89"),
    /outside the reviewed/,
  );
});

test("v2 evidence requires canonical hashes, reviewed roots, exact fields, and order", () => {
  const pack = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    entries: [entry(), entry({ version: "2.1.90", platform: "win32-arm64" })],
  };
  assert.equal(validateEvidencePack(pack), pack);
  assert.throws(() => validateEvidencePack({ ...pack, extra: true }), /only schemaVersion/);
  assert.throws(
    () => validateEvidencePack({ ...pack, entries: [entry({ signingKeyFingerprint: "FF".repeat(20) })] }),
    /reviewed signing-key/,
  );
  assert.throws(
    () => validateEvidencePack({ ...pack, entries: [entry({ sha256: HASH_A.toUpperCase() })] }),
    /canonical SHA-256/,
  );
  assert.throws(
    () => validateEvidencePack({ ...pack, entries: [entry({ unexpected: true })] }),
    /missing or unknown/,
  );
  assert.throws(
    () => validateEvidencePack({ ...pack, entries: [...pack.entries].reverse() }),
    /canonical order/,
  );
});

test("a release platform can appear only once", () => {
  assert.throws(
    () => validateEvidencePack({ schemaVersion: EVIDENCE_SCHEMA_VERSION, entries: [entry(), entry()] }),
    /duplicate release platform/,
  );
});

test("release-key rotation policies cannot overlap or leave an open-ended predecessor", () => {
  const first = {
    fingerprint: EXPECTED_FINGERPRINT,
    validFromVersion: "2.1.89",
    validThroughVersion: "2.1.100",
  };
  const second = {
    fingerprint: "FF".repeat(20),
    validFromVersion: "2.1.101",
    validThroughVersion: null,
  };
  assert.equal(validateTrustRootPolicies([first, second]).length, 2);
  assert.throws(
    () => validateTrustRootPolicies([first, { ...second, validFromVersion: "2.1.100" }]),
    /overlap/,
  );
  assert.throws(
    () => validateTrustRootPolicies([{ ...first, validThroughVersion: null }, second]),
    /overlap/,
  );
});

test("generation verifies stable snapshots and atomically writes canonical evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "yuanyuan-claude-evidence-test-"));
  try {
    const manifest = join(root, "manifest.json");
    const signature = join(root, "manifest.json.sig");
    const keyring = join(root, "release.gpg");
    const verifier = join(root, "gpgv.exe");
    const evidence = join(root, "evidence.json");
    writeFileSync(
      manifest,
      JSON.stringify({ platforms: { "win32-x64": { checksum: HASH_A.toUpperCase() } } }),
    );
    writeFileSync(signature, "detached-signature-fixture");
    writeFileSync(keyring, "keyring-fixture");
    writeFileSync(verifier, "controlled-verifier-fixture");
    writeFileSync(evidence, JSON.stringify({ schemaVersion: EVIDENCE_SCHEMA_VERSION, entries: [] }));

    const spawned = [];
    const result = generateEvidence(
      [
        "--gpgv",
        verifier,
        "--manifest",
        manifest,
        "--signature",
        signature,
        "--keyring",
        keyring,
        "--version",
        "2.1.89",
      ],
      {
        evidenceFile: evidence,
        temporaryRoot: root,
        report() {},
        spawnVerifier(executable, args) {
          spawned.push({ executable, args });
          assert.equal(readFileSync(args.at(-1), "utf8"), readFileSync(manifest, "utf8"));
          return {
            error: null,
            status: 0,
            stdout: `[GNUPG:] VALIDSIG ${EXPECTED_FINGERPRINT} 2026-01-01 0 0 4 0 1 10 00`,
          };
        },
      },
    );
    assert.equal(spawned.length, 1);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].sha256, HASH_A);
    assert.equal(result.entries[0].signingKeyFingerprint, EXPECTED_FINGERPRINT);
    assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
