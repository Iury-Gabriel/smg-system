const connection = require("../lib/redis");
const { enqueueManualScrape, scrapeQueue } = require("./queues");
const { resolveWorkflow } = require("../config/workflows");

function parseSegmentsArg(argv) {
  const arg = argv.find((item) => item.startsWith("--segments="));
  if (!arg) return [];
  const value = arg.split("=", 2)[1] || "";
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseWorkflowArg(argv) {
  const arg = argv.find((item) => item.startsWith("--workflow="));
  if (!arg) return resolveWorkflow("smg");
  const value = arg.split("=", 2)[1] || "smg";
  return resolveWorkflow(value);
}

async function main() {
  const workflow = parseWorkflowArg(process.argv.slice(2));
  const segments = parseSegmentsArg(process.argv.slice(2));
  const job = await enqueueManualScrape({ workflow, segments });
  console.log(
    `[enqueue] queued jobId=${job.id} workflow=${workflow} name=${job.name} segments=${segments.join(",") || "all"}`
  );
}

main()
  .catch((error) => {
    console.error(`[enqueue] failed message=${error?.message || "unknown"}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await scrapeQueue.close();
    await connection.quit();
  });
