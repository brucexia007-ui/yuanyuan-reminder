import assert from "node:assert/strict";
import test from "node:test";

import {
  isLicenseFileName,
  renderLicenseArchive,
  validateLicensePolicy,
} from "./generate_third_party_licenses.mjs";

test("accepts only conventional license and notice filenames", () => {
  for (const name of ["LICENSE", "LICENSE-APACHE", "LICENCE.md", "COPYING", "NOTICE.txt", "UNLICENSE"]) {
    assert.equal(isLicenseFileName(name), true, name);
  }
  for (const name of ["package.json", "README.md", "license-check.js", "NOTICEBOARD.txt"]) {
    assert.equal(isLicenseFileName(name), false, name);
  }
});

test("renders a deterministic path-free archive", () => {
  const hashes = {
    packageLockSha256: "A".repeat(64),
    cargoLockSha256: "B".repeat(64),
    licensePolicySha256: "C".repeat(64),
  };
  const archive = renderLicenseArchive(
    [
      { purl: "pkg:npm/z@1.0.0", license: "MIT", files: [{ name: "LICENSE", text: "z" }] },
      {
        purl: "pkg:cargo/a@1.0.0",
        license: "Apache-2.0 OR MIT",
        selectedLicense: "Apache-2.0",
        files: [
          { name: "LICENSE-MIT", text: "mit" },
          { name: "LICENSE-APACHE", text: "apache", origin: "reviewed fallback" },
        ],
      },
    ],
    hashes,
  );
  assert.ok(archive.indexOf("pkg:cargo/a@1.0.0") < archive.indexOf("pkg:npm/z@1.0.0"));
  assert.ok(archive.indexOf("LICENSE-APACHE") < archive.indexOf("LICENSE-MIT"));
  assert.match(archive, /Selected distribution license: Apache-2.0/);
  assert.match(archive, /License text provenance: reviewed fallback/);
  assert.equal(archive.includes("C:\\Users"), false);
  assert.equal(archive.endsWith("\n"), true);
});

test("license policy freezes expressions and exact MPL source availability", () => {
  const entries = [
    { purl: "pkg:cargo/a@1.0.0", license: "MIT" },
    { purl: "pkg:cargo/b@2.0.0", license: "MPL-2.0" },
  ];
  const policy = {
    schemaVersion: 1,
    releaseTarget: "x86_64-pc-windows-msvc",
    noticeArchiveRequired: true,
    permittedProductionLicenseExpressions: ["MIT", "MPL-2.0"],
    sourceAvailability: [
      {
        purl: "pkg:cargo/b@2.0.0",
        url: "https://crates.io/api/v1/crates/b/2.0.0/download",
      },
    ],
  };
  assert.equal(validateLicensePolicy(policy, entries), true);
  assert.equal(
    validateLicensePolicy(
      { ...policy, permittedProductionLicenseExpressions: ["MIT", "MPL-2.0", "GPL-3.0"] },
      entries,
    ),
    false,
  );
  assert.equal(validateLicensePolicy({ ...policy, sourceAvailability: [] }, entries), false);
});
