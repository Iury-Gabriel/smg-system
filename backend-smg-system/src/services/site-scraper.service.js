const axios = require("axios");
const cheerio = require("cheerio");

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_REGEX = /(?:\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}[-\s]?\d{4}/g;
const INSTAGRAM_URL_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+(?:\/)?/gi;
const TEXT_LIMIT = 20000;

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueValues(values) {
  return [...new Set(values.map((item) => cleanText(item)).filter(Boolean))];
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function collectStructuredNames(node, bucket) {
  if (!node || typeof node !== "object") return;

  const typeValue = node["@type"];
  const typeText = Array.isArray(typeValue) ? typeValue.join(" ").toLowerCase() : String(typeValue || "").toLowerCase();
  const isBusinessType =
    typeText.includes("organization") ||
    typeText.includes("localbusiness") ||
    typeText.includes("professionalservice") ||
    typeText.includes("constructionbusiness") ||
    typeText.includes("architect") ||
    typeText.includes("engineering");

  if (isBusinessType) {
    if (node.name) bucket.push(node.name);
    if (node.legalName) bucket.push(node.legalName);
  }

  if (Array.isArray(node["@graph"])) {
    for (const item of node["@graph"]) {
      collectStructuredNames(item, bucket);
    }
  }
}

function extractStructuredNames($) {
  const names = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const parsed = safeJsonParse($(element).text());
    if (!parsed) return;

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        collectStructuredNames(item, names);
      }
      return;
    }

    collectStructuredNames(parsed, names);
  });

  return uniqueValues(names);
}

function truncateText(value, limit = TEXT_LIMIT) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  return cleaned.slice(0, Math.max(0, limit));
}

function normalizeInstagramUrl(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";

  const withoutQuery = cleaned.split("?")[0].split("#")[0].replace(/\/+$/, "");
  if (!/^https?:\/\/(?:www\.)?instagram\.com\//i.test(withoutQuery)) return "";
  return withoutQuery;
}

function normalizeInstagramHandle(value) {
  const cleaned = cleanText(value).replace(/^@+/, "");
  if (!cleaned) return "";
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(cleaned)) return "";
  return cleaned;
}

async function scrapeWebsiteContacts(url, timeoutMs = 15000) {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) {
    return {
      emails: [],
      phones: [],
      instagramUrls: [],
      instagramHandles: [],
      title: "",
      description: "",
      h1: [],
      ogTitle: "",
      ogSiteName: "",
      structuredNames: [],
      bodyText: "",
    };
  }

  try {
    const response = await axios.get(safeUrl, {
      timeout: timeoutMs,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      },
    });

    const html = String(response.data || "");
    const $ = cheerio.load(html);
    const bodyText = truncateText($("body").text());
    const title = cleanText($("title").first().text());
    const description = cleanText($('meta[name="description"]').attr("content"));
    const ogTitle = cleanText($('meta[property="og:title"]').attr("content"));
    const ogSiteName = cleanText($('meta[property="og:site_name"]').attr("content"));
    const h1 = uniqueValues(
      $("h1")
        .map((_, element) => $(element).text())
        .get()
    ).slice(0, 5);
    const instagramUrls = uniqueValues(
      $("a[href*='instagram.com']")
        .map((_, element) => $(element).attr("href"))
        .get()
        .concat((html.match(INSTAGRAM_URL_REGEX) || []).map((item) => item.trim()))
    ).map(normalizeInstagramUrl).filter(Boolean);
    const instagramHandles = uniqueValues(
      $("a[href*='instagram.com']")
        .map((_, element) => $(element).text())
        .get()
        .concat(
          instagramUrls
            .map((item) => item.split("/").filter(Boolean).pop())
            .filter(Boolean)
        )
    )
      .map(normalizeInstagramHandle)
      .filter(Boolean);
    const structuredNames = extractStructuredNames($);
    const text = [
      bodyText,
      title,
      description,
      ogTitle,
      ogSiteName,
      ...h1,
      ...structuredNames,
      ...instagramUrls,
      ...instagramHandles.map((handle) => `@${handle}`),
    ]
      .map((item) => cleanText(item))
      .filter(Boolean)
      .join(" | ");

    const emails = [...new Set((text.match(EMAIL_REGEX) || []).map((item) => item.trim()))];
    const phones = [...new Set((text.match(PHONE_REGEX) || []).map((item) => item.trim()))];

    return {
      emails,
      phones,
      instagramUrls,
      instagramHandles,
      title,
      description,
      h1,
      ogTitle,
      ogSiteName,
      structuredNames,
      bodyText,
    };
  } catch (_error) {
    return {
      emails: [],
      phones: [],
      instagramUrls: [],
      instagramHandles: [],
      title: "",
      description: "",
      h1: [],
      ogTitle: "",
      ogSiteName: "",
      structuredNames: [],
      bodyText: "",
    };
  }
}

module.exports = {
  scrapeWebsiteContacts,
};
