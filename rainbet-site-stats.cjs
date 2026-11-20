"use strict";

const validRanges = new Set(["7d", "30d", "90d", "all"]);
const plausibleQueryUrl = "https://plausible.io/api/v2/query";
const cacheDurationMs = 5 * 60 * 1000;

class SiteStatsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createSiteStatsService(options) {
  const {auth, fetchImpl, apiKey, siteId, adminEmails} = options || {};
  const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const normalizedSiteId = typeof siteId === "string" ? siteId.trim() : "";
  const allowedEmails = new Set(
    Array.isArray(adminEmails)
      ? adminEmails.map((email) => typeof email === "string" ? email.trim().toLowerCase() : "")
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      : []
  );
  if (!auth || typeof auth.verifyIdToken !== "function" ||
      typeof fetchImpl !== "function" ||
      !normalizedApiKey ||
      !normalizedSiteId || normalizedSiteId.length > 253 ||
      allowedEmails.size === 0) {
    throw new Error("Site analytics require Firebase Admin Auth, a Plausible API key and site ID, and an admin email allowlist.");
  }

  const cache = new Map();

  async function fetchQuery(query) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(plausibleQueryUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + normalizedApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(query),
        signal: controller.signal
      });
      if (!response || !response.ok) {
        throw new SiteStatsError(502, "The analytics provider could not return site statistics.");
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new SiteStatsError(502, "The analytics provider returned an invalid response.");
      }
      if (!payload || !Array.isArray(payload.results)) {
        throw new SiteStatsError(502, "The analytics provider returned an invalid response.");
      }
      return payload.results;
    } catch (error) {
      if (error instanceof SiteStatsError) throw error;
      throw new SiteStatsError(502, "The analytics provider could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async getStats(idToken, dateRange) {
      if (!validRanges.has(dateRange)) {
        throw new SiteStatsError(400, "Choose a supported analytics date range.");
      }
      if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 5000) {
        throw new SiteStatsError(401, "Sign in with the approved Google account to view site analytics.");
      }

      let decoded;
      try {
        decoded = await auth.verifyIdToken(idToken, true);
      } catch {
        throw new SiteStatsError(401, "The Google sign-in session is invalid or expired.");
      }
      const email = decoded && typeof decoded.email === "string" ? decoded.email.toLowerCase() : "";
      if (!decoded || !decoded.email_verified ||
          !decoded.firebase || decoded.firebase.sign_in_provider !== "google.com") {
        throw new SiteStatsError(403, "Use a verified Google account to view site analytics.");
      }
      if (!allowedEmails.has(email)) {
        throw new SiteStatsError(403, "This Google account is not authorized to view site analytics.");
      }

      const cached = cache.get(dateRange);
      if (cached && Date.now() - cached.createdAt < cacheDurationMs) return cached.value;

      const [summaryRows, pageRows] = await Promise.all([
        fetchQuery({
          site_id: normalizedSiteId,
          metrics: ["visitors", "visits", "pageviews", "visit_duration", "bounce_rate"],
          date_range: dateRange
        }),
        fetchQuery({
          site_id: normalizedSiteId,
          metrics: ["visitors", "pageviews"],
          dimensions: ["event:page"],
          date_range: dateRange,
          order_by: [["pageviews", "desc"]],
          pagination: {limit: 5, offset: 0}
        })
      ]);
      const summaryMetrics = summaryRows[0] && summaryRows[0].metrics;
      if (summaryRows.length > 0 &&
          (!Array.isArray(summaryMetrics) || summaryMetrics.length !== 5 ||
            !summaryMetrics.every((value) => Number.isFinite(value)))) {
        throw new SiteStatsError(502, "The analytics provider returned incomplete summary metrics.");
      }
      const metrics = summaryRows.length ? summaryMetrics : [0, 0, 0, 0, 0];
      const topPages = pageRows.slice(0, 5).map((row) => {
        if (!row || !Array.isArray(row.dimensions) || typeof row.dimensions[0] !== "string" ||
            !Array.isArray(row.metrics) || row.metrics.length !== 2 ||
            !row.metrics.every((value) => Number.isFinite(value))) {
          throw new SiteStatsError(502, "The analytics provider returned an invalid page breakdown.");
        }
        return {
          path: row.dimensions[0],
          visitors: row.metrics[0],
          pageviews: row.metrics[1]
        };
      });
      const value = {
        dateRange,
        visitors: metrics[0],
        visits: metrics[1],
        pageviews: metrics[2],
        visitDurationSeconds: metrics[3],
        bounceRate: metrics[4],
        topPages
      };
      cache.set(dateRange, {createdAt: Date.now(), value});
      return value;
    }
  };
}

module.exports = {SiteStatsError, createSiteStatsService};
