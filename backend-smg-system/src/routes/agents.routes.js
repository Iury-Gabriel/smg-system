const express = require("express");
const { getRequestOrigin } = require("../services/agents/helpers");
const {
  listAgentsForApi,
  getAgentForApi,
  sendMessageForAgent,
} = require("../services/agents/runtime.service");
const { getAgentSetup, updateAgentSetup } = require("../services/agents/setup.service");
const {
  listAgentConversations,
  getAgentConversationMessages,
  listAgentExecutionRuns,
  getAgentExecutionRun,
} = require("../services/agents/observability.service");
const {
  runAgentConversationSimulation,
} = require("../services/agents/simulation.service");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const origin = getRequestOrigin(req);
    const agents = listAgentsForApi(origin);
    return res.json({
      success: true,
      data: agents,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:agentSlug", async (req, res, next) => {
  try {
    const origin = getRequestOrigin(req);
    const agent = getAgentForApi(req.params.agentSlug, origin);
    return res.json({
      success: true,
      data: agent,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:agentSlug/setup", async (req, res, next) => {
  try {
    const data = getAgentSetup(req.params.agentSlug);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:agentSlug/setup", async (req, res, next) => {
  try {
    const setup = updateAgentSetup(req.params.agentSlug, req.body?.values || {});
    const origin = getRequestOrigin(req);
    const agent = getAgentForApi(req.params.agentSlug, origin);
    return res.json({
      success: true,
      data: {
        setup,
        agent,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:agentSlug/messages/send", async (req, res, next) => {
  try {
    const provider = req.body?.provider;
    const to = req.body?.to;
    const text = req.body?.text;
    const data = await sendMessageForAgent({
      agentSlug: req.params.agentSlug,
      provider,
      to,
      text,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:agentSlug/conversations/simulate", async (req, res, next) => {
  try {
    const data = await runAgentConversationSimulation(req.params.agentSlug, {
      count: req.body?.count,
      turns: req.body?.turns,
    });
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:agentSlug/conversations", async (req, res, next) => {
  try {
    const data = await listAgentConversations(req.params.agentSlug, {
      limit: req.query?.limit,
      search: req.query?.search,
    });
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:agentSlug/conversations/:conversationKey/messages", async (req, res, next) => {
  try {
    const data = await getAgentConversationMessages(
      req.params.agentSlug,
      decodeURIComponent(req.params.conversationKey || ""),
      {
        limit: req.query?.limit,
      }
    );
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:agentSlug/executions", async (req, res, next) => {
  try {
    const data = await listAgentExecutionRuns(req.params.agentSlug, {
      limit: req.query?.limit,
      conversationKey: req.query?.conversationKey,
    });
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:agentSlug/executions/:runId", async (req, res, next) => {
  try {
    const data = await getAgentExecutionRun(req.params.agentSlug, req.params.runId);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
