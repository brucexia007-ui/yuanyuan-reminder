use std::collections::HashSet;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::config_preview::{
    group_is_exact, handler_is_exact, normalize_json_comments, parse_config_value,
    preview_hook_config_set, HookConfigFormat, HookConfigParseStatus, HookSetPreviewAction,
    OwnedCommandHookSpec, MAX_HOOK_CONFIG_BYTES,
};

/// An in-memory edit that never crosses the UI or diagnostic boundary.
#[derive(Clone, PartialEq, Eq)]
pub struct PreparedHookConfigEdit {
    pub output: Vec<u8>,
    pub original_sha256: [u8; 32],
    pub output_sha256: [u8; 32],
    pub added_handlers: usize,
    pub removed_handlers: usize,
    pub config_write_performed: bool,
    pub source_task_behavior_changed: bool,
}

impl std::fmt::Debug for PreparedHookConfigEdit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedHookConfigEdit")
            .field("output_bytes", &self.output.len())
            .field("added_handlers", &self.added_handlers)
            .field("removed_handlers", &self.removed_handlers)
            .field("config_write_performed", &self.config_write_performed)
            .field(
                "source_task_behavior_changed",
                &self.source_task_behavior_changed,
            )
            .finish()
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum HookConfigEditError {
    #[error("lossless editing supports only reviewed JSON hook sources")]
    UnsupportedFormat,
    #[error("hook configuration exceeds the supported size")]
    TooLarge,
    #[error("hook configuration is not safe to edit automatically")]
    ManualReviewRequired,
    #[error("hook configuration syntax cannot be edited losslessly")]
    UnsupportedSyntax,
    #[error("the prepared hook configuration would exceed the supported size")]
    OutputTooLarge,
}

/// Produces an idempotent, byte-preserving JSON/JSONC addition in memory.
///
/// Existing bytes are never rewritten or reordered. Only missing, fully
/// reviewed Yuanyuan matcher groups are inserted. Conflict, duplicate,
/// modified, unsupported, or oversized input fails closed.
pub fn prepare_lossless_hook_config_addition(
    format: HookConfigFormat,
    input: &[u8],
    expected: &[OwnedCommandHookSpec],
) -> Result<PreparedHookConfigEdit, HookConfigEditError> {
    if !matches!(
        format,
        HookConfigFormat::CodexHooksJson | HookConfigFormat::ClaudeSettingsJson
    ) {
        return Err(HookConfigEditError::UnsupportedFormat);
    }
    if input.len() > MAX_HOOK_CONFIG_BYTES {
        return Err(HookConfigEditError::TooLarge);
    }
    let preview = preview_hook_config_set(format, input, expected)
        .map_err(|_| HookConfigEditError::ManualReviewRequired)?;
    if !matches!(
        preview.parse_status,
        HookConfigParseStatus::Parsed | HookConfigParseStatus::Empty
    ) || preview.proposed_action == HookSetPreviewAction::ManualReview
    {
        return Err(HookConfigEditError::ManualReviewRequired);
    }

    let normalized =
        normalize_json_comments(input).map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
    let semantic_root = match parse_config_value(format, input) {
        Ok(root) => Some(root),
        Err(HookConfigParseStatus::Empty) => None,
        Err(_) => return Err(HookConfigEditError::ManualReviewRequired),
    };
    let missing = expected
        .iter()
        .filter(|spec| {
            !semantic_root
                .as_ref()
                .is_some_and(|root| contains_exact_spec(root, spec))
        })
        .collect::<Vec<_>>();
    if missing.len() != preview.missing_handlers {
        return Err(HookConfigEditError::ManualReviewRequired);
    }
    if missing.is_empty() {
        return Ok(prepared(input, input.to_vec(), 0, 0));
    }

    let output = if semantic_root.is_none() {
        append_new_root(input, &missing)?
    } else {
        let mut parser = JsonParser::new(&normalized);
        let syntax_root = parser
            .parse_document()
            .map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
        let root = syntax_root
            .as_object()
            .ok_or(HookConfigEditError::UnsupportedSyntax)?;
        prepare_existing_root_edit(input, &normalized, root, &missing)?
    };
    if output.len() > MAX_HOOK_CONFIG_BYTES {
        return Err(HookConfigEditError::OutputTooLarge);
    }
    let after = preview_hook_config_set(format, &output, expected)
        .map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
    if after.proposed_action != HookSetPreviewAction::NoChange
        || after.exact_handlers != expected.len()
        || after.missing_handlers != 0
    {
        return Err(HookConfigEditError::UnsupportedSyntax);
    }
    Ok(prepared(input, output, missing.len(), 0))
}

fn prepared(
    input: &[u8],
    output: Vec<u8>,
    added_handlers: usize,
    removed_handlers: usize,
) -> PreparedHookConfigEdit {
    PreparedHookConfigEdit {
        original_sha256: Sha256::digest(input).into(),
        output_sha256: Sha256::digest(&output).into(),
        output,
        added_handlers,
        removed_handlers,
        config_write_performed: false,
        source_task_behavior_changed: false,
    }
}

