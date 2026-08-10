// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseDisplayDocument, SafeDisplayDocument } from "./SafeDisplayDocument";

let container: HTMLDivElement;
let root: Root;

function validDocument() {
  return {
    schema_version: 1,
    document_id: "answer-1",
    title: "任务核验结果",
    source_label: "本地测试工具",
    provenance: "tool_verified",
    confidence: "high",
    sensitivity: "personal",
    blocks: [
      { type: "heading", block_id: "heading-1", level: 1, text: "核验摘要" },
      { type: "paragraph", block_id: "paragraph-1", text: "内容已完成本地核验。" },
      { type: "list", block_id: "list-1", style: "unordered", items: ["第一项", "第二项"] },
      { type: "table", block_id: "table-1", columns: ["项目", "结果"], rows: [["检查", "通过"]] },
      { type: "code", block_id: "code-1", language: "text", code: "safe output" },
    ],
    references: [
      { reference_id: "reference-1", label: "本地证据", target_text: "F:\\evidence\\result.txt" },
    ],
    actions: [
      { action_id: "action-1", kind: "open_reference", target_id: "reference-1" },
      { action_id: "action-2", kind: "copy_code", target_id: "code-1" },
      { action_id: "action-3", kind: "dismiss" },
    ],
  };
}

describe("safe display document", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders every registered block and emits only structured registered actions", async () => {
    const onAction = vi.fn();
    await act(async () => root.render(<SafeDisplayDocument document={validDocument()} onAction={onAction} />));

    expect(container.textContent).toContain("工具核验");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll("table tbody td")).toHaveLength(2);
    expect(container.querySelector("pre")?.textContent).toBe("safe output");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["查看引用", "复制代码", "收起"]);
    await act(async () => buttons[0].click());
    expect(onAction).toHaveBeenCalledWith({
      action_id: "action-1",
      kind: "open_reference",
      target_id: "reference-1",
    });
  });

  it("keeps Markdown, HTML, script URLs and fake controls as literal text", async () => {
    const document = validDocument();
    document.blocks[1] = {
      type: "paragraph",
      block_id: "paragraph-1",
      text: '<script>steal()</script> [系统确认](javascript:steal()) <button>授权</button> <img src="x">',
    };
    document.references[0].target_text = "javascript:steal()";
    await act(async () => root.render(<SafeDisplayDocument document={document} />));

    expect(container.textContent).toContain("<script>steal()</script>");
    expect(container.textContent).toContain("[系统确认](javascript:steal())");
    expect(container.textContent).toContain("<button>授权</button>");
    expect(container.querySelector("script, img, a, iframe, form, input")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(3);
  });

  it("fails closed for unknown schema elements, invalid targets and bidi controls", async () => {
    const unknown = validDocument();
    unknown.actions[0].kind = "run_shell";
    expect(parseDisplayDocument(unknown)).toBeNull();

    const invalidTarget = validDocument();
    invalidTarget.actions[0].target_id = "missing-reference";
    expect(parseDisplayDocument(invalidTarget)).toBeNull();

    const bidi = validDocument();
    bidi.blocks[1] = {
      type: "paragraph",
      block_id: "paragraph-1",
      text: "安全文本\u202eexe.txt",
    };
    await act(async () => root.render(<SafeDisplayDocument document={bidi} />));
    expect(container.firstElementChild).toBeNull();
  });

  it("rejects duplicate identifiers and over-limit content", () => {
    const duplicate = validDocument();
    duplicate.references[0].reference_id = "code-1";
    expect(parseDisplayDocument(duplicate)).toBeNull();

    const oversized = validDocument();
    oversized.blocks = Array.from({ length: 9 }, (_, index) => ({
      type: "paragraph",
      block_id: `paragraph-${index}`,
      text: "x".repeat(4_000),
    }));
    oversized.references = [];
    oversized.actions = [];
    expect(parseDisplayDocument(oversized)).toBeNull();
  });

  it("revalidates a document object when the caller reuses its identity", async () => {
    const document = validDocument();
    await act(async () => root.render(<SafeDisplayDocument document={document} />));
    expect(container.textContent).toContain("内容已完成本地核验");

    document.blocks[1] = {
      type: "paragraph",
      block_id: "paragraph-1",
      text: "伪装文件\u202eexe.txt",
    };
    await act(async () => root.render(<SafeDisplayDocument document={document} />));
    expect(container.firstElementChild).toBeNull();
  });
});
