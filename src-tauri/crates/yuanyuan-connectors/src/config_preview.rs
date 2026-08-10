use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const MAX_HOOK_CONFIG_BYTES: usize = 64 * 1024;
const YUANYUAN_OWNER_ID: &str = "yuanyuan-reminder";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookConfigFormat {
    CodexHooksJson,
    CodexConfigToml,
    ClaudeSettingsJson,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookConfigParseStatus {
    Empty,
    Parsed,
    Invalid,
    TooLarge,
    UnsupportedShape,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookOwnershipStatus {
    Absent,
    Exact,
    Modified,
    Duplicate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookPreviewAction {
    AddOwnedHandler,
    NoChange,
    ManualReview,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookSetOwnershipStatus {
    Absent,
    Partial,
    Exact,
    Conflict,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookSetPreviewAction {
    AddAll,
    AddMissing,
    NoChange,
    ManualReview,
}

/// A whole-connector view produced by parsing the source exactly once. Event
/// names, commands, paths, identities, and configuration values are omitted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookConfigSetPreview {
    pub format: HookConfigFormat,
    pub parse_status: HookConfigParseStatus,
    pub ownership_status: HookSetOwnershipStatus,
    pub proposed_action: HookSetPreviewAction,
    pub expected_handlers: usize,
    pub exact_handlers: usize,
    pub missing_handlers: usize,
    pub modified_handlers: usize,
    pub duplicate_handlers: usize,
    pub unexpected_owned_handlers: usize,
    pub total_matcher_groups: usize,
    pub total_handlers: usize,
    pub user_matcher_groups: usize,
    pub mixed_matcher_groups: usize,
    pub user_handlers: usize,
    pub owned_matcher_groups: usize,
    pub owned_handler_candidates: usize,
    pub other_top_level_fields: usize,
    pub has_hooks_section: bool,
    pub backup_required_before_write: bool,
    pub lossless_write_supported: bool,
    pub config_write_performed: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorHookTool {
    Codex,
    ClaudeCode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum HookConfigSource {
    CodexUserHooksJson,
    CodexUserConfigToml,
    CodexProjectHooksJson,
    CodexProjectConfigToml,
    ClaudeUserSettingsJson,
    ClaudeProjectSettingsJson,
    ClaudeProjectLocalSettingsJson,
}

impl HookConfigSource {
    fn tool(self) -> ConnectorHookTool {
        match self {
            Self::CodexUserHooksJson
            | Self::CodexUserConfigToml
            | Self::CodexProjectHooksJson
            | Self::CodexProjectConfigToml => ConnectorHookTool::Codex,
            Self::ClaudeUserSettingsJson
            | Self::ClaudeProjectSettingsJson
            | Self::ClaudeProjectLocalSettingsJson => ConnectorHookTool::ClaudeCode,
        }
    }

    fn format(self) -> HookConfigFormat {
        match self {
            Self::CodexUserHooksJson | Self::CodexProjectHooksJson => {
                HookConfigFormat::CodexHooksJson
            }
            Self::CodexUserConfigToml | Self::CodexProjectConfigToml => {
                HookConfigFormat::CodexConfigToml
            }
            Self::ClaudeUserSettingsJson
            | Self::ClaudeProjectSettingsJson
            | Self::ClaudeProjectLocalSettingsJson => HookConfigFormat::ClaudeSettingsJson,
        }
    }

    fn is_preferred(self) -> bool {
        matches!(
            self,
            Self::CodexUserHooksJson | Self::ClaudeUserSettingsJson
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub struct HookConfigSourceInput<'a> {
    pub source: HookConfigSource,
    pub input: &'a [u8],
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookSourcesConflict {
    None,
    ParseFailure,
    SourceToolMismatch,
    CodexUserInlineHooks,
    CodexUserDualRepresentation,
    OwnedOutsidePreferredSource,
    OwnedAcrossMultipleSources,
    PreferredSourceConflict,
}

/// Cross-file summary for a single connector. It contains only counts and
/// fixed enums, never source paths or configuration content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookConfigSourcesPreview {
    pub tool: ConnectorHookTool,
    pub conflict: HookSourcesConflict,
    pub proposed_action: HookSetPreviewAction,
    pub source_files: usize,
    pub parsed_sources: usize,
    pub sources_with_hooks: usize,
    pub sources_with_owned_handlers: usize,
    pub preferred_source_present: bool,
    pub expected_handlers: usize,
    pub exact_handlers: usize,
    pub missing_handlers: usize,
    pub modified_handlers: usize,
    pub duplicate_handlers: usize,
    pub unexpected_owned_handlers: usize,
    pub lossless_edit_supported: bool,
    pub config_write_performed: bool,
    pub source_task_behavior_changed: bool,
}

/// A redacted, read-only summary. It intentionally contains no command text,
/// paths, connector identifiers, key identifiers, or configuration values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookConfigPreview {
    pub format: HookConfigFormat,
    pub parse_status: HookConfigParseStatus,
    pub ownership_status: HookOwnershipStatus,
    pub proposed_action: HookPreviewAction,
    pub total_matcher_groups: usize,
    pub total_handlers: usize,
    pub user_matcher_groups: usize,
    pub user_handlers: usize,
    pub owned_matcher_groups: usize,
    pub owned_handler_candidates: usize,
    pub exact_owned_handlers: usize,
    pub other_top_level_fields: usize,
    pub backup_required_before_write: bool,
    pub lossless_write_supported: bool,
    pub config_write_performed: bool,
    pub source_task_behavior_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedCommandHookSpec {
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub timeout_seconds: Option<u64>,
    pub owner_id: String,
    pub connector_id: String,
    pub source_instance: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HookConfigPreviewError {
    #[error("owned hook field {0} is invalid")]
    InvalidOwnedHookField(&'static str),
    #[error("owned hook command does not contain all ownership markers")]
    MissingOwnershipMarkers,
    #[error("owned hook set must contain between 1 and 32 unique handlers")]
    InvalidOwnedHookSet,
    #[error("owned hook set contains duplicate handler specifications")]
    DuplicateOwnedHookSpec,
    #[error("all handlers in an owned hook set must use one connector identity")]
    MixedOwnedHookIdentity,
    #[error("hook source list contains a duplicate source")]
    DuplicateConfigSource,
    #[error("hook source list exceeds the supported source count")]
    TooManyConfigSources,
}

pub fn preview_hook_config(
    format: HookConfigFormat,
    input: &[u8],
    expected: &OwnedCommandHookSpec,
) -> Result<HookConfigPreview, HookConfigPreviewError> {
    validate_expected(expected)?;

    if input.len() > MAX_HOOK_CONFIG_BYTES {
        return Ok(empty_preview(format, HookConfigParseStatus::TooLarge));
    }
    if input.iter().all(u8::is_ascii_whitespace) {
        return Ok(empty_preview(format, HookConfigParseStatus::Empty));
    }

    let root = match parse_config_value(format, input) {
        Ok(root) => root,
        Err(status) => return Ok(empty_preview(format, status)),
    };

    inspect_root(format, &root, expected)
}

fn inspect_root(
    format: HookConfigFormat,
    root: &Value,
    expected: &OwnedCommandHookSpec,
) -> Result<HookConfigPreview, HookConfigPreviewError> {
    let Some(root) = root.as_object() else {
        return Ok(empty_preview(
            format,
            HookConfigParseStatus::UnsupportedShape,
        ));
    };
    let other_top_level_fields = root
        .keys()
        .filter(|key| {
            key.as_str() != "hooks"
                && !(format == HookConfigFormat::CodexHooksJson && key.as_str() == "description")
        })
        .count();

    let Some(hooks) = root.get("hooks") else {
        let mut preview = empty_preview(format, HookConfigParseStatus::Parsed);
        preview.other_top_level_fields = other_top_level_fields;
        return Ok(preview);
    };
    let Some(events) = hooks.as_object() else {
        return Ok(empty_preview(
            format,
            HookConfigParseStatus::UnsupportedShape,
        ));
    };

    let mut total_matcher_groups = 0usize;
    let mut total_handlers = 0usize;
    let mut owned_matcher_groups = 0usize;
    let mut user_matcher_groups = 0usize;
    let mut owned_handler_candidates = 0usize;
    let mut exact_owned_handlers = 0usize;

    for (event, groups) in events {
        let Some(groups) = groups.as_array() else {
            return Ok(empty_preview(
                format,
                HookConfigParseStatus::UnsupportedShape,
            ));
        };
        for group in groups {
            total_matcher_groups += 1;
            let Some(group) = group.as_object() else {
                return Ok(empty_preview(
                    format,
                    HookConfigParseStatus::UnsupportedShape,
                ));
            };
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                return Ok(empty_preview(
                    format,
                    HookConfigParseStatus::UnsupportedShape,
                ));
            };
            let mut group_has_owned_candidate = false;
            let mut group_has_user_handler = false;
            for handler in handlers {
                total_handlers += 1;
                let Some(handler) = handler.as_object() else {
                    return Ok(empty_preview(
                        format,
                        HookConfigParseStatus::UnsupportedShape,
                    ));
                };
                if !is_owned_candidate(handler, expected) {
                    group_has_user_handler = true;
                    continue;
                }
                group_has_owned_candidate = true;
                owned_handler_candidates += 1;
                if group_is_exact(event, group, expected) && handler_is_exact(handler, expected) {
                    exact_owned_handlers += 1;
                }
            }
            if group_has_owned_candidate {
                owned_matcher_groups += 1;
            }
            if group_has_user_handler {
                user_matcher_groups += 1;
            }
        }
    }

    let ownership_status = match (owned_handler_candidates, exact_owned_handlers) {
        (0, _) => HookOwnershipStatus::Absent,
        (1, 1) => HookOwnershipStatus::Exact,
        (1, _) => HookOwnershipStatus::Modified,
        _ => HookOwnershipStatus::Duplicate,
    };
    let proposed_action = match ownership_status {
        HookOwnershipStatus::Absent => HookPreviewAction::AddOwnedHandler,
        HookOwnershipStatus::Exact => HookPreviewAction::NoChange,
        HookOwnershipStatus::Modified | HookOwnershipStatus::Duplicate => {
            HookPreviewAction::ManualReview
        }
    };

    Ok(HookConfigPreview {
        format,
        parse_status: HookConfigParseStatus::Parsed,
        ownership_status,
        proposed_action,
        total_matcher_groups,
        total_handlers,
        user_matcher_groups,
        user_handlers: total_handlers.saturating_sub(owned_handler_candidates),
        owned_matcher_groups,
        owned_handler_candidates,
        exact_owned_handlers,
        other_top_level_fields,
        backup_required_before_write: true,
        lossless_write_supported: matches!(
            format,
            HookConfigFormat::CodexHooksJson | HookConfigFormat::ClaudeSettingsJson
        ),
        config_write_performed: false,
        source_task_behavior_changed: false,
    })
}

pub fn preview_hook_config_set(
    format: HookConfigFormat,
    input: &[u8],
    expected: &[OwnedCommandHookSpec],
) -> Result<HookConfigSetPreview, HookConfigPreviewError> {
    validate_expected_set(expected)?;
    if input.len() > MAX_HOOK_CONFIG_BYTES {
        return Ok(empty_set_preview(
            format,
            HookConfigParseStatus::TooLarge,
            expected.len(),
        ));
    }
    if input.iter().all(u8::is_ascii_whitespace) {
        return Ok(empty_set_preview(
            format,
            HookConfigParseStatus::Empty,
            expected.len(),
        ));
    }

    let root = match parse_config_value(format, input) {
        Ok(root) => root,
        Err(status) => return Ok(empty_set_preview(format, status, expected.len())),
    };
    inspect_root_set(format, &root, expected)
}

pub fn preview_hook_config_sources(
    tool: ConnectorHookTool,
    sources: &[HookConfigSourceInput<'_>],
    expected: &[OwnedCommandHookSpec],
) -> Result<HookConfigSourcesPreview, HookConfigPreviewError> {
    validate_expected_set(expected)?;
    if sources.len() > 7 {
        return Err(HookConfigPreviewError::TooManyConfigSources);
    }
    let mut seen = std::collections::HashSet::with_capacity(sources.len());
    for source in sources {
        if !seen.insert(source.source) {
            return Err(HookConfigPreviewError::DuplicateConfigSource);
        }
    }

    let mut analyses = Vec::with_capacity(sources.len());
    let mut source_tool_mismatch = false;
    for source in sources {
        source_tool_mismatch |= source.source.tool() != tool;
        analyses.push((
            source.source,
            preview_hook_config_set(source.source.format(), source.input, expected)?,
        ));
    }

    let source_files = analyses.len();
    let parsed_sources = analyses
        .iter()
        .filter(|(_, preview)| {
            matches!(
                preview.parse_status,
                HookConfigParseStatus::Parsed | HookConfigParseStatus::Empty
            )
        })
        .count();
    let sources_with_hooks = analyses
        .iter()
        .filter(|(_, preview)| preview.has_hooks_section)
        .count();
    let sources_with_owned_handlers = analyses
        .iter()
        .filter(|(_, preview)| preview.owned_handler_candidates > 0)
        .count();
    let preferred = analyses.iter().find(|(source, _)| source.is_preferred());
    let preferred_source_present = preferred.is_some();

    let parse_failure = analyses.iter().any(|(_, preview)| {
        !matches!(
            preview.parse_status,
            HookConfigParseStatus::Parsed | HookConfigParseStatus::Empty
        )
    });
    let codex_user_json_has_hooks = analyses.iter().any(|(source, preview)| {
        *source == HookConfigSource::CodexUserHooksJson && preview.has_hooks_section
    });
    let codex_user_toml_has_hooks = analyses.iter().any(|(source, preview)| {
        *source == HookConfigSource::CodexUserConfigToml && preview.has_hooks_section
    });
    let owned_outside_preferred = analyses
        .iter()
        .any(|(source, preview)| !source.is_preferred() && preview.owned_handler_candidates > 0);

    let conflict = if source_tool_mismatch {
        HookSourcesConflict::SourceToolMismatch
    } else if parse_failure {
        HookSourcesConflict::ParseFailure
    } else if tool == ConnectorHookTool::Codex
        && codex_user_json_has_hooks
        && codex_user_toml_has_hooks
    {
        HookSourcesConflict::CodexUserDualRepresentation
    } else if tool == ConnectorHookTool::Codex && codex_user_toml_has_hooks {
        HookSourcesConflict::CodexUserInlineHooks
    } else if sources_with_owned_handlers > 1 {
        HookSourcesConflict::OwnedAcrossMultipleSources
    } else if owned_outside_preferred {
        HookSourcesConflict::OwnedOutsidePreferredSource
    } else if preferred
        .is_some_and(|(_, preview)| preview.ownership_status == HookSetOwnershipStatus::Conflict)
    {
        HookSourcesConflict::PreferredSourceConflict
    } else {
        HookSourcesConflict::None
    };

    let (exact_handlers, missing_handlers, modified_handlers, duplicate_handlers, unexpected) =
        preferred
            .map(|(_, preview)| {
                (
                    preview.exact_handlers,
                    preview.missing_handlers,
                    preview.modified_handlers,
                    preview.duplicate_handlers,
                    preview.unexpected_owned_handlers,
                )
            })
            .unwrap_or((0, expected.len(), 0, 0, 0));
    let proposed_action = if conflict != HookSourcesConflict::None {
        HookSetPreviewAction::ManualReview
    } else {
        preferred
            .map(|(_, preview)| preview.proposed_action)
            .unwrap_or(HookSetPreviewAction::AddAll)
    };

    Ok(HookConfigSourcesPreview {
        tool,
        conflict,
        proposed_action,
        source_files,
        parsed_sources,
        sources_with_hooks,
        sources_with_owned_handlers,
        preferred_source_present,
        expected_handlers: expected.len(),
        exact_handlers,
        missing_handlers,
        modified_handlers,
        duplicate_handlers,
        unexpected_owned_handlers: unexpected,
        lossless_edit_supported: conflict == HookSourcesConflict::None
            && proposed_action != HookSetPreviewAction::ManualReview,
        config_write_performed: false,
        source_task_behavior_changed: false,
    })
}

pub(crate) fn parse_config_value(
    format: HookConfigFormat,
    input: &[u8],
) -> Result<Value, HookConfigParseStatus> {
    match format {
        HookConfigFormat::CodexHooksJson | HookConfigFormat::ClaudeSettingsJson => {
            let normalized = normalize_json_comments(input)?;
            if normalized.iter().all(u8::is_ascii_whitespace) {
                return Err(HookConfigParseStatus::Empty);
            }
            serde_json::from_slice(&normalized).map_err(|_| HookConfigParseStatus::Invalid)
        }
        HookConfigFormat::CodexConfigToml => {
            let text = std::str::from_utf8(input).map_err(|_| HookConfigParseStatus::Invalid)?;
            let value =
                toml::from_str::<toml::Value>(text).map_err(|_| HookConfigParseStatus::Invalid)?;
            serde_json::to_value(value).map_err(|_| HookConfigParseStatus::Invalid)
        }
    }
}

/// Replaces JSON comments with spaces while keeping byte offsets and newlines
/// stable. This lets the read-only preview and the lossless editor understand
/// existing JSONC without ever reserializing the user's document.
pub(crate) fn normalize_json_comments(input: &[u8]) -> Result<Vec<u8>, HookConfigParseStatus> {
    let mut output = input.to_vec();
    let mut index = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    while index < input.len() {
        let byte = input[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte != b'/' || index + 1 >= input.len() {
            index += 1;
            continue;
        }
        match input[index + 1] {
            b'/' => {
                output[index] = b' ';
                output[index + 1] = b' ';
                index += 2;
                while index < input.len() && !matches!(input[index], b'\r' | b'\n') {
                    output[index] = b' ';
                    index += 1;
                }
            }
            b'*' => {
                output[index] = b' ';
                output[index + 1] = b' ';
                index += 2;
                let mut closed = false;
                while index < input.len() {
                    if index + 1 < input.len() && input[index] == b'*' && input[index + 1] == b'/' {
                        output[index] = b' ';
                        output[index + 1] = b' ';
                        index += 2;
                        closed = true;
                        break;
                    }
                    if !matches!(input[index], b'\r' | b'\n') {
                        output[index] = b' ';
                    }
                    index += 1;
                }
                if !closed {
                    return Err(HookConfigParseStatus::Invalid);
                }
            }
            _ => index += 1,
        }
    }
    Ok(output)
}

fn inspect_root_set(
    format: HookConfigFormat,
    root: &Value,
    expected: &[OwnedCommandHookSpec],
) -> Result<HookConfigSetPreview, HookConfigPreviewError> {
    let Some(root) = root.as_object() else {
        return Ok(empty_set_preview(
            format,
            HookConfigParseStatus::UnsupportedShape,
            expected.len(),
        ));
    };
    let other_top_level_fields = root
        .keys()
        .filter(|key| {
            key.as_str() != "hooks"
                && !(format == HookConfigFormat::CodexHooksJson && key.as_str() == "description")
        })
        .count();
    let Some(hooks) = root.get("hooks") else {
        let mut preview = empty_set_preview(format, HookConfigParseStatus::Parsed, expected.len());
        preview.other_top_level_fields = other_top_level_fields;
        return Ok(preview);
    };
    let Some(events) = hooks.as_object() else {
        return Ok(empty_set_preview(
            format,
            HookConfigParseStatus::UnsupportedShape,
            expected.len(),
        ));
    };

    let mut assigned = vec![0usize; expected.len()];
    let mut exact = vec![0usize; expected.len()];
    let mut unexpected_owned_handlers = 0usize;
    let mut total_matcher_groups = 0usize;
    let mut total_handlers = 0usize;
    let mut user_matcher_groups = 0usize;
    let mut mixed_matcher_groups = 0usize;
    let mut user_handlers = 0usize;
    let mut owned_matcher_groups = 0usize;
    let mut owned_handler_candidates = 0usize;

    for (event, groups) in events {
        let Some(groups) = groups.as_array() else {
            return Ok(empty_set_preview(
                format,
                HookConfigParseStatus::UnsupportedShape,
                expected.len(),
            ));
        };
        for group in groups {
            total_matcher_groups += 1;
            let Some(group) = group.as_object() else {
                return Ok(empty_set_preview(
                    format,
                    HookConfigParseStatus::UnsupportedShape,
                    expected.len(),
                ));
            };
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                return Ok(empty_set_preview(
                    format,
                    HookConfigParseStatus::UnsupportedShape,
                    expected.len(),
                ));
            };
            let mut group_owned = 0usize;
            let mut group_user = 0usize;
            for handler in handlers {
                total_handlers += 1;
                let Some(handler) = handler.as_object() else {
                    return Ok(empty_set_preview(
                        format,
                        HookConfigParseStatus::UnsupportedShape,
                        expected.len(),
                    ));
                };
                if !is_owned_candidate(handler, &expected[0]) {
                    user_handlers += 1;
                    group_user += 1;
                    continue;
                }
                owned_handler_candidates += 1;
                group_owned += 1;
                match assign_owned_candidate(event, group, handler, expected) {
                    Some((index, is_exact)) => {
                        assigned[index] += 1;
                        if is_exact {
                            exact[index] += 1;
                        }
                    }
                    None => unexpected_owned_handlers += 1,
                }
            }
            if group_owned > 0 {
                owned_matcher_groups += 1;
            }
            if group_user > 0 {
                user_matcher_groups += 1;
            }
            if group_owned > 0 && group_user > 0 {
                mixed_matcher_groups += 1;
            }
        }
    }

    let mut exact_handlers = 0usize;
    let mut missing_handlers = 0usize;
    let mut modified_handlers = 0usize;
    let mut duplicate_handlers = 0usize;
    for (assigned, exact) in assigned.into_iter().zip(exact) {
        match (assigned, exact) {
            (0, _) => missing_handlers += 1,
            (1, 1) => exact_handlers += 1,
            (1, _) => modified_handlers += 1,
            _ => duplicate_handlers += 1,
        }
    }
    let ownership_status =
        if unexpected_owned_handlers > 0 || modified_handlers > 0 || duplicate_handlers > 0 {
            HookSetOwnershipStatus::Conflict
        } else if exact_handlers == expected.len() {
            HookSetOwnershipStatus::Exact
        } else if missing_handlers == expected.len() {
            HookSetOwnershipStatus::Absent
        } else {
            HookSetOwnershipStatus::Partial
        };
    let proposed_action = match ownership_status {
        HookSetOwnershipStatus::Absent => HookSetPreviewAction::AddAll,
        HookSetOwnershipStatus::Partial => HookSetPreviewAction::AddMissing,
        HookSetOwnershipStatus::Exact => HookSetPreviewAction::NoChange,
        HookSetOwnershipStatus::Conflict => HookSetPreviewAction::ManualReview,
    };

    Ok(HookConfigSetPreview {
        format,
        parse_status: HookConfigParseStatus::Parsed,
        ownership_status,
        proposed_action,
        expected_handlers: expected.len(),
        exact_handlers,
        missing_handlers,
        modified_handlers,
        duplicate_handlers,
        unexpected_owned_handlers,
        total_matcher_groups,
        total_handlers,
        user_matcher_groups,
        mixed_matcher_groups,
        user_handlers,
        owned_matcher_groups,
        owned_handler_candidates,
        other_top_level_fields,
        has_hooks_section: true,
        backup_required_before_write: true,
        lossless_write_supported: matches!(
            format,
            HookConfigFormat::CodexHooksJson | HookConfigFormat::ClaudeSettingsJson
        ),
        config_write_performed: false,
        source_task_behavior_changed: false,
    })
}

fn assign_owned_candidate(
    event: &str,
    group: &serde_json::Map<String, Value>,
    handler: &serde_json::Map<String, Value>,
    expected: &[OwnedCommandHookSpec],
) -> Option<(usize, bool)> {
    let exact = expected
        .iter()
        .enumerate()
        .filter(|(_, spec)| group_is_exact(event, group, spec) && handler_is_exact(handler, spec))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        return Some((exact[0], true));
    }

    let event_matches = expected
        .iter()
        .enumerate()
        .filter(|(_, spec)| spec.event == event)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if event_matches.len() == 1 {
        return Some((event_matches[0], false));
    }
    if event_matches.is_empty() {
        return None;
    }

    let matcher_matches = event_matches
        .iter()
        .copied()
        .filter(|index| group_matcher_matches(group, &expected[*index]))
        .collect::<Vec<_>>();
    if matcher_matches.len() == 1 {
        return Some((matcher_matches[0], false));
    }
    let handler_matches = event_matches
        .into_iter()
        .filter(|index| handler_command_and_args_match(handler, &expected[*index]))
        .collect::<Vec<_>>();
    (handler_matches.len() == 1).then_some((handler_matches[0], false))
}

fn group_matcher_matches(
    group: &serde_json::Map<String, Value>,
    expected: &OwnedCommandHookSpec,
) -> bool {
    match (&expected.matcher, group.get("matcher")) {
        (None, None) => true,
        (Some(expected), Some(Value::String(actual))) => expected == actual,
        _ => false,
    }
}

fn handler_command_and_args_match(
    handler: &serde_json::Map<String, Value>,
    expected: &OwnedCommandHookSpec,
) -> bool {
    if handler.get("command").and_then(Value::as_str) != Some(expected.command.as_str()) {
        return false;
    }
    match handler.get("args") {
        None => expected.args.is_empty(),
        Some(Value::Array(actual)) => {
            actual.len() == expected.args.len()
                && actual
                    .iter()
                    .zip(&expected.args)
                    .all(|(actual, expected)| actual.as_str() == Some(expected.as_str()))
        }
        Some(_) => false,
    }
}

fn validate_expected_set(expected: &[OwnedCommandHookSpec]) -> Result<(), HookConfigPreviewError> {
    if expected.is_empty() || expected.len() > 32 {
        return Err(HookConfigPreviewError::InvalidOwnedHookSet);
    }
    for spec in expected {
        validate_expected(spec)?;
    }
    let identity = (
        expected[0].owner_id.as_str(),
        expected[0].connector_id.as_str(),
        expected[0].source_instance.as_str(),
    );
    if expected.iter().skip(1).any(|spec| {
        (
            spec.owner_id.as_str(),
            spec.connector_id.as_str(),
            spec.source_instance.as_str(),
        ) != identity
    }) {
        return Err(HookConfigPreviewError::MixedOwnedHookIdentity);
    }
    for (index, spec) in expected.iter().enumerate() {
        if expected[..index].iter().any(|prior| prior == spec) {
            return Err(HookConfigPreviewError::DuplicateOwnedHookSpec);
        }
    }
    Ok(())
}

fn empty_set_preview(
    format: HookConfigFormat,
    parse_status: HookConfigParseStatus,
    expected_handlers: usize,
) -> HookConfigSetPreview {
    let safe_to_add = matches!(
        parse_status,
        HookConfigParseStatus::Empty | HookConfigParseStatus::Parsed
    );
    HookConfigSetPreview {
        format,
        parse_status,
        ownership_status: if safe_to_add {
            HookSetOwnershipStatus::Absent
        } else {
            HookSetOwnershipStatus::Conflict
        },
        proposed_action: if safe_to_add {
            HookSetPreviewAction::AddAll
        } else {
            HookSetPreviewAction::ManualReview
        },
        expected_handlers,
        exact_handlers: 0,
        missing_handlers: expected_handlers,
        modified_handlers: 0,
        duplicate_handlers: 0,
        unexpected_owned_handlers: 0,
        total_matcher_groups: 0,
        total_handlers: 0,
        user_matcher_groups: 0,
        mixed_matcher_groups: 0,
        user_handlers: 0,
        owned_matcher_groups: 0,
        owned_handler_candidates: 0,
        other_top_level_fields: 0,
        has_hooks_section: false,
        backup_required_before_write: true,
        lossless_write_supported: safe_to_add
            && matches!(
                format,
                HookConfigFormat::CodexHooksJson | HookConfigFormat::ClaudeSettingsJson
            ),
        config_write_performed: false,
        source_task_behavior_changed: false,
    }
}

pub(crate) fn group_is_exact(
    event: &str,
    group: &serde_json::Map<String, Value>,
    expected: &OwnedCommandHookSpec,
) -> bool {
    if event != expected.event || group.keys().any(|key| key != "matcher" && key != "hooks") {
        return false;
    }
    match (&expected.matcher, group.get("matcher")) {
        (None, None) => true,
        (Some(expected), Some(Value::String(actual))) => expected == actual,
        _ => false,
    }
}

pub(crate) fn handler_is_exact(
    handler: &serde_json::Map<String, Value>,
    expected: &OwnedCommandHookSpec,
) -> bool {
    if handler
        .keys()
        .any(|key| !matches!(key.as_str(), "type" | "command" | "args" | "timeout"))
    {
        return false;
    }
    if handler.get("type").and_then(Value::as_str) != Some("command")
        || handler.get("command").and_then(Value::as_str) != Some(expected.command.as_str())
    {
        return false;
    }

    let args_are_exact = match handler.get("args") {
        None => expected.args.is_empty(),
        Some(Value::Array(actual)) => {
            actual.len() == expected.args.len()
                && actual
                    .iter()
                    .zip(&expected.args)
                    .all(|(actual, expected)| actual.as_str() == Some(expected.as_str()))
        }
        Some(_) => false,
    };
    let timeout_is_exact = match (handler.get("timeout"), expected.timeout_seconds) {
        (None, None) => true,
        (Some(Value::Number(actual)), Some(expected)) => actual.as_u64() == Some(expected),
        _ => false,
    };
    args_are_exact && timeout_is_exact
}

fn is_owned_candidate(
    handler: &serde_json::Map<String, Value>,
    expected: &OwnedCommandHookSpec,
) -> bool {
    if handler.get("type").and_then(Value::as_str) != Some("command") {
        return false;
    }
    let Some(command) = handler.get("command").and_then(Value::as_str) else {
        return false;
    };
    if !command.to_ascii_lowercase().contains("yuanyuan-bridge") {
        return false;
    }

    let args = handler
        .get("args")
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    ownership_markers_present(command, &args, expected)
}

fn ownership_markers_present(
    command: &str,
    args: &[&str],
    expected: &OwnedCommandHookSpec,
) -> bool {
    marker_present(command, args, "--owner-id", &expected.owner_id)
        && marker_present(command, args, "--connector-id", &expected.connector_id)
        && marker_present(
            command,
            args,
            "--source-instance",
            &expected.source_instance,
        )
}

fn marker_present(command: &str, args: &[&str], marker: &str, value: &str) -> bool {
    let args_have_pair = args
        .windows(2)
        .any(|pair| pair[0] == marker && pair[1] == value);
    let args_have_equals = args
        .iter()
        .any(|argument| *argument == format!("{marker}={value}"));
    (command.contains(marker) && command.contains(value)) || args_have_pair || args_have_equals
}

fn validate_expected(expected: &OwnedCommandHookSpec) -> Result<(), HookConfigPreviewError> {
    for (name, value, max_len) in [
        ("event", expected.event.as_str(), 64usize),
        ("command", expected.command.as_str(), 4096),
        ("owner_id", expected.owner_id.as_str(), 64),
        ("connector_id", expected.connector_id.as_str(), 128),
        ("source_instance", expected.source_instance.as_str(), 128),
    ] {
        if value.trim().is_empty() || value.len() > max_len || value.chars().any(char::is_control) {
            return Err(HookConfigPreviewError::InvalidOwnedHookField(name));
        }
    }
    if expected.owner_id != YUANYUAN_OWNER_ID {
        return Err(HookConfigPreviewError::InvalidOwnedHookField("owner_id"));
    }
    if expected.args.len() > 32
        || expected
            .args
            .iter()
            .any(|arg| arg.is_empty() || arg.len() > 1024 || arg.chars().any(char::is_control))
    {
        return Err(HookConfigPreviewError::InvalidOwnedHookField("args"));
    }
    let borrowed_args = expected.args.iter().map(String::as_str).collect::<Vec<_>>();
    if !expected
        .command
        .to_ascii_lowercase()
        .contains("yuanyuan-bridge")
        || !ownership_markers_present(&expected.command, &borrowed_args, expected)
    {
        return Err(HookConfigPreviewError::MissingOwnershipMarkers);
    }
    Ok(())
}

fn empty_preview(
    format: HookConfigFormat,
    parse_status: HookConfigParseStatus,
) -> HookConfigPreview {
    let safe_to_add = matches!(
        parse_status,
        HookConfigParseStatus::Empty | HookConfigParseStatus::Parsed
    );
    HookConfigPreview {
        format,
        parse_status,
        ownership_status: HookOwnershipStatus::Absent,
        proposed_action: if safe_to_add {
            HookPreviewAction::AddOwnedHandler
        } else {
            HookPreviewAction::ManualReview
        },
        total_matcher_groups: 0,
        total_handlers: 0,
        user_matcher_groups: 0,
        user_handlers: 0,
        owned_matcher_groups: 0,
        owned_handler_candidates: 0,
        exact_owned_handlers: 0,
        other_top_level_fields: 0,
        backup_required_before_write: true,
        lossless_write_supported: safe_to_add
            && matches!(
                format,
                HookConfigFormat::CodexHooksJson | HookConfigFormat::ClaudeSettingsJson
            ),
        config_write_performed: false,
        source_task_behavior_changed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_spec() -> OwnedCommandHookSpec {
        OwnedCommandHookSpec {
            event: "TaskCompleted".to_owned(),
            matcher: None,
            command: r"C:\Program Files\Yuanyuan\yuanyuan-bridge.exe".to_owned(),
            args: vec![
                "--owner-id".to_owned(),
                "yuanyuan-reminder".to_owned(),
                "--source".to_owned(),
                "claude-code-hooks".to_owned(),
                "--connector-id".to_owned(),
                "connector-random-1".to_owned(),
                "--source-instance".to_owned(),
                "source-random-1".to_owned(),
                "--key-id".to_owned(),
                "credential-reference-1".to_owned(),
            ],
            timeout_seconds: Some(1),
            owner_id: "yuanyuan-reminder".to_owned(),
            connector_id: "connector-random-1".to_owned(),
            source_instance: "source-random-1".to_owned(),
        }
    }

    fn codex_spec() -> OwnedCommandHookSpec {
        OwnedCommandHookSpec {
            event: "SessionStart".to_owned(),
            matcher: Some("startup|resume".to_owned()),
            command: r#"\"C:\Program Files\Yuanyuan\yuanyuan-bridge.exe\" --owner-id yuanyuan-reminder --source codex-hooks --connector-id connector-random-1 --source-instance source-random-1 --key-id credential-reference-1"#.to_owned(),
            args: Vec::new(),
            timeout_seconds: Some(1),
            owner_id: "yuanyuan-reminder".to_owned(),
            connector_id: "connector-random-1".to_owned(),
            source_instance: "source-random-1".to_owned(),
        }
    }

    #[test]
    fn empty_and_invalid_inputs_never_write() {
        let empty =
            preview_hook_config(HookConfigFormat::ClaudeSettingsJson, b"  ", &claude_spec())
                .unwrap();
        assert_eq!(empty.parse_status, HookConfigParseStatus::Empty);
        assert!(!empty.config_write_performed);
        assert!(!empty.source_task_behavior_changed);

        let invalid = preview_hook_config(
            HookConfigFormat::CodexHooksJson,
            br#"{"hooks": "broken"}"#,
            &codex_spec(),
        )
        .unwrap();
        assert_eq!(
            invalid.parse_status,
            HookConfigParseStatus::UnsupportedShape
        );
        assert_eq!(invalid.proposed_action, HookPreviewAction::ManualReview);
    }

    #[test]
    fn claude_settings_count_user_entries_without_returning_their_contents() {
        let spec = claude_spec();
        let input = serde_json::json!({
            "$schema": "https://json.schemastore.org/claude-code-settings.json",
            "permissions": { "allow": ["Read"] },
            "hooks": {
                "PostToolUse": [{
                    "matcher": "Edit|Write",
                    "hooks": [{ "type": "command", "command": "private-user-command --secret value" }]
                }],
                "TaskCompleted": [{
                    "hooks": [{
                        "type": "command",
                        "command": spec.command,
                        "args": spec.args,
                        "timeout": 1
                    }]
                }]
            }
        });
        let preview = preview_hook_config(
            HookConfigFormat::ClaudeSettingsJson,
            &serde_json::to_vec(&input).unwrap(),
            &spec,
        )
        .unwrap();
        assert_eq!(preview.parse_status, HookConfigParseStatus::Parsed);
        assert_eq!(preview.ownership_status, HookOwnershipStatus::Exact);
        assert_eq!(preview.total_matcher_groups, 2);
        assert_eq!(preview.total_handlers, 2);
        assert_eq!(preview.user_matcher_groups, 1);
        assert_eq!(preview.user_handlers, 1);
        assert_eq!(preview.other_top_level_fields, 2);
        let redacted = serde_json::to_string(&preview).unwrap();
        assert!(!redacted.contains("private-user-command"));
        assert!(!redacted.contains("connector-random-1"));
        assert!(!redacted.contains("credential-reference-1"));
        assert!(!redacted.contains("Program Files"));
    }

    #[test]
    fn modified_and_duplicate_owned_entries_require_manual_review() {
        let spec = claude_spec();
        let modified = serde_json::json!({
            "hooks": {
                "TaskCompleted": [{
                    "matcher": "unexpected",
                    "hooks": [{
                        "type": "command",
                        "command": spec.command,
                        "args": spec.args,
                        "timeout": 1
                    }]
                }]
            }
        });
        let modified = preview_hook_config(
            HookConfigFormat::ClaudeSettingsJson,
            &serde_json::to_vec(&modified).unwrap(),
            &spec,
        )
        .unwrap();
        assert_eq!(modified.ownership_status, HookOwnershipStatus::Modified);
        assert_eq!(modified.proposed_action, HookPreviewAction::ManualReview);

        let handler = serde_json::json!({
            "type": "command",
            "command": spec.command,
            "args": spec.args,
            "timeout": 1
        });
        let duplicate = serde_json::json!({
            "hooks": { "TaskCompleted": [{ "hooks": [handler.clone(), handler] }] }
        });
        let duplicate = preview_hook_config(
            HookConfigFormat::ClaudeSettingsJson,
            &serde_json::to_vec(&duplicate).unwrap(),
            &spec,
        )
        .unwrap();
        assert_eq!(duplicate.ownership_status, HookOwnershipStatus::Duplicate);
        assert_eq!(duplicate.owned_handler_candidates, 2);
        assert_eq!(duplicate.exact_owned_handlers, 2);
    }

    #[test]
    fn codex_inline_toml_is_parsed_without_rewriting_comments_or_user_hooks() {
        let spec = codex_spec();
        let source = format!(
            r#"# keep this user comment
[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "user-policy.exe"

[[hooks.SessionStart]]
matcher = "startup|resume"
[[hooks.SessionStart.hooks]]
type = "command"
command = {}
timeout = 1
"#,
            serde_json::to_string(&spec.command).unwrap()
        );
        let parsed_source = toml::from_str::<toml::Value>(&source);
        assert!(parsed_source.is_ok(), "{source}\n{parsed_source:?}");
        let preview =
            preview_hook_config(HookConfigFormat::CodexConfigToml, source.as_bytes(), &spec)
                .unwrap();
        assert_eq!(preview.parse_status, HookConfigParseStatus::Parsed);
        assert_eq!(preview.ownership_status, HookOwnershipStatus::Exact);
        assert_eq!(preview.user_handlers, 1);
        assert_eq!(preview.other_top_level_fields, 1);
        assert!(!preview.lossless_write_supported);
        assert!(!preview.config_write_performed);
    }

    #[test]
    fn codex_hooks_json_accepts_official_description_metadata() {
        let spec = codex_spec();
        let input = serde_json::json!({
            "description": "user description stays outside the preview",
            "hooks": {
                "SessionStart": [{
                    "matcher": "startup|resume",
                    "hooks": [{
                        "type": "command",
                        "command": spec.command,
                        "timeout": 1
                    }]
                }]
            }
        });
        let preview = preview_hook_config(
            HookConfigFormat::CodexHooksJson,
            &serde_json::to_vec(&input).unwrap(),
            &spec,
        )
        .unwrap();
        assert_eq!(preview.ownership_status, HookOwnershipStatus::Exact);
        assert_eq!(preview.other_top_level_fields, 0);
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("user description"));
    }

    #[test]
    fn wrong_event_or_extra_owned_fields_are_modified_not_exact() {
        let spec = claude_spec();
        let input = serde_json::json!({
            "hooks": {
                "Stop": [{
                    "hooks": [{
                        "type": "command",
                        "command": spec.command,
                        "args": spec.args,
                        "timeout": 1,
                        "async": true
                    }]
                }]
            }
        });
        let preview = preview_hook_config(
            HookConfigFormat::ClaudeSettingsJson,
            &serde_json::to_vec(&input).unwrap(),
            &spec,
        )
        .unwrap();
        assert_eq!(preview.ownership_status, HookOwnershipStatus::Modified);
        assert_eq!(preview.exact_owned_handlers, 0);
    }

    #[test]
    fn oversized_input_and_invalid_spec_fail_closed_for_future_writes() {
        let oversized = preview_hook_config(
            HookConfigFormat::CodexHooksJson,
            &vec![b' '; MAX_HOOK_CONFIG_BYTES + 1],
            &codex_spec(),
        )
        .unwrap();
        assert_eq!(oversized.parse_status, HookConfigParseStatus::TooLarge);
        assert!(!oversized.lossless_write_supported);

        let mut invalid = claude_spec();
        invalid.owner_id = "someone-else".to_owned();
        assert_eq!(
            preview_hook_config(HookConfigFormat::ClaudeSettingsJson, b"{}", &invalid),
            Err(HookConfigPreviewError::InvalidOwnedHookField("owner_id"))
        );
    }

    #[test]
    fn hook_set_reports_partial_install_and_preserves_mixed_user_groups() {
        let mut created = claude_spec();
        created.event = "TaskCreated".to_owned();
        let completed = claude_spec();
        let mut failed = claude_spec();
        failed.event = "StopFailure".to_owned();
        let specs = [created, completed, failed];

        let created_handler = json_handler(&specs[0]);
        let completed_handler = json_handler(&specs[1]);
        let input = serde_json::json!({
            "permissions": { "allow": ["Read"] },
            "hooks": {
                "TaskCreated": [{
                    "hooks": [
                        created_handler,
                        { "type": "command", "command": "private-user-handler --token hidden" }
                    ]
                }],
                "TaskCompleted": [{ "hooks": [completed_handler] }]
            }
        });
        let preview = preview_hook_config_set(
            HookConfigFormat::ClaudeSettingsJson,
            &serde_json::to_vec(&input).unwrap(),
            &specs,
        )
        .unwrap();
        assert_eq!(preview.ownership_status, HookSetOwnershipStatus::Partial);
        assert_eq!(preview.proposed_action, HookSetPreviewAction::AddMissing);
        assert_eq!(preview.expected_handlers, 3);
        assert_eq!(preview.exact_handlers, 2);
        assert_eq!(preview.missing_handlers, 1);
        assert_eq!(preview.user_handlers, 1);
        assert_eq!(preview.user_matcher_groups, 1);
        assert_eq!(preview.mixed_matcher_groups, 1);
        assert_eq!(preview.other_top_level_fields, 1);
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains("private-user-handler"));
        assert!(!serialized.contains("connector-random-1"));
        assert!(!serialized.contains("credential-reference-1"));
    }

    #[test]
    fn hook_set_assigns_same_event_matchers_and_detects_per_spec_conflicts() {
        let mut permission = claude_spec();
        permission.event = "Notification".to_owned();
        permission.matcher = Some("permission_prompt".to_owned());
        let mut idle = permission.clone();
        idle.matcher = Some("idle_prompt".to_owned());
        let specs = [permission, idle];
        let permission_handler = json_handler(&specs[0]);
        let mut idle_handler = json_handler(&specs[1]);
        idle_handler
            .as_object_mut()
            .unwrap()
            .insert("async".to_owned(), Value::Bool(true));
        let input = serde_json::json!({
            "hooks": {
                "Notification": [
                    {
                        "matcher": "permission_prompt",
                        "hooks": [permission_handler.clone(), permission_handler]
                    },
                    { "matcher": "idle_prompt", "hooks": [idle_handler] }
                ]
            }
        });
        let preview = preview_hook_config_set(
            HookConfigFormat::ClaudeSettingsJson,
            &serde_json::to_vec(&input).unwrap(),
            &specs,
        )
        .unwrap();
        assert_eq!(preview.ownership_status, HookSetOwnershipStatus::Conflict);
        assert_eq!(preview.duplicate_handlers, 1);
        assert_eq!(preview.modified_handlers, 1);
        assert_eq!(preview.proposed_action, HookSetPreviewAction::ManualReview);
    }

    #[test]
    fn hook_set_does_not_guess_an_unexpected_owned_event() {
        let specs = [claude_spec()];
        let input = serde_json::json!({
            "hooks": {
                "FutureEvent": [{ "hooks": [json_handler(&specs[0])] }]
            }
        });
        let preview = preview_hook_config_set(
            HookConfigFormat::ClaudeSettingsJson,
            &serde_json::to_vec(&input).unwrap(),
            &specs,
        )
        .unwrap();
        assert_eq!(preview.ownership_status, HookSetOwnershipStatus::Conflict);
        assert_eq!(preview.unexpected_owned_handlers, 1);
        assert_eq!(preview.missing_handlers, 1);
    }

    #[test]
    fn codex_source_preview_blocks_inline_and_dual_user_representations() {
        let specs = [codex_spec()];
        let inline = br#"[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "user-policy.exe"
"#;
        let json = br#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"user-policy.exe"}]}]}}"#;

        let inline_only = preview_hook_config_sources(
            ConnectorHookTool::Codex,
            &[HookConfigSourceInput {
                source: HookConfigSource::CodexUserConfigToml,
                input: inline,
            }],
            &specs,
        )
        .unwrap();
        assert_eq!(
            inline_only.conflict,
            HookSourcesConflict::CodexUserInlineHooks
        );
        assert_eq!(
            inline_only.proposed_action,
            HookSetPreviewAction::ManualReview
        );

        let dual = preview_hook_config_sources(
            ConnectorHookTool::Codex,
            &[
                HookConfigSourceInput {
                    source: HookConfigSource::CodexUserHooksJson,
                    input: json,
                },
                HookConfigSourceInput {
                    source: HookConfigSource::CodexUserConfigToml,
                    input: inline,
                },
            ],
            &specs,
        )
        .unwrap();
        assert_eq!(
            dual.conflict,
            HookSourcesConflict::CodexUserDualRepresentation
        );
        assert_eq!(dual.sources_with_hooks, 2);
        assert!(!dual.config_write_performed);
        assert!(!dual.source_task_behavior_changed);
    }

    #[test]
    fn claude_sources_allow_user_hooks_but_reject_owned_entries_outside_user_settings() {
        let specs = [claude_spec()];
        let preferred = serde_json::json!({
            "hooks": { "TaskCompleted": [{ "hooks": [json_handler(&specs[0])] }] }
        });
        let unrelated_project = br#"{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"project-user-hook"}]}]}}"#;
        let clean = preview_hook_config_sources(
            ConnectorHookTool::ClaudeCode,
            &[
                HookConfigSourceInput {
                    source: HookConfigSource::ClaudeUserSettingsJson,
                    input: &serde_json::to_vec(&preferred).unwrap(),
                },
                HookConfigSourceInput {
                    source: HookConfigSource::ClaudeProjectSettingsJson,
                    input: unrelated_project,
                },
            ],
            &specs,
        )
        .unwrap();
        assert_eq!(clean.conflict, HookSourcesConflict::None);
        assert_eq!(clean.proposed_action, HookSetPreviewAction::NoChange);
        assert_eq!(clean.sources_with_owned_handlers, 1);

        let project_owned = serde_json::to_vec(&preferred).unwrap();
        let outside = preview_hook_config_sources(
            ConnectorHookTool::ClaudeCode,
            &[HookConfigSourceInput {
                source: HookConfigSource::ClaudeProjectSettingsJson,
                input: &project_owned,
            }],
            &specs,
        )
        .unwrap();
        assert_eq!(
            outside.conflict,
            HookSourcesConflict::OwnedOutsidePreferredSource
        );

        let preferred_bytes = serde_json::to_vec(&preferred).unwrap();
        let across = preview_hook_config_sources(
            ConnectorHookTool::ClaudeCode,
            &[
                HookConfigSourceInput {
                    source: HookConfigSource::ClaudeUserSettingsJson,
                    input: &preferred_bytes,
                },
                HookConfigSourceInput {
                    source: HookConfigSource::ClaudeProjectSettingsJson,
                    input: &project_owned,
                },
            ],
            &specs,
        )
        .unwrap();
        assert_eq!(
            across.conflict,
            HookSourcesConflict::OwnedAcrossMultipleSources
        );
    }

    #[test]
    fn source_and_spec_set_validation_fail_closed() {
        let spec = claude_spec();
        assert_eq!(
            preview_hook_config_set(HookConfigFormat::ClaudeSettingsJson, b"{}", &[]),
            Err(HookConfigPreviewError::InvalidOwnedHookSet)
        );
        assert_eq!(
            preview_hook_config_set(
                HookConfigFormat::ClaudeSettingsJson,
                b"{}",
                &[spec.clone(), spec.clone()]
            ),
            Err(HookConfigPreviewError::DuplicateOwnedHookSpec)
        );
        let duplicate_source = HookConfigSourceInput {
            source: HookConfigSource::ClaudeUserSettingsJson,
            input: b"{}",
        };
        assert_eq!(
            preview_hook_config_sources(
                ConnectorHookTool::ClaudeCode,
                &[duplicate_source, duplicate_source],
                std::slice::from_ref(&spec)
            ),
            Err(HookConfigPreviewError::DuplicateConfigSource)
        );
        let mismatch = preview_hook_config_sources(
            ConnectorHookTool::Codex,
            &[HookConfigSourceInput {
                source: HookConfigSource::ClaudeUserSettingsJson,
                input: b"{}",
            }],
            &[spec],
        )
        .unwrap();
        assert_eq!(mismatch.conflict, HookSourcesConflict::SourceToolMismatch);
        assert_eq!(mismatch.proposed_action, HookSetPreviewAction::ManualReview);
    }

    fn json_handler(spec: &OwnedCommandHookSpec) -> Value {
        serde_json::json!({
            "type": "command",
            "command": &spec.command,
            "args": &spec.args,
            "timeout": spec.timeout_seconds
        })
    }
}