/// Produces an idempotent JSON/JSONC removal in memory.
///
/// Only handlers that are semantically owned by the supplied specification
/// and whose raw node bytes still equal Yuanyuan's canonical writer output are
/// removed. A canonical single-handler Yuanyuan group may be removed as a
/// whole; in a mixed group only the canonical handler node is removed. Any
/// modified, duplicate, unexpected, reformatted, or commented owned node fails
/// closed so user changes are never guessed away.
pub fn prepare_lossless_hook_config_removal(
    format: HookConfigFormat,
    input: &[u8],
    expected: &[OwnedCommandHookSpec],
) -> Result<PreparedHookConfigEdit, HookConfigEditError> {
    if !matches!(
        format,
        HookConfigFormat::CodexHooksJson | HookConfigFormat::ClaudeSettingsJson
    ) {
        return Err(HookConfigEditError::UnsupportedFormat);
    }
    if input.len() > MAX_HOOK_CONFIG_BYTES {
        return Err(HookConfigEditError::TooLarge);
    }
    let preview = preview_hook_config_set(format, input, expected)
        .map_err(|_| HookConfigEditError::ManualReviewRequired)?;
    if !matches!(
        preview.parse_status,
        HookConfigParseStatus::Parsed | HookConfigParseStatus::Empty
    ) || preview.modified_handlers != 0
        || preview.duplicate_handlers != 0
        || preview.unexpected_owned_handlers != 0
        || preview.exact_handlers + preview.missing_handlers != expected.len()
    {
        return Err(HookConfigEditError::ManualReviewRequired);
    }
    if preview.parse_status == HookConfigParseStatus::Empty && preview.exact_handlers == 0 {
        return Ok(prepared(input, input.to_vec(), 0, 0));
    }

    let normalized =
        normalize_json_comments(input).map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
    let semantic_root =
        parse_config_value(format, input).map_err(|_| HookConfigEditError::ManualReviewRequired)?;
    let mut parser = JsonParser::new(&normalized);
    let syntax_root = parser
        .parse_document()
        .map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
    if preview.exact_handlers == 0 {
        return Ok(prepared(input, input.to_vec(), 0, 0));
    }
    let (output, removed_handlers) =
        prepare_existing_root_removal(input, &normalized, &semantic_root, &syntax_root, expected)?;
    if removed_handlers != preview.exact_handlers {
        return Err(HookConfigEditError::ManualReviewRequired);
    }
    let after = preview_hook_config_set(format, &output, expected)
        .map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
    if after.exact_handlers != 0
        || after.missing_handlers != expected.len()
        || after.modified_handlers != 0
        || after.duplicate_handlers != 0
        || after.unexpected_owned_handlers != 0
    {
        return Err(HookConfigEditError::UnsupportedSyntax);
    }
    Ok(prepared(input, output, 0, removed_handlers))
}

fn contains_exact_spec(root: &Value, expected: &OwnedCommandHookSpec) -> bool {
    root.get("hooks")
        .and_then(Value::as_object)
        .and_then(|hooks| hooks.get(&expected.event))
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                let Some(group) = group.as_object() else {
                    return false;
                };
                group_is_exact(&expected.event, group, expected)
                    && group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|handlers| {
                            handlers.iter().any(|handler| {
                                handler
                                    .as_object()
                                    .is_some_and(|handler| handler_is_exact(handler, expected))
                            })
                        })
            })
        })
}

fn append_new_root(
    input: &[u8],
    missing: &[&OwnedCommandHookSpec],
) -> Result<Vec<u8>, HookConfigEditError> {
    let mut output = input.to_vec();
    if !output.is_empty() && !matches!(output.last(), Some(b'\r' | b'\n')) {
        output.push(b'\n');
    }
    let mut root = Map::new();
    root.insert("hooks".to_owned(), hooks_value(missing));
    // Keep owned matcher and handler nodes in the same canonical compact form
    // used for insertions into an existing document. Disconnect can then bind
    // the exact raw node bytes instead of guessing whether a user reformatted
    // or annotated Yuanyuan-owned content.
    output.extend_from_slice(
        &serde_json::to_vec(&Value::Object(root))
            .map_err(|_| HookConfigEditError::UnsupportedSyntax)?,
    );
    output.push(b'\n');
    Ok(output)
}

fn prepare_existing_root_edit(
    input: &[u8],
    normalized: &[u8],
    root: &JsonObject,
    missing: &[&OwnedCommandHookSpec],
) -> Result<Vec<u8>, HookConfigEditError> {
    let mut insertions = Vec::new();
    let Some(hooks_member) = root.member("hooks") else {
        insertions.push(object_insertion(
            input,
            normalized,
            root,
            &[("hooks".to_owned(), hooks_value(missing))],
        )?);
        return apply_insertions(input, insertions);
    };
    let hooks = hooks_member
        .value
        .as_object()
        .ok_or(HookConfigEditError::UnsupportedSyntax)?;

    let mut grouped = Vec::<(String, Vec<&OwnedCommandHookSpec>)>::new();
    for spec in missing {
        if let Some((_, specs)) = grouped.iter_mut().find(|(event, _)| event == &spec.event) {
            specs.push(*spec);
        } else {
            grouped.push((spec.event.clone(), vec![*spec]));
        }
    }
    let mut new_events = Vec::new();
    for (event, specs) in grouped {
        if let Some(event_member) = hooks.member(&event) {
            let array = event_member
                .value
                .as_array()
                .ok_or(HookConfigEditError::UnsupportedSyntax)?;
            let entries = specs
                .iter()
                .map(|spec| group_value(spec))
                .collect::<Vec<_>>();
            insertions.push(array_insertion(input, normalized, array, &entries)?);
        } else {
            new_events.push((
                event,
                Value::Array(specs.iter().map(|spec| group_value(spec)).collect()),
            ));
        }
    }
    if !new_events.is_empty() {
        insertions.push(object_insertion(input, normalized, hooks, &new_events)?);
    }
    apply_insertions(input, insertions)
}

