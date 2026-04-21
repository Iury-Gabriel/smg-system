const express = require("express");
const { resolveWorkflow } = require("../config/workflows");
const { getPrisma } = require("../lib/prisma");
const {
  processWorkflowTick,
  processAllWorkflowTicks,
  createDiagnosticoFromPayload,
} = require("../services/wf2/wf2.service");

const router = express.Router();

router.post("/run", async (req, res, next) => {
  try {
    const workflow = String(req.body?.workflow || req.query?.workflow || "all")
      .trim()
      .toLowerCase();
    const data =
      workflow === "all"
        ? await processAllWorkflowTicks()
        : [await processWorkflowTick(resolveWorkflow(workflow))];

    return res.json({
      success: true,
      workflow,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/forms", async (req, res, next) => {
  try {
    const payload = req.body || {};
    const data = await createDiagnosticoFromPayload({
      workflow: payload.workflow,
      token: payload.token,
      phoneNumber: payload.phoneNumber || payload.telefone,
      payload: payload.form || payload,
      leadPayload: payload.lead || {},
    });

    return res.status(201).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/timeline", async (req, res, next) => {
  try {
    const workflow = resolveWorkflow(req.query?.workflow);
    const leadId = String(req.query?.leadId || "").trim();
    const limit = Math.max(1, Math.min(Number(req.query?.limit) || 100, 300));
    if (!leadId) {
      return res.status(400).json({
        success: false,
        error: "leadId e obrigatorio.",
      });
    }

    const prisma = getPrisma(workflow);
    const rows = await prisma.leadAutomacaoTimeline.findMany({
      where: {
        workflow,
        leadId,
      },
      orderBy: {
        createdAt: "desc",
      },
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
