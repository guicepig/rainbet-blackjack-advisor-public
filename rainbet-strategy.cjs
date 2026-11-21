"use strict";

const dasRuleValues = ["unknown", "allowed", "not-allowed"];

function parseRank(input) {
  const rank = String(input).trim().toUpperCase();
  if (rank === "A") return {rank, value: 11};
  if (["J", "Q", "K"].includes(rank)) return {rank, value: 10};
  const value = Number(rank);
  if (Number.isInteger(value) && value >= 2 && value <= 10) return {rank, value};
  throw new Error("Use card ranks A, 2–10, J, Q, or K.");
}

function handTotal(cards) {
  let total = cards.reduce((sum, card) => sum + card.value, 0);
  let aces = cards.filter((card) => card.rank === "A").length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return {total, soft: aces > 0};
}

function pairAction(pairValue, dealer, dasAllowed) {
  if (pairValue === 11 || pairValue === 8) return "SPLIT";
  if (pairValue === 2 || pairValue === 3) {
    return (dealer >= 4 && dealer <= 7) || (dasAllowed && dealer >= 2 && dealer <= 3) ? "SPLIT" : null;
  }
  if (pairValue === 4) return dasAllowed && (dealer === 5 || dealer === 6) ? "SPLIT" : null;
  if (pairValue === 6) {
    return (dealer >= 3 && dealer <= 6) || (dasAllowed && dealer === 2) ? "SPLIT" : null;
  }
  if (pairValue === 7) return dealer >= 2 && dealer <= 7 ? "SPLIT" : null;
  if (pairValue === 9) return (dealer >= 2 && dealer <= 6) || dealer === 8 || dealer === 9 ? "SPLIT" : "STAND";
  return null;
}

function hardAction(total, dealer, canDouble) {
  if (total <= 8) return "HIT";
  if (total === 9) return canDouble && dealer >= 3 && dealer <= 6 ? "DOUBLE" : "HIT";
  if (total === 10) return canDouble && dealer >= 2 && dealer <= 9 ? "DOUBLE" : "HIT";
  if (total === 11) return canDouble && dealer >= 2 && dealer <= 10 ? "DOUBLE" : "HIT";
  if (total === 12) return dealer >= 4 && dealer <= 6 ? "STAND" : "HIT";
  if (total <= 16) return dealer >= 2 && dealer <= 6 ? "STAND" : "HIT";
  return "STAND";
}