fn hooks_value(specs: &[&OwnedCommandHookSpec]) -> Value {
    let mut hooks = Map::new();
    for spec in specs {
        hooks
            .entry(spec.event.clone())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("new hook event is always an array")
            .push(group_value(spec));
    }
    Value::Object(hooks)
}

fn group_value(spec: &OwnedCommandHookSpec) -> Value {
    let handler = handler_value(spec);
    let mut group = Map::new();
    if let Some(matcher) = &spec.matcher {
        group.insert("matcher".to_owned(), Value::String(matcher.clone()));
    }
    group.insert("hooks".to_owned(), Value::Array(vec![handler]));
    Value::Object(group)
}

fn handler_value(spec: &OwnedCommandHookSpec) -> Value {
    let mut handler = Map::new();
    handler.insert("type".to_owned(), Value::String("command".to_owned()));
    handler.insert("command".to_owned(), Value::String(spec.command.clone()));
    if !spec.args.is_empty() {
        handler.insert(
            "args".to_owned(),
            Value::Array(spec.args.iter().cloned().map(Value::String).collect()),
        );
    }
    if let Some(timeout) = spec.timeout_seconds {
        handler.insert("timeout".to_owned(), Value::from(timeout));
    }
    Value::Object(handler)
}

#[derive(Debug)]
struct Removal {
    start: usize,
    end: usize,
}

fn prepare_existing_root_removal(
    input: &[u8],
    normalized: &[u8],
    semantic_root: &Value,
    syntax_root: &JsonNode,
    expected: &[OwnedCommandHookSpec],
) -> Result<(Vec<u8>, usize), HookConfigEditError> {
    let semantic_root = semantic_root
        .as_object()
        .ok_or(HookConfigEditError::UnsupportedSyntax)?;
    let syntax_root = syntax_root
        .as_object()
        .ok_or(HookConfigEditError::UnsupportedSyntax)?;
    let semantic_hooks = semantic_root
        .get("hooks")
        .and_then(Value::as_object)
        .ok_or(HookConfigEditError::UnsupportedSyntax)?;
    let syntax_hooks = syntax_root
        .member("hooks")
        .and_then(|member| member.value.as_object())
        .ok_or(HookConfigEditError::UnsupportedSyntax)?;

    let mut removals = Vec::new();
    let mut removed_handlers = 0usize;
    let expected_events = expected
        .iter()
        .map(|spec| spec.event.as_str())
        .collect::<HashSet<_>>();
    for event in expected_events {
        let Some(semantic_groups) = semantic_hooks.get(event).and_then(Value::as_array) else {
            continue;
        };
        let syntax_groups = syntax_hooks
            .member(event)
            .and_then(|member| member.value.as_array())
            .ok_or(HookConfigEditError::UnsupportedSyntax)?;
        if semantic_groups.len() != syntax_groups.items.len() {
            return Err(HookConfigEditError::UnsupportedSyntax);
        }
        let event_specs = expected
            .iter()
            .filter(|spec| spec.event == event)
            .collect::<Vec<_>>();
        let mut remove_group_indices = Vec::new();
        for (group_index, (semantic_group, syntax_group)) in
            semantic_groups.iter().zip(&syntax_groups.items).enumerate()
        {
            let semantic_group = semantic_group
                .as_object()
                .ok_or(HookConfigEditError::UnsupportedSyntax)?;
            let syntax_group_object = syntax_group
                .as_object()
                .ok_or(HookConfigEditError::UnsupportedSyntax)?;
            let matching_group_specs = event_specs
                .iter()
                .copied()
                .filter(|spec| group_is_exact(event, semantic_group, spec))
                .collect::<Vec<_>>();
            if matching_group_specs.is_empty() {
                continue;
            }
            let semantic_handlers = semantic_group
                .get("hooks")
                .and_then(Value::as_array)
                .ok_or(HookConfigEditError::UnsupportedSyntax)?;
            let syntax_handlers = syntax_group_object
                .member("hooks")
                .and_then(|member| member.value.as_array())
                .ok_or(HookConfigEditError::UnsupportedSyntax)?;
            if semantic_handlers.len() != syntax_handlers.items.len() {
                return Err(HookConfigEditError::UnsupportedSyntax);
            }

            let mut remove_handler_indices = Vec::new();
            let mut matched_specs = Vec::new();
            for (handler_index, (semantic_handler, syntax_handler)) in semantic_handlers
                .iter()
                .zip(&syntax_handlers.items)
                .enumerate()
            {
                let Some(semantic_handler) = semantic_handler.as_object() else {
                    return Err(HookConfigEditError::UnsupportedSyntax);
                };
                let matches = matching_group_specs
                    .iter()
                    .copied()
                    .filter(|spec| handler_is_exact(semantic_handler, spec))
                    .collect::<Vec<_>>();
                if matches.len() > 1 {
                    return Err(HookConfigEditError::ManualReviewRequired);
                }
                let Some(spec) = matches.first().copied() else {
                    continue;
                };
                let canonical = serde_json::to_vec(&handler_value(spec))
                    .map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
                if input.get(syntax_handler.start..syntax_handler.end) != Some(canonical.as_slice())
                {
                    return Err(HookConfigEditError::ManualReviewRequired);
                }
                remove_handler_indices.push(handler_index);
                matched_specs.push(spec);
            }
            if remove_handler_indices.is_empty() {
                continue;
            }
            removed_handlers += remove_handler_indices.len();
            if remove_handler_indices.len() == semantic_handlers.len() {
                if remove_handler_indices.len() != 1 || matched_specs.len() != 1 {
                    return Err(HookConfigEditError::ManualReviewRequired);
                }
                let canonical_group = serde_json::to_vec(&group_value(matched_specs[0]))
                    .map_err(|_| HookConfigEditError::UnsupportedSyntax)?;
                if input.get(syntax_group.start..syntax_group.end)
                    != Some(canonical_group.as_slice())
                {
                    return Err(HookConfigEditError::ManualReviewRequired);
                }
                remove_group_indices.push(group_index);
            } else {
                removals.extend(array_removals(
                    normalized,
                    syntax_handlers,
                    &remove_handler_indices,
                )?);
            }
        }
        removals.extend(array_removals(
            normalized,
            syntax_groups,
            &remove_group_indices,
        )?);
    }
    Ok((apply_removals(input, removals)?, removed_handlers))
}

