const { Queue } = require("bullmq");
const env = require("../config/env");
const connection = require("../lib/redis");
const {
  WORKFLOW_SMG,
  listWorkflowConfigs,
  resolveWorkflow,
  getWorkflowConfig,
} = require("../config/workflows");

const scrapeQueue = new Queue(env.bullQueueName, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

async function enqueueManualScrape(data = {}) {
  const workflow = resolveWorkflow(data.workflow || WORKFLOW_SMG);
  return scrapeQueue.add(
    `manual-scrape-${workflow}`,
    {
      ...data,
      workflow,
      trigger: "manual",
      queuedAt: new Date().toISOString(),
    },
    {
      jobId: `manual-${workflow}-${Date.now()}`,
    }
  );
}

async function ensureScheduleForWorkflow(workflowId) {
  const workflow = resolveWorkflow(workflowId);
  const config = getWorkflowConfig(workflow);
  const schedulerId = `daily-scrape-${workflow}`;
  const payload = {
    workflow,
    trigger: "cron",
    queuedAt: new Date().toISOString(),
  };

  if (typeof scrapeQueue.upsertJobScheduler === "function") {
    await scrapeQueue.upsertJobScheduler(
      schedulerId,
      {
        pattern: config.cron,
        tz: env.scraperTimezone,
      },
      {
        name: `daily-scrape-${workflow}`,
        data: payload,
      }
    );
    return {
      workflow,
      schedulerId,
      cron: config.cron,
      timezone: env.scraperTimezone,
    };
  }

  await scrapeQueue.add(`daily-scrape-${workflow}`, payload, {
    jobId: schedulerId,
    repeat: {
      pattern: config.cron,
      tz: env.scraperTimezone,
    },
  });

  return {
    workflow,
    schedulerId,
    cron: config.cron,
    timezone: env.scraperTimezone,
  };
}

async function ensureDailyScrapeSchedule(workflowId = "all") {
  const normalized = String(workflowId || "").trim().toLowerCase();
  if (normalized === "all" || !normalized) {
    const workflows = listWorkflowConfigs();
    const result = [];
    for (const config of workflows) {
      result.push(await ensureScheduleForWorkflow(config.id));
    }
    return result;
  }

  return [await ensureScheduleForWorkflow(resolveWorkflow(normalized))];
}

module.exports = {
  scrapeQueue,
  enqueueManualScrape,
  ensureDailyScrapeSchedule,
};
