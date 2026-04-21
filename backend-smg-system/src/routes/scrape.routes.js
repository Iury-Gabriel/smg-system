const express = require("express");
const { getPrisma } = require("../lib/prisma");
const { enqueueManualScrape, ensureDailyScrapeSchedule } = require("../queue/queues");
const { parseWorkflowFromRequest, listWorkflowConfigs, resolveWorkflow } = require("../config/workflows");
const { getWorkflowTables } = require("../services/workflow-data-access.service");

const router = express.Router();

router.post("/run", async (req, res, next) => {
  try {
    const workflow = parseWorkflowFromRequest(req);
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const job = await enqueueManualScrape({ workflow, segments });
    return res.status(202).json({
      success: true,
      data: {
        jobId: job.id,
        name: job.name,
        workflow,
        segments,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/schedule/ensure", async (req, res, next) => {
  try {
    const workflow = parseWorkflowFromRequest(req, { allowAll: true });
    const schedules = await ensureDailyScrapeSchedule(workflow);
    return res.json({
      success: true,
      workflow,
      data: schedules,
      message: "Agendamento diario garantido.",
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/executions", async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 200));
    const workflowFromQuery = String(req.query?.workflow || "").trim().toLowerCase();

    if (workflowFromQuery === "all") {
      const allRows = [];
      for (const workflowConfig of listWorkflowConfigs()) {
        const prisma = getPrisma(workflowConfig.id);
        const tables = getWorkflowTables(prisma, workflowConfig.id);
        const rows = await tables.execution.findMany({
          orderBy: { startedAt: "desc" },
          take: limit,
        });
        rows.forEach((row) => allRows.push({ ...row, workflow: workflowConfig.id }));
      }

      allRows.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      return res.json({
        success: true,
        workflow: "all",
        data: allRows.slice(0, limit),
      });
    }

    const workflow = resolveWorkflow(workflowFromQuery);
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);
    const rows = await tables.execution.findMany({
      orderBy: { startedAt: "desc" },
      take: limit,
    });

    return res.json({
      success: true,
      workflow,
      data: rows,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
