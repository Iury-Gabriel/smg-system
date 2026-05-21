const express = require("express");
const axios = require("axios");
const env = require("../config/env");

const router = express.Router();

router.post("/supabase/create-ldr-lead", async (req, res, next) => {
  try {
    const endpoint = String(env.supabaseCreateLdrLeadUrl || "").trim();
    const apiKey = String(env.supabaseAnonKey || "").trim();

    if (!endpoint) {
      return res.status(503).json({
        success: false,
        error: "SUPABASE_CREATE_LDR_LEAD_URL nao configurada no backend",
      });
    }

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error: "SUPABASE_ANON_KEY nao configurada no backend",
      });
    }

    const response = await axios.post(endpoint, req.body || {}, {
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    if (response.status >= 200 && response.status < 300) {
      return res.status(200).json({
        success: true,
        data: response.data ?? null,
      });
    }

    return res.status(response.status).json({
      success: false,
      error: "Falha ao enviar lead para o Supabase",
      details: response.data ?? null,
      upstreamStatus: response.status,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
