const { ScrapeSource, JobExecutionStatus } = require("@prisma/client");
const env = require("../config/env");
const { getPrisma } = require("../lib/prisma");
const {
  getWorkflowConfig,
  resolveWorkflow,
  WORKFLOW_SMG,
  WORKFLOW_BSB,
} = require("../config/workflows");
const { fetchGoogleSearchResults, fetchGoogleMapsResults } = require("../services/serpapi.service");
const { validateAndInsertLead } = require("../services/lead-pipeline.service");
const { getWorkflowTables } = require("../services/workflow-data-access.service");

const BSB_MIN_APPROVED_PER_EXECUTION = 70;
const BSB_MAX_PRESET_PASSES = 4;

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
    orderBy: [{ source: "desc" }, { name: "asc" }],
  });
}

async function resetBsbPresetStartOffsets(tables) {
  await tables.preset.updateMany({
    data: { startOffset: 0 },
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

function toPositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function resolveTargetApprovedPerExecution(workflow, workflowConfig, jobData = {}) {
  const requestedTarget = toPositiveInt(jobData.targetApprovedPerExecution);
  const configuredTarget = toPositiveInt(workflowConfig?.targetApprovedPerExecution);
  const fallbackTarget = configuredTarget || requestedTarget || 1;

  if (workflow === WORKFLOW_BSB) {
    return Math.max(BSB_MIN_APPROVED_PER_EXECUTION, requestedTarget || fallbackTarget);
  }

  return Math.max(1, requestedTarget || fallbackTarget);
}

async function runScrapeJob(jobData = {}) {
  const workflow = resolveWorkflow(jobData.workflow || WORKFLOW_SMG);
  const workflowConfig = getWorkflowConfig(workflow);
  const targetApprovedPerExecution = resolveTargetApprovedPerExecution(
    workflow,
    workflowConfig,
    jobData
  );
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
        targetApprovedPerExecution,
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
      targetApprovedPerExecution,
    });

    const activeSegments = await loadActiveSegmentsSet(tables);

    if (workflow === WORKFLOW_BSB) {
      await resetBsbPresetStartOffsets(tables);
      logScrape("job.cursor.reset", {
        executionId: execution.id,
        workflow,
        message: "Todos os presets BSB reiniciados com startOffset=0.",
      });
    }

    const presets = await loadPresets(tables, requestedSegments);

    logScrape("job.context", {
      executionId: execution.id,
      workflow,
      activeSegments: [...activeSegments],
      presetCount: presets.length,
      targetApprovedPerExecution,
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

    const maxPresetPasses = workflow === WORKFLOW_BSB ? BSB_MAX_PRESET_PASSES : 1;
    for (let passIndex = 0; passIndex < maxPresetPasses; passIndex += 1) {
      if (stats.totalApproved >= targetApprovedPerExecution) {
        logScrape("job.target.reached", {
          executionId: execution.id,
          workflow,
          targetApprovedPerExecution,
          totalApproved: stats.totalApproved,
          pass: passIndex + 1,
        });
        break;
      }

      logScrape("job.pass.started", {
        executionId: execution.id,
        workflow,
        pass: passIndex + 1,
        maxPresetPasses,
      });

      const approvedAtPassStart = stats.totalApproved;

      for (const preset of presets) {
        if (stats.totalApproved >= targetApprovedPerExecution) {
          break;
        }

        const currentStartOffset = Number(preset.startOffset || 0);

        logScrape("preset.started", {
          executionId: execution.id,
          workflow,
          presetId: preset.id,
          name: preset.name,
          source: preset.source,
          segment: preset.segment?.segment || null,
          pass: passIndex + 1,
        });

        const sourceOutput = await collectLeadsFromPreset(preset, workflow);
        const leads = Array.isArray(sourceOutput?.leads) ? sourceOutput.leads : [];
        const startUsed = Number.isFinite(Number(sourceOutput?.startUsed))
          ? Number(sourceOutput.startUsed)
          : currentStartOffset;
        const nextStart = Number.isFinite(Number(sourceOutput?.nextStart))
          ? Number(sourceOutput.nextStart)
          : startUsed;

        if (leads.length === 0 && nextStart === startUsed) {
          logScrape("preset.exhausted", {
            executionId: execution.id,
            workflow,
            presetId: preset.id,
            startUsed,
            pass: passIndex + 1,
            hint: "Preset esgotou resultados disponiveis, pulando.",
          });
          stats.presetBreakdown.push({
            pass: passIndex + 1,
            presetId: preset.id,
            name: preset.name,
            source: preset.source,
            startUsed,
            nextStart: startUsed,
            collected: 0,
            approved: 0,
            discarded: 0,
            targetReached: false,
          });
          continue;
        }
        let approvedInPreset = 0;
        let discardedInPreset = 0;
        let leadLogsCount = 0;
        let stopProcessingPreset = false;

        stats.totalCollected += leads.length;

        logScrape("preset.collected", {
          executionId: execution.id,
          workflow,
          presetId: preset.id,
          startUsed,
          nextStart,
          collected: leads.length,
          pass: passIndex + 1,
        });

        const savedStartOffset = Math.max(0, Math.floor(nextStart));
        await tables.preset.update({
          where: { id: preset.id },
          data: {
            startOffset: savedStartOffset,
          },
        });
        preset.startOffset = savedStartOffset;

        logScrape("preset.cursor.updated", {
          executionId: execution.id,
          workflow,
          presetId: preset.id,
          previousStart: startUsed,
          savedStartOffset,
          pass: passIndex + 1,
        });

        for (const rawLead of leads) {
          if (stats.totalApproved >= targetApprovedPerExecution) {
            stopProcessingPreset = true;
            break;
          }

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

          if (stats.totalApproved >= targetApprovedPerExecution) {
            stopProcessingPreset = true;
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
              pass: passIndex + 1,
            });
          }

          if (stopProcessingPreset) {
            break;
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
            pass: passIndex + 1,
          });
        }

        stats.presetBreakdown.push({
          pass: passIndex + 1,
          presetId: preset.id,
          name: preset.name,
          source: preset.source,
          startUsed,
          nextStart: savedStartOffset,
          collected: leads.length,
          approved: approvedInPreset,
          discarded: discardedInPreset,
          targetReached: stats.totalApproved >= targetApprovedPerExecution,
        });

        logScrape("preset.finished", {
          executionId: execution.id,
          workflow,
          presetId: preset.id,
          startUsed,
          nextStart: savedStartOffset,
          collected: leads.length,
          approved: approvedInPreset,
          discarded: discardedInPreset,
          targetReached: stats.totalApproved >= targetApprovedPerExecution,
          pass: passIndex + 1,
        });
      }

      logScrape("job.pass.finished", {
        executionId: execution.id,
        workflow,
        pass: passIndex + 1,
        approvedInPass: stats.totalApproved - approvedAtPassStart,
        totalApproved: stats.totalApproved,
        targetApprovedPerExecution,
      });

      if (stats.totalApproved === approvedAtPassStart) {
        logScrape("job.pass.no_progress", {
          executionId: execution.id,
          workflow,
          pass: passIndex + 1,
          totalApproved: stats.totalApproved,
          targetApprovedPerExecution,
        });
        break;
      }
    }

    if (workflow === WORKFLOW_BSB && stats.totalApproved < targetApprovedPerExecution) {
      const error = new Error(
        `BSB nao atingiu a meta obrigatoria de ${targetApprovedPerExecution} aprovados nesta execucao.`
      );
      error.statusCode = 422;
      throw error;
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
          targetApprovedPerExecution,
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
      targetApprovedPerExecution,
    });

    return {
      workflow,
      executionId: execution.id,
      targetApprovedPerExecution,
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
