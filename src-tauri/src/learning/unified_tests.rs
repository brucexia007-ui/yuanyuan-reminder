use super::*;
use super::models::{LearningQuestionKind, LearningStage};
use rusqlite::Connection;

const SAMPLE: &str = include_str!("../../../customization/learning/learning-pack.synthetic.example.json");

#[test]
fn generic_questions_respect_declared_kind_and_options() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sample.learning-pack.json");
    std::fs::write(&file, SAMPLE).unwrap();
    let mut runtime = LearningRuntime::initialize(&dir.path().join("learning.sqlite3"));
    let preview = runtime.preview_import_file(&file, 1000).unwrap();
    assert!(preview.rights_statement.as_deref().unwrap().contains("合成示例"));
    assert_eq!(preview.source_details, vec!["合成示例笔记"]);
    runtime.confirm_import(preview.preview_token.as_deref().unwrap(), 2000).unwrap();
    let conn = runtime.repository.as_ref().unwrap().connection();
    let mut statement = conn.prepare("SELECT card_id, exercise_kind, prompt_text, answer_text FROM learning_cards").unwrap();
    let cards = statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).unwrap();
    for row in cards {
        let (id, kind, prompt, answer) = row.unwrap();
        let card = LearningCardDto {schema_version:1,card_id:id,headword:prompt,phonetic:None,part_of_speech:vec!["generic".into()],meanings_zh:vec![answer.clone()],word_family:vec![],stage:LearningStage::New,source_ids:vec![]};
        let question = quiz::build_question(conn,"synthetic-session",&card,false).unwrap();
        if kind == "recall" {
            assert_eq!(question.kind, LearningQuestionKind::RecallFallback);
            assert!(question.options.is_empty());
        } else {
            assert_eq!(question.kind, LearningQuestionKind::MultipleChoice);
            assert_eq!(question.options.len(),3);
            assert_eq!(question.options.iter().filter(|o|o.meaning_zh==answer).count(),1);
        }
    }
}

#[test]
fn generic_repeat_import_and_native_roundtrip_preserve_content_and_schedules() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sample.learning-pack.json");
    std::fs::write(&file, SAMPLE).unwrap();
    let mut source = LearningRuntime::initialize(&dir.path().join("source.sqlite3"));
    let preview = source.preview_import_file(&file,1000).unwrap();
    source.confirm_import(preview.preview_token.as_deref().unwrap(),2000).unwrap();
    source.repository.as_ref().unwrap().connection().execute("UPDATE card_schedule SET stage='stable',reps=3,stability=3.5,difficulty=5.2,last_review_at_unix_ms=2000,due_at_unix_ms=90000",[]).unwrap();
    let again = source.preview_import_file(&file,3000).unwrap();
    assert_eq!((again.added_count,again.changed_count,again.disabled_count,again.reset_count),(0,0,0,0));
    assert_eq!(source.confirm_import(again.preview_token.as_deref().unwrap(),4000).unwrap().preserved_schedule_count,2);
    let first = source.export_payload(LearningExportFormat::NativeJson,5000).unwrap();
    let mut restored = LearningRuntime::initialize(&dir.path().join("restored.sqlite3"));
    let preview = restored.preview_native_json_import(&first.bytes,6000).unwrap();
    restored.confirm_import(preview.preview_token.as_deref().unwrap(),7000).unwrap();
    let second = restored.export_payload(LearningExportFormat::NativeJson,8000).unwrap();
    let before: serde_json::Value = serde_json::from_slice(&first.bytes).unwrap();
    let after: serde_json::Value = serde_json::from_slice(&second.bytes).unwrap();
    for key in ["cards","packs","sources","schedules","reviewLogs","sessions"] { assert_eq!(before[key],after[key],"{key}"); }
}

fn create_version_seven(path: &Path) {
    let conn=Connection::open(path).unwrap();
    for sql in [include_str!("migrations/001_initial.sql"),include_str!("migrations/002_export_metadata.sql"),include_str!("migrations/003_quiz_learning.sql"),include_str!("migrations/004_learning_insights.sql"),include_str!("migrations/005_learning_rounds.sql"),include_str!("migrations/006_resumable_sessions.sql"),include_str!("migrations/007_legacy_migration_receipts.sql")] { conn.execute_batch(sql).unwrap(); }
}

#[test]
fn version_seven_upgrade_is_atomic_and_failed_learning_stays_unavailable() {
    let dir=tempfile::tempdir().unwrap();
    let good=dir.path().join("good.sqlite3");
    create_version_seven(&good);
    let upgraded=repository::LearningRepository::open(&good).unwrap();
    let version:u32=upgraded.connection().query_row("PRAGMA user_version",[],|r|r.get(0)).unwrap();
    assert_eq!(version,8);
    let bad=dir.path().join("bad.sqlite3");
    create_version_seven(&bad);
    let conn=Connection::open(&bad).unwrap();
    conn.execute_batch("ALTER TABLE learning_cards ADD COLUMN exercise_kind TEXT;").unwrap();
    drop(conn);
    assert!(repository::LearningRepository::open(&bad).is_err());
    let mut runtime=LearningRuntime::initialize(&bad);
    assert!(runtime.preview_csv_import(b"headword,meanings_zh\nword,meaning",1000).is_err());
    let conn=Connection::open(&bad).unwrap();
    assert_eq!(conn.query_row("PRAGMA user_version",[],|r|r.get::<_,u32>(0)).unwrap(),7);
    assert_eq!(conn.query_row("SELECT count(*) FROM pragma_table_info('content_packs') WHERE name='description'",[],|r|r.get::<_,u32>(0)).unwrap(),0);
}
