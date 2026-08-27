use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
};

use csv::{ReaderBuilder, StringRecord, Trim};
use serde::Serialize;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, AppResult};

use super::models::{ImportProgressHint, ImportedCard, ParsedUserImport};

pub(super) const MAX_IMPORT_BYTES: usize = 25 * 1024 * 1024;
pub(super) const MAX_IMPORT_ROWS: usize = 20_000;
const IMPORT_READ_CHUNK_BYTES: usize = 64 * 1024;
const USER_PACK_NAMESPACE: &str = "user.local";
const REQUIRED_HEADER: &str = "headword";
const ALLOWED_HEADERS: [&str; 7] = [
    "headword",
    "meanings_zh",
    "phonetic",
    "part_of_speech",
    "word_family",
    "progress_hint",
    "source_label",
];

#[allow(dead_code)]
pub fn parse_user_csv(bytes: &[u8]) -> AppResult<ParsedUserImport> {
    parse_user_csv_with_cancellation(bytes, &|| false)
}

pub(super) fn parse_user_csv_with_cancellation<F>(
    bytes: &[u8],
    is_cancelled: &F,
) -> AppResult<ParsedUserImport>
where
    F: Fn() -> bool,
{
    ensure_import_not_cancelled(is_cancelled)?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORT_BYTES {
        return Err(AppError::Validation(
            "learning import size is outside the allowed range".into(),
        ));
    }
    std::str::from_utf8(bytes)
        .map_err(|_| AppError::Validation("learning import must be UTF-8".into()))?;
    let file_sha256 = sha256_hex(bytes);
    let mut reader = ReaderBuilder::new()
        .trim(Trim::All)
        .flexible(false)
        .from_reader(bytes);
    let headers = reader
        .headers()
        .map_err(|_| AppError::Validation("learning CSV header is invalid".into()))?
        .clone();
    let header_map = validate_headers(&headers)?;
    let mut cards = Vec::new();
    let mut normalized_seen = BTreeSet::new();
    let mut source_label: Option<String> = None;
    for (index, record) in reader.records().enumerate() {
        ensure_import_not_cancelled(is_cancelled)?;
        if index >= MAX_IMPORT_ROWS {
            return Err(AppError::Validation(
                "learning import row count exceeds the limit".into(),
            ));
        }
        let record =
            record.map_err(|_| AppError::Validation("learning CSV row is malformed".into()))?;
        let card = parse_record(&record, &header_map)?;
        if !normalized_seen.insert(card.normalized_headword.clone()) {
            return Err(AppError::Validation(
                "learning import contains duplicate normalized headwords".into(),
            ));
        }
        if let Some(label) = optional_cell(&record, &header_map, "source_label")? {
            validate_display_text(label, 160)?;
            match source_label.as_deref() {
                Some(existing) if existing != label => {
                    return Err(AppError::Validation(
                        "learning import source_label must be identical on every row".into(),
                    ));
                }
                None => source_label = Some(label.to_owned()),
                _ => {}
            }
        }
        cards.push(card);
    }
    if cards.is_empty() {
        return Err(AppError::Validation(
            "learning import must contain at least one card".into(),
        ));
    }
    ensure_import_not_cancelled(is_cancelled)?;
    let suffix = file_sha256[..16].to_owned();
    Ok(ParsedUserImport {
        file_sha256,
        pack_id: format!("user-import-{suffix}"),
        source_id: format!("user-import-{suffix}"),
        source_label: source_label.unwrap_or_else(|| "用户导入".into()),
        cards,
    })
}

#[allow(dead_code)]
pub fn read_bounded_import_file(path: &Path) -> AppResult<Vec<u8>> {
    read_bounded_import_file_with_cancellation(path, &|| false)
}

