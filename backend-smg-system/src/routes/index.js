const express = require("express");
const scrapeRoutes = require("./scrape.routes");
const leadsRoutes = require("./leads.routes");
const configRoutes = require("./config.routes");
const webhooksRoutes = require("./webhooks.routes");
const agentsRoutes = require("./agents.routes");
const wf2Routes = require("./wf2.routes");
const integrationsRoutes = require("./integrations.routes");
const { listWorkflowConfigs } = require("../config/workflows");
const { buildSha } = require("../config/build-info");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Scrap backend online",
    buildSha,
    workflows: listWorkflowConfigs().map((workflow) => workflow.id),
    timestamp: new Date().toISOString(),
  });
});

router.use("/scrape", scrapeRoutes);
router.use("/leads", leadsRoutes);
router.use("/config", configRoutes);
router.use("/webhooks", webhooksRoutes);
router.use("/agents", agentsRoutes);
router.use("/wf2", wf2Routes);
router.use("/integrations", integrationsRoutes);

module.exports = router;
