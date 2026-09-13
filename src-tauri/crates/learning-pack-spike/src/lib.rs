use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, Read, Write},
    path::Path,
    rc::Rc,
};

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub const PARSER_VERSION: &str = "learning-pack-v1";
pub const MAX_PACKAGE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_CARDS: usize = 20_000;
pub const MAX_JSON_DEPTH: usize = 8;
pub const PROGRESS_CARD_INTERVAL: usize = 256;
pub const PROGRESS_BYTE_INTERVAL: usize = 4 * 1024 * 1024;
pub const PROGRESS_VALUE_INTERVAL: usize = 16_384;
pub const CONTROL_DECODE_BYTE_INTERVAL: usize = 16 * 1024;
pub const CONTROL_ITEM_BYTE_INTERVAL: usize = 16 * 1024;
pub const MAX_PROMPT_CHARS: usize = 2_000;
pub const MAX_ANSWER_CHARS: usize = 4_000;
pub const MAX_EXPLANATION_CHARS: usize = 8_000;
pub const MAX_CHOICE_CHARS: usize = 1_000;
pub const MAX_TAGS: usize = 32;
pub const MAX_TAG_CHARS: usize = 64;
pub const MAX_EXTENSION_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    FileAccess,
    InvalidFileType,
    EmptyInput,
    ByteBudget,
    InvalidUtf8,
    NullByte,
    UnicodeControl,
    JsonDepth,
    MalformedJson,
    MalformedCsv,
    UnknownField,
    MissingField,
    InvalidSchemaVersion,
    InvalidIdentifier,
    DuplicateIdentifier,
    InvalidText,
    InvalidExercise,
    InvalidChoices,
    InvalidTags,
    InvalidExtension,
    CardBudget,
    FormulaPrefix,
    IdentityMismatch,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub code: ErrorCode,
    pub location: String,
    pub message: String,
}

impl ValidationError {
    fn new(code: ErrorCode, location: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            location: location.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.location, self.message)
    }
}