pub(super) fn read_bounded_import_file_with_cancellation<F>(
    path: &Path,
    is_cancelled: &F,
) -> AppResult<Vec<u8>>
where
    F: Fn() -> bool,
{
    ensure_import_not_cancelled(is_cancelled)?;
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("csv"))
    {
        return Err(AppError::Validation(
            "learning import file type is unsupported".into(),
        ));
    }
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMPORT_BYTES as u64 {
        return Err(AppError::Validation(
            "learning import size is outside the allowed range".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut chunk = [0_u8; IMPORT_READ_CHUNK_BYTES];
    loop {
        ensure_import_not_cancelled(is_cancelled)?;
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > MAX_IMPORT_BYTES {
            return Err(AppError::Validation(
                "learning import size is outside the allowed range".into(),
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    ensure_import_not_cancelled(is_cancelled)?;
    Ok(bytes)
}

pub(super) fn ensure_import_not_cancelled<F>(is_cancelled: &F) -> AppResult<()>
where
    F: Fn() -> bool,
{
    if is_cancelled() {
        return Err(AppError::Validation("learning import was cancelled".into()));
    }
    Ok(())
}

pub fn normalize_headword(value: &str) -> AppResult<String> {
    validate_no_controls_or_formula(value, 128)?;
    let mut output = String::new();
    let mut pending_space = false;
    for character in value.nfkc() {
        let character = match character {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
            '\u{2018}' | '\u{2019}' => '\'',
            other => other,
        };
        if character.is_whitespace() {
            pending_space = !output.is_empty();
            continue;
        }
        if pending_space {
            output.push(' ');
            pending_space = false;
        }
        let lower = character.to_ascii_lowercase();
        if !(lower.is_ascii_lowercase() || matches!(lower, ' ' | '-' | '\'')) {
            return Err(AppError::Validation(
                "learning headword contains unsupported characters".into(),
            ));
        }
        output.push(lower);
    }
    let normalized = output.trim().to_owned();
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized.bytes().any(|byte| byte.is_ascii_lowercase())
    {
        return Err(AppError::Validation(
            "learning headword is empty or invalid".into(),
        ));
    }
    Ok(normalized)
}

fn validate_headers(headers: &StringRecord) -> AppResult<BTreeMap<String, usize>> {
    let mut map = BTreeMap::new();
    for (index, header) in headers.iter().enumerate() {
        if !ALLOWED_HEADERS.contains(&header) || map.insert(header.to_owned(), index).is_some() {
            return Err(AppError::Validation(
                "learning CSV contains an unknown or duplicate header".into(),
            ));
        }
    }
    if !map.contains_key(REQUIRED_HEADER) || !map.contains_key("meanings_zh") {
        return Err(AppError::Validation(
            "learning CSV requires headword and meanings_zh".into(),
        ));
    }
    Ok(map)
}

fn parse_record(
    record: &StringRecord,
    headers: &BTreeMap<String, usize>,
) -> AppResult<ImportedCard> {
    let headword = required_cell(record, headers, "headword")?;
    validate_display_text(headword, 128)?;
    let normalized_headword = normalize_headword(headword)?;
    let meanings_zh = split_cell(
        required_cell(record, headers, "meanings_zh")?,
        2,
        160,
        false,
    )?;
    let phonetic = optional_cell(record, headers, "phonetic")?
        .map(|value| {
            validate_display_text(value, 160)?;
            Ok::<String, AppError>(value.to_owned())
        })
        .transpose()?;
    let part_of_speech = optional_cell(record, headers, "part_of_speech")?
        .map(|value| split_cell(value, 8, 32, false))
        .transpose()?
        .unwrap_or_else(|| vec!["unknown".into()]);
    let word_family = optional_cell(record, headers, "word_family")?
        .map(|value| split_word_family(value))
        .transpose()?
        .unwrap_or_default();
    let progress_hint = match optional_cell(record, headers, "progress_hint")? {
        None | Some("new") => ImportProgressHint::New,
        Some("learning") => ImportProgressHint::Learning,
        Some("review_known") => ImportProgressHint::ReviewKnown,
        Some(_) => {
            return Err(AppError::Validation(
                "learning import progress_hint is unsupported".into(),
            ));
        }
    };
    #[derive(Serialize)]
    struct CanonicalCard<'a> {
        normalized_headword: &'a str,
        phonetic: &'a Option<String>,
        part_of_speech: &'a [String],
        meanings_zh: &'a [String],
        word_family: &'a [String],
    }
    let canonical = serde_json::to_vec(&CanonicalCard {
        normalized_headword: &normalized_headword,
        phonetic: &phonetic,
        part_of_speech: &part_of_speech,
        meanings_zh: &meanings_zh,
        word_family: &word_family,
    })?;
    Ok(ImportedCard {
        card_id: stable_card_id(USER_PACK_NAMESPACE, &normalized_headword),
        headword: headword.to_owned(),
        normalized_headword,
        phonetic,
        part_of_speech,
        meanings_zh,
        word_family,
        progress_hint,
        content_sha256: sha256_hex(&canonical),
    })
}

fn split_word_family(value: &str) -> AppResult<Vec<String>> {
    let values = split_cell(value, 3, 128, true)?;
    let mut unique = BTreeSet::new();
    let mut result = Vec::new();
    for value in values {
        let normalized = normalize_headword(&value)?;
        if unique.insert(normalized.clone()) {
            result.push(normalized);
        }
    }
    Ok(result)
}

fn split_cell(
    value: &str,
    maximum_items: usize,
    maximum_item_chars: usize,
    allow_empty: bool,
) -> AppResult<Vec<String>> {
    if value.is_empty() && allow_empty {
        return Ok(Vec::new());
    }
    let values = value
        .split('|')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| {
            validate_display_text(item, maximum_item_chars)?;
            Ok(item.to_owned())
        })
        .collect::<AppResult<Vec<_>>>()?;
    if values.is_empty() || values.len() > maximum_items {
        return Err(AppError::Validation(
            "learning import list field has an invalid item count".into(),
        ));
    }
    Ok(values)
}

fn required_cell<'a>(
    record: &'a StringRecord,
    headers: &BTreeMap<String, usize>,
    name: &str,
) -> AppResult<&'a str> {
    optional_cell(record, headers, name)?
        .ok_or_else(|| AppError::Validation(format!("learning import requires non-empty {name}")))
}

fn optional_cell<'a>(
    record: &'a StringRecord,
    headers: &BTreeMap<String, usize>,
    name: &str,
) -> AppResult<Option<&'a str>> {
    let Some(index) = headers.get(name).copied() else {
        return Ok(None);
    };
    let value = record
        .get(index)
        .ok_or_else(|| AppError::Validation("learning CSV row has missing fields".into()))?
        .trim();
    Ok((!value.is_empty()).then_some(value))
}

