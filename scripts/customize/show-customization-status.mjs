import { loadRunState } from "./customization-state.mjs";

const index = process.argv.indexOf("--run-id");
const runId = index >= 0 ? process.argv[index + 1] : null;
if (!runId) {
  process.stderr.write("usage: --run-id <run-id>\n");
  process.exitCode = 1;
} else {
  loadRunState(runId).then((state) => {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`CUSTOMIZATION_RUN_NOT_FOUND: ${error.message}\n`);
    process.exitCode = 1;
  });
}
