//! Developer-only offline validation. Never starts Tauri or opens user data.
use std::path::Path;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !matches!(args.len(), 2 | 3)
        || (args[0] == "extract" && args.len() != 3)
        || (args[0] == "validate" && args.len() != 2)
    {
        eprintln!("Usage: yuanyuan-pet-repair extract INPUT NEW_DIRECTORY | validate DIRECTORY");
        std::process::exit(2);
    }
    match yuanyuan_reminder_lib::repair_tools_run(
        &args[0],
        Path::new(&args[1]),
        args.get(2).map(Path::new),
    ) {
        Ok(value) => println!("{value}"),
        Err(_) => {
            // IO errors can contain private absolute paths. Only a fixed message crosses the CLI boundary.
            eprintln!(
                "PET_REPAIR_INPUT: unsafe archive, unavailable input, or output already exists"
            );
            std::process::exit(2);
        }
    }
}