impl std::error::Error for ValidationError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExerciseKind {
    Choice,
    Recall,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedExtension {
    pub extension_version: u32,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedItem {
    pub item_id: String,
    pub external_card_id: String,
    pub exercise_kind: ExerciseKind,
    pub prompt_text: String,
    pub answer_text: String,
    pub choices: Vec<String>,
    pub explanation_text: Option<String>,
    pub tags: Vec<String>,
    pub schedule_epoch: u32,
    pub extensions: BTreeMap<String, ParsedExtension>,
    pub prompt_sha256: String,
    pub answer_sha256: String,
    pub content_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPack {
    pub schema_version: u32,
    pub parser_version: &'static str,
    pub pack_id: String,
    pub title: String,
    pub cards: Vec<ParsedItem>,
    pub file_sha256: String,
    pub content_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParsePhase {
    ReadingInput,
    ValidatingInput,
    ValidatingText,
    ScanningSyntax,
    Decoding,
    ValidatingStructure,
    ValidatingCards,
    Finalizing,
    Complete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseProgressUnit {
    Bytes,
    Values,
    Cards,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseProgress {
    pub phase: ParsePhase,
    pub unit: ParseProgressUnit,
    pub completed_units: usize,
    pub total_units: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseControl {
    Continue,
    Cancel,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPack<'a> {
    schema_version: u32,
    pack_id: &'a str,
    title: &'a str,
    cards: &'a [ParsedItem],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalItem<'a> {
    external_card_id: &'a str,
    exercise_kind: &'a ExerciseKind,
    prompt_text: &'a str,
    answer_text: &'a str,
    choices: &'a [String],
    explanation_text: &'a Option<String>,
    tags: &'a [String],
    schedule_epoch: u32,
    extensions: &'a BTreeMap<String, ParsedExtension>,
}

pub fn validate_declared_sha256(
    bytes: &[u8],
    declared_sha256: &str,
) -> Result<(), ValidationError> {
    if !is_sha256(declared_sha256) || !sha256_hex(bytes).eq_ignore_ascii_case(declared_sha256) {
        return Err(ValidationError::new(
            ErrorCode::IdentityMismatch,
            "file.sha256",
            "declared SHA-256 does not match the selected file",
        ));
    }
    Ok(())
}

pub fn read_bounded_file_with_progress<F>(
    path: &Path,
    mut observer: F,
) -> Result<Vec<u8>, ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    let path_metadata = fs::symlink_metadata(path).map_err(|_| file_access_error())?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(ValidationError::new(
            ErrorCode::InvalidFileType,
            "file",
            "selected input must be an ordinary file",
        ));
    }
    let mut file = File::open(path).map_err(|_| file_access_error())?;
    let metadata = file.metadata().map_err(|_| file_access_error())?;
    if !metadata.is_file() {
        return Err(ValidationError::new(
            ErrorCode::InvalidFileType,
            "file",
            "selected input must be an ordinary file",
        ));
    }
    if metadata.len() > MAX_PACKAGE_BYTES as u64 {
        return Err(ValidationError::new(
            ErrorCode::ByteBudget,
            "file",
            format!("file exceeds {MAX_PACKAGE_BYTES} bytes"),
        ));
    }
    observe_progress(
        &mut observer,
        ParseProgress {
            phase: ParsePhase::ReadingInput,
            unit: ParseProgressUnit::Bytes,
            completed_units: 0,
            total_units: None,
        },
    )?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut buffer = vec![0_u8; PROGRESS_BYTE_INTERVAL];
    loop {
        let count = file.read(&mut buffer).map_err(|_| file_access_error())?;
        if count == 0 {
            break;
        }
        if bytes.len().saturating_add(count) > MAX_PACKAGE_BYTES {
            return Err(ValidationError::new(
                ErrorCode::ByteBudget,
                "file",
                format!("file exceeds {MAX_PACKAGE_BYTES} bytes"),
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
        observe_progress(
            &mut observer,
            ParseProgress {
                phase: ParsePhase::ReadingInput,
                unit: ParseProgressUnit::Bytes,
                completed_units: bytes.len(),
                total_units: None,
            },
        )?;
    }
    observe_progress(
        &mut observer,
        ParseProgress {
            phase: ParsePhase::ReadingInput,
            unit: ParseProgressUnit::Bytes,
            completed_units: bytes.len(),
            total_units: Some(bytes.len()),
        },
    )?;
    Ok(bytes)
}

pub fn parse_json(bytes: &[u8]) -> Result<ParsedPack, ValidationError> {
    parse_json_with_progress(bytes, |_| ParseControl::Continue)
}

pub fn parse_json_with_progress<F>(bytes: &[u8], observer: F) -> Result<ParsedPack, ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    parse_json_with_progress_and_cancel(bytes, observer, || ParseControl::Continue)
}

pub fn parse_json_with_progress_and_cancel<F, C>(
    bytes: &[u8],
    mut observer: F,
    mut cancel_probe: C,
) -> Result<ParsedPack, ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
    C: FnMut() -> ParseControl,
{
    poll_cancel(&mut cancel_probe)?;
    let validated = validate_common_input(bytes, &mut observer)?;
    validate_json_depth(bytes, &mut observer)?;
    observe_progress(
        &mut observer,
        ParseProgress {
            phase: ParsePhase::Decoding,
            unit: ParseProgressUnit::Bytes,
            completed_units: 0,
            total_units: Some(bytes.len()),
        },
    )?;
    let shared_cancel_probe = Rc::new(RefCell::new(cancel_probe));
    let value = decode_json(bytes, &mut observer, shared_cancel_probe.clone())?;
    let mut cancel_probe = || (shared_cancel_probe.borrow_mut())();
    let mut item_control = CooperativeItemControl::new();
    validate_value_strings(
        &value,
        "json",
        &mut observer,
        &mut cancel_probe,
        &mut item_control,
    )?;
    let root = value.as_object().ok_or_else(|| {
        ValidationError::new(
            ErrorCode::MalformedJson,
            "json",
            "content package root must be an object",
        )
    })?;
    reject_unknown_fields(
        root,
        &[
            "schemaVersion",
            "packId",
            "version",
            "title",
            "description",
            "rights",
            "sources",
            "contentSha256",
            "cards",
        ],
        "json",
    )?;
    let schema_version = required_u64(root, "schemaVersion", "json.schemaVersion")?;
    if schema_version != 1 {
        return Err(ValidationError::new(
            ErrorCode::InvalidSchemaVersion,
            "json.schemaVersion",
            "only schemaVersion 1 is accepted by this spike",
        ));
    }
    let pack_id = validate_identifier(
        required_str(root, "packId", "json.packId")?,
        "json.packId",
        &mut cancel_probe,
        &mut item_control,
    )?;
    let title = validate_text(
        required_str(root, "title", "json.title")?,
        256,
        "json.title",
        &mut cancel_probe,
        &mut item_control,
    )?;
    let raw_cards = root.get("cards").and_then(Value::as_array).ok_or_else(|| {
        ValidationError::new(
            ErrorCode::MissingField,
            "json.cards",
            "cards must be an array",
        )
    })?;
    if raw_cards.len() > MAX_CARDS {
        return Err(ValidationError::new(
            ErrorCode::CardBudget,
            "json.cards",
            format!("card count exceeds {MAX_CARDS}"),
        ));
    }
    if raw_cards.is_empty() {
        return Err(ValidationError::new(
            ErrorCode::MissingField,
            "json.cards",
            "at least one card is required",
        ));
    }

    observe_progress(
        &mut observer,
        ParseProgress {
            phase: ParsePhase::ValidatingCards,
            unit: ParseProgressUnit::Cards,
            completed_units: 0,
            total_units: Some(raw_cards.len()),
        },
    )?;

    let mut seen = BTreeSet::new();
    let mut cards = Vec::with_capacity(raw_cards.len());
    for (index, raw_card) in raw_cards.iter().enumerate() {
        let location = format!("json.cards[{index}]");
        let card = raw_card.as_object().ok_or_else(|| {
            ValidationError::new(
                ErrorCode::MalformedJson,
                &location,
                "each card must be an object",
            )
        })?;
        let parsed = parse_json_card(
            card,
            &pack_id,
            &location,
            &mut cancel_probe,
            &mut item_control,
        )?;
        if !seen.insert(parsed.external_card_id.clone()) {
            return Err(ValidationError::new(
                ErrorCode::DuplicateIdentifier,
                format!("{location}.cardId"),
                "cardId is duplicated after normalization",
            ));
        }
        cards.push(parsed);
        report_card_progress(&mut observer, cards.len(), Some(raw_cards.len()))?;
    }
    build_pack(
        1,
        pack_id,
        title,
        cards,
        validated.file_sha256,
        &mut observer,
    )
}

pub fn parse_csv(bytes: &[u8], pack_id: &str, title: &str) -> Result<ParsedPack, ValidationError> {
    parse_csv_with_progress(bytes, pack_id, title, |_| ParseControl::Continue)
}

pub fn parse_csv_with_progress<F>(
    bytes: &[u8],
    pack_id: &str,
    title: &str,
    observer: F,
) -> Result<ParsedPack, ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    parse_csv_with_progress_and_cancel(bytes, pack_id, title, observer, || ParseControl::Continue)
}

pub fn parse_csv_with_progress_and_cancel<F, C>(
    bytes: &[u8],
    pack_id: &str,
    title: &str,
    mut observer: F,
    mut cancel_probe: C,
) -> Result<ParsedPack, ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
    C: FnMut() -> ParseControl,
{
    poll_cancel(&mut cancel_probe)?;
    let validated = validate_common_input(bytes, &mut observer)?;
    let mut item_control = CooperativeItemControl::new();
    let pack_id = validate_identifier(pack_id, "csv.packId", &mut cancel_probe, &mut item_control)?;
    let title = validate_text(
        title,
        256,
        "csv.title",
        &mut cancel_probe,
        &mut item_control,
    )?;
    observe_progress(
        &mut observer,
        ParseProgress {
            phase: ParsePhase::Decoding,
            unit: ParseProgressUnit::Bytes,
            completed_units: 0,
            total_units: Some(bytes.len()),
        },
    )?;
    let shared_cancel_probe = Rc::new(RefCell::new(cancel_probe));
    let mut cancel_probe = || (shared_cancel_probe.borrow_mut())();
    let cancelled = Rc::new(Cell::new(false));
    let mut observed_reader = ObservedReader::new(
        bytes,
        &mut observer,
        shared_cancel_probe.clone(),
        ParsePhase::Decoding,
        cancelled.clone(),
    );
    let mut reader = csv::ReaderBuilder::new()
        .flexible(false)
        .from_reader(&mut observed_reader);
    let headers = reader.headers().map_err(|_| {
        if cancelled.get() {
            cancelled_error()
        } else {
            ValidationError::new(
                ErrorCode::MalformedCsv,
                "csv.headers",
                "CSV headers are malformed",
            )
        }
    })?;
    let allowed = [
        "cardId",
        "id",
        "prompt",
        "front",
        "answer",
        "back",
        "exerciseKind",
        "choices",
        "explanation",
        "tags",
        "scheduleEpoch",
    ];
    let mut header_indices = BTreeMap::new();
    for (index, header) in headers.iter().enumerate() {
        if !allowed.contains(&header) {
            return Err(ValidationError::new(
                ErrorCode::UnknownField,
                format!("csv.headers[{index}]"),
                "unknown CSV fields are rejected",
            ));
        }
        if header_indices.insert(header.to_owned(), index).is_some() {
            return Err(ValidationError::new(
                ErrorCode::DuplicateIdentifier,
                format!("csv.headers[{index}]"),
                "CSV header is duplicated",
            ));
        }
    }
    reject_alias_conflict(&header_indices, "cardId", "id", "csv.headers")?;
    reject_alias_conflict(&header_indices, "prompt", "front", "csv.headers")?;
    reject_alias_conflict(&header_indices, "answer", "back", "csv.headers")?;
    let id_index = ["cardId", "id"]
        .iter()
        .find_map(|name| header_indices.get(*name).copied());
    let prompt_index =
        required_header(&header_indices, &["prompt", "front"], "csv.headers.prompt")?;
    let answer_index = required_header(&header_indices, &["answer", "back"], "csv.headers.answer")?;

    reader.get_mut().observe(ParseProgress {
        phase: ParsePhase::ValidatingStructure,
        unit: ParseProgressUnit::Values,
        completed_units: 1,
        total_units: Some(1),
    })?;
    reader.get_mut().observe(ParseProgress {
        phase: ParsePhase::ValidatingCards,
        unit: ParseProgressUnit::Cards,
        completed_units: 0,
        total_units: None,
    })?;

    let mut cards = Vec::new();
    let mut seen = BTreeSet::new();
    let mut row_index = 0_usize;
    while let Some(record) = reader.records().next() {
        let row_number = row_index + 2;
        let record = record.map_err(|_| {
            if cancelled.get() {
                cancelled_error()
            } else {
                ValidationError::new(
                    ErrorCode::MalformedCsv,
                    format!("csv.line.{row_number}"),
                    "CSV row is malformed",
                )
            }
        })?;
        for (column, raw) in record.iter().enumerate() {
            let location = format!("csv.line.{row_number}.column.{}", column + 1);
            validate_formula_prefix(raw, &location, &mut cancel_probe, &mut item_control)?;
            validate_string_security(raw, &location, &mut cancel_probe, &mut item_control)?;
        }
        if cards.len() >= MAX_CARDS {
            return Err(ValidationError::new(
                ErrorCode::CardBudget,
                format!("csv.line.{row_number}"),
                format!("card count exceeds {MAX_CARDS}"),
            ));
        }
        let external_card_id = match id_index {
            Some(index) => validate_identifier(
                record.get(index).unwrap_or_default(),
                &format!("csv.line.{row_number}.cardId"),
                &mut cancel_probe,
                &mut item_control,
            )?,
            None => format!("row-{:05}", row_index + 1),
        };
        if !seen.insert(external_card_id.clone()) {
            return Err(ValidationError::new(
                ErrorCode::DuplicateIdentifier,
                format!("csv.line.{row_number}.cardId"),
                "cardId is duplicated after normalization",
            ));
        }
        let prompt = validate_text(
            record.get(prompt_index).unwrap_or_default(),
            MAX_PROMPT_CHARS,
            &format!("csv.line.{row_number}.prompt"),
            &mut cancel_probe,
            &mut item_control,
        )?;
        let answer = validate_text(
            record.get(answer_index).unwrap_or_default(),
            MAX_ANSWER_CHARS,
            &format!("csv.line.{row_number}.answer"),
            &mut cancel_probe,
            &mut item_control,
        )?;
        let exercise = optional_csv(&record, &header_indices, "exerciseKind").unwrap_or("recall");
        let choices = split_csv_list(
            optional_csv(&record, &header_indices, "choices"),
            &mut cancel_probe,
            &mut item_control,
        )?;
        let explanation = match optional_csv(&record, &header_indices, "explanation") {
            Some(value)
                if has_non_whitespace_with_control(
                    value,
                    &mut cancel_probe,
                    &mut item_control,
                )? =>
            {
                Some(validate_text(
                    value,
                    MAX_EXPLANATION_CHARS,
                    &format!("csv.line.{row_number}.explanation"),
                    &mut cancel_probe,
                    &mut item_control,
                )?)
            }
            _ => None,
        };
        let tags = split_csv_list(
            optional_csv(&record, &header_indices, "tags"),
            &mut cancel_probe,
            &mut item_control,
        )?;
        let schedule_epoch = parse_optional_csv_schedule_epoch(
            optional_csv(&record, &header_indices, "scheduleEpoch"),
            &format!("csv.line.{row_number}.scheduleEpoch"),
            &mut cancel_probe,
            &mut item_control,
        )?
        .unwrap_or(1);
        cards.push(build_item(
            &pack_id,
            external_card_id,
            exercise,
            prompt,
            answer,
            choices,
            explanation,
            tags,
            schedule_epoch,
            BTreeMap::new(),
            &format!("csv.line.{row_number}"),
            &mut cancel_probe,
            &mut item_control,
        )?);
        if cards.len().is_multiple_of(PROGRESS_CARD_INTERVAL) {
            reader.get_mut().observe(ParseProgress {
                phase: ParsePhase::ValidatingCards,
                unit: ParseProgressUnit::Cards,
                completed_units: cards.len(),
                total_units: None,
            })?;
        }
        row_index += 1;
    }
    if cards.is_empty() {
        return Err(ValidationError::new(
            ErrorCode::MissingField,
            "csv",
            "at least one data row is required",
        ));
    }
    drop(reader);
    drop(observed_reader);
    build_pack(
        1,
        pack_id,
        title,
        cards,
        validated.file_sha256,
        &mut observer,
    )
}

fn report_card_progress<F>(
    observer: &mut F,
    completed_cards: usize,
    known_total_cards: Option<usize>,
) -> Result<(), ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    let is_final_known_card = known_total_cards == Some(completed_cards);
    if completed_cards.is_multiple_of(PROGRESS_CARD_INTERVAL) || is_final_known_card {
        observe_progress(
            observer,
            ParseProgress {
                phase: ParsePhase::ValidatingCards,
                unit: ParseProgressUnit::Cards,
                completed_units: completed_cards,
                total_units: known_total_cards,
            },
        )?;
    }
    Ok(())
}

fn observe_progress<F>(observer: &mut F, progress: ParseProgress) -> Result<(), ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    match observer(progress) {
        ParseControl::Continue => Ok(()),
        ParseControl::Cancel => Err(cancelled_error()),
    }
}

#[derive(Debug)]
struct CooperativeItemControl {
    completed_work_bytes: usize,
    next_checkpoint: usize,
}

struct CooperativeVecWriter<'control, 'probe, C> {
    bytes: Vec<u8>,
    item_control: &'control mut CooperativeItemControl,
    cancel_probe: &'probe mut C,
    cancelled: bool,
}

impl<'control, 'probe, C> CooperativeVecWriter<'control, 'probe, C>
where
    C: FnMut() -> ParseControl,
{
    fn new(
        item_control: &'control mut CooperativeItemControl,
        cancel_probe: &'probe mut C,
    ) -> Self {
        Self {
            bytes: Vec::new(),
            item_control,
            cancel_probe,
            cancelled: false,
        }
    }
}

impl<C> Write for CooperativeVecWriter<'_, '_, C>
where
    C: FnMut() -> ParseControl,
{
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        for chunk in buffer.chunks(CONTROL_ITEM_BYTE_INTERVAL) {
            self.bytes.extend_from_slice(chunk);
            if self
                .item_control
                .advance(chunk.len(), self.cancel_probe)
                .is_err()
            {
                self.cancelled = true;
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "pure parser cancelled",
                ));
            }
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn cooperative_json_bytes<T, C>(
    value: &T,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
    error_code: ErrorCode,
    location: &str,
) -> Result<Vec<u8>, ValidationError>
where
    T: Serialize + ?Sized,
    C: FnMut() -> ParseControl,
{
    let mut writer = CooperativeVecWriter::new(item_control, cancel_probe);
    if serde_json::to_writer(&mut writer, value).is_err() {
        return Err(if writer.cancelled {
            cancelled_error()
        } else {
            ValidationError::new(error_code, location, "JSON serialization failed")
        });
    }
    Ok(writer.bytes)
}

fn clone_text_with_control<C>(
    value: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<String, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let mut cloned = String::with_capacity(value.len());
    for character in value.chars() {
        cloned.push(character);
        item_control.advance(character.len_utf8(), cancel_probe)?;
    }
    Ok(cloned)
}

fn sha256_hex_with_control<C>(
    bytes: &[u8],
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<String, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let mut hasher = Sha256::new();
    for chunk in bytes.chunks(CONTROL_ITEM_BYTE_INTERVAL) {
        hasher.update(chunk);
        item_control.advance(chunk.len(), cancel_probe)?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

impl CooperativeItemControl {
    fn new() -> Self {
        Self {
            completed_work_bytes: 0,
            next_checkpoint: CONTROL_ITEM_BYTE_INTERVAL,
        }
    }

    fn advance<C>(
        &mut self,
        processed_bytes: usize,
        cancel_probe: &mut C,
    ) -> Result<(), ValidationError>
    where
        C: FnMut() -> ParseControl,
    {
        let completed = self.completed_work_bytes.saturating_add(processed_bytes);
        while completed >= self.next_checkpoint {
            poll_cancel(cancel_probe)?;
            self.next_checkpoint = self
                .next_checkpoint
                .saturating_add(CONTROL_ITEM_BYTE_INTERVAL);
        }
        self.completed_work_bytes = completed;
        Ok(())
    }
}

struct CooperativeChars<'text, 'control, 'probe, C> {
    chars: std::str::Chars<'text>,
    item_control: &'control mut CooperativeItemControl,
    cancel_probe: &'probe mut C,
    consumed_bytes: usize,
    cancelled: Rc<Cell<bool>>,
}

impl<'text, 'control, 'probe, C> CooperativeChars<'text, 'control, 'probe, C>
where
    C: FnMut() -> ParseControl,
{
    fn new(
        text: &'text str,
        item_control: &'control mut CooperativeItemControl,
        cancel_probe: &'probe mut C,
    ) -> Self {
        Self {
            chars: text.chars(),
            item_control,
            cancel_probe,
            consumed_bytes: 0,
            cancelled: Rc::new(Cell::new(false)),
        }
    }
}

impl<C> Iterator for CooperativeChars<'_, '_, '_, C>
where
    C: FnMut() -> ParseControl,
{
    type Item = char;

    fn next(&mut self) -> Option<Self::Item> {
        if self.cancelled.get() {
            return None;
        }
        let character = self.chars.next()?;
        self.consumed_bytes = self.consumed_bytes.saturating_add(character.len_utf8());
        if self
            .item_control
            .advance(character.len_utf8(), self.cancel_probe)
            .is_err()
        {
            self.cancelled.set(true);
            return None;
        }
        Some(character)
    }
}

fn poll_cancel<C>(cancel_probe: &mut C) -> Result<(), ValidationError>
where
    C: FnMut() -> ParseControl,
{
    match cancel_probe() {
        ParseControl::Continue => Ok(()),
        ParseControl::Cancel => Err(cancelled_error()),
    }
}

fn parse_json_card<C>(
    card: &Map<String, Value>,
    pack_id: &str,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<ParsedItem, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let legacy = card.contains_key("id") || card.contains_key("front") || card.contains_key("back");
    if legacy {
        reject_unknown_fields(card, &["id", "front", "back"], location)?;
        let id = validate_identifier(
            required_str(card, "id", &format!("{location}.id"))?,
            &format!("{location}.id"),
            cancel_probe,
            item_control,
        )?;
        let prompt = validate_text(
            required_str(card, "front", &format!("{location}.front"))?,
            MAX_PROMPT_CHARS,
            &format!("{location}.front"),
            cancel_probe,
            item_control,
        )?;
        let answer = validate_text(
            required_str(card, "back", &format!("{location}.back"))?,
            MAX_ANSWER_CHARS,
            &format!("{location}.back"),
            cancel_probe,
            item_control,
        )?;
        return build_item(
            pack_id,
            id,
            "recall",
            prompt,
            answer,
            Vec::new(),
            None,
            Vec::new(),
            1,
            BTreeMap::new(),
            location,
            cancel_probe,
            item_control,
        );
    }
    reject_unknown_fields(
        card,
        &[
            "cardId",
            "exerciseKind",
            "prompt",
            "answer",
            "choices",
            "explanation",
            "tags",
            "sourceRefs",
            "scheduleEpoch",
            "extensions",
        ],
        location,
    )?;
    let external_card_id = validate_identifier(
        required_str(card, "cardId", &format!("{location}.cardId"))?,
        &format!("{location}.cardId"),
        cancel_probe,
        item_control,
    )?;
    let prompt = validate_text(
        required_str(card, "prompt", &format!("{location}.prompt"))?,
        MAX_PROMPT_CHARS,
        &format!("{location}.prompt"),
        cancel_probe,
        item_control,
    )?;
    let answer = validate_text(
        required_str(card, "answer", &format!("{location}.answer"))?,
        MAX_ANSWER_CHARS,
        &format!("{location}.answer"),
        cancel_probe,
        item_control,
    )?;
    let exercise = card
        .get("exerciseKind")
        .and_then(Value::as_str)
        .unwrap_or("recall");
    let choices = optional_string_array(
        card,
        "choices",
        &format!("{location}.choices"),
        cancel_probe,
        item_control,
    )?;
    let explanation = card
        .get("explanation")
        .map(|value| {
            value.as_str().ok_or_else(|| {
                ValidationError::new(
                    ErrorCode::InvalidText,
                    format!("{location}.explanation"),
                    "explanation must be text",
                )
            })
        })
        .transpose()?
        .map(|value| {
            validate_text(
                value,
                MAX_EXPLANATION_CHARS,
                &format!("{location}.explanation"),
                cancel_probe,
                item_control,
            )
        })
        .transpose()?;
    let tags = optional_string_array(
        card,
        "tags",
        &format!("{location}.tags"),
        cancel_probe,
        item_control,
    )?;
    let schedule_epoch = match card.get("scheduleEpoch") {
        None => 1,
        Some(value) => value.as_u64().ok_or_else(|| {
            ValidationError::new(
                ErrorCode::InvalidExercise,
                format!("{location}.scheduleEpoch"),
                "scheduleEpoch must be a positive integer",
            )
        })?,
    };
    let schedule_epoch = u32::try_from(schedule_epoch).map_err(|_| {
        ValidationError::new(
            ErrorCode::InvalidExercise,
            format!("{location}.scheduleEpoch"),
            "scheduleEpoch is too large",
        )
    })?;
    let extensions = parse_extensions(
        card.get("extensions"),
        &format!("{location}.extensions"),
        cancel_probe,
        item_control,
    )?;
    build_item(
        pack_id,
        external_card_id,
        exercise,
        prompt,
        answer,
        choices,
        explanation,
        tags,
        schedule_epoch,
        extensions,
        location,
        cancel_probe,
        item_control,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_item<C>(
    pack_id: &str,
    external_card_id: String,
    exercise: &str,
    prompt_text: String,
    answer_text: String,
    mut choices: Vec<String>,
    explanation_text: Option<String>,
    tags: Vec<String>,
    schedule_epoch: u32,
    extensions: BTreeMap<String, ParsedExtension>,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<ParsedItem, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    if schedule_epoch == 0 {
        return Err(ValidationError::new(
            ErrorCode::InvalidExercise,
            format!("{location}.scheduleEpoch"),
            "scheduleEpoch must be at least 1",
        ));
    }
    let mut normalized_choices = Vec::with_capacity(choices.len());
    let mut choice_set = BTreeSet::new();
    for (index, choice) in choices.drain(..).enumerate() {
        let choice = validate_text(
            &choice,
            MAX_CHOICE_CHARS,
            &format!("{location}.choices[{index}]"),
            cancel_probe,
            item_control,
        )?;
        if !choice_set.insert(choice.clone()) {
            return Err(ValidationError::new(
                ErrorCode::InvalidChoices,
                format!("{location}.choices[{index}]"),
                "choices must be unambiguous and unique",
            ));
        }
        normalized_choices.push(choice);
    }
    let exercise_kind = match exercise {
        "recall" => {
            if !normalized_choices.is_empty() {
                return Err(ValidationError::new(
                    ErrorCode::InvalidChoices,
                    format!("{location}.choices"),
                    "recall items cannot declare choices",
                ));
            }
            ExerciseKind::Recall
        }
        "choice" if normalized_choices.is_empty() => ExerciseKind::Recall,
        "choice" => {
            if !(2..=4).contains(&normalized_choices.len())
                || normalized_choices
                    .iter()
                    .filter(|value| *value == &answer_text)
                    .count()
                    != 1
            {
                return Err(ValidationError::new(
                    ErrorCode::InvalidChoices,
                    format!("{location}.choices"),
                    "choice items require 2 to 4 unique choices containing the answer exactly once",
                ));
            }
            ExerciseKind::Choice
        }
        _ => {
            return Err(ValidationError::new(
                ErrorCode::InvalidExercise,
                format!("{location}.exerciseKind"),
                "exerciseKind must be choice or recall",
            ));
        }
    };
    let tags = validate_tags(
        tags,
        &format!("{location}.tags"),
        cancel_probe,
        item_control,
    )?;
    let prompt_sha256 =
        sha256_hex_with_control(prompt_text.as_bytes(), cancel_probe, item_control)?;
    let answer_sha256 =
        sha256_hex_with_control(answer_text.as_bytes(), cancel_probe, item_control)?;
    let canonical = cooperative_json_bytes(
        &CanonicalItem {
            external_card_id: &external_card_id,
            exercise_kind: &exercise_kind,
            prompt_text: &prompt_text,
            answer_text: &answer_text,
            choices: &normalized_choices,
            explanation_text: &explanation_text,
            tags: &tags,
            schedule_epoch,
            extensions: &extensions,
        },
        cancel_probe,
        item_control,
        ErrorCode::MalformedJson,
        "canonical.item",
    )?;
    Ok(ParsedItem {
        item_id: sha256_hex_with_control(
            format!("yuanyuan-item-v1\0{pack_id}\0{external_card_id}").as_bytes(),
            cancel_probe,
            item_control,
        )?,
        external_card_id,
        exercise_kind,
        prompt_text,
        answer_text,
        choices: normalized_choices,
        explanation_text,
        tags,
        schedule_epoch,
        extensions,
        prompt_sha256,
        answer_sha256,
        content_sha256: sha256_hex_with_control(&canonical, cancel_probe, item_control)?,
    })
}

struct ObservedReader<'bytes, 'observer, F, C> {
    bytes: &'bytes [u8],
    position: usize,
    next_progress_checkpoint: usize,
    next_control_checkpoint: usize,
    observer: &'observer mut F,
    cancel_probe: Rc<RefCell<C>>,
    phase: ParsePhase,
    cancelled: Rc<Cell<bool>>,
}

impl<'bytes, 'observer, F, C> ObservedReader<'bytes, 'observer, F, C>
where
    F: FnMut(ParseProgress) -> ParseControl,
    C: FnMut() -> ParseControl,
{
    fn new(
        bytes: &'bytes [u8],
        observer: &'observer mut F,
        cancel_probe: Rc<RefCell<C>>,
        phase: ParsePhase,
        cancelled: Rc<Cell<bool>>,
    ) -> Self {
        Self {
            bytes,
            position: 0,
            next_progress_checkpoint: PROGRESS_BYTE_INTERVAL.min(bytes.len()),
            next_control_checkpoint: CONTROL_DECODE_BYTE_INTERVAL.min(bytes.len()),
            observer,
            cancel_probe,
            phase,
            cancelled,
        }
    }

    fn observe(&mut self, progress: ParseProgress) -> Result<(), ValidationError> {
        let result = observe_progress(self.observer, progress);
        if result.is_err() {
            self.cancelled.set(true);
        }
        result
    }

    fn poll_control(&mut self) -> Result<(), ValidationError> {
        let result = {
            let mut cancel_probe = self.cancel_probe.borrow_mut();
            poll_cancel(&mut *cancel_probe)
        };
        if result.is_err() {
            self.cancelled.set(true);
        }
        result
    }
}

impl<F, C> Read for ObservedReader<'_, '_, F, C>
where
    F: FnMut(ParseProgress) -> ParseControl,
    C: FnMut() -> ParseControl,
{
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.bytes.len() || buffer.is_empty() {
            return Ok(0);
        }
        let progress_checkpoint = self.next_progress_checkpoint.max(self.position + 1);
        let control_checkpoint = self.next_control_checkpoint.max(self.position + 1);
        let count = buffer
            .len()
            .min(self.bytes.len() - self.position)
            .min(progress_checkpoint - self.position)
            .min(control_checkpoint - self.position);
        buffer[..count].copy_from_slice(&self.bytes[self.position..self.position + count]);
        self.position += count;
        if self.position >= self.next_control_checkpoint || self.position == self.bytes.len() {
            if self.poll_control().is_err() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "pure parser cancelled",
                ));
            }
            self.next_control_checkpoint = if self.position == self.bytes.len() {
                usize::MAX
            } else {
                (self.position + CONTROL_DECODE_BYTE_INTERVAL).min(self.bytes.len())
            };
        }
        if self.position >= self.next_progress_checkpoint || self.position == self.bytes.len() {
            let progress = ParseProgress {
                phase: self.phase,
                unit: ParseProgressUnit::Bytes,
                completed_units: self.position,
                total_units: Some(self.bytes.len()),
            };
            if self.observe(progress).is_err() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "pure parser cancelled",
                ));
            }
            self.next_progress_checkpoint = if self.position == self.bytes.len() {
                usize::MAX
            } else {
                (self.position + PROGRESS_BYTE_INTERVAL).min(self.bytes.len())
            };
        }
        Ok(count)
    }
}

fn decode_json<F, C>(
    bytes: &[u8],
    observer: &mut F,
    cancel_probe: Rc<RefCell<C>>,
) -> Result<Value, ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
    C: FnMut() -> ParseControl,
{
    let cancelled = Rc::new(Cell::new(false));
    let result = {
        let mut reader = ObservedReader::new(
            bytes,
            observer,
            cancel_probe,
            ParsePhase::Decoding,
            cancelled.clone(),
        );
        serde_json::from_reader(&mut reader)
    };
    result.map_err(|error| {
        if cancelled.get() {
            cancelled_error()
        } else {
            ValidationError::new(
                ErrorCode::MalformedJson,
                format!("json.line.{}.column.{}", error.line(), error.column()),
                "JSON is malformed",
            )
        }
    })
}

struct ObservedHashWriter<'observer, F> {
    observer: &'observer mut F,
    hasher: Sha256,
    completed: usize,
    next_checkpoint: usize,
    cancelled: Rc<Cell<bool>>,
}

