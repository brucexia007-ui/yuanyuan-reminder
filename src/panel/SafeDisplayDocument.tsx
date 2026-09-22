import { createElement } from "react";
import { petText } from "../pet/petProfile";

import "./safeDisplayDocument.css";

const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES = 32 * 1024;
const MAX_ID_BYTES = 96;

type Provenance =
  | "user_asserted"
  | "tool_verified"
  | "external_content"
  | "model_inferred";
type Confidence = "high" | "medium" | "low" | "unknown";
type Sensitivity = "public" | "personal" | "sensitive" | "restricted";

export type DisplayBlock =
  | { type: "heading"; block_id: string; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; block_id: string; text: string }
  | {
      type: "list";
      block_id: string;
      style: "ordered" | "unordered";
      items: string[];
    }
  | {
      type: "table";
      block_id: string;
      columns: string[];
      rows: string[][];
    }
  | {
      type: "code";
      block_id: string;
      language?: string;
      code: string;
    };

export type DisplayReference = {
  reference_id: string;
  label: string;
  target_text: string;
};

export type DisplayAction = {
  action_id: string;
  kind: "dismiss" | "open_reference" | "copy_code" | "open_task";
  target_id?: string;
};

export type DisplayDocumentV1 = {
  schema_version: 1;
  document_id: string;
  title?: string;
  source_label: string;
  provenance: Provenance;
  confidence: Confidence;
  sensitivity: Sensitivity;
  blocks: DisplayBlock[];
  references: DisplayReference[];
  actions: DisplayAction[];
};

const provenanceLabels: Record<Provenance, string> = {
  user_asserted: "用户提供",
  tool_verified: "工具核验",
  external_content: "外部内容",
  model_inferred: "模型推断",
};

const confidenceLabels: Record<Confidence, string> = {
  high: "高可信",
  medium: "中等可信",
  low: "低可信",
  unknown: "可信度未知",
};

const sensitivityLabels: Record<Sensitivity, string> = {
  public: "公开内容",
  personal: "个人内容",
  sensitive: "敏感内容",
  restricted: "受限内容",
};

