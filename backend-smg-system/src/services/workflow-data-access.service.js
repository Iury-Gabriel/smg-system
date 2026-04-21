const { WORKFLOW_BSB, resolveWorkflow } = require("../config/workflows");

function getWorkflowTables(prisma, workflowInput) {
  const workflow = resolveWorkflow(workflowInput);

  if (workflow === WORKFLOW_BSB) {
    return {
      workflow,
      lead: prisma.leadAutomacaoBsb,
      discard: prisma.discardLogBsb,
      segment: prisma.segmentConfigBsb,
      preset: prisma.searchPresetBsb,
      execution: prisma.jobExecutionBsb,
    };
  }

  return {
    workflow,
    lead: prisma.leadAutomacao,
    discard: prisma.discardLog,
    segment: prisma.segmentConfig,
    preset: prisma.searchPreset,
    execution: prisma.jobExecution,
  };
}

module.exports = {
  getWorkflowTables,
};
