import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, contentSha256, validateLearningPack } from "./learning-pack-validation.mjs";

function validPack() {
  const pack = {
    schemaVersion: 1,
    packId: "test.pack",
    version: "1.0.0",
    title: "Test",
    description: "Synthetic",
    rights: { basis: "self_authored", statement: "Synthetic", redistributable: true },
    sources: [{ sourceRef: "notes", label: "Notes" }],
    contentSha256: "",
    cards: [{ cardId: "c1", exerciseKind: "choice", prompt: "Q", answer: "A", choices: ["A", "B"], sourceRefs: ["notes"], scheduleEpoch: 1 }]
  };
  pack.contentSha256 = contentSha256(pack);
  return pack;
}

test("accepts a deterministic final local pack", () => {
  assert.equal(validateLearningPack(validPack()).valid, true);
});

test("rejects unknown rights and choice answers outside the options", () => {
  const pack = validPack();
  pack.rights.basis = "unknown";
  pack.cards[0].answer = "C";
  pack.contentSha256 = contentSha256(pack);
  const result = validateLearningPack(pack);
  assert.equal(result.valid, false);
  assert.deepEqual(new Set(result.problems.map((entry) => entry.code)), new Set(["rights_unknown", "invalid_choices"]));
});

test("personal-only packs cannot claim redistribution", () => {
  const pack = validPack();
  pack.rights = { basis: "personal_use_only", statement: "Local use", redistributable: true };
  pack.contentSha256 = contentSha256(pack);
  assert.equal(validateLearningPack(pack).problems.some((entry) => entry.code === "rights_distribution"), true);
});

test("canonical JSON orders astral keys by Unicode code point", () => {
  assert.equal(canonicalize({ "\uE000": 1, "\u{10000}": 2 }), "{\"\uE000\":1,\"\u{10000}\":2}");
});

test("extensions reject numbers that cannot round-trip exactly across tools", () => {
  for (const value of [-0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const pack = validPack();
    pack.cards[0].extensions = { synthetic: { version: 1, payload: { value } } };
    pack.contentSha256 = contentSha256(pack);
    assert.equal(
      validateLearningPack(pack).problems.some((entry) => entry.code === "invalid_extension_number"),
      true,
    );
  }
});
