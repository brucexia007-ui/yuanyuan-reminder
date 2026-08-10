import assert from "node:assert/strict";
import test from "node:test";

import {
  validateBundleDeclaration,
  validateFrontendTransport,
  validateOfflineCsp,
  validateRustTransport,
} from "./verify_ai_disabled_boundary.mjs";

test("offline CSP accepts only Tauri local IPC", () => {
  validateOfflineCsp("default-src 'self'; connect-src ipc: http://ipc.localhost");
  for (const value of [
    "default-src 'self'",
    "connect-src ipc: https://api.example.com",
    "connect-src ipc: http://ipc.localhost wss:",
  ]) {
    assert.throws(() => validateOfflineCsp(value));
  }
});

test("bundle declaration rejects every optional process and QA payload", () => {
  const resources = {
    "../LICENSE": "licenses/LICENSE.txt",
    "../THIRD_PARTY_NOTICES.md": "licenses/THIRD_PARTY_NOTICES.md",
    "../THIRD_PARTY_LICENSES.txt": "licenses/THIRD_PARTY_LICENSES.txt",
    "../ASSETS_LICENSE.md": "licenses/ASSETS_LICENSE.md",
  };
  assert.deepEqual(validateBundleDeclaration({ resources }), {
    externalBin: [],
    resources,
  });
  assert.throws(() => validateBundleDeclaration({}));
  assert.throws(() => validateBundleDeclaration({ resources: { ...resources, extra: "extra" } }));
  for (const marker of [
    "yuanyuan-ai.exe",
    "yuanyuan-bridge.exe",
    "runtime-qa",
    "yuanyuan-runtime-qa-fixture.exe",
    "migration-qa",
    "yuanyuan-database-migration-qa.exe",
    "store-data-lifecycle-qa",
    "yuanyuan-store-data-lifecycle-qa.exe",
    "yuanyuan-pid-reuse-qa.exe",
  ]) {
    assert.throws(() =>
      validateBundleDeclaration({ resources: { ...resources, "../LICENSE": marker } }),
    );
  }
});

test("frontend permits the fixed local pet manifest and rejects remote transports", () => {
  validateFrontendTransport(
    "src/pet/manifest.ts",
    'const value = fetch("/assets/pet/pet-manifest.json");',
  );
  for (const source of [
    'fetch("https://example.com")',
    'new WebSocket("wss://example.com")',
    'new EventSource("https://example.com")',
    "navigator.sendBeacon('/collect')",
  ]) {
    assert.throws(() => validateFrontendTransport("src/example.ts", source));
  }
});

test("stable core rejects direct socket and HTTP client code", () => {
  validateRustTransport("src-tauri/src/example.rs", "let local = 1;");
  for (const source of [
    "std::net::TcpStream::connect(address)",
    "TcpListener::bind(address)",
    "reqwest::Client::new()",
    "tokio_tungstenite::connect_async(url)",
  ]) {
    assert.throws(() => validateRustTransport("src-tauri/src/example.rs", source));
  }
});
