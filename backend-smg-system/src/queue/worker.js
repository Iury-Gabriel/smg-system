const { Worker } = require("bullmq");
const env = require("../config/env");
const connection = require("../lib/redis");
const { runScrapeJob } = require("../jobs/scrape-job.service");
const { scrapeQueue, ensureDailyScrapeSchedule } = require("./queues");
const { disconnectPrismaClients } = require("../lib/prisma");

let statsInterval = null;

async function logQueueStats() {
  try {
    const counts = await scrapeQueue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "paused"
    );

    console.log(
      `[worker][queue] waiting=${counts.waiting || 0} active=${counts.active || 0} delayed=${counts.delayed || 0} completed=${counts.completed || 0} failed=${counts.failed || 0}`
    );
  } catch (error) {
    console.error(`[worker][queue] stats_error=${error?.message || "unknown"}`);
  }
}

const worker = new Worker(
  env.bullQueueName,
  async (job) => {
    const payload = {
      ...(job.data || {}),
      queueJobId: job.id,
    };
    return runScrapeJob(payload);
  },
  {
    connection,
    concurrency: env.workerConcurrency,
  }
);

worker.on("ready", () => {
  console.log(`[worker] online queue=${env.bullQueueName} concurrency=${env.workerConcurrency}`);
  console.log("[worker] aguardando jobs... (dica: npm run enqueue para teste rapido)");
});

worker.on("completed", (job, result) => {
  console.log(
    `[worker] completed job=${job.id} workflow=${result?.workflow || "smg"} collected=${result?.totalCollected || 0} approved=${result?.totalApproved || 0}`
  );
});

worker.on("failed", (job, error) => {
  console.error(`[worker] failed job=${job?.id || "unknown"} message=${error?.message || "unknown"}`);
});

worker.on("error", (error) => {
  console.error(`[worker] error message=${error?.message || "unknown"}`);
});

async function bootstrap() {
  try {
    const schedules = await ensureDailyScrapeSchedule("all");
    for (const schedule of schedules) {
      console.log(
        `[worker] daily schedule ensured workflow=${schedule.workflow} cron="${schedule.cron}" tz=${schedule.timezone}`
      );
    }
  } catch (error) {
    console.error(
      `[worker] failed_to_ensure_daily_schedule message=${error?.message || "unknown"}`
    );
  }

  await logQueueStats();
  statsInterval = setInterval(logQueueStats, 15000);
}

async function shutdown(signal) {
  console.log(`[worker] shutting down (${signal})`);
  if (statsInterval) clearInterval(statsInterval);
  await worker.close();
  await scrapeQueue.close();
  await disconnectPrismaClients();
  await connection.quit();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

bootstrap().catch((error) => {
  console.error(`[worker] bootstrap_failed message=${error?.message || "unknown"}`);
});
