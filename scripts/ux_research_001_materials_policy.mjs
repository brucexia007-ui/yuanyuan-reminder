const REQUIRED_ERROR_CODES = [
  "missing_answer",
  "duplicate",
  "delimiter",
  "encoding",
  "field_mapping",
  "choice_answer",
];

const PROTOTYPE_MARKERS = [
  "ux-research-001-prototype-1",
  "私有学习包制作研究原型",
];

function finding(path, rule, detail) {
  return { path, rule, detail };
}
export function inspectManifest(manifest, observedPaths) {
  const findings = [];
  if (manifest.schema_version !== 1) {
    findings.push(finding("manifest.json", "manifest-schema", String(manifest.schema_version)));
  }
  if (manifest.study_id !== "UX-RESEARCH-001") {
    findings.push(finding("manifest.json", "manifest-study-id", String(manifest.study_id)));
  }
  if (manifest.prototype_version !== PROTOTYPE_MARKERS[0]) {
    findings.push(
      finding("manifest.json", "manifest-prototype-version", String(manifest.prototype_version)),
    );
  }
  if (manifest.status !== "internal_dry_run_ready_real_participant_execution_incomplete") {
    findings.push(finding("manifest.json", "manifest-status-overclaim", String(manifest.status)));
  }
  if (manifest.digest_algorithm !== "sha256_lf_utf8") {
    findings.push(
      finding("manifest.json", "manifest-digest-algorithm", String(manifest.digest_algorithm)),
    );
  }
  const files = manifest.files && typeof manifest.files === "object" ? manifest.files : {};
  const expectedPaths = [...Object.keys(files), "manifest.json"].sort();
  const actualPaths = [...observedPaths].sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    findings.push(
      finding(
        "manifest.json",
        "manifest-file-set",
        `expected=${expectedPaths.join(",")} actual=${actualPaths.join(",")}`,
      ),
    );
  }
  for (const [filePath, digest] of Object.entries(files)) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      findings.push(finding("manifest.json", "manifest-invalid-digest", filePath));
    }
  }
  if (!Array.isArray(manifest.synthetic_materials) || manifest.synthetic_materials.length !== 4) {
    findings.push(
      finding(
        "manifest.json",
        "manifest-material-count",
        String(manifest.synthetic_materials?.length),
      ),
    );
  }
  return findings;
}

export function inspectSyntheticMaterial(path, text, specification) {
  const findings = [];
  const notes = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^N\d{2}\s/u.test(line));
  if (notes.length < 12 || notes.length > 18 || notes.length !== specification.note_count) {
    findings.push(
      finding(path, "material-note-count", `${notes.length}/${specification.note_count}`),
    );
  }
  const ids = new Set();
  const tags = new Set();
  for (const note of notes) {
    const match = /^(N\d{2}) \[([a-z_,]+)\] (\S.*)$/u.exec(note);
    if (!match) {
      findings.push(finding(path, "material-line-format", note.slice(0, 40)));
      continue;
    }
    if (ids.has(match[1])) findings.push(finding(path, "material-duplicate-id", match[1]));
    ids.add(match[1]);
    for (const tag of match[2].split(",")) tags.add(tag);
  }
  for (const requiredTag of specification.required_tags || []) {
    if (!tags.has(requiredTag)) {
      findings.push(finding(path, "material-missing-coverage", requiredTag));
    }
  }
  if (!text.includes("禁止替换为真实工作内容") || !text.includes("每行均为虚构")) {
    findings.push(finding(path, "material-missing-synthetic-warning", "required warning"));
  }
  return findings;
}

export function findPrivacyBoundaryViolations(path, text) {
  const patterns = [
    ["email-address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ["web-url", /\bhttps?:\/\//iu],
    ["windows-absolute-path", /\b[A-Z]:[\\/]/iu],
    ["unc-path", /\\\\[A-Z0-9_.-]+[\\/]/iu],
    ["unix-personal-path", /(?:^|\s)\/(?:Users|home|var|etc|tmp)\//u],
    ["mainland-mobile-number", /\b1[3-9]\d{9}\b/u],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([rule]) => finding(path, `privacy-${rule}`, rule));
}

export function inspectPrototype(path, text) {
  const findings = [];
  const requiredFragments = [
    ...PROTOTYPE_MARKERS,
    "default-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "只在当前页面内存",
    ...REQUIRED_ERROR_CODES,
  ];
  for (const fragment of requiredFragments) {
    if (!text.includes(fragment)) {
      findings.push(finding(path, "prototype-required-boundary-missing", fragment));
    }
  }
  const forbiddenPatterns = [
    ["file-input", /<input\b[^>]*\btype\s*=\s*["']file["']/iu],
    ["external-script", /<script\b[^>]*\bsrc\s*=/iu],
    ["external-link", /<link\b[^>]*\bhref\s*=/iu],
    ["persistence-local-storage", /\blocalStorage\b/u],
    ["persistence-session-storage", /\bsessionStorage\b/u],
    ["persistence-indexed-db", /\bindexedDB\b/u],
    ["network-fetch", /\bfetch\s*\(/u],
    ["network-xhr", /\bXMLHttpRequest\b/u],
    ["network-web-socket", /\bWebSocket\b/u],
    ["network-event-source", /\bEventSource\b/u],
    ["network-beacon", /\bsendBeacon\b/u],
    ["tauri-runtime", /(?:@tauri-apps|__TAURI__|invoke\s*\()/u],
  ];
  for (const [rule, pattern] of forbiddenPatterns) {
    if (pattern.test(text)) findings.push(finding(path, `prototype-${rule}`, rule));
  }
  return findings;
}

export function inspectSessionRecord(path, record) {
  const findings = [];
  const prohibitedKey = /(?:^|_)(?:name|email|phone|account|customer|project|path|filename|file|content|original|note|free_text)(?:_|$)/iu;
  function visit(value, location) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (prohibitedKey.test(key)) {
        findings.push(finding(path, "session-prohibited-field", `${location}.${key}`));
      }
      visit(child, `${location}.${key}`);
    }
  }
  visit(record, "$record");
  if (!/^P0[1-8]$/u.test(record.participant_code || "")) {
    findings.push(
      finding(path, "session-participant-code", String(record.participant_code)),
    );
  }
  if (!record.prohibited_data_confirmed_absent) {
    findings.push(finding(path, "session-privacy-confirmation", "must be true"));
  }
  const codes = Object.keys(record.fixed_error_code_counts || {}).sort();
  if (JSON.stringify(codes) !== JSON.stringify([...REQUIRED_ERROR_CODES].sort())) {
    findings.push(finding(path, "session-error-code-set", codes.join(",")));
  }
  return findings;
}

export function findArtifactReferences(path, bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  return PROTOTYPE_MARKERS.filter((marker) => text.includes(marker)).map((marker) =>
    finding(path, "artifact-contains-research-prototype", marker),
  );
}
