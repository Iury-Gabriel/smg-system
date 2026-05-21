const express = require("express");
const { getPrisma } = require("../lib/prisma");
const { listWorkflowConfigs, resolveWorkflow } = require("../config/workflows");
const { getWorkflowTables } = require("../services/workflow-data-access.service");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const workflowFromQuery = String(req.query?.workflow || "").trim().toLowerCase();
    const orderInput = String(req.query?.order || "").trim().toLowerCase();
    const sortOrder = orderInput === "asc" ? "asc" : "desc";
    const where = {};

    if (req.query.segment) {
      where.segmento = String(req.query.segment);
    }

    if (workflowFromQuery === "all") {
      const allRows = [];
      let totalCount = 0;
      for (const workflowConfig of listWorkflowConfigs()) {
        const prisma = getPrisma(workflowConfig.id);
        const tables = getWorkflowTables(prisma, workflowConfig.id);
        const [rows, count] = await Promise.all([
          tables.lead.findMany({
            where,
            orderBy: { criadoEm: sortOrder },
            take: limit,
          }),
          tables.lead.count({ where }),
        ]);
        rows.forEach((row) => allRows.push({ ...row, workflow: workflowConfig.id }));
        totalCount += count;
      }

      allRows.sort((a, b) => {
        const left = new Date(a.criadoEm).getTime();
        const right = new Date(b.criadoEm).getTime();
        return sortOrder === "asc" ? left - right : right - left;
      });

      return res.json({
        success: true,
        workflow: "all",
        total: totalCount,
        data: allRows.slice(0, limit),
      });
    }

    const workflow = resolveWorkflow(workflowFromQuery);
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);

    const [rows, totalCount] = await Promise.all([
      tables.lead.findMany({
        where,
        orderBy: { criadoEm: sortOrder },
        take: limit,
      }),
      tables.lead.count({ where }),
    ]);

    return res.json({
      success: true,
      workflow,
      total: totalCount,
      data: rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/discarded", async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const workflowFromQuery = String(req.query?.workflow || "").trim().toLowerCase();
    const where = {};

    if (req.query.reason) {
      where.motivoDescarte = String(req.query.reason);
    }

    if (workflowFromQuery === "all") {
      const allRows = [];
      for (const workflowConfig of listWorkflowConfigs()) {
        const prisma = getPrisma(workflowConfig.id);
        const tables = getWorkflowTables(prisma, workflowConfig.id);
        const rows = await tables.discard.findMany({
          where,
          orderBy: { timestamp: "desc" },
          take: limit,
        });
        rows.forEach((row) => allRows.push({ ...row, workflow: workflowConfig.id }));
      }

      allRows.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return res.json({
        success: true,
        workflow: "all",
        data: allRows.slice(0, limit),
      });
    }

    const workflow = resolveWorkflow(workflowFromQuery);
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);
    const rows = await tables.discard.findMany({
      where,
      orderBy: { timestamp: "desc" },
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
