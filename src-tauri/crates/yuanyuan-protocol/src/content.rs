use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const RESPONSE_INTENT_SCHEMA_VERSION: u16 = 1;
pub const DISPLAY_DOCUMENT_SCHEMA_VERSION: u16 = 1;
pub const MAX_RESPONSE_INTENT_BYTES: usize = 8 * 1024;
pub const MAX_DISPLAY_DOCUMENT_BYTES: usize = 64 * 1024;

const MAX_ID_LENGTH: usize = 96;
const MAX_TITLE_LENGTH: usize = 256;
const MAX_SOURCE_LABEL_LENGTH: usize = 128;
const MAX_BLOCKS: usize = 64;
const MAX_REFERENCES: usize = 32;
const MAX_ACTIONS: usize = 16;
const MAX_PARAGRAPH_LENGTH: usize = 4_096;
const MAX_HEADING_LENGTH: usize = 256;
const MAX_LIST_ITEMS: usize = 32;
const MAX_LIST_ITEM_LENGTH: usize = 1_024;
const MAX_TABLE_COLUMNS: usize = 8;
const MAX_TABLE_ROWS: usize = 30;
const MAX_TABLE_CELL_LENGTH: usize = 1_024;
const MAX_CODE_LENGTH: usize = 8_192;
const MAX_LANGUAGE_LENGTH: usize = 32;
const MAX_REFERENCE_LABEL_LENGTH: usize = 256;
const MAX_REFERENCE_TARGET_LENGTH: usize = 2_048;
const MAX_TOTAL_TEXT_LENGTH: usize = 32_768;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseIntentKind {
    QuietPresence,
    Acknowledge,
    Approach,
    StayClose,
    Celebrate,
    NeedsAttention,
    PresentInformation,
    RequestFormalDecision,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponsePriority {
    Background,
    Normal,
    Important,
    Formal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentCompatibility {
    Exact,
    UnknownIntent,
    UnknownSchemaVersion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedResponseIntent {
    pub intent: ResponseIntentKind,
    pub priority: ResponsePriority,
    pub compatibility: IntentCompatibility,
}

pub fn resolve_response_intent_json(
    input: &[u8],
) -> Result<ResolvedResponseIntent, ContentProtocolError> {
    if input.len() > MAX_RESPONSE_INTENT_BYTES {
        return Err(ContentProtocolError::InputTooLarge);
    }
    let value: Value =
        serde_json::from_slice(input).map_err(|_| ContentProtocolError::InvalidJson)?;
    let object = value
        .as_object()
        .ok_or(ContentProtocolError::DocumentMustBeObject)?;
    let schema_version = object
        .get("schema_version")
        .and_then(Value::as_u64)
        .and_then(|version| u16::try_from(version).ok());
    if schema_version != Some(RESPONSE_INTENT_SCHEMA_VERSION) {
        return Ok(quiet_fallback(IntentCompatibility::UnknownSchemaVersion));
    }
    let priority = object
        .get("priority")
        .and_then(Value::as_str)
        .and_then(parse_priority)
        .unwrap_or(ResponsePriority::Normal);
    let Some(intent) = object
        .get("intent")
        .and_then(Value::as_str)
        .and_then(parse_intent)
    else {
        return Ok(quiet_fallback(IntentCompatibility::UnknownIntent));
    };
    Ok(ResolvedResponseIntent {
        intent,
        priority,
        compatibility: IntentCompatibility::Exact,
    })
}

fn quiet_fallback(compatibility: IntentCompatibility) -> ResolvedResponseIntent {
    ResolvedResponseIntent {
        intent: ResponseIntentKind::QuietPresence,
        priority: ResponsePriority::Background,
        compatibility,
    }
}

fn parse_intent(value: &str) -> Option<ResponseIntentKind> {
    match value {
        "quiet_presence" => Some(ResponseIntentKind::QuietPresence),
        "acknowledge" => Some(ResponseIntentKind::Acknowledge),
        "approach" => Some(ResponseIntentKind::Approach),
        "stay_close" => Some(ResponseIntentKind::StayClose),
        "celebrate" => Some(ResponseIntentKind::Celebrate),
        "needs_attention" => Some(ResponseIntentKind::NeedsAttention),
        "present_information" => Some(ResponseIntentKind::PresentInformation),
        "request_formal_decision" => Some(ResponseIntentKind::RequestFormalDecision),
        _ => None,
    }
}

fn parse_priority(value: &str) -> Option<ResponsePriority> {
    match value {
        "background" => Some(ResponsePriority::Background),
        "normal" => Some(ResponsePriority::Normal),
        "important" => Some(ResponsePriority::Important),
        "formal" => Some(ResponsePriority::Formal),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisplayDocumentV1 {
    pub schema_version: u16,
    pub document_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub source_label: String,
    pub provenance: DocumentProvenance,
    pub confidence: DocumentConfidence,
    pub sensitivity: DocumentSensitivity,
    pub blocks: Vec<DisplayBlock>,
    #[serde(default)]
    pub references: Vec<DocumentReference>,
    #[serde(default)]
    pub actions: Vec<DocumentAction>,
}

impl DisplayDocumentV1 {
    pub fn parse_and_validate(input: &[u8]) -> Result<Self, ContentProtocolError> {
        if input.len() > MAX_DISPLAY_DOCUMENT_BYTES {
            return Err(ContentProtocolError::InputTooLarge);
        }
        let document: Self =
            serde_json::from_slice(input).map_err(|_| ContentProtocolError::InvalidJson)?;
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> Result<(), ContentProtocolError> {
        if self.schema_version != DISPLAY_DOCUMENT_SCHEMA_VERSION {
            return Err(ContentProtocolError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        validate_id("document_id", &self.document_id)?;
        validate_optional_text("title", self.title.as_deref(), MAX_TITLE_LENGTH)?;
        validate_text("source_label", &self.source_label, MAX_SOURCE_LABEL_LENGTH)?;
        if self.blocks.is_empty() {
            return Err(ContentProtocolError::EmptyBlocks);
        }
        if self.blocks.len() > MAX_BLOCKS {
            return Err(ContentProtocolError::TooManyItems("blocks"));
        }
        if self.references.len() > MAX_REFERENCES {
            return Err(ContentProtocolError::TooManyItems("references"));
        }
        if self.actions.len() > MAX_ACTIONS {
            return Err(ContentProtocolError::TooManyItems("actions"));
        }

        let mut ids = HashSet::new();
        let mut code_blocks = HashSet::new();
        let mut total_text = self.title.as_ref().map_or(0, String::len) + self.source_label.len();
        for block in &self.blocks {
            let id = block.block_id();
            validate_id("block_id", id)?;
            insert_unique(&mut ids, id)?;
            total_text += block.validate()?;
            if matches!(block, DisplayBlock::Code { .. }) {
                code_blocks.insert(id.as_str());
            }
        }

        let mut reference_ids = HashSet::new();
        for reference in &self.references {
            validate_id("reference_id", &reference.reference_id)?;
            insert_unique(&mut ids, &reference.reference_id)?;
            reference_ids.insert(reference.reference_id.as_str());
            validate_text(
                "reference.label",
                &reference.label,
                MAX_REFERENCE_LABEL_LENGTH,
            )?;
            validate_text(
                "reference.target_text",
                &reference.target_text,
                MAX_REFERENCE_TARGET_LENGTH,
            )?;
            total_text += reference.label.len() + reference.target_text.len();
        }

        for action in &self.actions {
            validate_id("action_id", &action.action_id)?;
            insert_unique(&mut ids, &action.action_id)?;
            match action.kind {
                DisplayActionKind::Dismiss => {
                    if action.target_id.is_some() {
                        return Err(ContentProtocolError::UnexpectedActionTarget);
                    }
                }
                DisplayActionKind::OpenReference => {
                    let target = action
                        .target_id
                        .as_deref()
                        .ok_or(ContentProtocolError::MissingActionTarget)?;
                    if !reference_ids.contains(target) {
                        return Err(ContentProtocolError::UnknownActionTarget);
                    }
                }
                DisplayActionKind::CopyCode => {
                    let target = action
                        .target_id
                        .as_deref()
                        .ok_or(ContentProtocolError::MissingActionTarget)?;
                    if !code_blocks.contains(target) {
                        return Err(ContentProtocolError::UnknownActionTarget);
                    }
                }
                DisplayActionKind::OpenTask => {
                    let target = action
                        .target_id
                        .as_deref()
                        .ok_or(ContentProtocolError::MissingActionTarget)?;
                    validate_id("action.target_id", target)?;
                }
            }
        }

        if total_text > MAX_TOTAL_TEXT_LENGTH {
            return Err(ContentProtocolError::TotalTextTooLarge);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentProvenance {
    UserAsserted,
    ToolVerified,
    ExternalContent,
    ModelInferred,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentConfidence {
    High,
    Medium,
    Low,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentSensitivity {
    Public,
    Personal,
    Sensitive,
    Restricted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DisplayBlock {
    Heading {
        block_id: String,
        level: u8,
        text: String,
    },
    Paragraph {
        block_id: String,
        text: String,
    },
    List {
        block_id: String,
        style: ListStyle,
        items: Vec<String>,
    },
    Table {
        block_id: String,
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Code {
        block_id: String,
        #[serde(default)]
        language: Option<String>,
        code: String,
    },
}

impl DisplayBlock {
    fn block_id(&self) -> &String {
        match self {
            Self::Heading { block_id, .. }
            | Self::Paragraph { block_id, .. }
            | Self::List { block_id, .. }
            | Self::Table { block_id, .. }
            | Self::Code { block_id, .. } => block_id,
        }
    }

    fn validate(&self) -> Result<usize, ContentProtocolError> {
        match self {
            Self::Heading { level, text, .. } => {
                if !(1..=3).contains(level) {
                    return Err(ContentProtocolError::InvalidHeadingLevel(*level));
                }
                validate_text("heading.text", text, MAX_HEADING_LENGTH)?;
                Ok(text.len())
            }
            Self::Paragraph { text, .. } => {
                validate_text("paragraph.text", text, MAX_PARAGRAPH_LENGTH)?;
                Ok(text.len())
            }
            Self::List { items, .. } => {
                if items.is_empty() || items.len() > MAX_LIST_ITEMS {
                    return Err(ContentProtocolError::InvalidCollectionSize("list.items"));
                }
                let mut size = 0;
                for item in items {
                    validate_text("list.item", item, MAX_LIST_ITEM_LENGTH)?;
                    size += item.len();
                }
                Ok(size)
            }
            Self::Table { columns, rows, .. } => {
                if columns.is_empty() || columns.len() > MAX_TABLE_COLUMNS {
                    return Err(ContentProtocolError::InvalidCollectionSize("table.columns"));
                }
                if rows.len() > MAX_TABLE_ROWS {
                    return Err(ContentProtocolError::InvalidCollectionSize("table.rows"));
                }
                let mut size = 0;
                for column in columns {
                    validate_text("table.column", column, MAX_TABLE_CELL_LENGTH)?;
                    size += column.len();
                }
                for row in rows {
                    if row.len() != columns.len() {
                        return Err(ContentProtocolError::TableWidthMismatch);
                    }
                    for cell in row {
                        validate_text("table.cell", cell, MAX_TABLE_CELL_LENGTH)?;
                        size += cell.len();
                    }
                }
                Ok(size)
            }
            Self::Code { language, code, .. } => {
                validate_optional_text("code.language", language.as_deref(), MAX_LANGUAGE_LENGTH)?;
                validate_text("code.code", code, MAX_CODE_LENGTH)?;
                Ok(code.len() + language.as_ref().map_or(0, String::len))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ListStyle {
    Unordered,
    Ordered,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentReference {
    pub reference_id: String,
    pub label: String,
    /// Display-only address or local evidence description. It is never rendered
    /// as an href and cannot be opened without a separate registered action.
    pub target_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentAction {
    pub action_id: String,
    pub kind: DisplayActionKind,
    #[serde(default)]
    pub target_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DisplayActionKind {
    Dismiss,
    OpenReference,
    CopyCode,
    OpenTask,
}

fn validate_id(field: &'static str, value: &str) -> Result<(), ContentProtocolError> {
    validate_text(field, value, MAX_ID_LENGTH)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
    {
        return Err(ContentProtocolError::InvalidIdentifier(field));
    }
    Ok(())
}

fn validate_text(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), ContentProtocolError> {
    if value.trim().is_empty() {
        return Err(ContentProtocolError::BlankField(field));
    }
    if value.len() > maximum {
        return Err(ContentProtocolError::FieldTooLong { field, maximum });
    }
    if value.chars().any(is_unsafe_control) {
        return Err(ContentProtocolError::UnsafeControlCharacter(field));
    }
    Ok(())
}

fn validate_optional_text(
    field: &'static str,
    value: Option<&str>,
    maximum: usize,
) -> Result<(), ContentProtocolError> {
    if let Some(value) = value {
        validate_text(field, value, maximum)?;
    }
    Ok(())
}

fn is_unsafe_control(character: char) -> bool {
    matches!(
        character,
        '\0' | '\u{202a}'
            | '\u{202b}'
            | '\u{202c}'
            | '\u{202d}'
            | '\u{202e}'
            | '\u{2066}'
            | '\u{2067}'
            | '\u{2068}'
            | '\u{2069}'
    )
}

fn insert_unique<'a>(
    ids: &mut HashSet<&'a str>,
    value: &'a str,
) -> Result<(), ContentProtocolError> {
    if !ids.insert(value) {
        return Err(ContentProtocolError::DuplicateIdentifier);
    }
    Ok(())
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContentProtocolError {
    #[error("content protocol input exceeds its byte limit")]
    InputTooLarge,
    #[error("content protocol input is not valid JSON")]
    InvalidJson,
    #[error("content protocol input must be an object")]
    DocumentMustBeObject,
    #[error("unsupported content schema version {0}")]
    UnsupportedSchemaVersion(u16),
    #[error("{0} must not be blank")]
    BlankField(&'static str),
    #[error("{field} exceeds its maximum length of {maximum}")]
    FieldTooLong { field: &'static str, maximum: usize },
    #[error("{0} contains an unsafe control character")]
    UnsafeControlCharacter(&'static str),
    #[error("{0} is not a valid lowercase identifier")]
    InvalidIdentifier(&'static str),
    #[error("display document requires at least one block")]
    EmptyBlocks,
    #[error("too many {0}")]
    TooManyItems(&'static str),
    #[error("invalid item count for {0}")]
    InvalidCollectionSize(&'static str),
    #[error("heading level {0} is outside 1 through 3")]
    InvalidHeadingLevel(u8),
    #[error("table row width does not match its columns")]
    TableWidthMismatch,
    #[error("document identifiers must be unique")]
    DuplicateIdentifier,
    #[error("display action requires a target")]
    MissingActionTarget,
    #[error("display action does not accept a target")]
    UnexpectedActionTarget,
    #[error("display action target does not exist or has the wrong type")]
    UnknownActionTarget,
    #[error("display document total text exceeds its limit")]
    TotalTextTooLarge,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn valid_document_value() -> Value {
        json!({
            "schema_version": 1,
            "document_id": "document-1",
            "title": "构建结果",
            "source_label": "本地构建工具",
            "provenance": "tool_verified",
            "confidence": "high",
            "sensitivity": "personal",
            "blocks": [
                {"type": "heading", "block_id": "heading-1", "level": 2, "text": "检查结果"},
                {"type": "paragraph", "block_id": "paragraph-1", "text": "所有检查均已完成。"},
                {"type": "list", "block_id": "list-1", "style": "unordered", "items": ["前端通过", "后端通过"]},
                {"type": "table", "block_id": "table-1", "columns": ["项目", "状态"], "rows": [["测试", "通过"]]},
                {"type": "code", "block_id": "code-1", "language": "text", "code": "cargo test"}
            ],
            "references": [
                {"reference_id": "reference-1", "label": "构建记录", "target_text": "https://example.invalid/build/1"}
            ],
            "actions": [
                {"action_id": "action-copy", "kind": "copy_code", "target_id": "code-1"},
                {"action_id": "action-open", "kind": "open_reference", "target_id": "reference-1"},
                {"action_id": "action-dismiss", "kind": "dismiss"}
            ]
        })
    }

    #[test]
    fn resolves_known_intents_and_ignores_extra_fields() {
        let result = resolve_response_intent_json(
            br#"{"schema_version":1,"intent":"stay_close","priority":"important","future":true}"#,
        )
        .unwrap();
        assert_eq!(result.intent, ResponseIntentKind::StayClose);
        assert_eq!(result.priority, ResponsePriority::Important);
        assert_eq!(result.compatibility, IntentCompatibility::Exact);
    }

    #[test]
    fn unknown_intent_or_version_falls_back_to_quiet_presence() {
        for input in [
            br#"{"schema_version":1,"intent":"speak_like_a_human","priority":"formal"}"#.as_slice(),
            br#"{"schema_version":99,"intent":"celebrate","priority":"important"}"#.as_slice(),
        ] {
            let result = resolve_response_intent_json(input).unwrap();
            assert_eq!(result.intent, ResponseIntentKind::QuietPresence);
            assert_eq!(result.priority, ResponsePriority::Background);
            assert_ne!(result.compatibility, IntentCompatibility::Exact);
        }
    }

    #[test]
    fn valid_document_supports_every_safe_block_and_registered_action() {
        let bytes = serde_json::to_vec(&valid_document_value()).unwrap();
        let document = DisplayDocumentV1::parse_and_validate(&bytes).unwrap();
        assert_eq!(document.blocks.len(), 5);
        assert_eq!(document.references.len(), 1);
        assert_eq!(document.actions.len(), 3);
    }

    #[test]
    fn markdown_html_urls_and_fake_buttons_remain_literal_text() {
        let mut value = valid_document_value();
        value["blocks"][1]["text"] = json!(
            "<script>alert(1)</script> [系统确认](javascript:steal()) <button>立即允许</button> https://evil.invalid"
        );
        let document =
            DisplayDocumentV1::parse_and_validate(&serde_json::to_vec(&value).unwrap()).unwrap();
        let DisplayBlock::Paragraph { text, .. } = &document.blocks[1] else {
            panic!("expected paragraph")
        };
        assert!(text.contains("<script>"));
        assert!(text.contains("javascript:steal"));
        assert!(text.contains("<button>"));
    }

    #[test]
    fn actions_can_only_target_matching_registered_objects() {
        let mut value = valid_document_value();
        value["actions"][0]["target_id"] = json!("paragraph-1");
        let document: DisplayDocumentV1 = serde_json::from_value(value).unwrap();
        assert_eq!(
            document.validate(),
            Err(ContentProtocolError::UnknownActionTarget)
        );
    }

    #[test]
    fn duplicate_ids_and_unsafe_bidi_controls_are_rejected() {
        let mut duplicate = valid_document_value();
        duplicate["blocks"][1]["block_id"] = json!("heading-1");
        let document: DisplayDocumentV1 = serde_json::from_value(duplicate).unwrap();
        assert_eq!(
            document.validate(),
            Err(ContentProtocolError::DuplicateIdentifier)
        );

        let mut bidi = valid_document_value();
        bidi["blocks"][1]["text"] = json!("安全文本\u{202e}exe.txt");
        let document: DisplayDocumentV1 = serde_json::from_value(bidi).unwrap();
        assert_eq!(
            document.validate(),
            Err(ContentProtocolError::UnsafeControlCharacter(
                "paragraph.text"
            ))
        );
    }

    #[test]
    fn malformed_tables_and_unbounded_collections_are_rejected() {
        let mut table = valid_document_value();
        table["blocks"][3]["rows"] = json!([["missing second cell"]]);
        let document: DisplayDocumentV1 = serde_json::from_value(table).unwrap();
        assert_eq!(
            document.validate(),
            Err(ContentProtocolError::TableWidthMismatch)
        );

        let mut list = valid_document_value();
        list["blocks"][2]["items"] = Value::Array(
            (0..33)
                .map(|index| json!(format!("item-{index}")))
                .collect(),
        );
        let document: DisplayDocumentV1 = serde_json::from_value(list).unwrap();
        assert_eq!(
            document.validate(),
            Err(ContentProtocolError::InvalidCollectionSize("list.items"))
        );
    }

    #[test]
    fn oversized_payloads_and_total_text_are_rejected() {
        assert_eq!(
            DisplayDocumentV1::parse_and_validate(&vec![b'x'; MAX_DISPLAY_DOCUMENT_BYTES + 1]),
            Err(ContentProtocolError::InputTooLarge)
        );

        let mut value = valid_document_value();
        value["blocks"] = Value::Array(
            (0..9)
                .map(|index| {
                    json!({
                        "type": "paragraph",
                        "block_id": format!("paragraph-{index}"),
                        "text": "x".repeat(4_000)
                    })
                })
                .collect(),
        );
        value["references"] = json!([]);
        value["actions"] = json!([]);
        let document: DisplayDocumentV1 = serde_json::from_value(value).unwrap();
        assert_eq!(
            document.validate(),
            Err(ContentProtocolError::TotalTextTooLarge)
        );
    }
}
