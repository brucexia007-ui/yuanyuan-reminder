use std::{
    env,
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    process::ExitCode,
    time::Instant,
};

use serde::Serialize;
use yuanyuan_learning_pack_spike::{
    parse_csv_with_progress, parse_json_with_progress, read_bounded_file_with_progress,
    ParseControl, ParsePhase, ParseProgress, ValidationError, CONTROL_DECODE_BYTE_INTERVAL,
    CONTROL_ITEM_BYTE_INTERVAL, PROGRESS_BYTE_INTERVAL, PROGRESS_CARD_INTERVAL,
    PROGRESS_VALUE_INTERVAL,
};

const NEAR_LIMIT_JSON_PROMPT_PADDING: usize = 1_080;
const NEAR_LIMIT_CSV_PROMPT_PADDING: usize = 1_180;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseReport<'a> {
    schema_version: u32,
    mode: &'a str,
    parser_version: &'a str,
    file_bytes: usize,
    card_count: usize,
    file_sha256: &'a str,
    content_sha256: &'a str,
    elapsed_microseconds: u128,
    progress_callbacks: usize,
    progress_card_interval: usize,
    progress_byte_interval: usize,
    progress_value_interval: usize,
    control_decode_byte_interval: usize,
    control_item_byte_interval: usize,
    progress_phase_counts: ProgressPhaseCounts,
    final_progress: ParseProgress,
    working_set_bytes: u64,
    peak_working_set_bytes: u64,
    private_memory_bytes: u64,
    peak_private_memory_bytes: u64,
    database_writes: u8,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPhaseCounts {
    reading_input: usize,
    validating_input: usize,
    validating_text: usize,
    scanning_syntax: usize,
    decoding: usize,
    validating_structure: usize,
    validating_cards: usize,
    finalizing: usize,
    complete: usize,
}

