use std::{path::Path, time::Duration};

use rusqlite::{params, Connection, TransactionBehavior};
use thiserror::Error;

const MAX_QUERY_BYTES: usize = 128;
const MAX_MEMORY_ID_BYTES: usize = 96;
const MAX_CONTENT_BYTES: usize = 16 * 1024;
const MAX_RESULTS: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct MemorySearchResult {
    pub memory_id: String,
    pub content: String,
    pub rank: f64,
}

#[derive(Debug, Error)]
pub enum MemorySearchError {
    #[error("memory search database failed")]
    Database(#[from] rusqlite::Error),
    #[error("memory search input is invalid")]
    InvalidInput,
}

/// P0 retrieval spike. This index stores only caller-approved memory text and
/// an opaque ID; retention, consent and source records remain outside it.
pub struct MemorySearchIndex {
    connection: Connection,
}

impl MemorySearchIndex {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MemorySearchError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, MemorySearchError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, MemorySearchError> {
        connection.busy_timeout(Duration::from_secs(1))?;
        connection.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_spike
             USING fts5(memory_id UNINDEXED, content, tokenize='trigram');",
        )?;
        Ok(Self { connection })
    }

    pub fn upsert(&mut self, memory_id: &str, content: &str) -> Result<(), MemorySearchError> {
        validate_text(memory_id, MAX_MEMORY_ID_BYTES, true)?;
        validate_text(content, MAX_CONTENT_BYTES, false)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM memory_search_spike WHERE memory_id = ?1",
            [memory_id],
        )?;
        transaction.execute(
            "INSERT INTO memory_search_spike(memory_id, content) VALUES(?1, ?2)",
            params![memory_id, content],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn remove(&mut self, memory_id: &str) -> Result<bool, MemorySearchError> {
        validate_text(memory_id, MAX_MEMORY_ID_BYTES, true)?;
        Ok(self.connection.execute(
            "DELETE FROM memory_search_spike WHERE memory_id = ?1",
            [memory_id],
        )? > 0)
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemorySearchResult>, MemorySearchError> {
        validate_text(query, MAX_QUERY_BYTES, false)?;
        if limit == 0 || limit > MAX_RESULTS {
            return Err(MemorySearchError::InvalidInput);
        }
        if query.chars().count() < 3 {
            self.search_short_literal(query, limit)
        } else {
            self.search_trigram_phrase(query, limit)
        }
    }

    fn search_trigram_phrase(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemorySearchResult>, MemorySearchError> {
        // Quoting makes FTS operators literal; doubling quotes is the FTS5
        // phrase escape. Provider/model text never becomes query syntax.
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let mut statement = self.connection.prepare(
            "SELECT memory_id, content, bm25(memory_search_spike)
             FROM memory_search_spike
             WHERE memory_search_spike MATCH ?1
             ORDER BY bm25(memory_search_spike), memory_id
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![phrase, limit as i64], |row| {
            Ok(MemorySearchResult {
                memory_id: row.get(0)?,
                content: row.get(1)?,
                rank: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(MemorySearchError::from)
    }

    fn search_short_literal(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemorySearchResult>, MemorySearchError> {
        // Trigram cannot index fewer than three Unicode characters. A bounded
        // literal LIKE scan preserves two-character Chinese recall. Wildcards
        // and the escape character are escaped before binding.
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        let mut statement = self.connection.prepare(
            "SELECT memory_id, content, 0.0
             FROM memory_search_spike
             WHERE content LIKE ?1 ESCAPE '\\'
             ORDER BY memory_id
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![pattern, limit as i64], |row| {
            Ok(MemorySearchResult {
                memory_id: row.get(0)?,
                content: row.get(1)?,
                rank: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(MemorySearchError::from)
    }
}

fn validate_text(value: &str, maximum: usize, identifier: bool) -> Result<(), MemorySearchError> {
    if value.trim().is_empty()
        || value.len() > maximum
        || value
            .chars()
            .any(|character| matches!(character, '\0' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        || (identifier
            && !value.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
            }))
    {
        return Err(MemorySearchError::InvalidInput);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLD: [(&str, &str); 6] = [
        ("memory-1", "每周三下午开会前容易焦虑，希望圆圆安静靠近"),
        ("memory-2", "用户在加班后更喜欢安静陪伴，不想立刻聊天"),
        ("memory-3", "喝水提醒太频繁会让用户烦躁，应当减少打扰"),
        ("memory-4", "项目构建成功后会想摸摸圆圆，一起庆祝"),
        ("memory-5", "用户不喜欢被连续追问发生了什么"),
        ("memory-6", "午后肩颈酸痛时愿意短暂活动一下"),
    ];

    fn gold_index() -> MemorySearchIndex {
        let mut index = MemorySearchIndex::open_in_memory().unwrap();
        for (id, content) in GOLD {
            index.upsert(id, content).unwrap();
        }
        index
    }

    #[test]
    fn trigram_phrase_retrieval_hits_the_synthetic_chinese_gold_set() {
        let index = gold_index();
        for (query, expected) in [
            ("开会前", "memory-1"),
            ("加班后", "memory-2"),
            ("喝水提醒", "memory-3"),
            ("构建成功", "memory-4"),
            ("连续追问", "memory-5"),
            ("肩颈酸痛", "memory-6"),
        ] {
            let results = index.search(query, 3).unwrap();
            assert_eq!(
                results.first().map(|item| item.memory_id.as_str()),
                Some(expected)
            );
        }
    }

    #[test]
    fn trigram_outperforms_unicode61_for_unsegmented_chinese_phrases() {
        let trigram = gold_index();
        let unicode = Connection::open_in_memory().unwrap();
        unicode
            .execute_batch(
                "CREATE VIRTUAL TABLE unicode_search
                 USING fts5(memory_id UNINDEXED, content, tokenize='unicode61');",
            )
            .unwrap();
        for (id, content) in GOLD {
            unicode
                .execute(
                    "INSERT INTO unicode_search(memory_id, content) VALUES(?1, ?2)",
                    params![id, content],
                )
                .unwrap();
        }
        let queries = [
            ("开会前", "memory-1"),
            ("加班后", "memory-2"),
            ("喝水提醒", "memory-3"),
            ("构建成功", "memory-4"),
            ("连续追问", "memory-5"),
            ("肩颈酸痛", "memory-6"),
        ];
        let trigram_hits = queries
            .iter()
            .filter(|(query, expected)| {
                trigram
                    .search(query, 3)
                    .unwrap()
                    .iter()
                    .any(|result| result.memory_id == *expected)
            })
            .count();
        let unicode_hits = queries
            .iter()
            .filter(|(query, expected)| {
                unicode
                    .query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM unicode_search
                           WHERE unicode_search MATCH ?1 AND memory_id = ?2
                         )",
                        params![query, expected],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap()
            })
            .count();
        assert_eq!(trigram_hits, 6);
        assert_eq!(unicode_hits, 0);
    }

    #[test]
    fn two_character_chinese_queries_use_bounded_literal_fallback() {
        let index = gold_index();
        assert_eq!(index.search("焦虑", 3).unwrap()[0].memory_id, "memory-1");
        assert_eq!(index.search("加班", 3).unwrap()[0].memory_id, "memory-2");
    }

    #[test]
    fn query_operators_and_like_wildcards_are_literal() {
        let mut index = gold_index();
        index.upsert("memory-7", "百分比 100%_完成").unwrap();
        assert!(index.search("焦虑 OR 加班", 3).unwrap().is_empty());
        assert_eq!(index.search("%_", 3).unwrap()[0].memory_id, "memory-7");
    }

    #[test]
    fn upsert_removes_stale_text_and_delete_is_explicit() {
        let mut index = gold_index();
        index.upsert("memory-1", "现在开会前感觉平静").unwrap();
        assert!(index.search("容易焦虑", 3).unwrap().is_empty());
        assert!(index.remove("memory-1").unwrap());
        assert!(index.search("感觉平静", 3).unwrap().is_empty());
    }

    #[test]
    fn invalid_limits_controls_and_identifiers_fail_closed() {
        let mut index = gold_index();
        assert!(matches!(
            index.search("焦虑", 0),
            Err(MemorySearchError::InvalidInput)
        ));
        assert!(matches!(
            index.search("焦虑\u{202e}", 3),
            Err(MemorySearchError::InvalidInput)
        ));
        assert!(matches!(
            index.upsert("../bad", "内容"),
            Err(MemorySearchError::InvalidInput)
        ));
    }
}