impl<'observer, F> ObservedHashWriter<'observer, F>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    fn new(observer: &'observer mut F, cancelled: Rc<Cell<bool>>) -> Self {
        Self {
            observer,
            hasher: Sha256::new(),
            completed: 0,
            next_checkpoint: PROGRESS_BYTE_INTERVAL,
            cancelled,
        }
    }

    fn finish(self) -> Result<String, ValidationError> {
        observe_progress(
            self.observer,
            ParseProgress {
                phase: ParsePhase::Finalizing,
                unit: ParseProgressUnit::Bytes,
                completed_units: self.completed,
                total_units: Some(self.completed),
            },
        )?;
        Ok(format!("{:x}", self.hasher.finalize()))
    }
}

impl<F> Write for ObservedHashWriter<'_, F>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.hasher.update(buffer);
        self.completed += buffer.len();
        if self.completed >= self.next_checkpoint {
            if observe_progress(
                self.observer,
                ParseProgress {
                    phase: ParsePhase::Finalizing,
                    unit: ParseProgressUnit::Bytes,
                    completed_units: self.completed,
                    total_units: None,
                },
            )
            .is_err()
            {
                self.cancelled.set(true);
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "pure parser cancelled",
                ));
            }
            self.next_checkpoint = self.completed + PROGRESS_BYTE_INTERVAL;
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn cancelled_error() -> ValidationError {
    ValidationError::new(
        ErrorCode::Cancelled,
        "parse.control",
        "parsing was cancelled at a cooperative checkpoint",
    )
}

