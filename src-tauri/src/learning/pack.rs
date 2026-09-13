use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
pub(super) use yuanyuan_learning_pack_spike::ParseProgress;
use yuanyuan_learning_pack_spike::{
    parse_json_with_progress_and_cancel, read_bounded_file_with_progress, ExerciseKind,
    ParseControl, ParsedPack,
};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackEnvelope {
    schema_version: u32,
    pack_id: String,
    version: String,
    title: String,
    description: String,
    rights: RightsDeclaration,
    sources: Vec<SourceDeclaration>,
    content_sha256: String,
    cards: Vec<CardEnvelope>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RightsDeclaration {
    basis: String,
    statement: String,
    redistributable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDeclaration {
    pub source_ref: String,
    pub label: String,
    pub url: Option<String>,
    pub license: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CardEnvelope {
    card_id: String,
    exercise_kind: String,
    prompt: String,
    answer: String,
    #[serde(default)]
    choices: Vec<String>,
    explanation: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    source_refs: Vec<String>,
    schedule_epoch: u32,
    #[serde(default)]
    extensions: BTreeMap<String, ExtensionEnvelope>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExtensionEnvelope {
    version: u32,
    payload: Value,
}

#[derive(Debug, Clone)]
pub struct GenericImportedCard {
    pub card_id: String,
    pub external_card_id: String,
    pub exercise_kind: String,
    pub prompt: String,
    pub answer: String,
    pub choices: Vec<String>,
    pub explanation: Option<String>,
    pub tags: Vec<String>,
    pub source_refs: Vec<String>,
    pub schedule_epoch: u32,
    pub extensions_json: String,
    pub prompt_sha256: String,
    pub answer_sha256: String,
    pub content_sha256: String,
}

#[derive(Debug, Clone)]
pub struct GenericPackImport {
    pub file_sha256: String,
    pub content_sha256: String,
    pub pack_id: String,
    pub version: String,
    pub title: String,
    pub description: String,
    pub rights_basis: String,
    pub rights_statement: String,
    pub redistributable: bool,
    pub sources: Vec<SourceDeclaration>,
    pub cards: Vec<GenericImportedCard>,
}

pub fn parse_file_with_progress_and_cancellation<F, P>(
    path: &Path,
    is_cancelled: &F,
    on_progress: &mut P,
) -> AppResult<GenericPackImport>
where
    F: Fn() -> bool,
    P: FnMut(ParseProgress),
{
    if !path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            name.ends_with(".yuanyuan-learning.json") || name.ends_with(".learning-pack.json")
        })
    {
        return Err(AppError::Validation(
            "generic learning packs must use .yuanyuan-learning.json or .learning-pack.json".into(),
        ));
    }
    let bytes = read_bounded_file_with_progress(path, |progress| {
        on_progress(progress);
        control(is_cancelled)
    })
    .map_err(parser_error)?;
    parse_bytes_with_progress(&bytes, is_cancelled, on_progress)
}

pub fn verify_file_identity_with_progress_and_cancellation<F, P>(
    path: &Path,
    expected_file_sha256: &str,
    is_cancelled: &F,
    on_progress: &mut P,
) -> AppResult<()>
where
    F: Fn() -> bool,
    P: FnMut(ParseProgress),
{
    let bytes = read_bounded_file_with_progress(path, |progress| {
        on_progress(progress);
        control(is_cancelled)
    })
    .map_err(parser_error)?;
    let actual = sha256_hex(&bytes);
    if actual != expected_file_sha256 {
        return Err(AppError::Validation(
            "learning pack file changed after preview; preview it again".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn parse_bytes<F>(bytes: &[u8], is_cancelled: &F) -> AppResult<GenericPackImport>
where
    F: Fn() -> bool,
{
    parse_bytes_with_progress(bytes, is_cancelled, &mut |_| {})
}

fn parse_bytes_with_progress<F, P>(
    bytes: &[u8],
    is_cancelled: &F,
    on_progress: &mut P,
) -> AppResult<GenericPackImport>
where
    F: Fn() -> bool,
    P: FnMut(ParseProgress),
{
    let json_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let parsed = parse_json_with_progress_and_cancel(
        json_bytes,
        |progress| {
            on_progress(progress);
            control(is_cancelled)
        },
        || control(is_cancelled),
    )
    .map_err(parser_error)?;
    let mut value: Value = serde_json::from_slice(json_bytes)
        .map_err(|_| AppError::Validation("learning pack JSON is invalid".into()))?;
    let envelope: PackEnvelope = serde_json::from_value(value.clone()).map_err(|error| {
        AppError::Validation(format!("learning pack metadata is invalid: {error}"))
    })?;
    validate_envelope(&envelope, &parsed)?;
    let declared_hash = envelope.content_sha256.clone();
    value
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("learning pack root must be an object".into()))?
        .remove("contentSha256");
    let computed_hash = sha256_hex(canonical_json(&value).as_bytes());
    if declared_hash != computed_hash {
        return Err(AppError::Validation(format!(
            "learning pack contentSha256 does not match; expected {computed_hash}"
        )));
    }

    let cards = parsed
        .cards
        .into_iter()
        .zip(envelope.cards)
        .map(|(item, metadata)| {
            Ok::<GenericImportedCard, AppError>(GenericImportedCard {
                card_id: item.item_id,
                external_card_id: metadata.card_id,
                exercise_kind: match item.exercise_kind {
                    ExerciseKind::Choice => "choice",
                    ExerciseKind::Recall => "recall",
                }
                .into(),
                prompt: item.prompt_text,
                answer: item.answer_text,
                choices: item.choices,
                explanation: item.explanation_text,
                tags: item.tags,
                source_refs: metadata.source_refs,
                schedule_epoch: item.schedule_epoch,
                extensions_json: serde_json::to_string(&metadata.extensions)?,
                prompt_sha256: item.prompt_sha256,
                answer_sha256: item.answer_sha256,
                content_sha256: item.content_sha256,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(GenericPackImport {
        file_sha256: sha256_hex(bytes),
        content_sha256: computed_hash,
        pack_id: envelope.pack_id,
        version: envelope.version,
        title: envelope.title,
        description: envelope.description,
        rights_basis: envelope.rights.basis,
        rights_statement: envelope.rights.statement,
        redistributable: envelope.rights.redistributable,
        sources: envelope.sources,
        cards,
    })
}

fn validate_envelope(envelope: &PackEnvelope, parsed: &ParsedPack) -> AppResult<()> {
    if envelope.schema_version != 1
        || envelope.pack_id != parsed.pack_id
        || envelope.title != parsed.title
    {
        return Err(AppError::Validation(
            "learning pack identity is inconsistent".into(),
        ));
    }
    if !is_semver(&envelope.version) || envelope.description.chars().count() > 1_000 {
        return Err(AppError::Validation(
            "learning pack version or description is invalid".into(),
        ));
    }
    if envelope.rights.basis == "unknown" {
        return Err(AppError::Validation(
            "learning pack rights are unknown; final import is blocked".into(),
        ));
    }
    if !matches!(
        envelope.rights.basis.as_str(),
        "self_authored" | "public_domain" | "open_license" | "authorized" | "personal_use_only"
    ) || envelope.rights.statement.trim().is_empty()
        || envelope.rights.statement.chars().count() > 2_000
        || (envelope.rights.basis == "personal_use_only" && envelope.rights.redistributable)
    {
        return Err(AppError::Validation(
            "learning pack rights declaration is invalid".into(),
        ));
    }
    if envelope.sources.is_empty()
        || envelope.sources.len() > 128
        || envelope.cards.len() != parsed.cards.len()
    {
        return Err(AppError::Validation(
            "learning pack source or card count is invalid".into(),
        ));
    }
    let mut source_ids = BTreeSet::new();
    for source in &envelope.sources {
        if !valid_id(&source.source_ref)
            || !source_ids.insert(source.source_ref.clone())
            || source.label.trim().is_empty()
            || source.label.chars().count() > 256
            || source.url.as_ref().is_some_and(|url| {
                url.len() > 2_048 || !(url.starts_with("https://") || url.starts_with("http://"))
            })
            || source
                .license
                .as_ref()
                .is_some_and(|license| license.chars().count() > 256)
        {
            return Err(AppError::Validation(
                "learning pack source declaration is invalid".into(),
            ));
        }
    }
    for (index, (card, parsed_card)) in envelope.cards.iter().zip(&parsed.cards).enumerate() {
        if card.card_id != parsed_card.external_card_id
            || card.exercise_kind
                != match parsed_card.exercise_kind {
                    ExerciseKind::Choice => "choice",
                    ExerciseKind::Recall => "recall",
                }
            || card.prompt != parsed_card.prompt_text
            || card.answer != parsed_card.answer_text
            || card.choices != parsed_card.choices
            || card.explanation != parsed_card.explanation_text
            || card.tags != parsed_card.tags
            || card.schedule_epoch != parsed_card.schedule_epoch
            || card.source_refs.is_empty()
            || card.source_refs.len() > 8
            || card.source_refs.iter().collect::<BTreeSet<_>>().len() != card.source_refs.len()
            || card
                .source_refs
                .iter()
                .any(|source| !source_ids.contains(source))
            || card.extensions.values().any(|extension| {
                extension.version == 0
                    || extension.payload.is_null()
                    || !extension_payload_is_portable(&extension.payload)
            })
        {
            return Err(AppError::Validation(format!(
                "learning pack card metadata is invalid at cards[{index}]"
            )));
        }
    }
    Ok(())
}

fn extension_payload_is_portable(value: &Value) -> bool {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Number(number) => number
            .as_i64()
            .map(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER)
            .or_else(|| number.as_u64().map(|value| value <= MAX_SAFE_INTEGER))
            .unwrap_or(false),
        Value::Array(values) => values.iter().all(extension_payload_is_portable),
        Value::Object(values) => values.values().all(extension_payload_is_portable),
    }
}

fn control<F>(is_cancelled: &F) -> ParseControl
where
    F: Fn() -> bool,
{
    if is_cancelled() {
        ParseControl::Cancel
    } else {
        ParseControl::Continue
    }
}

fn parser_error(error: yuanyuan_learning_pack_spike::ValidationError) -> AppError {
    AppError::Validation(format!(
        "learning pack {}: {}",
        error.location, error.message
    ))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_semver(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub(super) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => {
            serde_json::to_string(value).expect("JSON string serialization cannot fail")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_rights_before_import() {
        let bytes = br#"{"schemaVersion":1,"packId":"test.pack","version":"1.0.0","title":"Test","description":"","rights":{"basis":"unknown","statement":"unknown","redistributable":false},"sources":[{"sourceRef":"s1","label":"Notes"}],"contentSha256":"0000000000000000000000000000000000000000000000000000000000000000","cards":[{"cardId":"c1","exerciseKind":"recall","prompt":"Q","answer":"A","sourceRefs":["s1"],"scheduleEpoch":1}]}"#;
        assert!(parse_bytes(bytes, &|| false)
            .unwrap_err()
            .to_string()
            .contains("rights are unknown"));
    }

    #[test]
    fn codex_kimi_and_workbuddy_fixtures_share_the_final_import_contract() {
        let codex = include_bytes!(
            "../../../customization/learning/interop-fixtures/codex.learning-pack.json"
        )
        .to_vec();
        let kimi = [
            vec![0xef, 0xbb, 0xbf],
            include_bytes!(
                "../../../customization/learning/interop-fixtures/kimi.learning-pack.json"
            )
            .to_vec(),
        ]
        .concat();
        let workbuddy = String::from_utf8(
            include_bytes!(
                "../../../customization/learning/interop-fixtures/workbuddy.learning-pack.json"
            )
            .to_vec(),
        )
        .unwrap()
        .replace('\n', "\r\n")
        .into_bytes();
        for bytes in [codex, kimi, workbuddy] {
            let expected_file_sha256 = sha256_hex(&bytes);
            let parsed = parse_bytes(&bytes, &|| false)
                .expect("interop fixture must pass the formal application adapter");
            assert!(parsed.pack_id.starts_with("interop."));
            assert_eq!(parsed.cards.len(), 1);
            assert_eq!(parsed.file_sha256, expected_file_sha256);
        }
    }

    #[test]
    fn canonical_edge_fixture_shares_the_node_generated_hash_contract() {
        let parsed = parse_bytes(
            include_bytes!(
                "../../../customization/learning/interop-fixtures/canonical-edge.learning-pack.json"
            ),
            &|| false,
        )
        .expect("canonical edge fixture must pass the formal application adapter");
        assert_eq!(parsed.pack_id, "interop.canonical-edge");
        assert_eq!(parsed.cards.len(), 1);
    }

    #[test]
    fn canonical_json_orders_astral_keys_by_unicode_code_point() {
        let value = serde_json::json!({ "\u{10000}": 2, "\u{e000}": 1 });
        assert_eq!(canonical_json(&value), "{\"\u{e000}\":1,\"\u{10000}\":2}");
    }

    #[test]
    fn extension_numbers_must_be_cross_tool_safe_integers() {
        for value in [
            serde_json::json!(-0.0),
            serde_json::json!(1.5),
            serde_json::json!(9_007_199_254_740_992_u64),
        ] {
            assert!(!extension_payload_is_portable(&value));
        }
        assert!(extension_payload_is_portable(&serde_json::json!({
            "minimum": -9_007_199_254_740_991_i64,
            "maximum": 9_007_199_254_740_991_u64
        })));
    }
}