function actionFor(cards, dealer, options) {
  const hand = handTotal(cards);
  const up = dealer.value === 11 ? 11 : dealer.value;
  const pair = cards.length === 2 && cards[0].rank === cards[1].rank;
  const pairValue = pair ? cards[0].value : 0;
  const canDouble = options.doubleAllowed && cards.length === 2;
  const canSplit = options.splitAllowed && pair;
  const dasRule = dasRuleValues.includes(options.dasRule)
    ? options.dasRule
    : typeof options.das === "boolean"
      ? options.das ? "allowed" : "not-allowed"
      : "unknown";
  let action;
  let explanation;

  if (pair && pairValue === 11 && !canSplit) {
    return {
      action: "HIT",
      alternativeAction: null,
      explanation: "When splitting aces is unavailable, this advisor uses hit as the fallback; special resplit-ace rules are not modeled.",
      hand
    };
  }

  if (canSplit && pairValue !== 5 && pairValue !== 10) {
    const fallback = hardAction(hand.total, up, canDouble);
    const noDasAction = pairAction(pairValue, up, false) || fallback;
    const dasAction = pairAction(pairValue, up, true) || fallback;
    action = dasRule === "allowed" ? dasAction : noDasAction;
    const alternativeAction = dasRule === "unknown" && noDasAction !== dasAction ? dasAction : null;
    if (action) {
      explanation = alternativeAction
        ? "Rainbet's published rules do not specify DAS. No-DAS baseline: " + action.toLowerCase() +
          "; if DAS is allowed: " + alternativeAction.toLowerCase() + "."
        : action === "SPLIT"
          ? "Basic strategy splits this pair against the dealer upcard."
          : action === "STAND"
            ? "Basic strategy stands on this pair against the dealer upcard."
            : "Basic strategy does not split this pair here; play it as a hand.";
      return {action, alternativeAction, explanation, hand};
    }
  }

  if (!hand.soft && hand.total === 11 && up === 11 && canDouble) {
    return {
      action: "HIT",
      alternativeAction: "DOUBLE",
      explanation: "The dealer's hole-card/peek rule is unpublished. Hit is the no-peek baseline; if the dealer checks for blackjack before player actions, double is the standard alternative.",
      hand
    };
  }

  if (hand.soft) {
    if (hand.total <= 17) {
      const doubleAt = hand.total <= 14 ? 5 : hand.total <= 16 ? 4 : 3;
      action = canDouble && up >= doubleAt && up <= 6 ? "DOUBLE" : "HIT";
    } else if (hand.total === 18) {
      action = canDouble && up >= 3 && up <= 6 ? "DOUBLE" : up >= 2 && up <= 8 ? "STAND" : "HIT";
    } else action = "STAND";
  } else {
    action = hardAction(hand.total, up, canDouble);
  }

  explanation = action === "DOUBLE"
    ? "Basic strategy doubles here when allowed; if the interface will not accept a double, use the fallback action shown in the note."
    : action === "STAND"
      ? "Basic strategy stands on this total against the dealer upcard."
      : "Basic strategy hits this hand against the dealer upcard.";
  if (action === "DOUBLE") {
    const fallback = hand.soft && hand.total >= 18 ? "STAND" : "HIT";
    explanation += " If doubling is unavailable, " + fallback.toLowerCase() + ".";
  }
  return {action, alternativeAction: null, explanation, hand};
}

function actionForSplitHand(cards, dealer, options) {
  if (cards.length > 0 && cards[0].rank === "A") {
    return {
      action: "STAND",
      alternativeAction: null,
      explanation: "Rainbet's split-ace rule: each split ace receives one card, then stands automatically; no further player action is available.",
      hand: handTotal(cards)
    };
  }

  const baselineOptions = {
    ...options,
    doubleAllowed: false,
    splitAllowed: false,
    afterSplit: true
  };
  const baseline = actionFor(cards, dealer, baselineOptions);
  if (options.dasRule === "allowed" && options.doubleAllowed) {
    return actionFor(cards, dealer, {...baselineOptions, doubleAllowed: true});
  }
  if (options.dasRule === "unknown" && options.doubleAllowed && cards.length === 2) {
    const withDas = actionFor(cards, dealer, {...baselineOptions, doubleAllowed: true});
    if (baseline.action !== withDas.action) {
      baseline.alternativeAction = withDas.action;
      baseline.explanation = "DAS for this split hand is unpublished. No-DAS baseline: " +
        baseline.action.toLowerCase() + "; if DAS is allowed: " + withDas.action.toLowerCase() + ".";
    }
  }
  return baseline;
}

