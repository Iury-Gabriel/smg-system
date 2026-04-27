const { ScrapeSource, JobExecutionStatus } = require("@prisma/client");
const env = require("../config/env");
const { getPrisma } = require("../lib/prisma");
const { getWorkflowConfig, resolveWorkflow, WORKFLOW_SMG } = require("../config/workflows");
const { fetchGoogleSearchResults, fetchGoogleMapsResults } = require("../services/serpapi.service");
const { validateAndInsertLead } = require("../services/lead-pipeline.service");
const { getWorkflowTables } = require("../services/workflow-data-access.service");

function normalizeRequestedSegments(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))];
}

async function loadActiveSegmentsSet(tables) {
  const rows = await tables.segment.findMany({
    where: { isActive: true },
    select: { segment: true },
  });
  return new Set(rows.map((row) => row.segment));
}

async function loadPresets(tables, requestedSegments = []) {
  const where = {
    isActive: true,
  };

  if (requestedSegments.length > 0) {
    where.segment = {
      is: {
        segment: {
          in: requestedSegments,
        },
      },
    };
  }

  return tables.preset.findMany({
    where,
    include: {
      segment: {
        select: {
          segment: true,
          isActive: true,
        },
      },
    },
    orderBy: [{ source: "asc" }, { name: "asc" }],
  });
}

