import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  findArtifactReferences,
  findPrivacyBoundaryViolations,
  inspectManifest,
  inspectPrototype,
  inspectSessionRecord,
  inspectSyntheticMaterial,
} from "./ux_research_001_materials_policy.mjs";

const requiredTags = [
  "single",
  "split",
  "missing_answer",
  "duplicate",
  "near_duplicate",
  "punctuation",
  "non_ascii",
  "choice",
  "recall",
];

function validMaterial() {
  const variants = [
    "single,recall",
    "split,recall",
    "missing_answer,recall",
    "duplicate,recall",
    "near_duplicate,recall",
    "punctuation,recall",
    "non_ascii,recall",
    "choice",
    "single,recall",
    "single,recall",
    "single,recall",
    "single,recall",
  ];
  return `禁止替换为真实工作内容；每行均为虚构。\n${variants
    .map((tags, index) => `N${String(index + 1).padStart(2, "0")} [${tags}] 合成内容`)
    .join("\n")}`;
}

test("accepts a complete synthetic material with every coverage tag", () => {
  assert.deepEqual(
    inspectSyntheticMaterial("material.txt", validMaterial(), {
      note_count: 12,
      required_tags: requiredTags,
    }),
    [],
  );
});

test("rejects missing coverage and an out-of-range note count", () => {
  const findings = inspectSyntheticMaterial(
    "material.txt",
    "禁止替换为真实工作内容；每行均为虚构。\nN01 [single] 合成内容",
    { note_count: 15, required_tags: requiredTags },
  );
  assert.deepEqual(
    findings.map(({ rule }) => rule),
    ["material-note-count", ...requiredTags.slice(1).map(() => "material-missing-coverage")],
  );
});

test("rejects personal contact data and absolute paths", () => {
  const findings = findPrivacyBoundaryViolations(
    "material.txt",
    "联系 demo@example.test，打开 C:\\private\\cards.csv，手机号 13800138000。",
  );
  assert.deepEqual(
    findings.map(({ rule }) => rule),
    ["privacy-email-address", "privacy-windows-absolute-path", "privacy-mainland-mobile-number"],
  );
});

test("rejects file input, persistence, network, and Tauri capabilities", () => {
  const source = `<input type="file"><script>localStorage.x=1;fetch("x");invoke("x")</script>`;
  assert.deepEqual(
    inspectPrototype("prototype.html", source)
      .filter(({ rule }) => !rule.includes("required-boundary-missing"))
      .map(({ rule }) => rule),
    [
      "prototype-file-input",
      "prototype-persistence-local-storage",
      "prototype-network-fetch",
      "prototype-tauri-runtime",
    ],
  );
});

test("rejects identifying or free-text fields in session records", () => {
  const findings = inspectSessionRecord("session.json", {
    participant_code: "person-one",
    participant_name: "example",
    free_text_notes: "example",
    fixed_error_code_counts: {},
    prohibited_data_confirmed_absent: false,
  });
  assert.deepEqual(
    findings.map(({ rule }) => rule),
    [
      "session-prohibited-field",
      "session-prohibited-field",
      "session-participant-code",
      "session-privacy-confirmation",
      "session-error-code-set",
    ],
  );
});

test("requires an incomplete research status and rejects artifact leakage", () => {
  const manifest = {
    schema_version: 1,
    study_id: "UX-RESEARCH-001",
    prototype_version: "ux-research-001-prototype-1",
    status: "complete",
    digest_algorithm: "sha256_lf_utf8",
    synthetic_materials: [{}, {}, {}, {}],
    files: { "prototype.html": "a".repeat(64) },
  };
  assert.deepEqual(
    inspectManifest(manifest, ["manifest.json", "prototype.html"]).map(({ rule }) => rule),
    ["manifest-status-overclaim"],
  );
  assert.equal(
    findArtifactReferences("dist/app.js", "ux-research-001-prototype-1")[0].rule,
    "artifact-contains-research-prototype",
  );
});

async function prototypeDom() {
  const html = await readFile(
    path.resolve(import.meta.dirname, "../docs/learning/ux-research-001/prototype.html"),
    "utf8",
  );
  return new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://research.invalid/",
  });
}

test("prototype completes mapping, preview, learning, and library entirely in memory", async () => {
  const dom = await prototypeDom();
  const { document, Event } = dom.window;
  const consent = document.getElementById("boundary-consent");
  consent.checked = true;
  consent.dispatchEvent(new Event("change", { bubbles: true }));
  document.getElementById("begin-button").click();
  const rows = Array.from(
    { length: 10 },
    (_, index) => `合成问题${index + 1},合成答案${index + 1},recall,,`,
  );
  document.getElementById("csv-input").value = [
    "front,back,format,choices,key",
    ...rows,
  ].join("\n");
  document.getElementById("parse-button").click();
  document.getElementById("preview-button").click();
  assert.equal(document.getElementById("import-button").disabled, false);
  document.getElementById("import-button").click();
  document.getElementById("reveal-button").click();
  assert.equal(document.getElementById("answer-text").hidden, false);
  document.getElementById("library-button").click();
  assert.match(document.getElementById("library-card").textContent, /10 张卡/u);
  assert.equal(dom.window.localStorage.length, 0);
  dom.window.close();
});

test("prototype reports only a fixed delimiter code for malformed rows", async () => {
  const dom = await prototypeDom();
  const { document } = dom.window;
  document.getElementById("csv-input").value = "front,back\n问题,答案,额外列";
  document.getElementById("parse-button").click();
  assert.equal(
    document.getElementById("parse-status").textContent,
    "需要修复：delimiter=1。请检查分隔符、引号和每行列数。",
  );
  assert.equal(document.getElementById("mapping-section").hidden, true);
  dom.window.close();
});
