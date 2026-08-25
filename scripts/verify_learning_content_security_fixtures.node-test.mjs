import assert from "node:assert/strict";
import test from "node:test";

import {
  loadSecurityFixtureSet,
  validateSecurityFixtureManifest,
} from "./verify_learning_content_security_fixtures.mjs";

function clone(value) {
  return structuredClone(value);
}

test("frozen SEC-001 fixture set is complete and hash-bound", async () => {
  const { manifest, fixtureBytes } = await loadSecurityFixtureSet();
  assert.equal(validateSecurityFixtureManifest(manifest, fixtureBytes), true);
});

test("fixture hash drift fails closed", async () => {
  const { manifest, fixtureBytes } = await loadSecurityFixtureSet();
  const changed = new Map(fixtureBytes);
  changed.set("valid-minimal.json", Buffer.from("changed"));
  assert.equal(validateSecurityFixtureManifest(manifest, changed), false);
});

test("budget drift and missing STRIDE coverage fail closed", async () => {
  const { manifest, fixtureBytes } = await loadSecurityFixtureSet();
  const changedBudget = clone(manifest);
  changedBudget.frozenBudgets.maxCards += 1;
  assert.equal(validateSecurityFixtureManifest(changedBudget, fixtureBytes), false);

  const missingRepudiation = clone(manifest);
  for (const fixture of missingRepudiation.fixtures) {
    fixture.stride = fixture.stride.filter((value) => value !== "repudiation");
  }
  assert.equal(validateSecurityFixtureManifest(missingRepudiation, fixtureBytes), false);
});

test("fixture paths cannot escape the owned directory", async () => {
  const { manifest, fixtureBytes } = await loadSecurityFixtureSet();
  const changed = clone(manifest);
  changed.fixtures[0].file = "../valid-minimal.json";
  assert.equal(validateSecurityFixtureManifest(changed, fixtureBytes), false);
});
