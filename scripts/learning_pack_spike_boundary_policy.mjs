export const SPIKE_PACKAGE_NAME = "yuanyuan-learning-pack-spike";
export const APPLICATION_PACKAGE_NAME = "yuanyuan-reminder";

const ALLOWED_SPIKE_DEPENDENCIES = new Map([
  ["csv", { kind: null, features: [] }],
  ["serde", { kind: null, features: ["derive"] }],
  ["serde_json", { kind: null, features: [] }],
  ["sha2", { kind: null, features: [] }],
  ["unicode-normalization", { kind: null, features: [] }],
  [
    "windows-sys",
    {
      kind: null,
      features: ["Win32_System_ProcessStatus", "Win32_System_Threading"],
    },
  ],
  ["tempfile", { kind: "dev", features: [] }],
]);

const ALLOWED_TARGET_KINDS = new Set(["bin", "lib", "test"]);

export const RUNTIME_REFERENCE_MARKERS = Object.freeze([
  "yuanyuan_learning_pack_spike",
  "yuanyuan-learning-pack-spike",
  "learning-pack-spike",
  "pre-gen-spike-",
]);

const FORBIDDEN_CRATE_CAPABILITIES = Object.freeze([
  { rule: "tauri-command", pattern: /#\s*\[\s*tauri::command\s*\]/iu },
  { rule: "tauri-runtime", pattern: /\btauri(?:::|_plugin|-)\w*/iu },
  { rule: "sqlite-runtime", pattern: /\b(?:rusqlite|sqlite)\b/iu },
  { rule: "process-spawn", pattern: /\b(?:std::)?process::Command\b|\bCommand::new\s*\(/u },
  { rule: "process-spawn", pattern: /\b(?:CreateProcess\w*|ShellExecute\w*|WinExec)\b/u },
  {
    rule: "network-runtime",
    pattern:
      /\b(?:std::net|TcpStream|TcpListener|UdpSocket|reqwest|hyper|ureq|WinHttp\w*|WinInet\w*|WinSock\w*)\b/u,
  },
]);

function finding(rule, detail) {
  return { rule, detail };
}

export function inspectWorkspaceMetadata(metadata) {
  const findings = [];
  const packages = Array.isArray(metadata?.packages) ? metadata.packages : [];
  const spike = packages.find((entry) => entry.name === SPIKE_PACKAGE_NAME);
  const application = packages.find((entry) => entry.name === APPLICATION_PACKAGE_NAME);

  if (!spike) findings.push(finding("spike-package-missing", SPIKE_PACKAGE_NAME));
  if (!application) findings.push(finding("application-package-missing", APPLICATION_PACKAGE_NAME));
  if (!spike || !application) return findings;

  if (!metadata.workspace_members?.includes(spike.id)) {
    findings.push(finding("spike-not-workspace-member", spike.id));
  }
  if (metadata.workspace_default_members?.includes(spike.id)) {
    findings.push(finding("spike-is-default-member", spike.id));
  }

  for (const packageEntry of packages.filter((entry) => entry.id !== spike.id)) {
    if (packageEntry.dependencies?.some((dependency) => dependency.name === SPIKE_PACKAGE_NAME)) {
      findings.push(finding("workspace-package-depends-on-spike", packageEntry.name));
    }
  }

  for (const dependency of spike.dependencies ?? []) {
    const expected = ALLOWED_SPIKE_DEPENDENCIES.get(dependency.name);
    const actualKind = dependency.kind ?? null;
    if (!expected || actualKind !== expected.kind) {
      findings.push(
        finding(
          "spike-dependency-outside-allowlist",
          `${dependency.name}:${actualKind ?? "normal"}`,
        ),
      );
      continue;
    }
    const actualFeatures = [...(dependency.features ?? [])].sort();
    const expectedFeatures = [...expected.features].sort();
    if (JSON.stringify(actualFeatures) !== JSON.stringify(expectedFeatures)) {
      findings.push(
        finding(
          "spike-dependency-feature-drift",
          `${dependency.name}:${actualFeatures.join(",") || "none"}`,
        ),
      );
    }
  }

  const actualDependencies = new Set((spike.dependencies ?? []).map((entry) => entry.name));
  for (const dependency of ALLOWED_SPIKE_DEPENDENCIES.keys()) {
    if (!actualDependencies.has(dependency)) {
      findings.push(finding("spike-dependency-missing", dependency));
    }
  }

  for (const target of spike.targets ?? []) {
    for (const kind of target.kind ?? []) {
      if (!ALLOWED_TARGET_KINDS.has(kind)) {
        findings.push(finding("spike-target-kind-forbidden", `${target.name}:${kind}`));
      }
    }
    for (const crateType of target.crate_types ?? []) {
      if (!ALLOWED_TARGET_KINDS.has(crateType)) {
        findings.push(finding("spike-crate-type-forbidden", `${target.name}:${crateType}`));
      }
    }
  }

  if (!Array.isArray(spike.publish) || spike.publish.length !== 0) {
    findings.push(finding("spike-package-publishable", JSON.stringify(spike.publish)));
  }

  return findings;
}

export function findRuntimeReferences(path, text) {
  const source = String(text).toLowerCase();
  return RUNTIME_REFERENCE_MARKERS.filter((marker) => source.includes(marker.toLowerCase())).map(
    (marker) => ({ path, rule: "runtime-references-spike", detail: marker }),
  );
}

export function findForbiddenCrateCapabilities(path, text) {
  return FORBIDDEN_CRATE_CAPABILITIES.filter(({ pattern }) => pattern.test(String(text))).map(
    ({ rule }) => ({ path, rule, detail: "pre-GEN parser capability boundary" }),
  );
}

export function findArtifactReferences(path, bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : String(bytes);
  return findRuntimeReferences(path, source).map((entry) => ({
    ...entry,
    rule: "artifact-contains-spike",
  }));
}
