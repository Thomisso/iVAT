import { runEvaluationCli } from "@/evaluation/evaluation-cli";

runEvaluationCli({ argv: process.argv.slice(2), env: process.env }).then(result => {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}).catch(() => {
  process.stderr.write("Extraction evaluation failed. Private output could not be finalized.\n");
  process.exitCode = 1;
});
