const axios = require("axios");
const cheerio = require("cheerio");

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_REGEX = /(?:\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}[-\s]?\d{4}/g;

async function scrapeWebsiteContacts(url, timeoutMs = 15000) {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) {
    return { emails: [], phones: [], title: "", description: "" };
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
    const text = $("body").text();

    const emails = [...new Set((text.match(EMAIL_REGEX) || []).map((item) => item.trim()))];
    const phones = [...new Set((text.match(PHONE_REGEX) || []).map((item) => item.trim()))];

    return {
      emails,
      phones,
      title: $("title").first().text().trim(),
      description: $('meta[name="description"]').attr("content") || "",
    };
  } catch (_error) {
    return { emails: [], phones: [], title: "", description: "" };
  }
}

module.exports = {
  scrapeWebsiteContacts,
};
