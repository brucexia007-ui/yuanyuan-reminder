use std::{fs, path::Path};

use tracing_appender::{
    non_blocking::{NonBlocking, WorkerGuard},
    rolling::{RollingFileAppender, Rotation},
};
use tracing_subscriber::{fmt, EnvFilter};

pub fn init(log_dir: &Path) -> WorkerGuard {
    let (writer, guard, persistent) = log_writer(log_dir);
    let subscriber = fmt()
        .with_env_filter(EnvFilter::new("info"))
        .with_ansi(false)
        .with_target(true)
        .with_writer(writer)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
    if !persistent {
        tracing::warn!("persistent logging is unavailable; continuing without a log file");
    }
    guard
}

fn log_writer(log_dir: &Path) -> (NonBlocking, WorkerGuard, bool) {
    if fs::create_dir_all(log_dir).is_ok() {
        let appender = RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix("yuanyuan-reminder.log")
            .build(log_dir);
        if let Ok(appender) = appender {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            return (writer, guard, true);
        }
    }

    let (writer, guard) = tracing_appender::non_blocking(std::io::sink());
    (writer, guard, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_log_directory_falls_back_without_panicking() {
        let blocker =
            std::env::temp_dir().join(format!("yuanyuan-log-blocker-{}", uuid::Uuid::new_v4()));
        fs::write(&blocker, b"not a directory").unwrap();

        let (_writer, _guard, persistent) = log_writer(&blocker);

        assert!(!persistent);
        fs::remove_file(blocker).unwrap();
    }
}