impl ProgressPhaseCounts {
    fn record(&mut self, phase: ParsePhase) {
        let count = match phase {
            ParsePhase::ReadingInput => &mut self.reading_input,
            ParsePhase::ValidatingInput => &mut self.validating_input,
            ParsePhase::ValidatingText => &mut self.validating_text,
            ParsePhase::ScanningSyntax => &mut self.scanning_syntax,
            ParsePhase::Decoding => &mut self.decoding,
            ParsePhase::ValidatingStructure => &mut self.validating_structure,
            ParsePhase::ValidatingCards => &mut self.validating_cards,
            ParsePhase::Finalizing => &mut self.finalizing,
            ParsePhase::Complete => &mut self.complete,
        };
        *count += 1;
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let payload = serde_json::json!({
                "schemaVersion": 6,
                "error": error,
                "databaseWrites": 0
            });
            eprintln!("{}", serde_json::to_string(&payload).unwrap());
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<(), ValidationError> {
    let arguments: Vec<String> = env::args().collect();
    match arguments.as_slice() {
        [_, command, input] if command == "parse-json" => parse_file("json", Path::new(input), None),
        [_, command, input, pack_id, title] if command == "parse-csv" => {
            parse_file("csv", Path::new(input), Some((pack_id, title)))
        }
        [_, command, output, count] if command == "generate-json" => {
            generate_json(Path::new(output), parse_count(count)?, 0).map_err(io_error)
        }
        [_, command, output, count] if command == "generate-csv" => {
            generate_csv(Path::new(output), parse_count(count)?, 0).map_err(io_error)
        }
        [_, command, output, count] if command == "generate-json-near-limit" => {
            generate_json(
                Path::new(output),
                parse_count(count)?,
                NEAR_LIMIT_JSON_PROMPT_PADDING,
            )
            .map_err(io_error)
        }
        [_, command, output, count] if command == "generate-csv-near-limit" => {
            generate_csv(
                Path::new(output),
                parse_count(count)?,
                NEAR_LIMIT_CSV_PROMPT_PADDING,
            )
            .map_err(io_error)
        }
        _ => Err(ValidationError {
            code: yuanyuan_learning_pack_spike::ErrorCode::MissingField,
            location: "command".into(),
            message: "usage: parse-json <file> | parse-csv <file> <pack-id> <title> | generate-json[-near-limit] <file> <count> | generate-csv[-near-limit] <file> <count>".into(),
        }),
    }
}

fn parse_file(
    mode: &str,
    path: &Path,
    csv_identity: Option<(&String, &String)>,
) -> Result<(), ValidationError> {
    let started = Instant::now();
    let mut progress_callbacks = 0_usize;
    let mut progress_phase_counts = ProgressPhaseCounts::default();
    let mut final_progress = None;
    let mut observer = |progress: ParseProgress| {
        progress_callbacks += 1;
        progress_phase_counts.record(progress.phase);
        final_progress = Some(progress);
        ParseControl::Continue
    };
    let bytes = read_bounded_file_with_progress(path, &mut observer)?;
    let pack = match csv_identity {
        Some((pack_id, title)) => parse_csv_with_progress(&bytes, pack_id, title, &mut observer)?,
        None => parse_json_with_progress(&bytes, &mut observer)?,
    };
    let elapsed_microseconds = started.elapsed().as_micros();
    let final_progress = final_progress.expect("a successful parse reports progress");
    let memory = process_memory();
    let report = ParseReport {
        schema_version: 6,
        mode,
        parser_version: pack.parser_version,
        file_bytes: bytes.len(),
        card_count: pack.cards.len(),
        file_sha256: &pack.file_sha256,
        content_sha256: &pack.content_sha256,
        elapsed_microseconds,
        progress_callbacks,
        progress_card_interval: PROGRESS_CARD_INTERVAL,
        progress_byte_interval: PROGRESS_BYTE_INTERVAL,
        progress_value_interval: PROGRESS_VALUE_INTERVAL,
        control_decode_byte_interval: CONTROL_DECODE_BYTE_INTERVAL,
        control_item_byte_interval: CONTROL_ITEM_BYTE_INTERVAL,
        progress_phase_counts,
        final_progress,
        working_set_bytes: memory.working_set_bytes,
        peak_working_set_bytes: memory.peak_working_set_bytes,
        private_memory_bytes: memory.private_memory_bytes,
        peak_private_memory_bytes: memory.peak_private_memory_bytes,
        database_writes: 0,
    };
    println!("{}", serde_json::to_string(&report).unwrap());
    Ok(())
}

#[derive(Default)]
struct ProcessMemory {
    working_set_bytes: u64,
    peak_working_set_bytes: u64,
    private_memory_bytes: u64,
    peak_private_memory_bytes: u64,
}

#[cfg(windows)]
fn process_memory() -> ProcessMemory {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::{
        ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        Threading::GetCurrentProcess,
    };

    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { zeroed() };
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let succeeded = unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if succeeded == 0 {
        return ProcessMemory::default();
    }
    ProcessMemory {
        working_set_bytes: counters.WorkingSetSize as u64,
        peak_working_set_bytes: counters.PeakWorkingSetSize as u64,
        private_memory_bytes: counters.PagefileUsage as u64,
        peak_private_memory_bytes: counters.PeakPagefileUsage as u64,
    }
}

#[cfg(not(windows))]
fn process_memory() -> ProcessMemory {
    ProcessMemory::default()
}

fn parse_count(value: &str) -> Result<usize, ValidationError> {
    value
        .parse::<usize>()
        .ok()
        .filter(|count| (1..=20_000).contains(count))
        .ok_or_else(|| ValidationError {
            code: yuanyuan_learning_pack_spike::ErrorCode::CardBudget,
            location: "command.count".into(),
            message: "synthetic count must be 1 to 20000".into(),
        })
}

fn generate_json(path: &Path, count: usize, prompt_padding: usize) -> std::io::Result<()> {
    let mut output = BufWriter::new(File::create(path)?);
    let padding = "x".repeat(prompt_padding);
    write!(
        output,
        "{{\"schemaVersion\":1,\"packId\":\"synthetic.performance.json\",\"title\":\"Synthetic performance JSON\",\"cards\":["
    )?;
    for index in 0..count {
        if index > 0 {
            output.write_all(b",")?;
        }
        write!(
            output,
            "{{\"cardId\":\"card-{index:05}\",\"exerciseKind\":\"choice\",\"prompt\":\"Synthetic prompt {index:05}{padding}\",\"answer\":\"Synthetic answer {index:05}\",\"choices\":[\"Synthetic answer {index:05}\",\"Synthetic distractor {index:05}\"],\"tags\":[\"synthetic\"],\"scheduleEpoch\":1}}"
        )?;
    }
    output.write_all(b"]}\n")?;
    output.flush()
}

fn generate_csv(path: &Path, count: usize, prompt_padding: usize) -> std::io::Result<()> {
    let mut output = BufWriter::new(File::create(path)?);
    let padding = "x".repeat(prompt_padding);
    output.write_all(b"cardId,prompt,answer,exerciseKind,choices,tags,scheduleEpoch\n")?;
    for index in 0..count {
        writeln!(
            output,
            "card-{index:05},Synthetic prompt {index:05}{padding},Synthetic answer {index:05},choice,Synthetic answer {index:05}|Synthetic distractor {index:05},synthetic,1"
        )?;
    }
    output.flush()
}

fn io_error(error: std::io::Error) -> ValidationError {
    ValidationError {
        code: yuanyuan_learning_pack_spike::ErrorCode::MalformedJson,
        location: "file".into(),
        message: format!("file operation failed: {error}"),
    }
}