async function collectLeadsFromPreset(preset, workflow) {
  if (preset.source === ScrapeSource.google_search) {
    return fetchGoogleSearchResults(preset, workflow);
  }

  if (preset.source === ScrapeSource.google_maps) {
    return fetchGoogleMapsResults(preset, workflow);
  }

  return { payload: {}, leads: [] };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function logScrape(label, payload) {
  const stamp = new Date().toISOString();
  console.log(`[scrape][${stamp}][${label}] ${safeJson(payload)}`);
}

async function runScrapeJob(jobData = {}) {
  const workflow = resolveWorkflow(jobData.workflow || WORKFLOW_SMG);
  const workflowConfig = getWorkflowConfig(workflow);
  const prisma = getPrisma(workflow);
  const tables = getWorkflowTables(prisma, workflow);
  const startedAt = new Date();
  const requestedSegments = normalizeRequestedSegments(jobData.segments);

  const execution = await tables.execution.create({
    data: {
      queueJobId: String(jobData.queueJobId || "") || null,
      startedAt,
      status: JobExecutionStatus.running,
      details: {
        workflow,
        requestedSegments,
      },
    },
  });

  try {
    logScrape("job.started", {
      executionId: execution.id,
      queueJobId: jobData.queueJobId || null,
      workflow,
      trigger: jobData.trigger || "manual",
      requestedSegments,
    });

    const activeSegments = await loadActiveSegmentsSet(tables);
    const presets = await loadPresets(tables, requestedSegments);

    logScrape("job.context", {
      executionId: execution.id,
      workflow,
      activeSegments: [...activeSegments],
      presetCount: presets.length,
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        source: preset.source,
        segment: preset.segment?.segment || null,
        startOffset: preset.startOffset || 0,
      })),
    });

    const stats = {
      totalCollected: 0,
      totalApproved: 0,
      totalDiscarded: 0,
      presetBreakdown: [],
    };

    for (const preset of presets) {
      logScrape("preset.started", {
        executionId: execution.id,
        workflow,
        presetId: preset.id,
        name: preset.name,
        source: preset.source,
        segment: preset.segment?.segment || null,
      });

      const sourceOutput = await collectLeadsFromPreset(preset, workflow);
      const leads = Array.isArray(sourceOutput?.leads) ? sourceOutput.leads : [];
      const startUsed = Number.isFinite(Number(sourceOutput?.startUsed))
        ? Number(sourceOutput.startUsed)
        : Number(preset.startOffset || 0);
      const nextStart = Number.isFinite(Number(sourceOutput?.nextStart))
        ? Number(sourceOutput.nextStart)
        : startUsed;
      let approvedInPreset = 0;
      let discardedInPreset = 0;
      let leadLogsCount = 0;

      stats.totalCollected += leads.length;

      logScrape("preset.collected", {
        executionId: execution.id,
        workflow,
        presetId: preset.id,
        startUsed,
        nextStart,
        collected: leads.length,
      });

      await tables.preset.update({
        where: { id: preset.id },
        data: {
          startOffset: Math.max(0, Math.floor(nextStart)),
        },
      });

      logScrape("preset.cursor.updated", {
        executionId: execution.id,
        workflow,
        presetId: preset.id,
        previousStart: startUsed,
        savedStartOffset: Math.max(0, Math.floor(nextStart)),
      });

      for (const rawLead of leads) {
        const result = await validateAndInsertLead({
          tables,
          workflowConfig,
          rawLead,
          fallbackSegment: preset.segment.segment,
          activeSegments,
        });

        if (result.approved) {
          approvedInPreset += 1;
          stats.totalApproved += 1;
        } else {
          discardedInPreset += 1;
          stats.totalDiscarded += 1;
        }

        const canLogLead =
          env.workerVerboseLogs &&
          (env.workerLeadLogLimit === 0 || leadLogsCount < env.workerLeadLogLimit);

        if (canLogLead) {
          leadLogsCount += 1;
          logScrape("lead.processed", {
            executionId: execution.id,
            workflow,
            presetId: preset.id,
            status: result.approved ? "approved" : "discarded",
            reason: result.reason || null,
            leadId: result.leadId || null,
            nome: result.lead?.nome || rawLead?.nome || null,
            empresa: result.lead?.empresa || rawLead?.empresa || null,
            telefone: result.lead?.telefone || rawLead?.telefoneBruto || null,
            segmento: result.lead?.segmento || preset.segment.segment,
            fonte: result.lead?.fonte || rawLead?.fonte || preset.source,
          });
        }
      }

      if (env.workerVerboseLogs && env.workerLeadLogLimit > 0 && leads.length > leadLogsCount) {
        logScrape("preset.lead_logs_truncated", {
          executionId: execution.id,
          workflow,
          presetId: preset.id,
          emitted: leadLogsCount,
          total: leads.length,
          hint: "Aumente WORKER_LEAD_LOG_LIMIT ou use 0 para logar todos.",
        });
      }

      stats.presetBreakdown.push({
        presetId: preset.id,
        name: preset.name,
        source: preset.source,
        startUsed,
        nextStart: Math.max(0, Math.floor(nextStart)),
        collected: leads.length,
        approved: approvedInPreset,
        discarded: discardedInPreset,
      });

      logScrape("preset.finished", {
        executionId: execution.id,
        workflow,
        presetId: preset.id,
        startUsed,
        nextStart: Math.max(0, Math.floor(nextStart)),
        collected: leads.length,
        approved: approvedInPreset,
        discarded: discardedInPreset,
      });
    }

    await tables.execution.update({
      where: { id: execution.id },
      data: {
        finishedAt: new Date(),
        status: JobExecutionStatus.success,
        totalCollected: stats.totalCollected,
        totalApproved: stats.totalApproved,
        totalDiscarded: stats.totalDiscarded,
        details: {
          workflow,
          requestedSegments,
          presetBreakdown: stats.presetBreakdown,
        },
      },
    });

    logScrape("job.finished", {
      executionId: execution.id,
      workflow,
      totalCollected: stats.totalCollected,
      totalApproved: stats.totalApproved,
      totalDiscarded: stats.totalDiscarded,
    });

    return {
      workflow,
      executionId: execution.id,
      ...stats,
    };
  } catch (error) {
    logScrape("job.failed", {
      executionId: execution.id,
      workflow,
      message: error?.message || "unknown",
    });

    await tables.execution.update({
      where: { id: execution.id },
      data: {
        finishedAt: new Date(),
        status: JobExecutionStatus.failed,
        errorMessage: error?.message || "unknown",
      },
    });
    throw error;
  }
}

module.exports = {
  runScrapeJob,
};
