const app = require("./app");
const env = require("./config/env");
const { buildSha } = require("./config/build-info");
const { ensureDailyScrapeSchedule } = require("./queue/queues");
const { startWf2Scheduler, stopWf2Scheduler } = require("./services/wf2/wf2-scheduler.service");

async function bootstrap() {
  const schedules = await ensureDailyScrapeSchedule("all");

  app.listen(env.port, () => {
    console.log(`[server] backend-smg-system running on port ${env.port} build=${buildSha}`);
    for (const schedule of schedules) {
      console.log(
        `[server] workflow=${schedule.workflow} daily cron=${schedule.cron} tz=${schedule.timezone} queue=${env.bullQueueName}`
      );
    }
    startWf2Scheduler();
  });
}

process.on("SIGINT", () => {
  stopWf2Scheduler();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopWf2Scheduler();
  process.exit(0);
});

bootstrap().catch((error) => {
  console.error("[server] failed to start", error);
  process.exit(1);
});