fn file_access_error() -> ValidationError {
    ValidationError::new(
        ErrorCode::FileAccess,
        "file",
        "selected input could not be read",
    )
}

fn build_pack(
    schema_version: u32,
    pack_id: String,
    title: String,
    cards: Vec<ParsedItem>,
    file_sha256: String,
    observer: &mut impl FnMut(ParseProgress) -> ParseControl,
) -> Result<ParsedPack, ValidationError> {
    observe_progress(
        observer,
        ParseProgress {
            phase: ParsePhase::Finalizing,
            unit: ParseProgressUnit::Bytes,
            completed_units: 0,
            total_units: None,
        },
    )?;
    let cancelled = Rc::new(Cell::new(false));
    let mut writer = ObservedHashWriter::new(observer, cancelled.clone());
    let serialization = serde_json::to_writer(
        &mut writer,
        &CanonicalPack {
            schema_version,
            pack_id: &pack_id,
            title: &title,
            cards: &cards,
        },
    );
    if serialization.is_err() {
        return Err(if cancelled.get() {
            cancelled_error()
        } else {
            ValidationError::new(
                ErrorCode::MalformedJson,
                "canonical",
                "canonical pack serialization failed",
            )
        });
    }
    let content_sha256 = writer.finish()?;
    let card_count = cards.len();
    let pack = ParsedPack {
        schema_version,
        parser_version: PARSER_VERSION,
        pack_id,
        title,
        cards,
        file_sha256,
        content_sha256,
    };
    observe_progress(
        observer,
        ParseProgress {
            phase: ParsePhase::Complete,
            unit: ParseProgressUnit::Cards,
            completed_units: card_count,
            total_units: Some(card_count),
        },
    )?;
    Ok(pack)
}

#[derive(Debug)]
struct ValidatedInput {
    file_sha256: String,
}

fn validate_common_input<F>(
    bytes: &[u8],
    observer: &mut F,
) -> Result<ValidatedInput, ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    if bytes.is_empty() {
        return Err(ValidationError::new(
            ErrorCode::EmptyInput,
            "file",
            "file is empty",
        ));
    }
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err(ValidationError::new(
            ErrorCode::ByteBudget,
            "file",
            format!("file exceeds {MAX_PACKAGE_BYTES} bytes"),
        ));
    }
    observe_progress(
        observer,
        ParseProgress {
            phase: ParsePhase::ValidatingInput,
            unit: ParseProgressUnit::Bytes,
            completed_units: 0,
            total_units: Some(bytes.len()),
        },
    )?;
    let mut hasher = Sha256::new();
    let mut completed = 0_usize;
    for chunk in bytes.chunks(PROGRESS_BYTE_INTERVAL) {
        if chunk.contains(&0) {
            return Err(ValidationError::new(
                ErrorCode::NullByte,
                "file",
                "NUL bytes are not allowed",
            ));
        }
        hasher.update(chunk);
        completed += chunk.len();
        observe_progress(
            observer,
            ParseProgress {
                phase: ParsePhase::ValidatingInput,
                unit: ParseProgressUnit::Bytes,
                completed_units: completed,
                total_units: Some(bytes.len()),
            },
        )?;
    }
    validate_utf8_chunks(bytes, observer)?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(ValidationError::new(
            ErrorCode::UnicodeControl,
            "file",
            "UTF-8 BOM is not accepted by the spike contract",
        ));
    }
    Ok(ValidatedInput {
        file_sha256: format!("{:x}", hasher.finalize()),
    })
}