function expectedValueActionAnalysis(cards, dealer, options) {
  if (dealer.value < 2 || dealer.value > 11 || options.afterSplit) return null;

  const rankProbabilities = [1 / 13, 1 / 13, 1 / 13, 1 / 13, 1 / 13, 1 / 13, 1 / 13, 1 / 13, 1 / 13, 4 / 13];
  const stateForCards = (hand) => hand.reduce((state, card) => ({
    hardTotal: state.hardTotal + (card.rank === "A" ? 1 : card.value),
    aces: state.aces + (card.rank === "A" ? 1 : 0)
  }), {hardTotal: 0, aces: 0});
  const bestTotal = (state) => state.hardTotal +
    (state.aces > 0 && state.hardTotal + 10 <= 21 ? 10 : 0);
  const addCard = (state, index) => ({
    hardTotal: state.hardTotal + (index === 0 ? 1 : index === 9 ? 10 : index + 1),
    aces: state.aces + (index === 0 ? 1 : 0)
  });
  const dealerMemo = new Map();
  const playerMemo = new Map();

  function dealerOutcomes(state) {
    const total = bestTotal(state);
    if (total > 21) return [1, 0, 0, 0, 0, 0];
    if (total >= 17) {
      const outcomes = [0, 0, 0, 0, 0, 0];
      outcomes[total - 16] = 1;
      return outcomes;
    }

    const key = state.hardTotal + "|" + state.aces;
    const cached = dealerMemo.get(key);
    if (cached) return cached;
    const outcomes = [0, 0, 0, 0, 0, 0];
    for (let index = 0; index < rankProbabilities.length; index++) {
      const next = dealerOutcomes(addCard(state, index));
      for (let outcome = 0; outcome < outcomes.length; outcome++) {
        outcomes[outcome] += rankProbabilities[index] * next[outcome];
      }
    }
    dealerMemo.set(key, outcomes);
    return outcomes;
  }

  const dealerStart = {
    hardTotal: dealer.rank === "A" ? 1 : dealer.value,
    aces: dealer.rank === "A" ? 1 : 0
  };
  const dealerNaturalIndex = dealer.rank === "A" ? 9 : dealer.value === 10 ? 0 : -1;
  const dealerNaturalProbability = dealerNaturalIndex < 0 ? 0 : rankProbabilities[dealerNaturalIndex];
  const dealerDistribution = dealerNaturalIndex < 0
    ? dealerOutcomes(dealerStart)
    : rankProbabilities.reduce((distribution, probability, index) => {
      if (index === dealerNaturalIndex) return distribution;
      const outcomes = dealerOutcomes(addCard(dealerStart, index));
      outcomes.forEach((value, outcome) => {
        distribution[outcome] += probability / (1 - dealerNaturalProbability) * value;
      });
      return distribution;
    }, [0, 0, 0, 0, 0, 0]);
  function standOutcomes(state) {
    const playerTotal = bestTotal(state);
    if (playerTotal > 21) return {win: 0, push: 0, loss: 1};
    let win = dealerDistribution[0];
    let push = 0;
    let loss = 0;
    for (let dealerTotal = 17; dealerTotal <= 21; dealerTotal++) {
      const probability = dealerDistribution[dealerTotal - 16];
      if (playerTotal > dealerTotal) win += probability;
      else if (playerTotal === dealerTotal) push += probability;
      else loss += probability;
    }
    return {win, push, loss};
  }

  function standValue(state, natural = false) {
    if (natural) return 1.5;
    const outcomes = standOutcomes(state);
    return outcomes.win - outcomes.loss;
  }

  function hitOutcomes(state, resolveOptimally) {
    const outcomes = {win: 0, push: 0, loss: 0};
    for (let index = 0; index < rankProbabilities.length; index++) {
      const probability = rankProbabilities[index];
      const nextState = addCard(state, index);
      const nextOutcomes = bestTotal(nextState) > 21
        ? {win: 0, push: 0, loss: 1}
        : resolveOptimally(nextState);
      for (const result of ["win", "push", "loss"]) {
        outcomes[result] += probability * nextOutcomes[result];
      }
    }
    return outcomes;
  }

  function optimalValue(state) {
    const total = bestTotal(state);
    if (total > 21) return -1;
    const key = state.hardTotal + "|" + state.aces;
    const cached = playerMemo.get(key);
    if (cached !== undefined) return cached;
    let hitValue = 0;
    for (let index = 0; index < rankProbabilities.length; index++) {
      hitValue += rankProbabilities[index] * optimalValue(addCard(state, index));
    }
    const value = Math.max(standValue(state), hitValue);
    playerMemo.set(key, value);
    return value;
  }

  function optimalOutcomes(state) {
    const total = bestTotal(state);
    if (total > 21) return {win: 0, push: 0, loss: 1};
    return standValue(state) >= optimalValue(state) - 1e-12
      ? standOutcomes(state)
      : hitOutcomes(state, optimalOutcomes);
  }

  function hitValue(state) {
    let value = 0;
    for (let index = 0; index < rankProbabilities.length; index++) {
      value += rankProbabilities[index] * optimalValue(addCard(state, index));
    }
    return value;
  }

  function doubleOutcomes(state) {
    const outcomes = {win: 0, push: 0, loss: 0};
    for (let index = 0; index < rankProbabilities.length; index++) {
      const probability = rankProbabilities[index];
      const nextState = addCard(state, index);
      const nextOutcomes = bestTotal(nextState) > 21
        ? {win: 0, push: 0, loss: 1}
        : standOutcomes(nextState);
      for (const result of ["win", "push", "loss"]) {
        outcomes[result] += probability * nextOutcomes[result];
      }
    }
    return outcomes;
  }

  function doubleValue(state) {
    let value = 0;
    for (let index = 0; index < rankProbabilities.length; index++) {
      const nextState = addCard(state, index);
      value += rankProbabilities[index] *
        (bestTotal(nextState) > 21 ? -2 : 2 * standValue(nextState));
    }
    return value;
  }

  function includeDealerNatural(outcomes, natural = false) {
    if (natural) {
      return {win: 1 - dealerNaturalProbability, push: dealerNaturalProbability, loss: 0};
    }
    return {
      win: outcomes.win * (1 - dealerNaturalProbability),
      push: outcomes.push * (1 - dealerNaturalProbability),
      loss: dealerNaturalProbability + outcomes.loss * (1 - dealerNaturalProbability)
    };
  }

  const state = stateForCards(cards);
  const total = bestTotal(state);
  const natural = cards.length === 2 && state.aces === 1 && state.hardTotal === 11;
  const standOutcomesForHand = natural
    ? {win: 1, push: 0, loss: 0}
    : standOutcomes(state);
  const values = {
    stand: natural
      ? standValue(state, true) * (1 - dealerNaturalProbability)
      : standValue(state) * (1 - dealerNaturalProbability) - dealerNaturalProbability
  };
  const outcomeProbabilities = {
    stand: includeDealerNatural(standOutcomesForHand, natural)
  };
  if (!natural && total < 21) {
    const hitOutcomesForHand = hitOutcomes(state, optimalOutcomes);
    values.hit = hitValue(state) * (1 - dealerNaturalProbability) - dealerNaturalProbability;
    outcomeProbabilities.hit = includeDealerNatural(hitOutcomesForHand);
    if (options.doubleAllowed && cards.length === 2) {
      values.double = doubleValue(state) * (1 - dealerNaturalProbability) - dealerNaturalProbability;
      outcomeProbabilities.double = includeDealerNatural(doubleOutcomes(state));
    }
  }

  let splitOutcomeProbabilities = null;
  const pair = cards.length === 2 && cards[0].rank === cards[1].rank;
  if (pair && options.splitAllowed && !options.afterSplit && dealerNaturalProbability === 0) {
    const splitHandState = stateForCards([cards[0]]);
    const canDoubleAfterSplit = options.doubleAllowed && options.dasRule === "allowed";
    splitOutcomeProbabilities = {win: 0, push: 0, loss: 0};
    for (let index = 0; index < rankProbabilities.length; index++) {
      const firstDrawState = addCard(splitHandState, index);
      let handOutcomes;
      if (cards[0].rank === "A" || bestTotal(firstDrawState) >= 21) {
        handOutcomes = standOutcomes(firstDrawState);
      } else {
        const standValueForHand = standValue(firstDrawState);
        const hitValueForHand = hitValue(firstDrawState);
        handOutcomes = standValueForHand >= hitValueForHand
          ? standOutcomes(firstDrawState)
          : hitOutcomes(firstDrawState, optimalOutcomes);
        if (canDoubleAfterSplit) {
          const doubleValueForHand = doubleValue(firstDrawState);
          if (doubleValueForHand > Math.max(standValueForHand, hitValueForHand)) {
            handOutcomes = doubleOutcomes(firstDrawState);
          }
        }
      }
      for (const result of ["win", "push", "loss"]) {
        splitOutcomeProbabilities[result] += rankProbabilities[index] * handOutcomes[result];
      }
    }
  }

  const bestAction = Object.entries(values).reduce((best, entry) =>
    entry[1] > best.value ? {action: entry[0].toUpperCase(), value: entry[1]} : best,
  {action: "STAND", value: values.stand}).action;
  return {
    bestAction,
    values,
    outcomeProbabilities,
    ...(dealerNaturalProbability > 0 ? {dealerNaturalProbability} : {}),
    ...(splitOutcomeProbabilities ? {splitOutcomeProbabilities} : {}),
    shoe: "8-deck S17 rank probabilities (replacement approximation)",
    unit: "initial wager",
    ...(dealerNaturalProbability > 0
      ? {assumption: "Dealer checks for blackjack before player actions; W/P/L includes dealer natural."}
      : {})
  };
}

