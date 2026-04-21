const { getPrisma } = require("../../lib/prisma");
const { resolveWorkflow } = require("../../config/workflows");
const { getAgentOrThrow } = require("./registry.service");
const { normalizePhone, textOrEmpty } = require("./helpers");

function toWorkflow(workflowInput, agentSlug = "") {
  if (textOrEmpty(workflowInput)) {
    return resolveWorkflow(workflowInput);
  }
  if (textOrEmpty(agentSlug)) {
    return resolveWorkflow("smg");
  }
  const agent = getAgentOrThrow(agentSlug);
  return resolveWorkflow(agent.workflow);
}

async function createExecutionRun({
  workflow: workflowInput,
  agentSlug,
  provider = "",
  conversationKey = "",
  phoneNumber = "",
  triggerSource = "runtime",
  inputPayload = null,
}) {
  const workflow = toWorkflow(workflowInput, agentSlug);
  const prisma = getPrisma(workflow);

  return prisma.agentExecutionRun.create({
    data: {
      workflow,
      agentSlug: textOrEmpty(agentSlug),
      provider: textOrEmpty(provider) || null,
      conversationKey: textOrEmpty(conversationKey) || null,
      phoneNumber: normalizePhone(phoneNumber) || null,
      triggerSource: textOrEmpty(triggerSource) || "runtime",
      inputPayload: inputPayload || null,
      status: "running",
      startedAt: new Date(),
    },
  });
}

async function appendExecutionEvent({
  workflow: workflowInput,
  runId,
  stepKey,
  title,
  nodeType = "process",
  status = "info",
  payload = null,
}) {
  const workflow = resolveWorkflow(workflowInput || "smg");
  if (!textOrEmpty(runId) || !textOrEmpty(stepKey) || !textOrEmpty(title)) {
    return null;
  }
  const prisma = getPrisma(workflow);

  return prisma.agentExecutionEvent.create({
    data: {
      runId,
      stepKey: textOrEmpty(stepKey),
      title: textOrEmpty(title),
      nodeType: textOrEmpty(nodeType) || "process",
      status: textOrEmpty(status) || "info",
      payload: payload || null,
    },
  });
}

async function finishExecutionRun({
  workflow: workflowInput,
  runId,
  status = "success",
  outputPayload = null,
  errorMessage = "",
}) {
  const workflow = resolveWorkflow(workflowInput || "smg");
  if (!textOrEmpty(runId)) {
    return null;
  }
  const prisma = getPrisma(workflow);

  return prisma.agentExecutionRun.update({
    where: { id: runId },
    data: {
      status: textOrEmpty(status) || "success",
      outputPayload: outputPayload || null,
      errorMessage: textOrEmpty(errorMessage) || null,
      finishedAt: new Date(),
    },
  });
}

module.exports = {
  createExecutionRun,
  appendExecutionEvent,
  finishExecutionRun,
};