fn array_removals(
    normalized: &[u8],
    array: &JsonArray,
    remove_indices: &[usize],
) -> Result<Vec<Removal>, HookConfigEditError> {
    if remove_indices.is_empty() {
        return Ok(Vec::new());
    }
    let remove = remove_indices.iter().copied().collect::<HashSet<_>>();
    if remove.len() != remove_indices.len()
        || remove.iter().any(|index| *index >= array.items.len())
    {
        return Err(HookConfigEditError::UnsupportedSyntax);
    }
    let comma_offsets = array
        .items
        .windows(2)
        .map(|pair| {
            let commas = normalized[pair[0].end..pair[1].start]
                .iter()
                .enumerate()
                .filter(|(_, byte)| **byte == b',')
                .map(|(offset, _)| pair[0].end + offset)
                .collect::<Vec<_>>();
            (commas.len() == 1)
                .then_some(commas[0])
                .ok_or(HookConfigEditError::UnsupportedSyntax)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let kept = (0..array.items.len())
        .filter(|index| !remove.contains(index))
        .collect::<Vec<_>>();
    let retained_commas = kept.windows(2).map(|pair| pair[0]).collect::<HashSet<_>>();

    let mut removals = remove
        .into_iter()
        .map(|index| Removal {
            start: array.items[index].start,
            end: array.items[index].end,
        })
        .collect::<Vec<_>>();
    removals.extend(
        comma_offsets
            .into_iter()
            .enumerate()
            .filter(|(index, _)| !retained_commas.contains(index))
            .map(|(_, offset)| Removal {
                start: offset,
                end: offset + 1,
            }),
    );
    Ok(removals)
}

fn apply_removals(
    input: &[u8],
    mut removals: Vec<Removal>,
) -> Result<Vec<u8>, HookConfigEditError> {
    removals.sort_by_key(|removal| (std::cmp::Reverse(removal.start), removal.end));
    if removals
        .iter()
        .any(|removal| removal.start >= removal.end || removal.end > input.len())
        || removals.windows(2).any(|pair| pair[1].end > pair[0].start)
    {
        return Err(HookConfigEditError::UnsupportedSyntax);
    }
    let mut output = input.to_vec();
    for removal in removals {
        output.drain(removal.start..removal.end);
    }
    Ok(output)
}

#[derive(Debug)]
struct Insertion {
    offset: usize,
    bytes: Vec<u8>,
}

fn object_insertion(
    input: &[u8],
    normalized: &[u8],
    object: &JsonObject,
    entries: &[(String, Value)],
) -> Result<Insertion, HookConfigEditError> {
    let serialized = entries
        .iter()
        .map(|(key, value)| {
            Ok(format!(
                "{}:{}",
                serde_json::to_string(key).map_err(|_| HookConfigEditError::UnsupportedSyntax)?,
                serde_json::to_string(value).map_err(|_| HookConfigEditError::UnsupportedSyntax)?
            ))
        })
        .collect::<Result<Vec<_>, HookConfigEditError>>()?;
    insertion_for_container(
        input,
        normalized,
        object.start,
        object.end,
        !object.members.is_empty(),
        &serialized,
    )
}

fn array_insertion(
    input: &[u8],
    normalized: &[u8],
    array: &JsonArray,
    entries: &[Value],
) -> Result<Insertion, HookConfigEditError> {
    let serialized = entries
        .iter()
        .map(|value| {
            serde_json::to_string(value).map_err(|_| HookConfigEditError::UnsupportedSyntax)
        })
        .collect::<Result<Vec<_>, _>>()?;
    insertion_for_container(
        input,
        normalized,
        array.start,
        array.end,
        !array.items.is_empty(),
        &serialized,
    )
}

fn insertion_for_container(
    input: &[u8],
    normalized: &[u8],
    start: usize,
    end: usize,
    has_existing: bool,
    entries: &[String],
) -> Result<Insertion, HookConfigEditError> {
    if entries.is_empty() || end == 0 || end > input.len() {
        return Err(HookConfigEditError::UnsupportedSyntax);
    }
    let close = end - 1;
    let mut trimmed = close;
    while trimmed > start && normalized[trimmed - 1].is_ascii_whitespace() {
        trimmed -= 1;
    }
    let trailing_contains_comment = input[trimmed..close] != normalized[trimmed..close];
    let offset = if trailing_contains_comment {
        close
    } else {
        trimmed
    };
    let multiline = normalized[start..end]
        .iter()
        .any(|byte| matches!(byte, b'\r' | b'\n'));
    let mut text = String::new();
    if has_existing {
        text.push(',');
    }
    if multiline {
        let close_indent = line_indent(input, close);
        let child_indent = child_indent(input, normalized, start, end, &close_indent);
        text.push('\n');
        text.push_str(&child_indent);
        text.push_str(&entries.join(&format!(",\n{child_indent}")));
        if offset == close {
            text.push('\n');
            text.push_str(&close_indent);
        }
    } else {
        text.push_str(&entries.join(","));
    }
    Ok(Insertion {
        offset,
        bytes: text.into_bytes(),
    })
}

fn line_indent(input: &[u8], offset: usize) -> String {
    let line_start = input[..offset]
        .iter()
        .rposition(|byte| matches!(byte, b'\r' | b'\n'))
        .map_or(0, |index| index + 1);
    input[line_start..offset]
        .iter()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .map(|byte| char::from(*byte))
        .collect()
}

fn child_indent(
    input: &[u8],
    normalized: &[u8],
    start: usize,
    end: usize,
    close_indent: &str,
) -> String {
    let first_content =
        (start + 1..end.saturating_sub(1)).find(|index| !normalized[*index].is_ascii_whitespace());
    if let Some(offset) = first_content {
        let indent = line_indent(input, offset);
        if indent.len() > close_indent.len() {
            return indent;
        }
    }
    format!("{}  ", close_indent)
}

fn apply_insertions(
    input: &[u8],
    mut insertions: Vec<Insertion>,
) -> Result<Vec<u8>, HookConfigEditError> {
    insertions.sort_by_key(|insertion| std::cmp::Reverse(insertion.offset));
    if insertions
        .windows(2)
        .any(|pair| pair[0].offset == pair[1].offset)
    {
        return Err(HookConfigEditError::UnsupportedSyntax);
    }
    let mut output = input.to_vec();
    for insertion in insertions {
        if insertion.offset > output.len() {
            return Err(HookConfigEditError::UnsupportedSyntax);
        }
        output.splice(insertion.offset..insertion.offset, insertion.bytes);
    }
    Ok(output)
}

#[derive(Debug, Clone)]
struct JsonNode {
    start: usize,
    end: usize,
    kind: JsonNodeKind,
}

impl JsonNode {
    fn as_object(&self) -> Option<&JsonObject> {
        match &self.kind {
            JsonNodeKind::Object(object) => Some(object),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&JsonArray> {
        match &self.kind {
            JsonNodeKind::Array(array) => Some(array),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
enum JsonNodeKind {
    Object(JsonObject),
    Array(JsonArray),
    Scalar,
}

#[derive(Debug, Clone)]
struct JsonObject {
    start: usize,
    end: usize,
    members: Vec<JsonMember>,
}

impl JsonObject {
    fn member(&self, key: &str) -> Option<&JsonMember> {
        self.members.iter().find(|member| member.key == key)
    }
}

#[derive(Debug, Clone)]
struct JsonMember {
    key: String,
    value: JsonNode,
}

#[derive(Debug, Clone)]
struct JsonArray {
    start: usize,
    end: usize,
    items: Vec<JsonNode>,
}

struct JsonParser<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> JsonParser<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn parse_document(&mut self) -> Result<JsonNode, ()> {
        self.skip_whitespace();
        let node = self.parse_value()?;
        self.skip_whitespace();
        (self.offset == self.input.len()).then_some(node).ok_or(())
    }

    fn parse_value(&mut self) -> Result<JsonNode, ()> {
        self.skip_whitespace();
        match self.input.get(self.offset) {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => {
                let start = self.offset;
                self.parse_string()?;
                Ok(JsonNode {
                    start,
                    end: self.offset,
                    kind: JsonNodeKind::Scalar,
                })
            }
            Some(_) => self.parse_scalar(),
            None => Err(()),
        }
    }

    fn parse_object(&mut self) -> Result<JsonNode, ()> {
        let start = self.offset;
        self.offset += 1;
        self.skip_whitespace();
        let mut members = Vec::new();
        let mut keys = HashSet::new();
        if self.consume(b'}') {
            return Ok(object_node(start, self.offset, members));
        }
        loop {
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(());
            }
            self.skip_whitespace();
            self.expect(b':')?;
            let value = self.parse_value()?;
            members.push(JsonMember { key, value });
            self.skip_whitespace();
            if self.consume(b'}') {
                return Ok(object_node(start, self.offset, members));
            }
            self.expect(b',')?;
            self.skip_whitespace();
        }
    }

    fn parse_array(&mut self) -> Result<JsonNode, ()> {
        let start = self.offset;
        self.offset += 1;
        self.skip_whitespace();
        let mut items = Vec::new();
        if self.consume(b']') {
            return Ok(array_node(start, self.offset, items));
        }
        loop {
            items.push(self.parse_value()?);
            self.skip_whitespace();
            if self.consume(b']') {
                return Ok(array_node(start, self.offset, items));
            }
            self.expect(b',')?;
            self.skip_whitespace();
        }
    }

    fn parse_string(&mut self) -> Result<String, ()> {
        let start = self.offset;
        self.expect(b'"')?;
        let mut escaped = false;
        while let Some(byte) = self.input.get(self.offset).copied() {
            self.offset += 1;
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                return serde_json::from_slice::<String>(&self.input[start..self.offset])
                    .map_err(|_| ());
            } else if byte < 0x20 {
                return Err(());
            }
        }
        Err(())
    }

    fn parse_scalar(&mut self) -> Result<JsonNode, ()> {
        let start = self.offset;
        while let Some(byte) = self.input.get(self.offset) {
            if byte.is_ascii_whitespace() || matches!(byte, b',' | b']' | b'}') {
                break;
            }
            self.offset += 1;
        }
        if start == self.offset {
            return Err(());
        }
        let value =
            serde_json::from_slice::<Value>(&self.input[start..self.offset]).map_err(|_| ())?;
        if value.is_array() || value.is_object() || value.is_string() {
            return Err(());
        }
        Ok(JsonNode {
            start,
            end: self.offset,
            kind: JsonNodeKind::Scalar,
        })
    }

    fn skip_whitespace(&mut self) {
        while self
            .input
            .get(self.offset)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.offset += 1;
        }
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.input.get(self.offset) == Some(&expected) {
            self.offset += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, expected: u8) -> Result<(), ()> {
        self.consume(expected).then_some(()).ok_or(())
    }
}

fn object_node(start: usize, end: usize, members: Vec<JsonMember>) -> JsonNode {
    JsonNode {
        start,
        end,
        kind: JsonNodeKind::Object(JsonObject {
            start,
            end,
            members,
        }),
    }
}

fn array_node(start: usize, end: usize, items: Vec<JsonNode>) -> JsonNode {
    JsonNode {
        start,
        end,
        kind: JsonNodeKind::Array(JsonArray { start, end, items }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_spec(event: &str) -> OwnedCommandHookSpec {
        OwnedCommandHookSpec {
            event: event.to_owned(),
            matcher: None,
            command: r"C:\Program Files\Yuanyuan\yuanyuan-bridge.exe".to_owned(),
            args: vec![
                "--owner-id".to_owned(),
                "yuanyuan-reminder".to_owned(),
                "--source".to_owned(),
                "claude-code-hooks".to_owned(),
                "--connector-id".to_owned(),
                "builtin.claude-code.00000000-0000-4000-8000-000000000010".to_owned(),
                "--source-instance".to_owned(),
                "00000000-0000-4000-8000-000000000001".to_owned(),
                "--key-id".to_owned(),
                "credential-reference-1".to_owned(),
            ],
            timeout_seconds: Some(1),
            owner_id: "yuanyuan-reminder".to_owned(),
            connector_id: "builtin.claude-code.00000000-0000-4000-8000-000000000010".to_owned(),
            source_instance: "00000000-0000-4000-8000-000000000001".to_owned(),
        }
    }

    fn codex_spec(event: &str) -> OwnedCommandHookSpec {
        OwnedCommandHookSpec {
            event: event.to_owned(),
            matcher: None,
            command: r#""C:\Program Files\Yuanyuan\yuanyuan-bridge.exe" --owner-id yuanyuan-reminder --source codex-hooks --connector-id builtin.codex.00000000-0000-4000-8000-000000000010 --source-instance 00000000-0000-4000-8000-000000000001 --key-id credential-reference-1"#.to_owned(),
            args: Vec::new(),
            timeout_seconds: Some(1),
            owner_id: "yuanyuan-reminder".to_owned(),
            connector_id: "builtin.codex.00000000-0000-4000-8000-000000000010".to_owned(),
            source_instance: "00000000-0000-4000-8000-000000000001".to_owned(),
        }
    }

    fn existing_bytes_are_preserved(original: &[u8], edited: &[u8]) -> bool {
        let mut original = original.iter();
        let mut next = original.next();
        for byte in edited {
            if next == Some(byte) {
                next = original.next();
            }
        }
        next.is_none()
    }

    #[test]
    fn empty_config_adds_the_complete_set_and_is_idempotent() {
        let specs = vec![codex_spec("SessionStart"), codex_spec("Stop")];
        let first =
            prepare_lossless_hook_config_addition(HookConfigFormat::CodexHooksJson, b"", &specs)
                .unwrap();
        assert_eq!(first.added_handlers, 2);
        assert!(!first.config_write_performed);
        assert!(!first.source_task_behavior_changed);
        assert_ne!(first.original_sha256, first.output_sha256);
        let second = prepare_lossless_hook_config_addition(
            HookConfigFormat::CodexHooksJson,
            &first.output,
            &specs,
        )
        .unwrap();
        assert_eq!(second.added_handlers, 0);
        assert_eq!(second.output, first.output);
        assert_eq!(second.original_sha256, second.output_sha256);
    }

    #[test]
    fn comments_unknown_fields_and_user_hooks_remain_byte_for_byte_in_order() {
        let original = br#"{
  // user appearance stays where it is
  "appearance": {"theme":"warm","url":"https://example.test/a//b"},
  "hooks": {
    "TaskCompleted": [
      {"matcher":"user-owned","hooks":[{"type":"command","command":"user-tool"}]}
    ] /* keep this comment */
  },
  "futureSetting": true
}"#;
        let specs = vec![claude_spec("TaskCompleted"), claude_spec("StopFailure")];
        let edit = prepare_lossless_hook_config_addition(
            HookConfigFormat::ClaudeSettingsJson,
            original,
            &specs,
        )
        .unwrap();
        assert_eq!(edit.added_handlers, 2);
        assert!(existing_bytes_are_preserved(original, &edit.output));
        let output = String::from_utf8(edit.output).unwrap();
        for unchanged in [
            "// user appearance stays where it is",
            r#""futureSetting": true"#,
            r#""command":"user-tool""#,
            "/* keep this comment */",
            "https://example.test/a//b",
        ] {
            assert!(output.contains(unchanged));
        }
    }

    #[test]
    fn partial_install_adds_only_the_missing_handler() {
        let specs = vec![claude_spec("TaskCreated"), claude_spec("TaskCompleted")];
        let mut hooks = Map::new();
        hooks.insert(
            "TaskCreated".to_owned(),
            Value::Array(vec![group_value(&specs[0])]),
        );
        let mut root = Map::new();
        root.insert("userSetting".to_owned(), Value::from(7));
        root.insert("hooks".to_owned(), Value::Object(hooks));
        let original = serde_json::to_vec_pretty(&Value::Object(root)).unwrap();
        let edit = prepare_lossless_hook_config_addition(
            HookConfigFormat::ClaudeSettingsJson,
            &original,
            &specs,
        )
        .unwrap();
        assert_eq!(edit.added_handlers, 1);
        assert!(existing_bytes_are_preserved(&original, &edit.output));
        let preview =
            preview_hook_config_set(HookConfigFormat::ClaudeSettingsJson, &edit.output, &specs)
                .unwrap();
        assert_eq!(preview.exact_handlers, 2);
        assert_eq!(preview.proposed_action, HookSetPreviewAction::NoChange);
    }

    #[test]
    fn modified_or_duplicate_owned_content_never_produces_an_edit() {
        let spec = claude_spec("TaskCompleted");
        let mut group = group_value(&spec);
        group["hooks"][0]["unexpected"] = Value::Bool(true);
        let input = serde_json::to_vec(&serde_json::json!({
            "hooks": {"TaskCompleted": [group]}
        }))
        .unwrap();
        assert_eq!(
            prepare_lossless_hook_config_addition(
                HookConfigFormat::ClaudeSettingsJson,
                &input,
                &[spec],
            ),
            Err(HookConfigEditError::ManualReviewRequired)
        );
    }

    #[test]
    fn duplicate_json_keys_fail_closed_even_when_semantic_preview_would_choose_one() {
        let input = br#"{"user":1,"user":2}"#;
        assert_eq!(
            prepare_lossless_hook_config_addition(
                HookConfigFormat::CodexHooksJson,
                input,
                &[codex_spec("SessionStart")],
            ),
            Err(HookConfigEditError::UnsupportedSyntax)
        );
    }

    #[test]
    fn trailing_comments_stay_before_inserted_content_and_output_remains_valid_jsonc() {
        let original = b"{\"user\":true // keep with user field\n}";
        let edit = prepare_lossless_hook_config_addition(
            HookConfigFormat::CodexHooksJson,
            original,
            &[codex_spec("SessionStart")],
        )
        .unwrap();
        assert!(existing_bytes_are_preserved(original, &edit.output));
        let output = String::from_utf8(edit.output).unwrap();
        assert!(
            output.find("// keep with user field").unwrap() < output.find("\"hooks\"").unwrap()
        );
    }

    #[test]
    fn comment_markers_inside_strings_are_not_removed_and_unclosed_comments_are_invalid() {
        let input = br#"{"url":"https://example.test/a//b","pattern":"/*literal*/"}"#;
        assert_eq!(normalize_json_comments(input).unwrap(), input);
        assert_eq!(
            normalize_json_comments(b"{/* never closed"),
            Err(HookConfigParseStatus::Invalid)
        );
    }

    #[test]
    fn toml_and_output_capacity_fail_closed_without_partial_results() {
        assert_eq!(
            prepare_lossless_hook_config_addition(
                HookConfigFormat::CodexConfigToml,
                b"",
                &[codex_spec("SessionStart")],
            ),
            Err(HookConfigEditError::UnsupportedFormat)
        );
        let padding = "x".repeat(MAX_HOOK_CONFIG_BYTES - 32);
        let input = serde_json::to_vec(&serde_json::json!({"padding": padding})).unwrap();
        assert!(input.len() <= MAX_HOOK_CONFIG_BYTES);
        assert_eq!(
            prepare_lossless_hook_config_addition(
                HookConfigFormat::CodexHooksJson,
                &input,
                &[codex_spec("SessionStart")],
            ),
            Err(HookConfigEditError::OutputTooLarge)
        );
    }

    #[test]
    fn debug_output_is_redacted() {
        let edit = prepare_lossless_hook_config_addition(
            HookConfigFormat::ClaudeSettingsJson,
            b"{}",
            &[claude_spec("TaskCompleted")],
        )
        .unwrap();
        let debug = format!("{edit:?}");
        assert!(!debug.contains("credential-reference"));
        assert!(!debug.contains("Program Files"));
        assert!(!debug.contains("connector-id"));
        assert!(debug.contains("output_bytes"));
    }

    #[test]
    fn canonical_single_handler_groups_are_removed_and_removal_is_idempotent() {
        let specs = vec![codex_spec("SessionStart"), codex_spec("Stop")];
        let installed =
            prepare_lossless_hook_config_addition(HookConfigFormat::CodexHooksJson, b"{}", &specs)
                .unwrap();
        let removed = prepare_lossless_hook_config_removal(
            HookConfigFormat::CodexHooksJson,
            &installed.output,
            &specs,
        )
        .unwrap();
        assert_eq!(removed.added_handlers, 0);
        assert_eq!(removed.removed_handlers, 2);
        assert!(!removed.config_write_performed);
        let preview =
            preview_hook_config_set(HookConfigFormat::CodexHooksJson, &removed.output, &specs)
                .unwrap();
        assert_eq!(preview.exact_handlers, 0);
        assert_eq!(preview.missing_handlers, 2);

        let again = prepare_lossless_hook_config_removal(
            HookConfigFormat::CodexHooksJson,
            &removed.output,
            &specs,
        )
        .unwrap();
        assert_eq!(again.removed_handlers, 0);
        assert_eq!(again.output, removed.output);
    }

    #[test]
    fn mixed_groups_remove_only_the_canonical_owned_handler_and_keep_user_bytes() {
        let spec = claude_spec("TaskCompleted");
        let owned = serde_json::to_string(&handler_value(&spec)).unwrap();
        let input = format!(
            "{{\n  \"future\":true,\n  \"hooks\":{{\"TaskCompleted\":[{{\"hooks\":[\n    {{\"type\":\"command\",\"command\":\"user-tool\"}},\n    /* owned follows */ {owned},\n    {{\"type\":\"command\",\"command\":\"user-tool-two\"}}\n  ]}}]}}\n}}"
        );
        let removed = prepare_lossless_hook_config_removal(
            HookConfigFormat::ClaudeSettingsJson,
            input.as_bytes(),
            &[spec],
        )
        .unwrap();
        assert_eq!(removed.removed_handlers, 1);
        let output = String::from_utf8(removed.output).unwrap();
        assert!(output.contains("user-tool"));
        assert!(output.contains("user-tool-two"));
        assert!(output.contains("/* owned follows */"));
        assert!(output.contains("\"future\":true"));
        assert!(!output.contains("credential-reference-1"));
        serde_json::from_slice::<Value>(&normalize_json_comments(output.as_bytes()).unwrap())
            .unwrap();
    }

    #[test]
    fn partial_install_removes_only_the_remaining_exact_owned_group() {
        let specs = vec![claude_spec("TaskCreated"), claude_spec("TaskCompleted")];
        let input = serde_json::to_vec(&serde_json::json!({
            "user": 7,
            "hooks": {"TaskCreated": [group_value(&specs[0])]}
        }))
        .unwrap();
        let removed = prepare_lossless_hook_config_removal(
            HookConfigFormat::ClaudeSettingsJson,
            &input,
            &specs,
        )
        .unwrap();
        assert_eq!(removed.removed_handlers, 1);
        let preview = preview_hook_config_set(
            HookConfigFormat::ClaudeSettingsJson,
            &removed.output,
            &specs,
        )
        .unwrap();
        assert_eq!(preview.exact_handlers, 0);
        assert_eq!(preview.missing_handlers, 2);
        assert!(String::from_utf8(removed.output)
            .unwrap()
            .contains("\"user\":7"));
    }

    #[test]
    fn semantically_exact_but_reformatted_or_commented_owned_nodes_require_review() {
        let spec = claude_spec("TaskCompleted");
        let pretty_handler = serde_json::to_string_pretty(&handler_value(&spec)).unwrap();
        let reformatted =
            format!("{{\"hooks\":{{\"TaskCompleted\":[{{\"hooks\":[{pretty_handler}]}}]}}}}");
        assert_eq!(
            prepare_lossless_hook_config_removal(
                HookConfigFormat::ClaudeSettingsJson,
                reformatted.as_bytes(),
                std::slice::from_ref(&spec)
            ),
            Err(HookConfigEditError::ManualReviewRequired)
        );

        let canonical = serde_json::to_string(&handler_value(&spec)).unwrap();
        let commented_handler = canonical.replacen('{', "{/* user touched */", 1);
        let commented =
            format!("{{\"hooks\":{{\"TaskCompleted\":[{{\"hooks\":[{commented_handler}]}}]}}}}");
        assert_eq!(
            prepare_lossless_hook_config_removal(
                HookConfigFormat::ClaudeSettingsJson,
                commented.as_bytes(),
                &[spec]
            ),
            Err(HookConfigEditError::ManualReviewRequired)
        );
    }

    #[test]
    fn modified_duplicate_and_duplicate_key_inputs_never_produce_a_removal() {
        let spec = claude_spec("TaskCompleted");
        let handler = handler_value(&spec);
        let duplicate = serde_json::to_vec(&serde_json::json!({
            "hooks": {"TaskCompleted": [{"hooks": [handler.clone(), handler]}]}
        }))
        .unwrap();
        assert_eq!(
            prepare_lossless_hook_config_removal(
                HookConfigFormat::ClaudeSettingsJson,
                &duplicate,
                std::slice::from_ref(&spec)
            ),
            Err(HookConfigEditError::ManualReviewRequired)
        );

        let mut modified = handler_value(&spec);
        modified["timeout"] = Value::from(2);
        let modified = serde_json::to_vec(&serde_json::json!({
            "hooks": {"TaskCompleted": [{"hooks": [modified]}]}
        }))
        .unwrap();
        assert_eq!(
            prepare_lossless_hook_config_removal(
                HookConfigFormat::ClaudeSettingsJson,
                &modified,
                std::slice::from_ref(&spec)
            ),
            Err(HookConfigEditError::ManualReviewRequired)
        );

        assert_eq!(
            prepare_lossless_hook_config_removal(
                HookConfigFormat::ClaudeSettingsJson,
                b"{\"hooks\":{},\"hooks\":{}}",
                &[spec]
            ),
            Err(HookConfigEditError::UnsupportedSyntax)
        );
    }

    #[test]
    fn removal_rejects_toml_and_debug_output_remains_redacted() {
        assert_eq!(
            prepare_lossless_hook_config_removal(
                HookConfigFormat::CodexConfigToml,
                b"",
                &[codex_spec("SessionStart")]
            ),
            Err(HookConfigEditError::UnsupportedFormat)
        );
        let spec = codex_spec("SessionStart");
        let installed = prepare_lossless_hook_config_addition(
            HookConfigFormat::CodexHooksJson,
            b"{}",
            std::slice::from_ref(&spec),
        )
        .unwrap();
        let removed = prepare_lossless_hook_config_removal(
            HookConfigFormat::CodexHooksJson,
            &installed.output,
            &[spec],
        )
        .unwrap();
        let debug = format!("{removed:?}");
        assert!(debug.contains("removed_handlers"));
        assert!(!debug.contains("credential-reference"));
        assert!(!debug.contains("Program Files"));
    }
}
