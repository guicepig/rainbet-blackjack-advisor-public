"use strict";

const {createHash, createHmac} = require("node:crypto");
const {parseRank} = require("./rainbet-strategy.cjs");

const validActions = new Set(["HIT", "STAND", "DOUBLE", "SPLIT"]);
const validDasRules = new Set(["unknown", "allowed", "not-allowed"]);
const validOutcomes = new Set(["win", "loss", "push"]);
const maxContributionsPerMinute = 20;

function takeContributionRateLimit(windows, client, now = Date.now()) {
  let window = windows.get(client);
  if (!window || now - window.startedAt >= 60000) {
    window = {startedAt: now, count: 0};
  }
  if (window.count >= maxContributionsPerMinute) {
    windows.set(client, window);
    return false;
  }
  window.count++;
  windows.set(client, window);
  if (windows.size > 1000) {
    for (const [key, value] of windows) {
      if (now - value.startedAt >= 60000) windows.delete(key);
    }
  }
  return true;
}

class TrainingContributionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeTrainingContribution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingContributionError(400, "A completed hand record is required.");
  }
  if (typeof value.consultationId !== "string" ||
      value.consultationId.length < 1 ||
      value.consultationId.length > 100) {
    throw new TrainingContributionError(400, "The hand record identifier is invalid.");
  }
  if (!Array.isArray(value.cards) || value.cards.length < 2 || value.cards.length > 12) {
    throw new TrainingContributionError(400, "The hand must contain 2 to 12 player cards.");
  }

  let cards;
  let dealer;
  try {
    cards = value.cards.map((rank) => parseRank(rank).rank).sort();
    dealer = parseRank(value.dealer).rank;
  } catch (error) {
    throw new TrainingContributionError(400, error instanceof Error ? error.message : "The card input is invalid.");
  }

  if (typeof value.doubleAllowed !== "boolean" ||
      typeof value.splitAllowed !== "boolean" ||
      !validDasRules.has(value.dasRule) ||
      typeof value.afterSplit !== "boolean") {
    throw new TrainingContributionError(400, "The table-rule settings are invalid.");
  }
  if (!validActions.has(value.playerAction) || !validActions.has(value.recommendedAction) ||
      value.alternativeAction !== null && !validActions.has(value.alternativeAction)) {
    throw new TrainingContributionError(400, "The recorded and recommended actions are invalid.");
  }
  if (!validOutcomes.has(value.result)) {
    throw new TrainingContributionError(400, "The hand must have a win, loss, or push outcome.");
  }

  const scenario = {
    cards,
    dealer,
    doubleAllowed: value.doubleAllowed,
    splitAllowed: value.splitAllowed,
    dasRule: value.dasRule,
    afterSplit: value.afterSplit,
    recommendedAction: value.recommendedAction,
    alternativeAction: value.alternativeAction,
    playerAction: value.playerAction
  };
  const context = {...scenario};
  delete context.playerAction;
  const contextId = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  const scenarioId = createHash("sha256").update(JSON.stringify(scenario)).digest("hex");
  return {
    consultationId: value.consultationId,
    contextId,
    scenario,
    scenarioId,
    result: value.result
  };
}

function createFirebaseTrainingStore(options) {
  const {auth, firestore, fieldValue, receiptSecret} = options || {};
  if (!auth || typeof auth.verifyIdToken !== "function" ||
      !firestore || typeof firestore.collection !== "function" ||
      !fieldValue || typeof fieldValue.increment !== "function" ||
      typeof fieldValue.serverTimestamp !== "function" ||
      typeof receiptSecret !== "string" || receiptSecret.length < 32) {
    throw new Error("Firebase training storage requires Admin Auth, Firestore, and a private receipt key.");
  }
  const rateWindows = new Map();

  return {
    async submit(idToken, value) {
      if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 5000) {
        throw new TrainingContributionError(401, "A valid anonymous Firebase session is required.");
      }

      let decoded;
      try {
        decoded = await auth.verifyIdToken(idToken, true);
      } catch {
        throw new TrainingContributionError(401, "The anonymous Firebase session is invalid or expired.");
      }
      if (!decoded || typeof decoded.uid !== "string" ||
          !decoded.firebase || decoded.firebase.sign_in_provider !== "anonymous") {
        throw new TrainingContributionError(401, "Use the anonymous training session; Google identity is not accepted.");
      }
      const rateKey = createHmac("sha256", receiptSecret).update("rate\0" + decoded.uid).digest("hex");
      if (!takeContributionRateLimit(rateWindows, rateKey)) {
        throw new TrainingContributionError(429, "The anonymous session reached its shared-training limit. Try again later.");
      }

      const contribution = normalizeTrainingContribution(value);
      const receiptId = createHmac("sha256", receiptSecret)
        .update(decoded.uid + "\0" + contribution.consultationId)
        .digest("hex");
      const receipt = firestore.collection("trainingReceipts").doc(receiptId);
      const aggregate = firestore.collection("trainingAggregates").doc(contribution.scenarioId);

      return firestore.runTransaction(async (transaction) => {
        const receiptSnapshot = await transaction.get(receipt);
        if (receiptSnapshot.exists) return {duplicate: true};

        const update = {
          schemaVersion: 1,
          contextId: contribution.contextId,
          scenario: contribution.scenario,
          sampleCount: fieldValue.increment(1),
          updatedAt: fieldValue.serverTimestamp()
        };
        update[contribution.result + "Count"] = fieldValue.increment(1);
        transaction.create(receipt, {createdAt: fieldValue.serverTimestamp()});
        transaction.set(aggregate, update, {merge: true});
        return {duplicate: false};
      });
    }
  };
}

module.exports = {
  TrainingContributionError,
  createFirebaseTrainingStore,
  normalizeTrainingContribution
};
