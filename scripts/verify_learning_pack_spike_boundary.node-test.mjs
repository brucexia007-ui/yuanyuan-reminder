import assert from "node:assert/strict";
import test from "node:test";

import {
  findArtifactReferences,
  findForbiddenCrateCapabilities,
  findRuntimeReferences,
  inspectWorkspaceMetadata,
} from "./learning_pack_spike_boundary_policy.mjs";

function cleanMetadata() {
  const allowedDependencies = [
    "csv",
    "serde",
    "serde_json",
    "sha2",
    "unicode-normalization",
    "windows-sys",
  ].map((name) => ({
    name,
    kind: null,
    features:
      name === "serde"
        ? ["derive"]
        : name === "windows-sys"
          ? ["Win32_System_ProcessStatus", "Win32_System_Threading"]
          : [],
  }));
  allowedDependencies.push({ name: "tempfile", kind: "dev", features: [] });
  return {
    packages: [
      {
        name: "yuanyuan-reminder",
        id: "application",
        dependencies: [],
      },
      {
        name: "yuanyuan-learning-pack-spike",
        id: "spike",
        dependencies: allowedDependencies,
        targets: [
          { name: "spike_lib", kind: ["lib"], crate_types: ["lib"] },
          { name: "spike", kind: ["bin"], crate_types: ["bin"] },
          { name: "security", kind: ["test"], crate_types: ["bin"] },
        ],
        publish: [],
      },
    ],
    workspace_members: ["application", "spike"],
    workspace_default_members: ["application"],
  };
}

test("accepts an isolated non-default standalone parser package", () => {
  assert.deepEqual(inspectWorkspaceMetadata(cleanMetadata()), []);
});

test("rejects default membership and an application dependency on the spike", () => {
  const metadata = cleanMetadata();
  metadata.workspace_default_members.push("spike");
  metadata.packages[0].dependencies.push({ name: "yuanyuan-learning-pack-spike", kind: null });
  assert.deepEqual(
    inspectWorkspaceMetadata(metadata).map(({ rule }) => rule),
    ["spike-is-default-member", "workspace-package-depends-on-spike"],
  );
});

test("rejects dependency, target, and publication scope expansion", () => {
  const metadata = cleanMetadata();
  metadata.packages[1].dependencies.push({ name: "tauri", kind: null });
  metadata.packages[1].targets.push({
    name: "build-script-build",
    kind: ["custom-build"],
    crate_types: ["bin"],
  });
  metadata.packages[1].publish = null;
  assert.deepEqual(
    inspectWorkspaceMetadata(metadata).map(({ rule }) => rule),
    [
      "spike-dependency-outside-allowlist",
      "spike-target-kind-forbidden",
      "spike-package-publishable",
    ],
  );
});

test("rejects capability feature expansion on an otherwise allowed dependency", () => {
  const metadata = cleanMetadata();
  const windows = metadata.packages[1].dependencies.find(
    (dependency) => dependency.name === "windows-sys",
  );
  windows.features.push("Win32_Networking_WinSock");
  assert.deepEqual(
    inspectWorkspaceMetadata(metadata).map(({ rule }) => rule),
    ["spike-dependency-feature-drift"],
  );
});

test("rejects runtime linkage and artifact leakage", () => {
  assert.deepEqual(findRuntimeReferences("src-tauri/src/lib.rs", "yuanyuan_learning_pack_spike"), [
    {
      path: "src-tauri/src/lib.rs",
      rule: "runtime-references-spike",
      detail: "yuanyuan_learning_pack_spike",
    },
  ]);
  assert.equal(
    findArtifactReferences("dist/assets/app.js", Buffer.from("pre-gen-spike-7"))[0].rule,
    "artifact-contains-spike",
  );
});

test("rejects Tauri, SQLite, network, and child-process capabilities in the crate", () => {
  const source = `
    #[tauri::command]
    fn import() { let _ = rusqlite::Connection::open("x"); }
    fn network() { let _ = std::net::TcpStream::connect("localhost:1"); }
    fn child() { let _ = std::process::Command::new("tool"); }
  `;
  assert.deepEqual(
    findForbiddenCrateCapabilities("src/lib.rs", source).map(({ rule }) => rule),
    ["tauri-command", "tauri-runtime", "sqlite-runtime", "process-spawn", "network-runtime"],
  );
});
