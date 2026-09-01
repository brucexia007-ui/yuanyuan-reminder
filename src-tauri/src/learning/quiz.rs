use std::collections::BTreeSet;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

use super::models::{
    LearningCardDto, LearningQuestionDto, LearningQuestionKind, LearningQuestionOptionDto,
};

const MAX_OPTIONS: usize = 4;
const CANDIDATE_LIMIT: usize = 256;
const MAX_DISPLAY_MEANING_CHARS: usize = 42;
const MAX_DISPLAY_SENSES: usize = 2;

#[derive(Debug)]
struct Candidate {
    card_id: String,
    meaning_zh: String,
    tier: u8,
    length_gap: usize,
    order_key: String,
}

pub(super) fn build_question(
    conn: &Connection,
    session_id: &str,
    card: &LearningCardDto,
    is_remediation: bool,
) -> AppResult<LearningQuestionDto> {
    let (
        pack_id,
        frequency_band,
        target_pos_json,
        target_meanings_json,
        exercise_kind,
        choices_json,
        answer_text,
    ): (
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
    ) = conn.query_row(
        "SELECT pack_id, frequency_band, part_of_speech_json, meanings_zh_json,
                exercise_kind, choices_json, answer_text
         FROM learning_cards WHERE card_id = ?1",
        [&card.card_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        },
    )?;
    let question_id = question_id(session_id, &card.card_id, is_remediation);
    let correct_meaning = display_meaning(&card.meanings_zh);
    let declared_answer = answer_text.as_deref().unwrap_or(&correct_meaning);
    let target_pos: Vec<String> = serde_json::from_str(&target_pos_json)?;
    let declared_choices: Vec<String> = serde_json::from_str(&choices_json)?;
    if exercise_kind == "choice"
        && (2..=MAX_OPTIONS).contains(&declared_choices.len())
        && declared_choices
            .iter()
            .filter(|choice| choice.as_str() == declared_answer)
            .count()
            == 1
    {
        let mut options = declared_choices
            .into_iter()
            .map(|meaning_zh| LearningQuestionOptionDto {
                option_id: if meaning_zh == declared_answer {
                    option_id(&question_id, &card.card_id)
                } else {
                    hash_hex(format!("declared-option-v1\0{question_id}\0{meaning_zh}").as_bytes())
                },
                meaning_zh,
            })
            .collect::<Vec<_>>();
        options.sort_by_key(|option| {
            hash_hex(format!("position-v1\0{question_id}\0{}", option.option_id).as_bytes())
        });
        return Ok(LearningQuestionDto {
            schema_version: 1,
            question_id,
            kind: LearningQuestionKind::MultipleChoice,
            card_id: card.card_id.clone(),
            headword: card.headword.clone(),
            phonetic: card.phonetic.clone(),
            part_of_speech: card.part_of_speech.clone(),
            stage: card.stage,
            is_remediation,
            options,
        });
    }

    let mut statement = conn.prepare(
        "SELECT c.card_id, c.meanings_zh_json, c.part_of_speech_json, c.frequency_band
         FROM learning_cards c
         JOIN content_packs p ON p.pack_id = c.pack_id
         WHERE c.pack_id = ?1 AND c.card_id <> ?2 AND p.status = 'ready'
         ORDER BY
           CASE WHEN c.part_of_speech_json = ?3 THEN 0 ELSE 1 END,
           CASE WHEN c.frequency_band = ?4 THEN 0 ELSE 1 END,
           abs(length(c.meanings_zh_json) - length(?5)),
           c.card_id
         LIMIT ?6",
    )?;
    let rows = statement.query_map(
        params![
            pack_id,
            card.card_id,
            target_pos_json,
            frequency_band,
            target_meanings_json,
            CANDIDATE_LIMIT as u32,
        ],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    )?;

    let mut candidates = Vec::new();
    for raw in rows {
        let (candidate_card_id, meanings_json, pos_json, candidate_frequency) = raw?;
        let meanings: Vec<String> = serde_json::from_str(&meanings_json)?;
        let candidate_pos: Vec<String> = serde_json::from_str(&pos_json)?;
        let meaning_zh = display_meaning(&meanings);
        if !meaning_is_safe(&correct_meaning, &meaning_zh) {
            continue;
        }
        let same_pos = target_pos.iter().any(|value| candidate_pos.contains(value));
        let same_frequency = candidate_frequency == frequency_band;
        let tier = match (same_pos, same_frequency) {
            (true, true) => 0,
            (true, false) => 1,
            (false, true) => 2,
            (false, false) => 3,
        };
        candidates.push(Candidate {
            order_key: hash_hex(
                format!("distractor-v1\0{question_id}\0{candidate_card_id}").as_bytes(),
            ),
            card_id: candidate_card_id,
            length_gap: correct_meaning
                .chars()
                .count()
                .abs_diff(meaning_zh.chars().count()),
            meaning_zh,
            tier,
        });
    }
    candidates.sort_by(|left, right| {
        left.tier
            .cmp(&right.tier)
            .then_with(|| left.length_gap.cmp(&right.length_gap))
            .then_with(|| left.order_key.cmp(&right.order_key))
    });

    let mut selected = vec![(card.card_id.clone(), correct_meaning.clone())];
    let mut normalized = BTreeSet::from([normalize_meaning(&correct_meaning)]);
    for candidate in candidates {
        if selected.len() >= MAX_OPTIONS {
            break;
        }
        let key = normalize_meaning(&candidate.meaning_zh);
        if key.is_empty() || normalized.contains(&key) {
            continue;
        }
        if selected
            .iter()
            .any(|(_, existing)| !meaning_is_safe(existing, &candidate.meaning_zh))
        {
            continue;
        }
        normalized.insert(key);
        selected.push((candidate.card_id, candidate.meaning_zh));
    }

    let kind = if selected.len() >= 2 {
        LearningQuestionKind::MultipleChoice
    } else {
        LearningQuestionKind::RecallFallback
    };
    let mut options = if kind == LearningQuestionKind::MultipleChoice {
        selected
            .into_iter()
            .map(|(option_card_id, meaning_zh)| LearningQuestionOptionDto {
                option_id: option_id(&question_id, &option_card_id),
                meaning_zh,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    options.sort_by_key(|option| {
        hash_hex(format!("position-v1\0{question_id}\0{}", option.option_id).as_bytes())
    });

    Ok(LearningQuestionDto {
        schema_version: 1,
        question_id,
        kind,
        card_id: card.card_id.clone(),
        headword: card.headword.clone(),
        phonetic: card.phonetic.clone(),
        part_of_speech: card.part_of_speech.clone(),
        stage: card.stage,
        is_remediation,
        options,
    })
}

pub(super) fn correct_option_id(question_id: &str, card_id: &str) -> String {
    option_id(question_id, card_id)
}

pub(super) fn correct_meaning(card: &LearningCardDto) -> String {
    display_meaning(&card.meanings_zh)
}

fn question_id(session_id: &str, card_id: &str, is_remediation: bool) -> String {
    hash_hex(
        format!(
            "question-v1\0{session_id}\0{card_id}\0{}",
            if is_remediation {
                "remediation"
            } else {
                "original"
            }
        )
        .as_bytes(),
    )
}

fn option_id(question_id: &str, card_id: &str) -> String {
    hash_hex(format!("option-v1\0{question_id}\0{card_id}").as_bytes())
}

fn display_meaning(meanings: &[String]) -> String {
    let senses = meanings
        .iter()
        .flat_map(|meaning| meaning.split([';', '；']))
        .map(str::trim)
        .filter(|sense| !sense.is_empty())
        .take(MAX_DISPLAY_SENSES)
        .collect::<Vec<_>>()
        .join("；");
    truncate_display_meaning(&senses)
}

fn truncate_display_meaning(value: &str) -> String {
    if value.chars().count() <= MAX_DISPLAY_MEANING_CHARS {
        return value.to_owned();
    }
    let mut output = value
        .chars()
        .take(MAX_DISPLAY_MEANING_CHARS.saturating_sub(1))
        .collect::<String>();
    while output.ends_with(['，', ',', '、', '：', ':', '；', ';', ' ']) {
        output.pop();
    }
    output.push('…');
    output
}

fn normalize_meaning(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn meaning_is_safe(left: &str, right: &str) -> bool {
    let left = normalize_meaning(left);
    let right = normalize_meaning(right);
    if left.is_empty() || right.is_empty() || left == right {
        return false;
    }
    if (left.contains(&right) || right.contains(&left)) && left.len().min(right.len()) >= 4 {
        return false;
    }
    let left_length = left.chars().count();
    let right_length = right.chars().count();
    if left_length.min(right_length) >= 5
        && left_length.max(right_length) > left_length.min(right_length).saturating_mul(2)
    {
        return false;
    }
    let left_chars = left.chars().collect::<BTreeSet<_>>();
    let right_chars = right.chars().collect::<BTreeSet<_>>();
    let intersection = left_chars.intersection(&right_chars).count();
    let union = left_chars.union(&right_chars).count();
    union == 0 || (intersection as f32 / union as f32) < 0.72
}

fn hash_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn validate_answer_identity(value: &str, name: &str) -> AppResult<()> {
    if uuid::Uuid::parse_str(value).is_err() {
        return Err(AppError::Validation(format!(
            "learning {name} identifier is invalid"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meaning_filter_rejects_duplicate_and_nearly_identical_choices() {
        assert!(!meaning_is_safe("处理；解决", "处理、解决"));
        assert!(!meaning_is_safe("学习", "学习过程"));
        assert!(meaning_is_safe("处理；解决", "树木；木材"));
    }

    #[test]
    fn generated_identifiers_are_stable_lowercase_sha256() {
        let first = question_id("session", "card", false);
        assert_eq!(first, question_id("session", "card", false));
        assert_ne!(first, question_id("session", "card", true));
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn display_meaning_keeps_two_concise_senses_and_truncates_locally() {
        assert_eq!(
            display_meaning(&["石头; 结石; 宝石; 石制的".into()]),
            "石头；结石"
        );
        let long = display_meaning(&["这是一个非常非常长的中文释义用于验证小黑板不会被冗长的内容撑开并且依然能够清晰阅读与快速作答".into()]);
        assert!(long.chars().count() <= MAX_DISPLAY_MEANING_CHARS);
        assert!(long.ends_with('…'));
    }
}
