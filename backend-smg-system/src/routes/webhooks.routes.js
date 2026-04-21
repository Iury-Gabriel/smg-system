const express = require("express");
const { normalizeProvider } = require("../services/agents/helpers");
const {
  verifyMetaWebhookChallenge,
  processInboundWebhook,
} = require("../services/agents/runtime.service");

const router = express.Router();

function safeJson(value, max = 5000) {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > max ? `${raw.slice(0, max)}...<truncated>` : raw;
  } catch (_error) {
    return "<unserializable_payload>";
  }
}

function logWebhookRoute(event, payload = {}) {
  const stamp = new Date().toISOString();
  console.log(`[webhooks.route][${stamp}][${event}]`, payload);
}

router.get("/:agentSlug/:provider", async (req, res, next) => {
  try {
    logWebhookRoute("verify.request", {
      explanation:
        "Requisicao de verificacao de webhook recebida. Normalmente usada pela Meta no setup inicial.",
      agentSlug: req.params.agentSlug,
      provider: req.params.provider,
      query: safeJson(req.query || {}),
    });

    const provider = normalizeProvider(req.params.provider);
    if (!provider) {
      return res.status(400).json({
        success: false,
        error: "Provider invalido. Use meta ou uazapi.",
      });
    }

    if (provider !== "meta") {
      return res.json({
        success: true,
        message: "Webhook ativo. Para Uazapi use chamadas POST.",
      });
    }

    const result = await verifyMetaWebhookChallenge(req.params.agentSlug, req.query || {});
    if (!result.verified) {
      return res.status(result.statusCode).json({
        success: false,
        error: "Falha ao validar webhook da Meta.",
        reason: result.reason || "verification_failed",
      });
    }

    return res.status(200).send(result.challenge);
  } catch (error) {
    return next(error);
  }
});

router.post("/:agentSlug/:provider", async (req, res, next) => {
  try {
    logWebhookRoute("inbound.request", {
      explanation:
        "Webhook inbound recebido na rota HTTP. Payload ainda nao processado pelo parser.",
      agentSlug: req.params.agentSlug,
      provider: req.params.provider,
      payload: safeJson(req.body || {}),
    });

    const provider = normalizeProvider(req.params.provider);
    if (!provider) {
      return res.status(400).json({
        success: false,
        error: "Provider invalido. Use meta ou uazapi.",
      });
    }

    const result = await processInboundWebhook({
      agentSlug: req.params.agentSlug,
      provider,
      payload: req.body || {},
      headers: req.headers || {},
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
