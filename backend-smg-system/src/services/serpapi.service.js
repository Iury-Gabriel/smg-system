const axios = require("axios");
const env = require("../config/env");

function assertSerpApiKey() {
  if (!env.serpApiKey) {
    const error = new Error("SERPAPI_API_KEY nao configurada.");
    error.statusCode = 500;
    throw error;
  }
}

async function callSerpApi(params) {
  assertSerpApiKey();
  const response = await axios.get(env.serpApiBaseUrl, {
    timeout: env.serpApiTimeoutMs,
    params: {
      ...params,
      api_key: env.serpApiKey,
    },
  });
  return response.data || {};
}

function toNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function resolveStartOffset(preset) {
  return toNonNegativeInt(preset?.startOffset, 0);
}

function parseStartFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get("start");
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  } catch (_error) {
    try {
      const parsed = new URL(url, "https://serpapi.com");
      const raw = parsed.searchParams.get("start");
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    } catch (_error2) {
      return null;
    }
  }
}

function resolveNextStart(payload, currentStart, fallbackStep) {
  const nextUrl =
    payload?.serpapi_pagination?.next ||
    payload?.serpapi_pagination?.next_link ||
    payload?.pagination?.next ||
    null;

  const nextFromPayload = parseStartFromUrl(nextUrl);
  if (nextFromPayload !== null) return nextFromPayload;

  const step = Math.max(1, Number(fallbackStep || 10));
  const candidate = currentStart + step;
  if (candidate > env.serpApiMaxStart) {
    return 0;
  }

  return candidate;
}

async function fetchGoogleSearchResults(preset) {
  const startOffset = resolveStartOffset(preset);
  const payload = await callSerpApi({
    engine: "google",
    q: preset.query,
    location: preset.location || undefined,
    google_domain: preset.googleDomain || "google.com",
    hl: preset.hl || "pt",
    gl: preset.gl || "br",
    start: startOffset,
  });

  const localPlaces = Array.isArray(payload?.local_results?.places)
    ? payload.local_results.places
    : [];

  const organic = Array.isArray(payload?.organic_results) ? payload.organic_results : [];

  const leadsFromLocal = localPlaces.map((item) => ({
    nome: item?.title || "",
    empresa: item?.title || "",
    telefoneBruto: item?.phone || "",
    endereco: item?.address || "",
    site: item?.links?.website || "",
    email: "",
    segmentoBruto: item?.type || "",
    fonte: "google_search",
    dadosBrutos: item,
  }));

  const leadsFromOrganic = organic.map((item) => ({
    nome: item?.title || "",
    empresa: item?.source || item?.title || "",
    telefoneBruto: "",
    endereco: "",
    site: item?.link || "",
    email: "",
    segmentoBruto: preset.query || "",
    fonte: "google_search",
    dadosBrutos: item,
  }));

  return {
    payload,
    leads: [...leadsFromLocal, ...leadsFromOrganic].slice(0, Math.max(1, preset.maxResults || 20)),
    startUsed: startOffset,
    nextStart: resolveNextStart(payload, startOffset, 10),
  };
}

async function fetchGoogleMapsResults(preset) {
  const startOffset = resolveStartOffset(preset);
  const payload = await callSerpApi({
    engine: "google_maps",
    q: preset.query,
    ll: preset.ll || undefined,
    hl: preset.hl || "pt",
    google_domain: preset.googleDomain || "google.com",
    start: startOffset,
    type: "search",
  });

  const localResults = Array.isArray(payload?.local_results) ? payload.local_results : [];

  return {
    payload,
    leads: localResults
      .map((item) => ({
        nome: item?.title || "",
        empresa: item?.title || "",
        telefoneBruto: item?.phone || "",
        endereco: item?.address || "",
        site: item?.website || "",
        email: "",
        segmentoBruto: item?.type || "",
        fonte: "google_maps",
        dadosBrutos: item,
      }))
      .slice(0, Math.max(1, preset.maxResults || 20)),
    startUsed: startOffset,
    nextStart: resolveNextStart(payload, startOffset, 20),
  };
}

module.exports = {
  fetchGoogleSearchResults,
  fetchGoogleMapsResults,
};