function decisionFactorSummary(cards, dealer, options) {
  const hand = handTotal(cards);
  const pair = cards.length === 2 && cards[0].rank === cards[1].rank;
  const dasRule = dasRuleValues.includes(options.dasRule)
    ? options.dasRule
    : typeof options.das === "boolean"
      ? options.das ? "allowed" : "not-allowed"
      : "unknown";
  const doubleStatus = !options.doubleAllowed
    ? "double disabled"
    : cards.length !== 2
      ? "double unavailable after a draw"
      : options.afterSplit && dasRule === "unknown"
        ? "double conditional on DAS"
        : options.afterSplit && dasRule !== "allowed"
          ? "double unavailable under the no-DAS baseline"
          : "double available";
  const splitStatus = options.afterSplit
    ? "after-split hand; resplitting unavailable"
    : !pair
      ? "not a pair"
      : options.splitAllowed
        ? "split allowed"
        : "split disabled";
  const factors = [
    "published 8-deck, stand-on-soft-17 baseline",
    (hand.soft ? "soft" : "hard") + " total " + hand.total,
    cards.length + (cards.length === 1 ? " player card" : " player cards"),
    "dealer upcard " + dealer.rank,
    pair ? "pair " + cards[0].rank : "",
    doubleStatus,
    splitStatus
  ].filter(Boolean);
  if (pair || options.afterSplit) factors.push("DAS " + dasRule);
  if (!hand.soft && hand.total === 11 && dealer.rank === "A" &&
      options.doubleAllowed && cards.length === 2) {
    factors.push("dealer hole-card/peek rule unpublished");
  }
  return factors.join("; ");
}

function actionForContext(cards, dealer, options) {
  const result = options.afterSplit
    ? actionForSplitHand(cards, dealer, options)
    : actionFor(cards, dealer, options);
  const analysis = expectedValueActionAnalysis(cards, dealer, options);
  if (analysis) {
    if (dealer.value > 9 || result.action === "SPLIT" || result.alternativeAction === "SPLIT") {
      result.comparisonAnalysis = analysis;
    } else {
      const chartAction = result.action;
      result.action = analysis.bestAction;
      result.analysis = analysis;
      result.explanation =       "An 8-deck S17 expected-value comparison recommends " +
        result.action.toLowerCase() + ". Expected net values per initial wager: " +
        Object.entries(analysis.values)
          .map(([action, value]) => action + " " + (value >= 0 ? "+" : "") + value.toFixed(4))
          .join(", ") +
        (chartAction !== result.action ? "; EV result differs from the basic-strategy baseline (" + chartAction.toLowerCase() + ")" : "") +
        ".";
    }
  }
  result.explanation += " Factors considered: " + decisionFactorSummary(cards, dealer, options) + ".";
  return result;
}

module.exports = {actionFor, actionForContext, expectedValueActionAnalysis, handTotal, parseRank};