const actionLabels: Record<DisplayAction["kind"], string> = {
  dismiss: "收起",
  open_reference: "查看引用",
  copy_code: "复制代码",
  open_task: "查看任务",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function safeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    byteLength(value) <= maximum &&
    !/[\0\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function safeId(value: unknown): value is string {
  return (
    safeText(value, MAX_ID_BYTES) &&
    /^[a-z0-9._-]+$/u.test(value)
  );
}

function parseBlock(value: unknown): DisplayBlock | null {
  if (!isRecord(value) || !safeId(value.block_id)) return null;
  if (value.type === "heading") {
    if (
      (value.level !== 1 && value.level !== 2 && value.level !== 3) ||
      !safeText(value.text, 256)
    ) return null;
    return { type: value.type, block_id: value.block_id, level: value.level, text: value.text };
  }
  if (value.type === "paragraph") {
    if (!safeText(value.text, 4_096)) return null;
    return { type: value.type, block_id: value.block_id, text: value.text };
  }
  if (value.type === "list") {
    if (
      (value.style !== "ordered" && value.style !== "unordered") ||
      !Array.isArray(value.items) ||
      value.items.length < 1 ||
      value.items.length > 32 ||
      !value.items.every((item) => safeText(item, 1_024))
    ) return null;
    return { type: value.type, block_id: value.block_id, style: value.style, items: value.items };
  }
  if (value.type === "table") {
    const columns = value.columns;
    const rows = value.rows;
    if (
      !Array.isArray(columns) ||
      columns.length < 1 ||
      columns.length > 8 ||
      !columns.every((column) => safeText(column, 1_024)) ||
      !Array.isArray(rows) ||
      rows.length > 30 ||
      !rows.every(
        (row) =>
          Array.isArray(row) &&
          row.length === columns.length &&
          row.every((cell) => safeText(cell, 1_024)),
      )
    ) return null;
    return {
      type: value.type,
      block_id: value.block_id,
      columns,
      rows,
    };
  }
  if (value.type === "code") {
    if (
      !safeText(value.code, 8_192) ||
      (value.language !== undefined &&
        value.language !== null &&
        !safeText(value.language, 32))
    ) return null;
    return {
      type: value.type,
      block_id: value.block_id,
      ...(typeof value.language === "string" ? { language: value.language } : {}),
      code: value.code,
    };
  }
  return null;
}

function blockTextBytes(block: DisplayBlock): number {
  if (block.type === "heading" || block.type === "paragraph") return byteLength(block.text);
  if (block.type === "list") return block.items.reduce((sum, item) => sum + byteLength(item), 0);
  if (block.type === "table") {
    return [...block.columns, ...block.rows.flat()].reduce(
      (sum, cell) => sum + byteLength(cell),
      0,
    );
  }
  return byteLength(block.code) + (block.language ? byteLength(block.language) : 0);
}

export function parseDisplayDocument(value: unknown): DisplayDocumentV1 | null {
  if (!isRecord(value)) return null;
  try {
    if (byteLength(JSON.stringify(value)) > MAX_DOCUMENT_BYTES) return null;
  } catch {
    return null;
  }
  if (
    value.schema_version !== 1 ||
    !safeId(value.document_id) ||
    (value.title !== undefined && value.title !== null && !safeText(value.title, 256)) ||
    !safeText(value.source_label, 128) ||
    !["user_asserted", "tool_verified", "external_content", "model_inferred"].includes(
      value.provenance as string,
    ) ||
    !["high", "medium", "low", "unknown"].includes(value.confidence as string) ||
    !["public", "personal", "sensitive", "restricted"].includes(value.sensitivity as string) ||
    !Array.isArray(value.blocks) ||
    value.blocks.length < 1 ||
    value.blocks.length > 64 ||
    !Array.isArray(value.references) ||
    value.references.length > 32 ||
    !Array.isArray(value.actions) ||
    value.actions.length > 16
  ) return null;

  const blocks = value.blocks.map(parseBlock);
  if (blocks.some((block) => block === null)) return null;
  const safeBlocks = blocks as DisplayBlock[];
  const ids = new Set<string>();
  const codeIds = new Set<string>();
  for (const block of safeBlocks) {
    if (ids.has(block.block_id)) return null;
    ids.add(block.block_id);
    if (block.type === "code") codeIds.add(block.block_id);
  }

  const references: DisplayReference[] = [];
  const referenceIds = new Set<string>();
  for (const item of value.references) {
    if (
      !isRecord(item) ||
      !safeId(item.reference_id) ||
      ids.has(item.reference_id) ||
      !safeText(item.label, 256) ||
      !safeText(item.target_text, 2_048)
    ) return null;
    ids.add(item.reference_id);
    referenceIds.add(item.reference_id);
    references.push({
      reference_id: item.reference_id,
      label: item.label,
      target_text: item.target_text,
    });
  }

  const actions: DisplayAction[] = [];
  for (const item of value.actions) {
    if (
      !isRecord(item) ||
      !safeId(item.action_id) ||
      ids.has(item.action_id) ||
      !["dismiss", "open_reference", "copy_code", "open_task"].includes(item.kind as string)
    ) return null;
    const kind = item.kind as DisplayAction["kind"];
    const target = item.target_id;
    if (
      (kind === "dismiss" && target !== undefined && target !== null) ||
      (kind !== "dismiss" && !safeId(target)) ||
      (kind === "open_reference" && !referenceIds.has(target as string)) ||
      (kind === "copy_code" && !codeIds.has(target as string))
    ) return null;
    ids.add(item.action_id);
    actions.push({
      action_id: item.action_id,
      kind,
      ...(typeof target === "string" ? { target_id: target } : {}),
    });
  }

  const title = typeof value.title === "string" ? value.title : undefined;
  const totalText =
    byteLength(value.source_label) +
    (title ? byteLength(title) : 0) +
    safeBlocks.reduce((sum, block) => sum + blockTextBytes(block), 0) +
    references.reduce(
      (sum, reference) =>
        sum + byteLength(reference.label) + byteLength(reference.target_text),
      0,
    );
  if (totalText > MAX_TOTAL_TEXT_BYTES) return null;

  return {
    schema_version: 1,
    document_id: value.document_id,
    ...(title ? { title } : {}),
    source_label: value.source_label,
    provenance: value.provenance as Provenance,
    confidence: value.confidence as Confidence,
    sensitivity: value.sensitivity as Sensitivity,
    blocks: safeBlocks,
    references,
    actions,
  };
}

export function SafeDisplayDocument({
  document,
  onAction,
}: {
  document: unknown;
  onAction?: (action: DisplayAction) => void;
}) {
  // Revalidate on every render. A caller that mutates an object in place must
  // not be able to reuse a previously accepted parse result.
  const parsed = parseDisplayDocument(document);
  if (!parsed) return null;

  return (
    <article className="safe-document" aria-label={parsed.title ?? petText("{pet}展示的信息")}>
      <header className="safe-document__header">
        {parsed.title && <h2>{parsed.title}</h2>}
        <div className="safe-document__provenance" aria-label="内容来源和可信度">
          <span>{parsed.source_label}</span>
          <span>{provenanceLabels[parsed.provenance]}</span>
          <span>{confidenceLabels[parsed.confidence]}</span>
          <span>{sensitivityLabels[parsed.sensitivity]}</span>
        </div>
      </header>
      <div className="safe-document__body">
        {parsed.blocks.map((block) => {
          if (block.type === "heading") {
            return createElement(
              `h${block.level + 2}`,
              { key: block.block_id, id: block.block_id },
              block.text,
            );
          }
          if (block.type === "paragraph") return <p key={block.block_id}>{block.text}</p>;
          if (block.type === "list") {
            const List = block.style === "ordered" ? "ol" : "ul";
            return (
              <List key={block.block_id}>
                {block.items.map((item, index) => <li key={`${block.block_id}-${index}`}>{item}</li>)}
              </List>
            );
          }
          if (block.type === "table") {
            return (
              <div className="safe-document__table-wrap" key={block.block_id}>
                <table>
                  <thead><tr>{block.columns.map((column, index) => <th key={`${block.block_id}-column-${index}`}>{column}</th>)}</tr></thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${block.block_id}-${rowIndex}`}>
                        {row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          return (
            <pre key={block.block_id} id={block.block_id}>
              <code data-language={block.language}>{block.code}</code>
            </pre>
          );
        })}
      </div>
      {parsed.references.length > 0 && (
        <section className="safe-document__references" aria-label="引用">
          {parsed.references.map((reference) => (
            <div key={reference.reference_id} id={reference.reference_id}>
              <strong>{reference.label}</strong>
              <code>{reference.target_text}</code>
            </div>
          ))}
        </section>
      )}
      {parsed.actions.length > 0 && (
        <footer className="safe-document__actions">
          {parsed.actions.map((action) => (
            <button key={action.action_id} type="button" onClick={() => onAction?.(action)}>
              {actionLabels[action.kind]}
            </button>
          ))}
        </footer>
      )}
    </article>
  );
}