fn validate_utf8_chunks<F>(bytes: &[u8], observer: &mut F) -> Result<(), ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    observe_progress(
        observer,
        ParseProgress {
            phase: ParsePhase::ValidatingText,
            unit: ParseProgressUnit::Bytes,
            completed_units: 0,
            total_units: Some(bytes.len()),
        },
    )?;
    let mut start = 0_usize;
    while start < bytes.len() {
        let mut end = start
            .saturating_add(PROGRESS_BYTE_INTERVAL)
            .min(bytes.len());
        if end < bytes.len() {
            while end > start && is_utf8_continuation(bytes[end]) {
                end -= 1;
            }
            if end == start {
                return Err(invalid_utf8_error());
            }
        }
        std::str::from_utf8(&bytes[start..end]).map_err(|_| invalid_utf8_error())?;
        start = end;
        observe_progress(
            observer,
            ParseProgress {
                phase: ParsePhase::ValidatingText,
                unit: ParseProgressUnit::Bytes,
                completed_units: start,
                total_units: Some(bytes.len()),
            },
        )?;
    }
    Ok(())
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

fn invalid_utf8_error() -> ValidationError {
    ValidationError::new(ErrorCode::InvalidUtf8, "file", "file must be valid UTF-8")
}

fn validate_json_depth<F>(bytes: &[u8], observer: &mut F) -> Result<(), ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
{
    observe_progress(
        observer,
        ParseProgress {
            phase: ParsePhase::ScanningSyntax,
            unit: ParseProgressUnit::Bytes,
            completed_units: 0,
            total_units: Some(bytes.len()),
        },
    )?;
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut completed = 0_usize;
    for chunk in bytes.chunks(PROGRESS_BYTE_INTERVAL) {
        for byte in chunk {
            if in_string {
                if escaped {
                    escaped = false;
                } else if *byte == b'\\' {
                    escaped = true;
                } else if *byte == b'"' {
                    in_string = false;
                }
                continue;
            }
            match *byte {
                b'"' => in_string = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > MAX_JSON_DEPTH {
                        return Err(ValidationError::new(
                            ErrorCode::JsonDepth,
                            "json",
                            format!("JSON depth exceeds {MAX_JSON_DEPTH}"),
                        ));
                    }
                }
                b'}' | b']' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
        completed += chunk.len();
        observe_progress(
            observer,
            ParseProgress {
                phase: ParsePhase::ScanningSyntax,
                unit: ParseProgressUnit::Bytes,
                completed_units: completed,
                total_units: Some(bytes.len()),
            },
        )?;
    }
    Ok(())
}

fn validate_value_strings<F, C>(
    value: &Value,
    location: &str,
    observer: &mut F,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<(), ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
    C: FnMut() -> ParseControl,
{
    observe_progress(
        observer,
        ParseProgress {
            phase: ParsePhase::ValidatingStructure,
            unit: ParseProgressUnit::Values,
            completed_units: 0,
            total_units: None,
        },
    )?;
    let mut completed = 0_usize;
    validate_value_strings_inner(
        value,
        location,
        observer,
        &mut completed,
        cancel_probe,
        item_control,
    )?;
    observe_progress(
        observer,
        ParseProgress {
            phase: ParsePhase::ValidatingStructure,
            unit: ParseProgressUnit::Values,
            completed_units: completed,
            total_units: Some(completed),
        },
    )
}

fn validate_value_strings_inner<F, C>(
    value: &Value,
    location: &str,
    observer: &mut F,
    completed: &mut usize,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<(), ValidationError>
where
    F: FnMut(ParseProgress) -> ParseControl,
    C: FnMut() -> ParseControl,
{
    *completed += 1;
    if completed.is_multiple_of(PROGRESS_VALUE_INTERVAL) {
        observe_progress(
            observer,
            ParseProgress {
                phase: ParsePhase::ValidatingStructure,
                unit: ParseProgressUnit::Values,
                completed_units: *completed,
                total_units: None,
            },
        )?;
    }
    match value {
        Value::String(text) => validate_string_security(text, location, cancel_probe, item_control),
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                validate_value_strings_inner(
                    value,
                    &format!("{location}[{index}]"),
                    observer,
                    completed,
                    cancel_probe,
                    item_control,
                )?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (index, (key, value)) in values.iter().enumerate() {
                validate_string_security(key, location, cancel_probe, item_control)?;
                validate_value_strings_inner(
                    value,
                    &format!("{location}.field[{index}]"),
                    observer,
                    completed,
                    cancel_probe,
                    item_control,
                )?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_string_security<C>(
    text: &str,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<(), ValidationError>
where
    C: FnMut() -> ParseControl,
{
    for character in text.chars() {
        if is_disallowed_control(character) {
            return Err(ValidationError::new(
                ErrorCode::UnicodeControl,
                location,
                "Unicode control or bidi characters are not allowed",
            ));
        }
        item_control.advance(character.len_utf8(), cancel_probe)?;
    }
    Ok(())
}

fn is_disallowed_control(character: char) -> bool {
    character.is_control()
        || matches!(
            character as u32,
            0x061C
                | 0x200B..=0x200F
                | 0x202A..=0x202E
                | 0x2060..=0x2069
                | 0xFEFF
        )
}

fn validate_formula_prefix<C>(
    text: &str,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<(), ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let mut first_non_whitespace = None;
    for character in text.chars() {
        item_control.advance(character.len_utf8(), cancel_probe)?;
        if !character.is_whitespace() {
            first_non_whitespace = Some(character);
            break;
        }
    }
    if matches!(first_non_whitespace, Some('=' | '+' | '-' | '@')) {
        return Err(ValidationError::new(
            ErrorCode::FormulaPrefix,
            location,
            "spreadsheet formula prefixes are not allowed",
        ));
    }
    Ok(())
}

fn reject_unknown_fields(
    object: &Map<String, Value>,
    allowed: &[&str],
    location: &str,
) -> Result<(), ValidationError> {
    if object
        .keys()
        .any(|field| !allowed.contains(&field.as_str()))
    {
        return Err(ValidationError::new(
            ErrorCode::UnknownField,
            format!("{location}.unknownField"),
            "unknown fields are rejected",
        ));
    }
    Ok(())
}

fn required_str<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    location: &str,
) -> Result<&'a str, ValidationError> {
    object.get(key).and_then(Value::as_str).ok_or_else(|| {
        ValidationError::new(
            ErrorCode::MissingField,
            location,
            format!("{key} must be text"),
        )
    })
}

fn required_u64(
    object: &Map<String, Value>,
    key: &str,
    location: &str,
) -> Result<u64, ValidationError> {
    object.get(key).and_then(Value::as_u64).ok_or_else(|| {
        ValidationError::new(
            ErrorCode::MissingField,
            location,
            format!("{key} must be an unsigned integer"),
        )
    })
}

fn validate_identifier<C>(
    value: &str,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<String, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let normalized = normalize_nfkc_with_control(value, cancel_probe, item_control)?;
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(ValidationError::new(
            ErrorCode::InvalidIdentifier,
            location,
            "identifier must be 1 to 128 ASCII characters from [A-Za-z0-9._:-]",
        ));
    }
    Ok(normalized)
}

fn normalize_nfc_with_control<C>(
    value: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<String, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let mut source = CooperativeChars::new(value, item_control, cancel_probe);
    let cancelled = source.cancelled.clone();
    let mut normalized = String::with_capacity(value.len());
    for character in (&mut source).nfc() {
        if cancelled.get() {
            return Err(cancelled_error());
        }
        normalized.push(character);
    }
    if cancelled.get() {
        Err(cancelled_error())
    } else {
        Ok(normalized)
    }
}

fn normalize_nfkc_with_control<C>(
    value: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<String, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let mut source = CooperativeChars::new(value, item_control, cancel_probe);
    let cancelled = source.cancelled.clone();
    let mut normalized = String::with_capacity(value.len());
    for character in (&mut source).nfkc() {
        if cancelled.get() {
            return Err(cancelled_error());
        }
        normalized.push(character);
    }
    if cancelled.get() {
        Err(cancelled_error())
    } else {
        Ok(normalized)
    }
}

fn validate_text<C>(
    value: &str,
    maximum: usize,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<String, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    validate_string_security(value, location, cancel_probe, item_control)?;
    let normalized = normalize_nfc_with_control(value, cancel_probe, item_control)?;

    let mut start = normalized.len();
    for (index, character) in normalized.char_indices() {
        item_control.advance(character.len_utf8(), cancel_probe)?;
        if !character.is_whitespace() {
            start = index;
            break;
        }
    }
    let mut end = start;
    if start < normalized.len() {
        for (index, character) in normalized.char_indices().rev() {
            item_control.advance(character.len_utf8(), cancel_probe)?;
            if !character.is_whitespace() {
                end = index + character.len_utf8();
                break;
            }
        }
    }

    let mut result = String::with_capacity(end.saturating_sub(start));
    let mut length = 0_usize;
    for character in normalized[start..end].chars() {
        result.push(character);
        length += 1;
        item_control.advance(character.len_utf8(), cancel_probe)?;
    }
    if length == 0 || length > maximum {
        return Err(ValidationError::new(
            ErrorCode::InvalidText,
            location,
            format!("text must contain 1 to {maximum} Unicode characters"),
        ));
    }
    Ok(result)
}

fn optional_string_array<C>(
    object: &Map<String, Value>,
    key: &str,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<Vec<String>, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let Some(value) = object.get(key) else {
        return Ok(Vec::new());
    };
    let array = value.as_array().ok_or_else(|| {
        ValidationError::new(
            ErrorCode::InvalidText,
            location,
            format!("{key} must be an array"),
        )
    })?;
    let mut result = Vec::with_capacity(array.len());
    for (index, value) in array.iter().enumerate() {
        let value = value.as_str().ok_or_else(|| {
            ValidationError::new(
                ErrorCode::InvalidText,
                format!("{location}[{index}]"),
                "array entries must be text",
            )
        })?;
        result.push(clone_text_with_control(value, cancel_probe, item_control)?);
    }
    Ok(result)
}

fn validate_tags<C>(
    tags: Vec<String>,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<Vec<String>, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    if tags.len() > MAX_TAGS {
        return Err(ValidationError::new(
            ErrorCode::InvalidTags,
            location,
            format!("no more than {MAX_TAGS} tags are allowed"),
        ));
    }
    let mut result = Vec::with_capacity(tags.len());
    let mut seen = BTreeSet::new();
    for (index, tag) in tags.iter().enumerate() {
        let tag = validate_text(
            tag,
            MAX_TAG_CHARS,
            &format!("{location}[{index}]"),
            cancel_probe,
            item_control,
        )?;
        if !seen.insert(tag.clone()) {
            return Err(ValidationError::new(
                ErrorCode::InvalidTags,
                format!("{location}[{index}]"),
                "tags must be unique",
            ));
        }
        result.push(tag);
    }
    Ok(result)
}

fn parse_extensions<C>(
    value: Option<&Value>,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<BTreeMap<String, ParsedExtension>, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let serialized = cooperative_json_bytes(
        value,
        cancel_probe,
        item_control,
        ErrorCode::InvalidExtension,
        location,
    )?;
    if serialized.len() > MAX_EXTENSION_BYTES {
        return Err(ValidationError::new(
            ErrorCode::InvalidExtension,
            location,
            format!("extensions exceed {MAX_EXTENSION_BYTES} UTF-8 bytes"),
        ));
    }
    let object = value.as_object().ok_or_else(|| {
        ValidationError::new(
            ErrorCode::InvalidExtension,
            location,
            "extensions must be an object keyed by namespace",
        )
    })?;
    let mut result = BTreeMap::new();
    for (namespace, value) in object {
        poll_cancel(cancel_probe)?;
        if !valid_namespace(namespace) {
            return Err(ValidationError::new(
                ErrorCode::InvalidExtension,
                format!("{location}.{namespace}"),
                "extension namespace is invalid",
            ));
        }
        let extension = value.as_object().ok_or_else(|| {
            ValidationError::new(
                ErrorCode::InvalidExtension,
                format!("{location}.{namespace}"),
                "extension must be an object",
            )
        })?;
        reject_unknown_fields(
            extension,
            &["version", "payload"],
            &format!("{location}.{namespace}"),
        )?;
        let version = required_u64(
            extension,
            "version",
            &format!("{location}.{namespace}.version"),
        )?;
        let version = u32::try_from(version)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                ValidationError::new(
                    ErrorCode::InvalidExtension,
                    format!("{location}.{namespace}.version"),
                    "extension version must be a positive 32-bit integer",
                )
            })?;
        let payload = extension.get("payload").cloned().ok_or_else(|| {
            ValidationError::new(
                ErrorCode::MissingField,
                format!("{location}.{namespace}.payload"),
                "extension payload is required",
            )
        })?;
        item_control.advance(serialized.len().min(MAX_EXTENSION_BYTES), cancel_probe)?;
        result.insert(
            namespace.clone(),
            ParsedExtension {
                extension_version: version,
                payload,
            },
        );
    }
    Ok(result)
}

fn valid_namespace(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphabetic())
        && value.len() <= 64
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn reject_alias_conflict(
    headers: &BTreeMap<String, usize>,
    first: &str,
    second: &str,
    location: &str,
) -> Result<(), ValidationError> {
    if headers.contains_key(first) && headers.contains_key(second) {
        return Err(ValidationError::new(
            ErrorCode::UnknownField,
            location,
            format!("{first} and {second} cannot both be present"),
        ));
    }
    Ok(())
}

fn required_header(
    headers: &BTreeMap<String, usize>,
    names: &[&str],
    location: &str,
) -> Result<usize, ValidationError> {
    names
        .iter()
        .find_map(|name| headers.get(*name).copied())
        .ok_or_else(|| {
            ValidationError::new(
                ErrorCode::MissingField,
                location,
                format!("one of {} is required", names.join(", ")),
            )
        })
}

fn optional_csv<'a>(
    record: &'a csv::StringRecord,
    headers: &BTreeMap<String, usize>,
    name: &str,
) -> Option<&'a str> {
    headers.get(name).and_then(|index| record.get(*index))
}

