const express = require("express");
const { getPrisma } = require("../lib/prisma");
const { parseWorkflowFromRequest } = require("../config/workflows");
const { getWorkflowTables } = require("../services/workflow-data-access.service");

const router = express.Router();

router.get("/segments", async (req, res, next) => {
  try {
    const workflow = parseWorkflowFromRequest(req);
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);
    const rows = await tables.segment.findMany({
      orderBy: { segment: "asc" },
    });
    return res.json({ success: true, workflow, data: rows });
  } catch (error) {
    return next(error);
  }
});

router.patch("/segments/:segment", async (req, res, next) => {
  try {
    const workflow = parseWorkflowFromRequest(req);
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);
    const segment = String(req.params.segment || "").trim();
    const isActive = Boolean(req.body?.isActive);

    const row = await tables.segment.update({
      where: { segment },
      data: { isActive },
    });
    return res.json({ success: true, workflow, data: row });
  } catch (error) {
    return next(error);
  }
});

router.get("/presets", async (req, res, next) => {
  try {
    const workflow = parseWorkflowFromRequest(req);
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);
    const rows = await tables.preset.findMany({
      include: {
        segment: {
          select: {
            segment: true,
            displayName: true,
            isActive: true,
          },
        },
      },
      orderBy: [{ source: "asc" }, { name: "asc" }],
    });
    return res.json({ success: true, workflow, data: rows });
  } catch (error) {
    return next(error);
  }
});

router.patch("/presets/:id/start", async (req, res, next) => {
  try {
    const workflow = parseWorkflowFromRequest(req);
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);
    const id = String(req.params.id || "").trim();
    const rawStart = Number(req.body?.startOffset);
    if (!id) {
      return res.status(400).json({
        success: false,
        error: "ID do preset e obrigatorio.",
      });
    }

    if (!Number.isFinite(rawStart) || rawStart < 0) {
      return res.status(400).json({
        success: false,
        error: "startOffset precisa ser numero inteiro maior ou igual a 0.",
      });
    }

    const startOffset = Math.floor(rawStart);

    const row = await tables.preset.update({
      where: { id },
      data: { startOffset },
    });

    return res.json({
      success: true,
      workflow,
      data: row,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
