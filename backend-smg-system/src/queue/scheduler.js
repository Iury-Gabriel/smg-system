const connection = require("../lib/redis");
const { ensureDailyScrapeSchedule, scrapeQueue } = require("./queues");
const env = require("../config/env");

async function main() {
  const schedules = await ensureDailyScrapeSchedule("all");
  const repeatable = await scrapeQueue.getRepeatableJobs();
  console.log("[scheduler] daily jobs ensured");
  for (const schedule of schedules) {
    console.log(
      `[scheduler] workflow=${schedule.workflow} queue=${env.bullQueueName} cron="${schedule.cron}" tz=${schedule.timezone}`
    );
  }
  console.log(`[scheduler] repeatable_count=${repeatable.length}`);
  await connection.quit();
  await scrapeQueue.close();
}

main().catch(async (error) => {
  console.error("[scheduler] failed:", error);
  try {
    await connection.quit();
    await scrapeQueue.close();
  } catch (_error) {
    // noop
  }
  process.exit(1);
});
