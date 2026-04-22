const express = require("express");
const { resolveWorkflow } = require("../config/workflows");
const { getPrisma } = require("../lib/prisma");
const { getWorkflowTables } = require("../services/workflow-data-access.service");
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

router.get("/forms", async (req, res, next) => {
  try {
    const workflow = resolveWorkflow(req.query?.workflow);
    const limit = Math.max(1, Math.min(Number(req.query?.limit) || 100, 300));
    const search = String(req.query?.q || "").trim();
    const prisma = getPrisma(workflow);
    const tables = getWorkflowTables(prisma, workflow);

    const where = {
      workflow,
    };

    if (search) {
      where.OR = [
        {
          token: {
            contains: search,
            mode: "insensitive",
          },
        },
        {
          telefone: {
            contains: search,
          },
        },
        {
          segmento: {
            contains: search,
            mode: "insensitive",
          },
        },
      ];
    }

    const forms = await prisma.leadDiagnostico.findMany({
      where,
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    });

    const formIds = forms.map((item) => item.id);
    const leads = formIds.length
      ? await tables.lead.findMany({
          where: {
            diagnosticoFormularioId: {
              in: formIds,
            },
          },
          orderBy: {
            criadoEm: "desc",
          },
          select: {
            id: true,
            nome: true,
            telefone: true,
            empresa: true,
            status: true,
            pipelineOrigin: true,
            canalAquisicao: true,
            diagnosticoFormularioId: true,
          },
        })
      : [];

    const leadByFormId = new Map();
    for (const lead of leads) {
      const formId = String(lead.diagnosticoFormularioId || "").trim();
      if (!formId || leadByFormId.has(formId)) continue;
      leadByFormId.set(formId, lead);
    }

    const data = forms.map((item) => ({
      id: item.id,
      workflow: item.workflow,
      token: item.token,
      telefone: item.telefone,
      segmento: item.segmento,
      faturamentoMensal: item.faturamentoMensal,
      numFuncionarios: item.numFuncionarios,
      ferramentas: item.ferramentas,
      tentativaAnterior: item.tentativaAnterior,
      mudancaOperacao: item.mudancaOperacao,
      descricaoOperacao: item.descricaoOperacao,
      urgencia: item.urgencia,
      maiorDesafio: item.maiorDesafio,
      motivacao: item.motivacao,
      expectativa: item.expectativa,
      rawData: item.rawData || {},
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lead: leadByFormId.get(item.id) || null,
    }));

    return res.json({
      success: true,
      workflow,
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