fn has_non_whitespace_with_control<C>(
    value: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<bool, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    for character in value.chars() {
        item_control.advance(character.len_utf8(), cancel_probe)?;
        if !character.is_whitespace() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn parse_optional_csv_schedule_epoch<C>(
    value: Option<&str>,
    location: &str,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<Option<u32>, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let Some(value) = value else {
        return Ok(None);
    };
    if !has_non_whitespace_with_control(value, cancel_probe, item_control)? {
        return Ok(None);
    }
    if value.len() > 11 {
        return Err(ValidationError::new(
            ErrorCode::InvalidExercise,
            location,
            "scheduleEpoch must be a positive integer",
        ));
    }
    value.parse::<u32>().map(Some).map_err(|_| {
        ValidationError::new(
            ErrorCode::InvalidExercise,
            location,
            "scheduleEpoch must be a positive integer",
        )
    })
}

fn split_csv_list<C>(
    value: Option<&str>,
    cancel_probe: &mut C,
    item_control: &mut CooperativeItemControl,
) -> Result<Vec<String>, ValidationError>
where
    C: FnMut() -> ParseControl,
{
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if !has_non_whitespace_with_control(value, cancel_probe, item_control)? {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    let mut start = 0_usize;
    for (index, character) in value.char_indices() {
        item_control.advance(character.len_utf8(), cancel_probe)?;
        if character == '|' {
            result.push(clone_text_with_control(
                &value[start..index],
                cancel_probe,
                item_control,
            )?);
            start = index + character.len_utf8();
        }
    }
    result.push(clone_text_with_control(
        &value[start..],
        cancel_probe,
        item_control,
    )?);
    Ok(result)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::io::{Read as _, Write as _};

    use super::*;
    use tempfile::{tempdir, NamedTempFile};

    fn synthetic_json(card_count: usize) -> Vec<u8> {
        let mut json = String::from(
            "{\"schemaVersion\":1,\"packId\":\"synthetic.progress\",\"title\":\"Progress\",\"cards\":[",
        );
        for index in 0..card_count {
            if index > 0 {
                json.push(',');
            }
            json.push_str(&format!(
                "{{\"cardId\":\"c{index}\",\"prompt\":\"p{index}\",\"answer\":\"a{index}\"}}"
            ));
        }
        json.push_str("]}");
        json.into_bytes()
    }

    fn synthetic_csv(card_count: usize) -> Vec<u8> {
        let mut csv = String::from("cardId,prompt,answer\n");
        for index in 0..card_count {
            csv.push_str(&format!("c{index},p{index},a{index}\n"));
        }
        csv.into_bytes()
    }

    #[test]
    fn parses_preimplementation_security_fixture_shape() {
        let pack = parse_json(
            br#"{"schemaVersion":1,"packId":"synthetic.valid","title":"Valid","cards":[{"id":"card-1","front":"alpha","back":"one"}]}"#,
        )
        .unwrap();
        assert_eq!(pack.cards.len(), 1);
        assert_eq!(pack.cards[0].exercise_kind, ExerciseKind::Recall);
        assert_eq!(pack.cards[0].item_id.len(), 64);
    }

    #[test]
    fn parses_generic_choice_and_namespaced_extension() {
        let pack = parse_json(
            br#"{"schemaVersion":1,"packId":"synthetic.generic","title":"Generic","cards":[{"cardId":"c1","exerciseKind":"choice","prompt":"alpha","answer":"one","choices":["one","two"],"tags":["demo"],"scheduleEpoch":1,"extensions":{"englishVocabulary":{"version":1,"payload":{"headword":"alpha"}}}}]}"#,
        )
        .unwrap();
        assert_eq!(pack.cards[0].exercise_kind, ExerciseKind::Choice);
        assert!(pack.cards[0].extensions.contains_key("englishVocabulary"));
    }

    #[test]
    fn choice_without_candidates_downgrades_to_recall() {
        let pack = parse_json(
            br#"{"schemaVersion":1,"packId":"synthetic.generic","title":"Generic","cards":[{"cardId":"c1","exerciseKind":"choice","prompt":"alpha","answer":"one"}]}"#,
        )
        .unwrap();
        assert_eq!(pack.cards[0].exercise_kind, ExerciseKind::Recall);
    }

    #[test]
    fn rejects_duplicate_ids_and_unknown_fields() {
        let duplicate = br#"{"schemaVersion":1,"packId":"synthetic.generic","title":"Generic","cards":[{"id":"same","front":"a","back":"b"},{"id":"same","front":"c","back":"d"}]}"#;
        assert_eq!(
            parse_json(duplicate).unwrap_err().code,
            ErrorCode::DuplicateIdentifier
        );
        let unknown = br#"{"schemaVersion":1,"packId":"synthetic.generic","title":"Generic","execute":"bad","cards":[]}"#;
        assert_eq!(
            parse_json(unknown).unwrap_err().code,
            ErrorCode::UnknownField
        );
    }

    #[test]
    fn rejects_depth_and_formula_prefixes() {
        let nested = br#"[[[[[[[[[]]]]]]]]]"#;
        assert_eq!(parse_json(nested).unwrap_err().code, ErrorCode::JsonDepth);
        let csv = b"id,front,back\nc1,=2+3,value\n";
        assert_eq!(
            parse_csv(csv, "synthetic.csv", "Synthetic")
                .unwrap_err()
                .code,
            ErrorCode::FormulaPrefix
        );
    }

    #[test]
    fn canonical_hashes_and_item_ids_are_deterministic() {
        let bytes = br#"{"schemaVersion":1,"packId":"synthetic.generic","title":"Generic","cards":[{"id":"c1","front":"alpha","back":"one"}]}"#;
        let first = parse_json(bytes).unwrap();
        let second = parse_json(bytes).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.file_sha256, sha256_hex(bytes));
    }

    #[test]
    fn progress_is_monotonic_bounded_and_preserves_results_for_json_and_csv() {
        let card_count = PROGRESS_CARD_INTERVAL * 2 + 1;
        let json = synthetic_json(card_count);
        let csv = synthetic_csv(card_count);

        let mut json_progress = Vec::new();
        let observed_json = parse_json_with_progress(&json, |progress| {
            json_progress.push(progress);
            ParseControl::Continue
        })
        .unwrap();
        assert_eq!(observed_json, parse_json(&json).unwrap());

        let mut csv_progress = Vec::new();
        let observed_csv =
            parse_csv_with_progress(&csv, "synthetic.progress.csv", "Progress CSV", |progress| {
                csv_progress.push(progress);
                ParseControl::Continue
            })
            .unwrap();
        assert_eq!(
            observed_csv,
            parse_csv(&csv, "synthetic.progress.csv", "Progress CSV").unwrap()
        );

        for progress in [&json_progress, &csv_progress] {
            assert_eq!(progress[0].phase, ParsePhase::ValidatingInput);
            assert_eq!(progress.last().unwrap().phase, ParsePhase::Complete);
            assert_eq!(progress.last().unwrap().unit, ParseProgressUnit::Cards);
            assert_eq!(progress.last().unwrap().completed_units, card_count);
            assert_eq!(progress.last().unwrap().total_units, Some(card_count));
            assert!(progress.len() <= card_count.div_ceil(PROGRESS_CARD_INTERVAL) + 20);
            for (index, entry) in progress.iter().enumerate() {
                if let Some(total) = entry.total_units {
                    assert!(entry.completed_units <= total);
                }
                if let Some(previous) = progress[..index]
                    .iter()
                    .rev()
                    .find(|previous| previous.phase == entry.phase && previous.unit == entry.unit)
                {
                    assert!(previous.completed_units <= entry.completed_units);
                }
            }
            let observed_card_counts: Vec<_> = progress
                .iter()
                .filter(|entry| entry.phase == ParsePhase::ValidatingCards)
                .map(|entry| entry.completed_units)
                .collect();
            assert!(observed_card_counts
                .windows(2)
                .all(|pair| pair[0] < pair[1]));
            for required in [
                ParsePhase::ValidatingInput,
                ParsePhase::ValidatingText,
                ParsePhase::Decoding,
                ParsePhase::ValidatingStructure,
                ParsePhase::ValidatingCards,
                ParsePhase::Finalizing,
                ParsePhase::Complete,
            ] {
                assert!(progress.iter().any(|entry| entry.phase == required));
            }
        }
    }

    #[test]
    fn cooperative_cancellation_returns_no_partial_json_or_csv_pack() {
        let card_count = PROGRESS_CARD_INTERVAL * 3;
        let json = synthetic_json(card_count);
        let csv = synthetic_csv(card_count);

        let mut json_progress = Vec::new();
        let json_error = parse_json_with_progress(&json, |progress| {
            json_progress.push(progress);
            if progress.phase == ParsePhase::ValidatingCards
                && progress.completed_units >= PROGRESS_CARD_INTERVAL
            {
                ParseControl::Cancel
            } else {
                ParseControl::Continue
            }
        })
        .unwrap_err();
        assert_eq!(json_error.code, ErrorCode::Cancelled);
        assert_eq!(
            json_progress.last().unwrap().completed_units,
            PROGRESS_CARD_INTERVAL
        );

        let mut csv_progress = Vec::new();
        let csv_error =
            parse_csv_with_progress(&csv, "synthetic.cancel.csv", "Cancel CSV", |progress| {
                csv_progress.push(progress);
                if progress.phase == ParsePhase::ValidatingCards
                    && progress.completed_units >= PROGRESS_CARD_INTERVAL
                {
                    ParseControl::Cancel
                } else {
                    ParseControl::Continue
                }
            })
            .unwrap_err();
        assert_eq!(csv_error.code, ErrorCode::Cancelled);
        assert_eq!(
            csv_progress.last().unwrap().completed_units,
            PROGRESS_CARD_INTERVAL
        );
    }

    #[test]
    fn item_control_polls_at_the_exact_frozen_byte_interval() {
        let mut control = CooperativeItemControl::new();
        let polls = Cell::new(0_usize);
        let mut probe = || {
            polls.set(polls.get() + 1);
            ParseControl::Continue
        };

        control
            .advance(CONTROL_ITEM_BYTE_INTERVAL - 1, &mut probe)
            .unwrap();
        assert_eq!(polls.get(), 0);
        control.advance(1, &mut probe).unwrap();
        assert_eq!(polls.get(), 1);
        control
            .advance(CONTROL_ITEM_BYTE_INTERVAL * 2, &mut probe)
            .unwrap();
        assert_eq!(polls.get(), 3);

        let mut cancelled = CooperativeItemControl::new();
        let error = cancelled
            .advance(CONTROL_ITEM_BYTE_INTERVAL, &mut || ParseControl::Cancel)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
    }

    #[test]
    fn unicode_source_stops_before_a_normalizer_can_buffer_the_whole_segment() {
        let value = format!("a{}", "\u{0301}".repeat(CONTROL_ITEM_BYTE_INTERVAL));
        let mut control = CooperativeItemControl::new();
        let mut cancel_probe = || ParseControl::Cancel;
        let mut source = CooperativeChars::new(&value, &mut control, &mut cancel_probe);
        let normalized = (&mut source).nfc().collect::<String>();

        assert!(source.cancelled.get());
        assert!(source.consumed_bytes >= CONTROL_ITEM_BYTE_INTERVAL);
        assert!(source.consumed_bytes <= CONTROL_ITEM_BYTE_INTERVAL + 3);
        assert!(source.consumed_bytes < value.len());
        assert!(normalized.len() < value.len());
    }

    #[test]
    fn nfc_normalization_propagates_cancel_without_returning_partial_text() {
        let value = format!("a{}", "\u{0301}".repeat(CONTROL_ITEM_BYTE_INTERVAL));
        let mut control = CooperativeItemControl::new();
        let error = normalize_nfc_with_control(&value, &mut || ParseControl::Cancel, &mut control)
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.location, "parse.control");
    }

    #[test]
    fn nfkc_identifier_propagates_cancel_before_oversized_input_is_accepted_or_rejected() {
        let value = "Ａ".repeat(CONTROL_ITEM_BYTE_INTERVAL);
        let polls = Cell::new(0_usize);
        let mut control = CooperativeItemControl::new();
        let error = validate_identifier(
            &value,
            "test.identifier",
            &mut || {
                polls.set(polls.get() + 1);
                ParseControl::Cancel
            },
            &mut control,
        )
        .unwrap_err();

        assert_eq!(polls.get(), 1);
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.location, "parse.control");
    }

    #[test]
    fn csv_optional_whitespace_scan_propagates_cancel() {
        let value = " ".repeat(CONTROL_ITEM_BYTE_INTERVAL * 2);
        let polls = Cell::new(0_usize);
        let mut control = CooperativeItemControl::new();
        let error = has_non_whitespace_with_control(
            &value,
            &mut || {
                polls.set(polls.get() + 1);
                ParseControl::Cancel
            },
            &mut control,
        )
        .unwrap_err();

        assert_eq!(polls.get(), 1);
        assert_eq!(error.code, ErrorCode::Cancelled);
    }

    #[test]
    fn csv_list_delimiter_scan_propagates_cancel_before_cloning() {
        let value = format!("{}|tail", "x".repeat(CONTROL_ITEM_BYTE_INTERVAL * 2));
        let polls = Cell::new(0_usize);
        let mut control = CooperativeItemControl::new();
        let error = split_csv_list(
            Some(&value),
            &mut || {
                polls.set(polls.get() + 1);
                ParseControl::Cancel
            },
            &mut control,
        )
        .unwrap_err();

        assert_eq!(polls.get(), 1);
        assert_eq!(error.code, ErrorCode::Cancelled);
    }

    #[test]
    fn csv_schedule_epoch_preserves_optional_and_u32_parse_semantics() {
        let mut control = CooperativeItemControl::new();
        let mut probe = || ParseControl::Continue;

        assert_eq!(
            parse_optional_csv_schedule_epoch(None, "test", &mut probe, &mut control).unwrap(),
            None
        );
        assert_eq!(
            parse_optional_csv_schedule_epoch(Some("  "), "test", &mut probe, &mut control)
                .unwrap(),
            None
        );
        assert_eq!(
            parse_optional_csv_schedule_epoch(Some("+1"), "test", &mut probe, &mut control)
                .unwrap(),
            Some(1)
        );
        assert_eq!(
            parse_optional_csv_schedule_epoch(Some("4294967295"), "test", &mut probe, &mut control)
                .unwrap(),
            Some(u32::MAX)
        );
        assert_eq!(
            parse_optional_csv_schedule_epoch(Some(" 1"), "test", &mut probe, &mut control)
                .unwrap_err()
                .code,
            ErrorCode::InvalidExercise
        );
    }

    #[test]
    fn decoder_control_polls_at_the_exact_interval_without_progress_flood() {
        let bytes = vec![b'x'; CONTROL_DECODE_BYTE_INTERVAL * 2 + 1];
        let polls = Rc::new(Cell::new(0_usize));
        let observed_polls = polls.clone();
        let cancel_probe = Rc::new(RefCell::new(move || {
            observed_polls.set(observed_polls.get() + 1);
            ParseControl::Continue
        }));
        let cancelled = Rc::new(Cell::new(false));
        let mut progress = Vec::new();
        let mut observer = |entry| {
            progress.push(entry);
            ParseControl::Continue
        };
        let mut reader = ObservedReader::new(
            &bytes,
            &mut observer,
            cancel_probe,
            ParsePhase::Decoding,
            cancelled,
        );
        let mut buffer = vec![0_u8; bytes.len()];

        assert_eq!(
            reader.read(&mut buffer).unwrap(),
            CONTROL_DECODE_BYTE_INTERVAL
        );
        assert_eq!(polls.get(), 1);
        assert_eq!(
            reader.read(&mut buffer).unwrap(),
            CONTROL_DECODE_BYTE_INTERVAL
        );
        assert_eq!(polls.get(), 2);
        assert_eq!(reader.read(&mut buffer).unwrap(), 1);
        assert_eq!(polls.get(), 3);
        drop(reader);

        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].completed_units, bytes.len());
    }

    #[test]
    fn json_decode_cancel_probe_stops_before_structure_or_cards_are_visible() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "packId": "synthetic.decode-cancel-json",
            "title": "Decode cancellation JSON",
            "padding": "x".repeat(CONTROL_DECODE_BYTE_INTERVAL * 2),
            "cards": [{"cardId": "one", "prompt": "p", "answer": "a"}]
        }))
        .unwrap();
        let decoding_started = Cell::new(false);
        let mut progress = Vec::new();

        let error = parse_json_with_progress_and_cancel(
            &bytes,
            |entry| {
                if entry.phase == ParsePhase::Decoding {
                    decoding_started.set(true);
                }
                progress.push(entry);
                ParseControl::Continue
            },
            || {
                if decoding_started.get() {
                    ParseControl::Cancel
                } else {
                    ParseControl::Continue
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.location, "parse.control");
        assert_eq!(
            progress
                .iter()
                .filter(|entry| entry.phase == ParsePhase::Decoding)
                .map(|entry| entry.completed_units)
                .collect::<Vec<_>>(),
            vec![0]
        );
        assert!(!progress
            .iter()
            .any(|entry| entry.phase == ParsePhase::ValidatingStructure));
        assert!(!progress
            .iter()
            .any(|entry| entry.phase == ParsePhase::ValidatingCards));
    }

    #[test]
    fn csv_decode_cancel_probe_stops_before_any_card_is_completed() {
        let csv = format!(
            "cardId,prompt,answer,explanation\ncard-1,prompt,answer,{}\n",
            "x".repeat(CONTROL_DECODE_BYTE_INTERVAL * 2)
        );
        let decoding_started = Cell::new(false);
        let mut progress = Vec::new();

        let error = parse_csv_with_progress_and_cancel(
            csv.as_bytes(),
            "synthetic.decode-cancel-csv",
            "Decode cancellation CSV",
            |entry| {
                if entry.phase == ParsePhase::Decoding {
                    decoding_started.set(true);
                }
                progress.push(entry);
                ParseControl::Continue
            },
            || {
                if decoding_started.get() {
                    ParseControl::Cancel
                } else {
                    ParseControl::Continue
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.location, "parse.control");
        assert_eq!(
            progress
                .iter()
                .filter(|entry| entry.phase == ParsePhase::Decoding)
                .map(|entry| entry.completed_units)
                .collect::<Vec<_>>(),
            vec![0]
        );
        assert_eq!(
            progress
                .iter()
                .filter(|entry| entry.phase == ParsePhase::ValidatingCards)
                .map(|entry| entry.completed_units)
                .collect::<Vec<_>>(),
            vec![0]
        );
    }

    #[test]
    fn single_long_json_card_cancels_inside_item_work_without_a_partial_card() {
        let tags = (0..MAX_TAGS)
            .map(|index| format!("tag-{index:02}-{}", "t".repeat(MAX_TAG_CHARS - 7)))
            .collect::<Vec<_>>();
        let value = serde_json::json!({
            "schemaVersion": 1,
            "packId": "synthetic.single-item-json",
            "title": "Single item JSON",
            "cards": [{
                "cardId": "card-1",
                "exerciseKind": "recall",
                "prompt": "e\u{301}".repeat(MAX_PROMPT_CHARS / 2),
                "answer": "a".repeat(MAX_ANSWER_CHARS),
                "explanation": "x".repeat(MAX_EXPLANATION_CHARS),
                "tags": tags,
                "extensions": {
                    "synthetic": {
                        "version": 1,
                        "payload": { "text": "z".repeat(MAX_EXTENSION_BYTES / 2) }
                    }
                }
            }]
        });
        let bytes = serde_json::to_vec(&value).unwrap();
        let validating_cards = Cell::new(false);
        let completed_cards = Cell::new(usize::MAX);
        let error = parse_json_with_progress_and_cancel(
            &bytes,
            |progress| {
                if progress.phase == ParsePhase::ValidatingCards
                    && progress.unit == ParseProgressUnit::Cards
                {
                    validating_cards.set(true);
                    completed_cards.set(progress.completed_units);
                }
                ParseControl::Continue
            },
            || {
                if validating_cards.get() {
                    ParseControl::Cancel
                } else {
                    ParseControl::Continue
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(completed_cards.get(), 0);
    }

    #[test]
    fn single_long_csv_card_cancels_inside_item_work_without_a_partial_card() {
        let csv = format!(
            "cardId,prompt,answer,explanation\ncard-1,{},{},{}\n",
            "p".repeat(MAX_PROMPT_CHARS),
            "a".repeat(MAX_ANSWER_CHARS),
            "x".repeat(MAX_EXPLANATION_CHARS),
        );
        let validating_cards = Cell::new(false);
        let completed_cards = Cell::new(usize::MAX);
        let error = parse_csv_with_progress_and_cancel(
            csv.as_bytes(),
            "synthetic.single-item-csv",
            "Single item CSV",
            |progress| {
                if progress.phase == ParsePhase::ValidatingCards
                    && progress.unit == ParseProgressUnit::Cards
                {
                    validating_cards.set(true);
                    completed_cards.set(progress.completed_units);
                }
                ParseControl::Continue
            },
            || {
                if validating_cards.get() {
                    ParseControl::Cancel
                } else {
                    ParseControl::Continue
                }
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(completed_cards.get(), 0);
    }

    #[test]
    fn cancellation_can_stop_before_input_bytes_are_inspected() {
        let error = parse_json_with_progress(b"not json", |_| ParseControl::Cancel).unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.location, "parse.control");
    }

    #[test]
    fn bounded_file_read_reports_progress_cancels_and_rejects_invalid_inputs() {
        let mut input = NamedTempFile::new().unwrap();
        let bytes = vec![b'x'; PROGRESS_BYTE_INTERVAL + 7];
        input.write_all(&bytes).unwrap();
        input.flush().unwrap();

        let mut progress = Vec::new();
        let read = read_bounded_file_with_progress(input.path(), |entry| {
            progress.push(entry);
            ParseControl::Continue
        })
        .unwrap();
        assert_eq!(read, bytes);
        assert!(progress
            .iter()
            .all(|entry| entry.phase == ParsePhase::ReadingInput));
        assert_eq!(progress.first().unwrap().completed_units, 0);
        assert_eq!(progress.last().unwrap().completed_units, bytes.len());
        assert_eq!(progress.last().unwrap().total_units, Some(bytes.len()));

        let error = read_bounded_file_with_progress(input.path(), |entry| {
            if entry.completed_units > 0 {
                ParseControl::Cancel
            } else {
                ParseControl::Continue
            }
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);

        let oversized = NamedTempFile::new().unwrap();
        oversized
            .as_file()
            .set_len((MAX_PACKAGE_BYTES + 1) as u64)
            .unwrap();
        assert_eq!(
            read_bounded_file_with_progress(oversized.path(), |_| ParseControl::Continue)
                .unwrap_err()
                .code,
            ErrorCode::ByteBudget
        );

        let directory = tempdir().unwrap();
        assert_eq!(
            read_bounded_file_with_progress(directory.path(), |_| ParseControl::Continue)
                .unwrap_err()
                .code,
            ErrorCode::InvalidFileType
        );
    }

    #[test]
    fn chunked_utf8_validation_handles_boundary_scalars_and_cancellation() {
        let mut valid = vec![b'a'; PROGRESS_BYTE_INTERVAL - 1];
        valid.extend_from_slice("圆".as_bytes());
        valid.push(b'z');
        let mut progress = Vec::new();
        let validated = validate_common_input(&valid, &mut |entry| {
            progress.push(entry);
            ParseControl::Continue
        })
        .unwrap();
        assert_eq!(validated.file_sha256, sha256_hex(&valid));
        let text_progress: Vec<_> = progress
            .iter()
            .filter(|entry| entry.phase == ParsePhase::ValidatingText)
            .collect();
        assert_eq!(text_progress[1].completed_units, PROGRESS_BYTE_INTERVAL - 1);
        assert_eq!(text_progress.last().unwrap().completed_units, valid.len());

        let mut invalid = vec![b'a'; PROGRESS_BYTE_INTERVAL - 1];
        invalid.extend_from_slice(&[0xE5, 0x9C, b'x']);
        assert_eq!(
            validate_common_input(&invalid, &mut |_| ParseControl::Continue)
                .unwrap_err()
                .code,
            ErrorCode::InvalidUtf8
        );

        let error = validate_common_input(&valid, &mut |entry| {
            if entry.phase == ParsePhase::ValidatingText && entry.completed_units > 0 {
                ParseControl::Cancel
            } else {
                ParseControl::Continue
            }
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
    }

    #[test]
    fn cooperative_cancellation_is_observed_in_every_json_byte_processing_phase() {
        let json = synthetic_json(PROGRESS_CARD_INTERVAL + 1);
        for phase in [
            ParsePhase::ValidatingInput,
            ParsePhase::ValidatingText,
            ParsePhase::ScanningSyntax,
            ParsePhase::Decoding,
            ParsePhase::ValidatingStructure,
            ParsePhase::ValidatingCards,
            ParsePhase::Finalizing,
            ParsePhase::Complete,
        ] {
            let error = parse_json_with_progress(&json, |progress| {
                if progress.phase == phase && progress.completed_units > 0 {
                    ParseControl::Cancel
                } else {
                    ParseControl::Continue
                }
            })
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::Cancelled, "{phase:?}");
        }
    }

    #[test]
    fn cooperative_cancellation_is_observed_in_every_csv_byte_processing_phase() {
        let csv = synthetic_csv(PROGRESS_CARD_INTERVAL + 1);
        for phase in [
            ParsePhase::ValidatingInput,
            ParsePhase::ValidatingText,
            ParsePhase::Decoding,
            ParsePhase::ValidatingStructure,
            ParsePhase::ValidatingCards,
            ParsePhase::Finalizing,
            ParsePhase::Complete,
        ] {
            let error = parse_csv_with_progress(
                &csv,
                "synthetic.cancel-phases.csv",
                "Cancel phases",
                |progress| {
                    if progress.phase == phase && progress.completed_units > 0 {
                        ParseControl::Cancel
                    } else {
                        ParseControl::Continue
                    }
                },
            )
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::Cancelled, "{phase:?}");
        }
    }
}