fn validate_display_text(value: &str, maximum_chars: usize) -> AppResult<()> {
    validate_no_controls_or_formula(value, maximum_chars)?;
    if value.trim().is_empty() {
        return Err(AppError::Validation(
            "learning import contains an empty display field".into(),
        ));
    }
    Ok(())
}

fn validate_no_controls_or_formula(value: &str, maximum_chars: usize) -> AppResult<()> {
    if value.chars().count() > maximum_chars
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{202a}'
                        ..='\u{202e}' | '\u{2066}'
                        ..='\u{2069}' | '\u{200e}' | '\u{200f}'
                )
        })
        || value
            .trim_start()
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '=' | '+' | '-' | '@'))
    {
        return Err(AppError::Validation(
            "learning import contains unsafe or oversized text".into(),
        ));
    }
    Ok(())
}

fn stable_card_id(namespace: &str, normalized_headword: &str) -> String {
    sha256_hex(format!("{namespace}\0{normalized_headword}").as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn csv_preview_is_deterministic_and_normalizes_safe_headwords() {
        let bytes = "headword,meanings_zh,phonetic,part_of_speech,word_family,progress_hint,source_label\nAddress,\"处理|地址\",/e'dres/,verb,addressable|addressing,learning,My list\n\"take  off\",起飞,,verb,,review_known,My list\n".as_bytes();
        let first = parse_user_csv(bytes).unwrap();
        let second = parse_user_csv(bytes).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.cards.len(), 2);
        assert_eq!(first.cards[0].normalized_headword, "address");
        assert_eq!(first.cards[0].meanings_zh, ["处理", "地址"]);
        assert_eq!(first.cards[1].normalized_headword, "take off");
        assert_eq!(first.cards[1].progress_hint.initial_due_offset_days(), 7);
        assert_eq!(first.cards[0].card_id.len(), 64);
    }

    #[test]
    fn fullwidth_and_typographic_punctuation_have_one_stable_form() {
        assert_eq!(normalize_headword(" ＣＡＮ’Ｔ ").unwrap(), "can't");
        assert_eq!(
            normalize_headword("decision‐making").unwrap(),
            "decision-making"
        );
    }

    #[test]
    fn duplicates_unknown_headers_and_formula_cells_fail_closed() {
        assert!(parse_user_csv(b"headword,meanings_zh\nWord,one\nword,two\n").is_err());
        assert!(parse_user_csv(b"headword,meanings_zh,extra\nword,one,no\n").is_err());
        assert!(parse_user_csv(b"headword,meanings_zh\nword,=HYPERLINK(x)\n").is_err());
    }

    #[test]
    fn non_utf8_empty_and_row_limit_fail_closed() {
        assert!(parse_user_csv(&[0xff, 0xfe]).is_err());
        assert!(parse_user_csv(b"headword,meanings_zh\n").is_err());
        let mut bytes = b"headword,meanings_zh\n".to_vec();
        for index in 0..MAX_IMPORT_ROWS {
            let mut value = index;
            let mut suffix = String::new();
            loop {
                suffix.push((b'a' + (value % 26) as u8) as char);
                value /= 26;
                if value == 0 {
                    break;
                }
            }
            bytes.extend_from_slice(format!("word{suffix},meaning\n").as_bytes());
        }
        assert_eq!(parse_user_csv(&bytes).unwrap().cards.len(), MAX_IMPORT_ROWS);
        bytes.extend_from_slice(b"wordoverflow,meaning\n");
        assert!(parse_user_csv(&bytes).is_err());
    }

    #[test]
    fn csv_parsing_can_be_cancelled_cooperatively() {
        use std::cell::Cell;

        let mut bytes = b"headword,meanings_zh\n".to_vec();
        for index in 0..1_000 {
            let mut value = index;
            let mut suffix = String::new();
            loop {
                suffix.push((b'a' + (value % 26) as u8) as char);
                value /= 26;
                if value == 0 {
                    break;
                }
            }
            bytes.extend_from_slice(format!("word{suffix},meaning\n").as_bytes());
        }
        let checks = Cell::new(0_u32);
        let error = parse_user_csv_with_cancellation(&bytes, &|| {
            checks.set(checks.get() + 1);
            checks.get() >= 100
        })
        .unwrap_err();

        assert!(error.to_string().contains("learning import was cancelled"));
        assert_eq!(checks.get(), 100);
    }

    #[test]
    fn bounded_file_reader_accepts_only_regular_csv_files_within_limit() {
        let directory = tempdir().unwrap();
        let valid_path = directory.path().join("words.CSV");
        std::fs::write(&valid_path, b"headword,meanings_zh\nword,meaning\n").unwrap();
        assert_eq!(
            read_bounded_import_file(&valid_path).unwrap(),
            b"headword,meanings_zh\nword,meaning\n"
        );
        let wrong_extension = directory.path().join("words.txt");
        std::fs::write(&wrong_extension, b"headword,meanings_zh\nword,meaning\n").unwrap();
        assert!(read_bounded_import_file(&wrong_extension).is_err());
        let oversized_path = directory.path().join("oversized.csv");
        let file = File::create(&oversized_path).unwrap();
        file.set_len(MAX_IMPORT_BYTES as u64 + 1).unwrap();
        assert!(read_bounded_import_file(&oversized_path).is_err());
    }
}
