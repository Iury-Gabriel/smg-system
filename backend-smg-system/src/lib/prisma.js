const { PrismaClient } = require("@prisma/client");
const { getWorkflowConfig, resolveWorkflow, WORKFLOW_SMG } = require("../config/workflows");

const clients = new Map();

function getPrisma(workflowId = WORKFLOW_SMG) {
  const workflow = resolveWorkflow(workflowId);
  const config = getWorkflowConfig(workflow);
  const databaseUrl = String(config.databaseUrl || "").trim();
  const clientKey = databaseUrl || workflow;

  const existing = clients.get(clientKey);
  if (existing) return existing;

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  clients.set(clientKey, prisma);
  return prisma;
}

async function disconnectPrismaClients() {
  const tasks = [];
  for (const prisma of clients.values()) {
    tasks.push(prisma.$disconnect());
  }
  await Promise.all(tasks);
}

const prisma = getPrisma(WORKFLOW_SMG);

module.exports = prisma;
module.exports.getPrisma = getPrisma;
module.exports.disconnectPrismaClients = disconnectPrismaClients;
