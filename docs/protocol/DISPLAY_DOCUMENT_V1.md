# display_document v1

状态：P0 冻结草案；协议版本：`1`。

`display_document` 是圆圆拨动的独立信息工具所使用的受限文档，不是猫咪对话气泡，也不是通用 Markdown/HTML 容器。Rust 接收端和 React 渲染端都执行允许列表校验。

## 顶层结构

```json
{
  "schema_version": 1,
  "document_id": "answer-1",
  "title": "核验结果",
  "source_label": "本地任务工具",
  "provenance": "tool_verified",
  "confidence": "high",
  "sensitivity": "personal",
  "blocks": [],
  "references": [],
  "actions": []
}
```

来源枚举：`user_asserted`、`tool_verified`、`external_content`、`model_inferred`。可信度枚举：`high`、`medium`、`low`、`unknown`。敏感级别枚举：`public`、`personal`、`sensitive`、`restricted`。

## 安全内容块

- `heading`：`block_id`、1—3 级 `level`、纯文本 `text`；
- `paragraph`：`block_id`、纯文本 `text`；
- `list`：`ordered|unordered` 与 1—32 个纯文本条目；
- `table`：最多 8 列、30 行，行宽必须一致；
- `code`：可选语言标签与纯文本代码，代码上限 8 KiB。

最多 64 个内容块、32 个引用、16 个动作；JSON 上限 64 KiB，累计展示文本上限 32 KiB。全部标识符必须是小写 ASCII、数字、`.`、`_` 或 `-`，并在整份文档中唯一。

## 引用与动作

引用只有 `reference_id`、`label` 和展示用 `target_text`。`target_text` 即使看起来像 URL，也绝不直接渲染为 `href`。

动作只有产品注册的固定枚举：

- `dismiss`：无目标；
- `open_reference`：目标必须是本文件中存在的引用；
- `copy_code`：目标必须是本文件中存在的代码块；
- `open_task`：目标必须是合法的不透明任务标识符。

按钮名称由产品固定，文档不能提供按钮文案、图标、脚本或回调。实际执行仍需由宿主按权限与风险级别处理。

## 渲染安全规则

- 不使用 `dangerouslySetInnerHTML`；
- 不解析 Markdown，不自动生成链接，不加载远程图片、字体、样式或 iframe；
- `<script>`、`<button>`、`[文字](javascript:...)` 等均作为普通文字；
- NUL 与 Unicode 双向文本控制符会令整份文档失败；
- 未知块、未知动作、重复 ID、错目标、超限内容和未知版本均整份拒绝；
- 文档不能指定圆圆动画，也不能出现在猫咪对白气泡中。

Rust 协议位于 `src-tauri/crates/yuanyuan-protocol/src/content.rs`，防御性前端解析与渲染位于 `src/panel/SafeDisplayDocument.tsx`。
