const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {createServer: createGeminiServer, extractAnswer} = require("./rainbet-gemini-server.cjs");
const {actionFor, actionForContext, expectedValueActionAnalysis} = require("./rainbet-strategy.cjs");

const html = fs.readFileSync(path.join(__dirname, "rainbet-original-blackjack-advisor.html"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "rainbet-gemini-server.cjs"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const mainScript = scripts[0] && scripts[0][1];
const simulatorScript = scripts[1] && scripts[1][1];
assert.ok(mainScript, "main advisor script should exist");
assert.ok(simulatorScript, "simulator script should exist");

const analyticsPredicateStart = mainScript.indexOf("      function isAnalyticsOrigin(");
const analyticsPredicateEnd = mainScript.indexOf("      function trackHistoryAccountCreated(", analyticsPredicateStart);
assert.ok(analyticsPredicateStart >= 0 && analyticsPredicateEnd > analyticsPredicateStart, "analytics consent guard should be present");
const {isAnalyticsOrigin, shouldLoadAnalytics} = new Function(
  mainScript.slice(analyticsPredicateStart, analyticsPredicateEnd) +
  "return {isAnalyticsOrigin, shouldLoadAnalytics};"
)();

test("analytics requires explicit consent and an exact HTTPS domain match", () => {
  assert.equal(shouldLoadAnalytics("accepted", "advisor.example", "https:", "advisor.example"), true);
  assert.equal(shouldLoadAnalytics("rejected", "advisor.example", "https:", "advisor.example"), false);
  assert.equal(shouldLoadAnalytics(null, "advisor.example", "https:", "advisor.example"), false);
  assert.equal(shouldLoadAnalytics("accepted", "", "https:", "advisor.example"), false);
  assert.equal(shouldLoadAnalytics("accepted", "advisor.example", "http:", "advisor.example"), false);
  assert.equal(shouldLoadAnalytics("accepted", "advisor.example", "https:", "localhost"), false);
  assert.equal(isAnalyticsOrigin(" Advisor.Example ", "https:", "advisor.example"), true);
});

test("history-account analytics sends only an approved event after consent", () => {
  const eventStart = mainScript.indexOf("      function trackHistoryAccountCreated(");
  const eventEnd = mainScript.indexOf("      function initializePoliciesAndAnalytics(", eventStart);
  const trackHistoryAccountCreated = new Function(
    "window",
    "analyticsPreferenceKey",
    "analyticsSiteDomain",
    mainScript.slice(analyticsPredicateStart, eventEnd) + "return trackHistoryAccountCreated;"
  );
  const events = [];
  let consent = "rejected";
  const recordEvent = trackHistoryAccountCreated({
    localStorage: {getItem() { return consent; }},
    location: {protocol: "https:", hostname: "advisor.example"},
    plausible(...args) { events.push(args); }
  }, "analytics-consent", "advisor.example");

  recordEvent();
  consent = "accepted";
  recordEvent();
  assert.deepEqual(events, [["History Account Created"]]);
});

test("public policy disclosures cover local data, optional providers, and current lack of payments", () => {
  assert.match(html, /id="privacyPolicyDialog"/);
  assert.match(html, /id="usagePolicyDialog"/);
  assert.match(html, /guicepig@gmail\.com/);
  assert.match(html, /cards, moves, outcomes, and wager amounts/);
  assert.match(html, /card ranks you enter, dealer upcard, and selected rule toggles are sent to the operator's server/);
  assert.match(html, /offline by default/);
  assert.match(html, /does not connect to Rainbet/);
  assert.match(html, /fictional credits only/);
  assert.match(html, /requires 12 resolved outcomes recorded in fictional-credit mode/);
  assert.match(html, /Never use these amounts or progressions for real-money wagers/);
  assert.match(html, /No paid membership or payment feature is currently offered/);
  assert.match(html, /aria-label="Optional analytics preferences"/);
  assert.match(html, /Version française/);
  assert.match(serverSource, /script-src[^"]*https:\/\/plausible\.io/);
  assert.match(serverSource, /connect-src[^"]*https:\/\/plausible\.io/);
});

test("public page omits the strategy implementation and detailed action tables", () => {
  assert.doesNotMatch(mainScript, /\bfunction (?:actionFor|actionForContext|actionForSplitHand|hardAction|pairAction)\s*\(/);
  assert.doesNotMatch(html, /<td>8 or less<\/td>/);
  assert.doesNotMatch(html, /Soft 13–14/);
  assert.match(html, /exact decision implementation runs on the advisor server/i);
});

test("advisor starts empty and offers a clearly labeled example hand", () => {
  assert.match(html, /id="playerCards" type="hidden" value=""/);
  assert.match(html, /id="dealer" type="hidden" value=""/);
  assert.match(html, /id="loadExampleHand">Try example hand<\/button>/);
  assert.match(html, /id="advisorCardInstruction" aria-live="polite"/);
  assert.match(html, /id="advisorStatus" aria-live="polite"/);
  assert.match(html, /id="advisorSplitPresentation" hidden/);
  assert.match(html, /id="splitHand2Cards" type="hidden"/);
  assert.match(html, /id="advisorSplitHandOneCards"[\s\S]*id="advisorSplitHandTwoCards"/);
  assert.match(html, /data-advisor-target="split2"/);
  assert.match(html, /@keyframes advisor-split-card-left/);
  assert.match(html, /@keyframes advisor-split-card-right/);
  assert.doesNotMatch(html, /\.advisor-live-advice\s*\{[^}]*position:\s*sticky/);
  assert.match(html, /\.advisor-live-advice\s*\{\s*position: static;/);
});

test("advisor connection errors explain local-server and file-page requirements", () => {
  assert.match(advisorRequestErrorMessage(new TypeError("Failed to fetch"), "http:"), /npm start/);
  assert.match(advisorRequestErrorMessage(new TypeError("Failed to fetch"), "file:"), /opened as a local file/);
  assert.equal(advisorRequestErrorMessage(new Error("Server returned HTTP 503."), "http:"), "Server returned HTTP 503.");
});

const featureFunctionStart = mainScript.indexOf("      function setActiveFeature(");
const featureFunctionEnd = mainScript.indexOf("      const featureButtons", featureFunctionStart);
assert.ok(featureFunctionStart >= 0 && featureFunctionEnd > featureFunctionStart, "feature navigation helper should be present");
const setActiveFeature = new Function(
  mainScript.slice(featureFunctionStart, featureFunctionEnd) + "return setActiveFeature;"
)();
const liveInputBinderStart = mainScript.indexOf("      function bindLiveAdvisorInputs() {");
const liveInputBinderEnd = mainScript.indexOf("      const featureButtons", liveInputBinderStart);
assert.ok(liveInputBinderStart >= 0 && liveInputBinderEnd > liveInputBinderStart, "live advisor input binder should be present");
const helperReplyStart = mainScript.indexOf("      function helperReply(question, currentHand) {");
const appendHelperStart = mainScript.indexOf("      function appendHelperMessage(", helperReplyStart);
assert.ok(helperReplyStart >= 0 && appendHelperStart > helperReplyStart, "offline helper reply function should be present");
const helperReply = new Function(
  mainScript.slice(helperReplyStart, appendHelperStart) + "return helperReply;"
)();
const helperToggleStart = mainScript.indexOf("      function setHelperChatOpen(");
assert.ok(helperToggleStart >= 0 && helperToggleStart < helperReplyStart, "floating helper controls should be present");
const setHelperChatOpen = new Function(
  mainScript.slice(helperToggleStart, helperReplyStart) + "return setHelperChatOpen;"
)();
const geminiSendStart = mainScript.indexOf("      async function sendGeminiHelperMessage() {");
const clearHelperStart = mainScript.indexOf("      function clearHelperConversation() {", geminiSendStart);
assert.ok(geminiSendStart >= 0 && clearHelperStart > geminiSendStart, "hosted helper sender should be present");
const sendGeminiHelperMessage = new Function(
  "byId",
  "appendHelperMessage",
  "fetch",
  mainScript.slice(geminiSendStart, clearHelperStart) + "return sendGeminiHelperMessage;"
);

const strategyStart = mainScript.indexOf("      function handTotal(cards) {");
const strategyEnd = mainScript.indexOf("      async function decide(recordConsultation) {", strategyStart);
assert.ok(strategyStart >= 0 && strategyEnd > strategyStart, "strategy functions should be present");

function parseRank(input) {
  const rank = String(input).trim().toUpperCase();
  if (rank === "A") return {rank, value: 11};
  if (["J", "Q", "K"].includes(rank)) return {rank, value: 10};
  const value = Number(rank);
  if (Number.isInteger(value) && value >= 2 && value <= 10) return {rank, value};
  throw new Error("Use card ranks A, 2–10, J, Q, or K.");
}

let learningStorageValue = null;
const learningStorage = {
  getItem(key) {
    assert.equal(key, "test-learning-progress");
    return learningStorageValue;
  }
};
const strategy = new Function(
  "dasRuleValues",
  "parseRank",
  "learningKey",
  "learningRecordLimit",
  "masteryStreak",
  "localStorage",
  "practiceReviewIntervalsDays",
  "practiceRetryDelayMinutes",
  mainScript.slice(strategyStart, strategyEnd) + "return { handTotal, getAdvisorInputPrompt, calculateExposure, progressionUnits, replayProgression, chooseProgression, fictionalProgressionHistory, calculateSuggestedWager, classifyHistoryDecision, summarizeDecisionPatterns, historyPracticeScenarios, practiceAnswerKind, practiceScenarioKey, readLearningProgress, updateLearningProgress, practiceReviewScenarios };"
)(["unknown", "allowed", "not-allowed"], parseRank, "test-learning-progress", 250, 3, learningStorage, [1, 3, 7, 14], 10);
const {
  handTotal,
  getAdvisorInputPrompt,
  calculateExposure,
  progressionUnits,
  replayProgression,
  chooseProgression,
  fictionalProgressionHistory,
  calculateSuggestedWager,
  classifyHistoryDecision,
  summarizeDecisionPatterns,
  historyPracticeScenarios,
  practiceAnswerKind,
  practiceScenarioKey,
  readLearningProgress,
  updateLearningProgress,
  practiceReviewScenarios
} = strategy;

test("advisor asks for missing table cards before parsing or requesting advice", () => {
  assert.equal(
    getAdvisorInputPrompt("", ""),
    "Add the dealer upcard and two starting-hand cards to get advice."
  );
  assert.equal(
    getAdvisorInputPrompt("10", ""),
    "Add the dealer upcard and one more starting-hand card to get advice."
  );
  assert.equal(
    getAdvisorInputPrompt("10, 6", ""),
    "Add the dealer upcard to get advice."
  );
  assert.equal(getAdvisorInputPrompt("10, 6", "9"), "");
});

test("feature navigation shows one feature and keeps grouped advisor panels together", () => {
  const buttons = ["advisor", "simulator", "strategy", "practice"].map((feature) => ({
    dataset: {featureTarget: feature},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  }));
  const panels = ["advisor", "advisor", "simulator", "strategy", "practice"].map((feature) => ({
    dataset: {featurePanel: feature},
    hidden: true
  }));

  setActiveFeature("practice", buttons, panels);
  assert.deepEqual(buttons.map((button) => button.attributes["aria-pressed"]), ["false", "false", "false", "true"]);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, true, true, true, false]);

  setActiveFeature("advisor", buttons, panels);
  assert.deepEqual(panels.map((panel) => panel.hidden), [false, false, true, true, true]);
  assert.throws(() => setActiveFeature("unknown", buttons, panels), /Unknown advisor feature/);
});

test("floating helper opens accessibly, focuses its input, and closes cleanly", () => {
  const dock = {hidden: true};
  const attributes = {};
  const launcher = {setAttribute(name, value) { attributes[name] = value; }};
  let focusCalls = 0;
  const input = {focus() { focusCalls++; }};

  setHelperChatOpen(true, dock, launcher, input);
  assert.equal(dock.hidden, false);
  assert.equal(attributes["aria-expanded"], "true");
  assert.equal(attributes["aria-label"], "Close AI helper chat");
  assert.equal(focusCalls, 1);

  setHelperChatOpen(false, dock, launcher, input);
  assert.equal(dock.hidden, true);
  assert.equal(attributes["aria-expanded"], "false");
  assert.equal(attributes["aria-label"], "Open AI helper chat");
  assert.equal(focusCalls, 1);
});

test("live advisor input debounces private-server requests", () => {
  const fields = Object.fromEntries(
    ["playerCards", "hitCards", "splitHandCards", "splitHand2Cards", "dealer", "doubleAllowed", "splitAllowed"].map((id) => [id, {listeners: {}}])
  );
  Object.values(fields).forEach((field) => {
    field.addEventListener = (eventName, listener) => { field.listeners[eventName] = listener; };
  });
  const calls = [];
  const timers = new Map();
  let nextTimerId = 0;
  const window = {
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback, delay) {
      assert.equal(delay, 180);
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    }
  };
  const bindLiveAdvisorInputs = new Function(
    "byId",
    "window",
    "decide",
    mainScript.slice(liveInputBinderStart, liveInputBinderEnd) + "return bindLiveAdvisorInputs;"
  )((id) => fields[id], window, (...args) => calls.push(args));

  bindLiveAdvisorInputs();
  fields.playerCards.listeners.input();
  fields.hitCards.listeners.input();
  fields.splitHandCards.listeners.input();
  fields.splitHand2Cards.listeners.input();
  fields.dealer.listeners.change();
  fields.doubleAllowed.listeners.change();
  fields.splitAllowed.listeners.change();
  assert.equal(calls.length, 0);
  assert.equal(timers.size, 1);
  Array.from(timers.values())[0]();
  assert.deepEqual(calls, [[]]);
});

test("visual card picker adds and removes selected cards in the advice input state", () => {
  function fakeElement(value = "") {
    const listeners = {};
    const classes = new Set();
    const element = {
      value,
      className: "",
      dataset: {},
      attributes: {},
      children: [],
      classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name) || element.className.split(/\s+/).includes(name); }
      },
      addEventListener(name, listener) { listeners[name] = listener; },
      setAttribute(name, attributeValue) { this.attributes[name] = attributeValue; },
      appendChild(child) {
        if (child.parentNode) {
          const previousIndex = child.parentNode.children.indexOf(child);
          if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
        }
        child.parentNode = this;
        this.children.push(child);
      },
      click() {
        if (this.disabled) return;
        assert.equal(typeof listeners.click, "function", "element should have a click handler");
        listeners.click();
      }
    };
    let textContent = "";
    Object.defineProperty(element, "textContent", {
      get() { return textContent; },
      set(value) {
        textContent = value;
        if (value === "") {
          element.children.forEach((child) => { child.parentNode = null; });
          element.children = [];
        }
      }
    });
    return element;
  }

  const elements = {
    dealer: fakeElement("10"),
    playerCards: fakeElement("10, 6"),
    hitCards: fakeElement(""),
    splitHandCards: fakeElement(""),
    splitHand2Cards: fakeElement(""),
    advisorCardTarget: fakeElement("hit"),
    advisorCardInstruction: fakeElement(),
    advisorCardRank: fakeElement("4"),
    addAdvisorCard: fakeElement(),
    loadExampleHand: fakeElement(),
    clearAdvisorCards: fakeElement(),
    advisorCardStatus: fakeElement(),
    advisorDealerCards: fakeElement(),
    advisorPlayerCards: fakeElement(),
    advisorHitCards: fakeElement(),
    advisorSplitCards: fakeElement(),
    advisorPlayerZone: fakeElement(),
    advisorPlayerZones: fakeElement(),
    advisorHitZone: fakeElement(),
    advisorSplitZone: fakeElement(),
    advisorSplitPresentation: fakeElement(),
    advisorSplitHandOne: fakeElement(),
    advisorSplitHandTwo: fakeElement(),
    advisorSplitHandOneStatus: fakeElement(),
    advisorSplitHandTwoStatus: fakeElement(),
    advisorSplitHandOneCards: fakeElement(),
    advisorSplitHandTwoCards: fakeElement(),
    advisorSplit2Cards: fakeElement(),
    advisorSplitLockNotice: fakeElement(),
    followupSplitOption: fakeElement(),
    followupSplitButton: fakeElement(),
    moveFollowupAction: fakeElement(),
    moveFollowup: fakeElement(),
    advisorTable: fakeElement()
  };
  const suitButtons = ["diamonds", "hearts", "spades", "clubs"].map((suit) => {
    const button = fakeElement();
    button.dataset.advisorSuit = suit;
    return button;
  });
  const targetButtons = ["dealer", "player", "hit", "split", "split2"].map((target) => {
    const button = fakeElement();
    button.dataset.advisorTarget = target;
    return button;
  });
  const document = {
    createElement() { return fakeElement(); },
    querySelectorAll(selector) {
      if (selector === "[data-advisor-suit]") return suitButtons;
      if (selector === "[data-advisor-target]") return targetButtons;
      if (selector === '[data-advisor-target="split"], [data-advisor-target="split2"]') {
        return targetButtons.filter((button) => button.dataset.advisorTarget === "split" || button.dataset.advisorTarget === "split2");
      }
      throw new Error("Unexpected selector: " + selector);
    }
  };
  const pickerStart = mainScript.indexOf("      const advisorCardSuits =");
  const pickerEnd = mainScript.indexOf("      let selectedFollowupSuit", pickerStart);
  assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, "visual card picker should be present");
  let previewUpdates = 0;
  const picker = new Function(
    "byId",
    "document",
    "parseRank",
    "handTotal",
    "decide",
    "window",
    mainScript.slice(pickerStart, pickerEnd) + "return {bindAdvisorCardPicker, setSplitVisualActive, setSplitInputAvailability};"
  )((id) => elements[id], document, parseRank, handTotal, () => { previewUpdates++; }, {setTimeout() {}});

  picker.bindAdvisorCardPicker();
  assert.equal(elements.advisorPlayerCards.children.length, 2);
  targetButtons[0].click();
  assert.equal(elements.addAdvisorCard.textContent, "Set dealer upcard");
  assert.match(elements.advisorCardInstruction.textContent, /Selected area: dealer upcard/);
  targetButtons[2].click();
  assert.equal(elements.advisorCardTarget.value, "hit");
  assert.equal(targetButtons[2].attributes["aria-pressed"], "true");
  suitButtons[1].click();
  elements.addAdvisorCard.click();
  assert.equal(elements.hitCards.value, "4");
  assert.equal(elements.advisorHitCards.children.length, 1);
  assert.equal(previewUpdates, 1);

  elements.advisorHitCards.children[0].children[1].click();
  assert.equal(elements.hitCards.value, "");
  assert.equal(elements.advisorHitCards.children[0].className, "advisor-empty-card");
  assert.equal(previewUpdates, 2);

  elements.loadExampleHand.click();
  assert.equal(elements.dealer.value, "10");
  assert.equal(elements.playerCards.value, "10, 6");
  assert.equal(elements.advisorDealerCards.children.length, 1);
  assert.equal(elements.advisorPlayerCards.children.length, 2);
  assert.deepEqual(
    elements.advisorPlayerCards.children.map((item) =>
      item.children[0].children.map((part) => part.textContent)
    ),
    [["10", "♥"], ["6", "♠"]]
  );
  assert.match(elements.advisorCardStatus.textContent, /Loaded an example hand/);
  assert.equal(elements.advisorCardTarget.value, "player");
  assert.equal(elements.addAdvisorCard.textContent, "Add card to your starting hand");
  assert.match(elements.advisorCardInstruction.textContent, /Selected area: your starting hand/);
  assert.equal(previewUpdates, 3);

  picker.setSplitInputAvailability(true);
  targetButtons[4].click();
  assert.equal(elements.advisorCardTarget.value, "player", "split hand targets stay locked until the split is active");
  picker.setSplitVisualActive(true);
  assert.equal(elements.advisorSplitPresentation.hidden, false);
  assert.equal(elements.advisorPlayerZone.hidden, true);
  assert.equal(elements.advisorHitZone.hidden, true);
  assert.equal(elements.advisorSplitHandOneCards.children[0].classList.contains("split-card-left"), true);
  assert.equal(elements.advisorSplitHandTwoCards.children[0].classList.contains("split-card-right"), true);
  targetButtons[3].click();
  elements.addAdvisorCard.click();
  assert.equal(elements.splitHandCards.value, "4");
  assert.equal(elements.splitHand2Cards.value, "");
  assert.equal(elements.advisorSplitHandOneCards.children.length, 2);
  assert.deepEqual(
    elements.advisorSplitHandOneCards.children.map((item) => item.children[0].children.map((part) => part.textContent)),
    [["10", "♥"], ["4", "♥"]]
  );
  targetButtons[4].click();
  assert.equal(elements.advisorCardTarget.value, "split", "only the active hand can receive cards");

  picker.setSplitVisualActive(false);
  assert.equal(elements.advisorSplitPresentation.hidden, true);
  assert.equal(elements.advisorPlayerZone.hidden, false);
  assert.equal(elements.advisorHitZone.hidden, false);
});

test("move follow-up records a hit card and shows the updated next action", async () => {
  const elements = {
    moveFollowupRank: {value: "5"},
    moveFollowupResponse: {
      textContent: "",
      offsetWidth: 100,
      classList: {remove() {}, add() {}}
    },
    action: {textContent: "HIT"},
    reason: {textContent: ""},
    moveActionPanel: {hidden: false},
    moveActionButtons: {hidden: false},
    moveFollowup: {hidden: false},
    moveFollowupAction: {value: "HIT"},
    hitCards: {value: ""},
    splitHandCards: {value: ""},
    splitHand2Cards: {value: ""},
    advisorCardTarget: {value: "player"}
  };
  const advisorCardSuits = [
    {id: "diamonds", name: "Diamonds"},
    {id: "hearts", name: "Hearts"},
    {id: "spades", name: "Spades"},
    {id: "clubs", name: "Clubs"}
  ];
  const advisorCardState = {player: [], dealer: [], hit: [], split: [], split2: []};
  let previewUpdates = 0;
  const applyMoveFollowup = new Function(
    "byId",
    "parseRank",
    "handTotal",
    "advisorCardSuits",
    "advisorCardState",
    "splitInputWasAvailable",
    "selectedFollowupSuit",
    "syncAdvisorCardValues",
    "renderAdvisorCardPicker",
    "document",
    "decide",
    "dealerTurnActive",
    "addDealerTurnCard",
    "beginDealerTurn",
    "splitVisualActive",
    "splitInitialDealStep",
    "activeSplitHand",
    "splitHandFinished",
    "markSplitHandFinished",
    "advanceSplitHand",
    mainScript.slice(
      mainScript.indexOf("      async function applyMoveFollowup() {"),
      mainScript.indexOf("      function bindMoveFollowup()", mainScript.indexOf("      async function applyMoveFollowup() {"))
    ) + "return applyMoveFollowup;"
  )(
    (id) => elements[id],
    parseRank,
    handTotal,
    advisorCardSuits,
    advisorCardState,
    false,
    "hearts",
    () => { elements.hitCards.value = advisorCardState.hit.map((card) => card.rank).join(", "); },
    () => {},
    {querySelectorAll() { return []; }},
    () => {
      previewUpdates++;
      elements.action.textContent = "STAND";
    },
    false,
    () => {},
    () => {},
    false,
    0,
    1,
    [false, false],
    () => {},
    async () => {}
  );

  await applyMoveFollowup();
  assert.deepEqual(advisorCardState.hit, [{rank: "5", suit: "hearts"}]);
  assert.equal(elements.hitCards.value, "5");
  assert.match(elements.moveFollowupResponse.textContent, /Next basic-strategy advice: STAND/);
  assert.equal(elements.moveFollowup.hidden, true);
  assert.equal(previewUpdates, 1);
});

test("choosing a move records the first action in the current history entry", () => {
  const actionInput = {value: ""};
  const status = {textContent: ""};
  const entries = [{consultationId: "hand-1", playerAction: null}];
  const writes = [];
  const helperStart = mainScript.indexOf("      function recordFirstAction(action) {");
  const helperEnd = mainScript.indexOf("      async function advanceSplitHand(", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "first-action history helper should be present");
  const {recordFirstAction, setActiveConsultation} = new Function(
    "byId",
    "readHistory",
    "writeHistory",
    "refreshHistory",
    "let activeConsultationId = null;" +
      mainScript.slice(helperStart, helperEnd) +
      "return {recordFirstAction, setActiveConsultation(value) { activeConsultationId = value; }};"
  )(
    (id) => id === "playerAction" ? actionInput : status,
    () => entries,
    (value) => writes.push(value.map((entry) => ({...entry}))),
    () => {}
  );

  recordFirstAction("HIT");
  assert.equal(actionInput.value, "HIT");
  assert.equal(writes.length, 0, "an unsaved hand should not create a history record");
  setActiveConsultation("hand-1");
  recordFirstAction("HIT");
  recordFirstAction("STAND");
  assert.equal(entries[0].playerAction, "HIT");
  assert.equal(writes.length, 1, "only the first move is persisted");
});

test("standing starts required dealer entry and the hand cannot finish before the dealer stands", () => {
  let dealerTurnReason = "";
  const standFollowup = new Function(
    "byId",
    "dealerTurnActive",
    "addDealerTurnCard",
    "beginDealerTurn",
    "advisorCardState",
    "splitVisualActive",
    "splitInitialDealStep",
    "activeSplitHand",
    "splitHandFinished",
    "markSplitHandFinished",
    "advanceSplitHand",
    mainScript.slice(
      mainScript.indexOf("      async function applyMoveFollowup() {"),
      mainScript.indexOf("      function bindMoveFollowup()", mainScript.indexOf("      async function applyMoveFollowup() {"))
    ) + "return applyMoveFollowup;"
  )(
    (id) => id === "moveFollowupAction" ? {value: "STAND"} : null,
    false,
    () => {},
    (reason) => { dealerTurnReason = reason; },
    {split: [], split2: []},
    false,
    0,
    1,
    [false, false],
    () => {},
    async () => {}
  );
  standFollowup();
  assert.equal(dealerTurnReason, "You stood.");

  const finishStart = mainScript.indexOf("      function finishDealerTurn() {");
  const finishEnd = mainScript.indexOf("      async function applyMoveFollowup()", finishStart);
  const finishSource = mainScript.slice(finishStart, finishEnd) + "return finishDealerTurn;";
  const dealerTotalStart = mainScript.indexOf("      function handTotal(cards) {");
  const dealerTotalEnd = mainScript.indexOf("      function classifyHistoryDecision(", dealerTotalStart);
  const handTotal = new Function(
    "parseRank",
    mainScript.slice(dealerTotalStart, dealerTotalEnd) + "return handTotal;"
  )(parseRank);
  const elements = {
    action: {textContent: ""},
    reason: {textContent: ""},
    moveFollowupResponse: {
      textContent: "",
      offsetWidth: 100,
      classList: {remove() {}, add() {}}
    },
    moveFollowup: {hidden: false},
    moveActionPanel: {hidden: false},
    moveActionButtons: {hidden: true},
    advisorCardControls: {hidden: true}
  };
  const dealerTurnCards = [{rank: "6", suit: "clubs"}];
  const savedDealerCards = [];
  const finishDealerTurn = new Function(
    "dealerTurnActive",
    "advisorCardState",
    "dealerTurnCards",
    "handTotal",
    "parseRank",
    "byId",
    "activeConsultationId",
    "advisorCardSuits",
    "readHistory",
    "historyKey",
    "localStorage",
    "refreshHistory",
    "updateMoveFollowupControls",
    "persistActiveConsultationFinalCards",
    finishSource
  )(
    true,
    {dealer: [{rank: "10", suit: "hearts"}]},
    dealerTurnCards,
    handTotal,
    parseRank,
    (id) => elements[id],
    "consult-1",
    [
      {id: "hearts", name: "Hearts"},
      {id: "clubs", name: "Clubs"},
      {id: "spades", name: "Spades"}
    ],
    () => [],
    "test-history",
    {setItem() {}},
    () => {},
    () => {},
    (dealerRanks) => savedDealerCards.push(dealerRanks)
  );

  finishDealerTurn();
  assert.equal(savedDealerCards.length, 0);
  assert.equal(elements.action.textContent, "");

  dealerTurnCards.push({rank: "2", suit: "spades"});
  finishDealerTurn();
  assert.deepEqual(savedDealerCards, [["10", "6", "2"]]);
  assert.equal(elements.action.textContent, "HAND COMPLETE");
  assert.match(elements.reason.textContent, /stands on 18/);
  assert.equal(elements.moveFollowup.hidden, true);
});

test("reaching 21 after a hit automatically starts dealer entry", async () => {
  const elements = {
    moveFollowupAction: {value: "HIT"},
    moveFollowupRank: {value: "5"},
    moveFollowupResponse: {
      textContent: "",
      offsetWidth: 100,
      classList: {remove() {}, add() {}}
    },
    action: {textContent: "STAND"},
    reason: {textContent: ""},
    moveActionPanel: {hidden: false},
    moveActionButtons: {hidden: false},
    moveFollowup: {hidden: false},
    hitCards: {value: ""},
    splitHandCards: {value: ""}
  };
  const advisorCardState = {player: [{rank: "10"}, {rank: "6"}], dealer: [], hit: [], split: [], split2: []};
  let dealerTurnReason = "";
  const applyMoveFollowup = new Function(
    "byId",
    "parseRank",
    "handTotal",
    "advisorCardSuits",
    "advisorCardState",
    "splitInputWasAvailable",
    "selectedFollowupSuit",
    "syncAdvisorCardValues",
    "renderAdvisorCardPicker",
    "document",
    "decide",
    "dealerTurnActive",
    "addDealerTurnCard",
    "beginDealerTurn",
    "splitVisualActive",
    "splitInitialDealStep",
    "activeSplitHand",
    "splitHandFinished",
    "markSplitHandFinished",
    "advanceSplitHand",
    mainScript.slice(
      mainScript.indexOf("      async function applyMoveFollowup() {"),
      mainScript.indexOf("      function bindMoveFollowup()", mainScript.indexOf("      async function applyMoveFollowup() {"))
    ) + "return applyMoveFollowup;"
  )(
    (id) => elements[id],
    parseRank,
    handTotal,
    [{id: "hearts", name: "Hearts"}],
    advisorCardState,
    false,
    "hearts",
    () => { elements.hitCards.value = advisorCardState.hit.map((card) => card.rank).join(", "); },
    () => {},
    {querySelectorAll() { return []; }},
    () => ({hand: {total: 21}}),
    false,
    () => {},
    (reason) => { dealerTurnReason = reason; },
    false,
    0,
    1,
    [false, false],
    () => {},
    async () => {}
  );

  await applyMoveFollowup();
  assert.deepEqual(advisorCardState.hit, [{rank: "5", suit: "hearts"}]);
  assert.equal(dealerTurnReason, "Your hand reached 21.");
});

test("offline helper answers site topics and explains the current preview without predicting outcomes", () => {
  for (const greeting of ["hi", "Hi!", "hello", "hey there", "good morning"]) {
    assert.match(helperReply(greeting), /^Hi! I can help/);
  }
  assert.match(helperReply("What is DAS?"), /DAS means double after split/);
  assert.match(helperReply("How do I use the advisor?"), /click Add here/);
  assert.match(helperReply("How does the simulator work?"), /fictional credits/);
  assert.match(helperReply("How does practice learning work?"), /missed scenarios return sooner/);
  assert.match(helperReply("Are you as capable as you?"), /not a general-purpose generative AI/);
  assert.match(helperReply("How much should I wager?"), /fictional credits/);
  assert.match(helperReply("What is a soft hand?"), /ace currently counted as 11/);
  assert.match(helperReply("What does split mean?"), /separates a pair into two hands/);
  assert.match(helperReply("What does 3:2 mean?"), /1\.5 times the original wager/);
  assert.match(helperReply("Can I count cards?"), /does not count cards/);
  assert.match(helperReply("What factors does the advisor use?"), /8-deck S17 rank-probability model/);
  assert.match(helperReply("What factors does the advisor use?"), /does not track earlier hands/);
  assert.match(helperReply("I want the advisor to learn based on history of past bets"), /recorded decisions/);
  assert.match(helperReply("What is the house edge?"), /long-run expected loss/);
  assert.match(helperReply("Can I predict the next card?"), /cannot predict cards/);
  assert.match(helperReply("Does this connect to my account?"), /does not connect to your Rainbet account/);
  assert.match(helperReply("What is sent to Gemini and what about privacy?"), /plus fixed public Rainbet and app-reference notes/);
  assert.match(helperReply("Why did I lose?"), /action can follow basic strategy and still lose/);
  assert.match(helperReply("Why hit this hand?", {
    summary: "Hard 16 vs. dealer 10",
    action: "HIT",
    reason: "Basic strategy hits this hand against the dealer upcard.",
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown"
  }), /current preview is HIT for Hard 16 vs. dealer 10.*DAS is unpublished/s);
  assert.match(helperReply("Can you tell the next card?"), /cannot predict cards/);
});

test("hosted helper sends only the typed question and labels the returned model answer", async () => {
  const elements = {
    helperQuestion: {value: "  Explain the rules.  ", disabled: false},
    askOffline: {disabled: false},
    askGemini: {disabled: false},
    clearHelperChat: {disabled: false},
    helperRequestStatus: {
      textContent: "",
      classes: new Set(["error"]),
      classList: {
        remove(name) { this.owner.classes.delete(name); },
        add(name) { this.owner.classes.add(name); },
        owner: null
      }
    }
  };
  elements.helperRequestStatus.classList.owner = elements.helperRequestStatus;
  const appended = [];
  const requests = [];
  const send = sendGeminiHelperMessage(
    (id) => elements[id],
    (...args) => appended.push(args),
    async (url, options) => {
      requests.push({url, options});
      return {ok: true, json: async () => ({answer: "Use the published assumptions.", model: "gemini-4-carbon"})};
    }
  );

  await send();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/chat");
  assert.deepEqual(JSON.parse(requests[0].options.body), {message: "Explain the rules."});
  assert.deepEqual(appended, [
    ["user", "Explain the rules."],
    ["assistant", "Use the published assumptions.", "Gemini"]
  ]);
  assert.equal(elements.helperQuestion.value, "");
  assert.equal(elements.helperRequestStatus.textContent, "Answered with gemini-4-carbon. Google received your question and fixed reference notes, not account or saved-hand data.");
  assert.equal(elements.helperRequestStatus.classes.has("error"), false);
  assert.ok(["askOffline", "askGemini", "clearHelperChat"].every((id) => elements[id].disabled === false));
  assert.equal(elements.helperQuestion.disabled, false);
});

test("simulator animates each card only once and staggers newly dealt cards", () => {
  const createElement = () => ({
    classes: [],
    styles: {},
    classList: {
      add(value) { this.owner.classes.push(value); },
      owner: null
    },
    style: {
      setProperty(name, value) { this.owner.styles[name] = value; },
      owner: null
    }
  });
  const firstCard = {};
  const firstElement = createElement();
  firstElement.classList.owner = firstElement;
  firstElement.style.owner = firstElement;
  markCardEntrance(firstElement, firstCard);
  assert.deepEqual(firstElement.classes, ["card-enter"]);
  assert.equal(firstElement.styles["--deal-delay"], "0ms");

  const rerenderedElement = createElement();
  rerenderedElement.classList.owner = rerenderedElement;
  rerenderedElement.style.owner = rerenderedElement;
  markCardEntrance(rerenderedElement, firstCard);
  assert.deepEqual(rerenderedElement.classes, []);
  assert.deepEqual(rerenderedElement.styles, {});

  const secondElement = createElement();
  secondElement.classList.owner = secondElement;
  secondElement.style.owner = secondElement;
  markCardEntrance(secondElement, {});
  assert.equal(secondElement.styles["--deal-delay"], "85ms");
});

test("simulator speed selector applies slow, normal, fast, and off settings", () => {
  const styles = {};
  const panel = {
    style: {
      setProperty(name, value) { styles[name] = value; }
    }
  };
  const animationState = {staggerMs: 0};

  applySimulatorAnimationSpeed("slow", panel, animationState);
  assert.equal(styles["--deal-duration"], "720ms");
  assert.equal(styles["--reveal-duration"], "760ms");
  assert.equal(animationState.staggerMs, 150);
  applySimulatorAnimationSpeed("normal", panel, animationState);
  assert.equal(styles["--deal-duration"], "420ms");
  assert.equal(animationState.staggerMs, 85);
  applySimulatorAnimationSpeed("fast", panel, animationState);
  assert.equal(styles["--deal-duration"], "220ms");
  assert.equal(animationState.staggerMs, 30);
  applySimulatorAnimationSpeed("off", panel, animationState);
  assert.equal(styles["--deal-duration"], "1ms");
  assert.equal(animationState.staggerMs, 0);
  assert.throws(() => applySimulatorAnimationSpeed("invalid", panel, animationState), /valid simulator animation speed/);
});

const toggleHistoryStart = mainScript.indexOf("      function toggleHistory() {");
const toggleHistoryEnd = mainScript.indexOf("      function refreshHistory() {", toggleHistoryStart);
assert.ok(toggleHistoryStart >= 0 && toggleHistoryEnd > toggleHistoryStart, "history toggle function should be present");
const historySearchStart = mainScript.indexOf("      function historyMatchesSearch(entry, query) {");
const refreshHistoryStart = mainScript.indexOf("      function refreshHistory() {", historySearchStart);
assert.ok(historySearchStart >= 0 && refreshHistoryStart > historySearchStart, "history search helper should be present");
const historyMatchesSearch = new Function(
  mainScript.slice(historySearchStart, refreshHistoryStart) + "return historyMatchesSearch;"
)();
const mergeHistoryStart = mainScript.indexOf("      function mergeHistoryEntries(");
const cloudStatusStart = mainScript.indexOf("      function setCloudHistoryStatus(", mergeHistoryStart);
assert.ok(mergeHistoryStart >= 0 && cloudStatusStart > mergeHistoryStart, "cloud history merge function should be present");
const mergeHistoryEntries = new Function(
  mainScript.slice(mergeHistoryStart, cloudStatusStart) + "return mergeHistoryEntries;"
)();
const decideStart = mainScript.indexOf("      async function decide(recordConsultation) {");
const recordConsultationStart = mainScript.indexOf("      function recordAdvisorConsultation(", decideStart);
assert.ok(decideStart >= 0 && recordConsultationStart > decideStart, "advisor decision function should be present");
const advisorErrorFunctionStart = mainScript.indexOf("      function advisorRequestErrorMessage(");
const advisorErrorFunctionEnd = mainScript.indexOf("      async function requestStrategyAdvice(", advisorErrorFunctionStart);
assert.ok(advisorErrorFunctionStart >= 0 && advisorErrorFunctionEnd > advisorErrorFunctionStart, "advisor connection guidance should be present");
const advisorRequestErrorMessage = new Function(
  "TypeError",
  mainScript.slice(advisorErrorFunctionStart, advisorErrorFunctionEnd) + "return advisorRequestErrorMessage;"
)(TypeError);
const recordStart = recordConsultationStart;
const readHistoryStart = mainScript.indexOf("      function readHistory() {", recordStart);
assert.ok(readHistoryStart > recordStart, "automatic history-recording function should be present");
const saveResultStart = mainScript.indexOf("      function saveHandResult() {", readHistoryStart);
const clearHistoryStart = mainScript.indexOf("      async function clearHistory() {", saveResultStart);
assert.ok(saveResultStart >= 0 && clearHistoryStart > saveResultStart, "hand-result update function should be present");
const balanceChangeStart = mainScript.indexOf("      function calculateHandBalanceChange(");
const manualBalanceUpdaterStart = mainScript.indexOf("      function updateManualBalanceForHand(", balanceChangeStart);
const settingsUiStart = mainScript.indexOf("      function initializeSettingsUi()", manualBalanceUpdaterStart);
assert.ok(balanceChangeStart >= 0 && manualBalanceUpdaterStart > balanceChangeStart && settingsUiStart > manualBalanceUpdaterStart, "automatic balance adjustment helpers should be present");
const calculateHandBalanceChange = new Function(
  mainScript.slice(balanceChangeStart, manualBalanceUpdaterStart) + "return calculateHandBalanceChange;"
)();
const formatBalanceStart = mainScript.indexOf("      function formatManualBalance(");
const initializeBalanceStart = mainScript.indexOf("      function initializeManualBalance()", formatBalanceStart);
const formatManualBalance = new Function(
  mainScript.slice(formatBalanceStart, initializeBalanceStart) + "return formatManualBalance;"
)();
const createManualBalanceUpdater = (elements, localStorage) => new Function(
  "byId",
  "localStorage",
  "manualBalanceKey",
  "balanceCurrencies",
  "formatManualBalance",
  mainScript.slice(manualBalanceUpdaterStart, settingsUiStart) + "return updateManualBalanceForHand;"
)(
  (id) => elements[id],
  localStorage,
  "rainbet-advisor-manual-balance-v1",
  ["FAKE"],
  formatManualBalance
);
const finalPlayerRanksStart = mainScript.indexOf("      function currentFinalPlayerCardRanks() {");
const persistFinalCardsStart = mainScript.indexOf("      function persistActiveConsultationFinalCards(", finalPlayerRanksStart);
assert.ok(finalPlayerRanksStart >= 0 && persistFinalCardsStart > finalPlayerRanksStart, "automatic final player-card helper should be present");
const finishDealerFunctionStart = mainScript.indexOf("      function finishDealerTurn() {", persistFinalCardsStart);
assert.ok(finishDealerFunctionStart > persistFinalCardsStart, "automatic consultation final-card persistence should be present");
const createFinalPlayerCardReader = (elements) => new Function(
  "byId",
  "parseRank",
  mainScript.slice(finalPlayerRanksStart, persistFinalCardsStart) + "return currentFinalPlayerCardRanks;"
)((id) => elements[id], parseRank);
const createFinalCardPersistence = (elements, entries) => new Function(
  "activeConsultationId",
  "byId",
  "currentFinalPlayerCardRanks",
  "readHistory",
  "writeHistory",
  "refreshHistory",
  mainScript.slice(persistFinalCardsStart, finishDealerFunctionStart) + "return persistActiveConsultationFinalCards;"
)(
  "consult-1",
  (id) => elements[id],
  createFinalPlayerCardReader(elements),
  () => entries,
  (updatedEntries) => entries.splice(0, entries.length, ...updatedEntries),
  () => {}
);
const exportHistoryStart = mainScript.indexOf("      function exportHistory() {", clearHistoryStart);
assert.ok(exportHistoryStart > clearHistoryStart, "history export function should follow history clearing");
const handHistorySummaryStart = mainScript.indexOf("      function summarizeHandHistory(entries, cards, dealer, options) {");
const updateHandHistoryInsightStart = mainScript.indexOf("      function updateHandHistoryInsight(", handHistorySummaryStart);
assert.ok(handHistorySummaryStart >= 0 && updateHandHistoryInsightStart > handHistorySummaryStart, "history-based hand insight should be present");
const summarizeHandHistory = new Function(
  "parseRank",
  mainScript.slice(handHistorySummaryStart, updateHandHistoryInsightStart) + "return summarizeHandHistory;"
)(parseRank);
const sessionLimitStart = mainScript.indexOf("      function restoreSessionLossLimit() {");
const sessionRenderStart = mainScript.indexOf("      function renderSessionGuard() {", sessionLimitStart);
assert.ok(sessionLimitStart >= 0 && sessionRenderStart > sessionLimitStart, "session loss-limit persistence helpers should be present");

const animationPresetStart = simulatorScript.indexOf("      const simulatorAnimationPresets = {");
const cardEntranceStart = simulatorScript.indexOf("      function markCardEntrance(element, card) {");
const makeCardStart = simulatorScript.indexOf("      function makeCardElement(card, hidden) {", cardEntranceStart);
assert.ok(animationPresetStart >= 0 && cardEntranceStart > animationPresetStart, "simulator animation speed settings should be present");
assert.ok(makeCardStart > cardEntranceStart, "simulator card animation helper should be present");
const applySimulatorAnimationSpeed = new Function(
  simulatorScript.slice(animationPresetStart, cardEntranceStart) +
    "return applySimulatorAnimationSpeed;"
)();
const cardAnimationState = {seen: new WeakSet(), order: 0, staggerMs: 85};
const markCardEntrance = new Function(
  "cardAnimationState",
  simulatorScript.slice(cardEntranceStart, makeCardStart) + "return markCardEntrance;"
)(cardAnimationState);

const card = (rank) => ({
  rank: String(rank),
  value: rank === "A" ? 11 : Number(rank)
});
const dealerCards = [2, 3, 4, 5, 6, 7, 8, 9, 10, "A"];

function hardCards(total) {
  if (total <= 10) return [card(2), card(total - 2)];
  if (total <= 17) return [card(9), card(total - 9)];
  if (total <= 19) return [card(10), card(total - 10)];
  return [card(10), card(10)];
}

function expectedHard(total, dealer, canDouble) {
  const upcard = dealer === "A" ? 11 : dealer;
  if (total <= 8) return "HIT";
  if (total === 9) return canDouble && upcard >= 3 && upcard <= 6 ? "DOUBLE" : "HIT";
  if (total === 10) return canDouble && upcard >= 2 && upcard <= 9 ? "DOUBLE" : "HIT";
  if (total === 11) return canDouble && upcard >= 2 && upcard <= 10 ? "DOUBLE" : "HIT";
  if (total === 12) return upcard >= 4 && upcard <= 6 ? "STAND" : "HIT";
  if (total <= 16) return upcard >= 2 && upcard <= 6 ? "STAND" : "HIT";
  return "STAND";
}

function expectedSoft(total, dealer, canDouble) {
  const upcard = dealer === "A" ? 11 : dealer;
  if (total <= 14) return canDouble && upcard >= 5 && upcard <= 6 ? "DOUBLE" : "HIT";
  if (total <= 16) return canDouble && upcard >= 4 && upcard <= 6 ? "DOUBLE" : "HIT";
  if (total === 17) return canDouble && upcard >= 3 && upcard <= 6 ? "DOUBLE" : "HIT";
  if (total === 18) {
    if (canDouble && upcard >= 3 && upcard <= 6) return "DOUBLE";
    return upcard >= 2 && upcard <= 8 ? "STAND" : "HIT";
  }
  return "STAND";
}

function expectedPairSplit(value, dealer, dasAllowed) {
  const upcard = dealer === "A" ? 11 : dealer;
  if (value === 11 || value === 8) return "SPLIT";
  if (value === 2 || value === 3) {
    return upcard >= 4 && upcard <= 7 || dasAllowed && upcard >= 2 && upcard <= 3 ? "SPLIT" : null;
  }
  if (value === 4) return dasAllowed && upcard >= 5 && upcard <= 6 ? "SPLIT" : null;
  if (value === 6) {
    return upcard >= 3 && upcard <= 6 || dasAllowed && upcard === 2 ? "SPLIT" : null;
  }
  if (value === 7) return upcard >= 2 && upcard <= 7 ? "SPLIT" : null;
  if (value === 9) {
    return upcard >= 2 && upcard <= 6 || upcard === 8 || upcard === 9 ? "SPLIT" : "STAND";
  }
  return null;
}

test("hard and soft totals match the 4-8 deck S17 chart", () => {
  for (let total = 5; total <= 20; total++) {
    for (const dealer of dealerCards) {
      for (const canDouble of [true, false]) {
        const result = actionFor(hardCards(total), card(dealer), {
          doubleAllowed: canDouble,
          splitAllowed: false,
          dasRule: "unknown"
        });
        assert.equal(result.action, expectedHard(total, dealer, canDouble), `hard ${total} vs ${dealer}, double=${canDouble}`);
      }
    }
  }

  for (let total = 13; total <= 21; total++) {
    for (const dealer of dealerCards) {
      for (const canDouble of [true, false]) {
        const result = actionFor([card("A"), card(total - 11)], card(dealer), {
          doubleAllowed: canDouble,
          splitAllowed: true,
          dasRule: "unknown"
        });
        assert.equal(result.action, expectedSoft(total, dealer, canDouble), `soft ${total} vs ${dealer}, double=${canDouble}`);
      }
    }
  }
});

test("pair decisions match the chart and show conditional DAS alternatives", () => {
  for (const value of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const rank = value === 11 ? "A" : value;
    for (const dealer of dealerCards) {
      for (const dasRule of ["allowed", "not-allowed", "unknown"]) {
        const noDasAction = expectedPairSplit(value, dealer, false) || expectedHard(value * 2, dealer, true);
        const dasAction = expectedPairSplit(value, dealer, true) || expectedHard(value * 2, dealer, true);
        const expectedAction = dasRule === "allowed" ? dasAction : noDasAction;
        const expectedAlternative = dasRule === "unknown" && noDasAction !== dasAction ? dasAction : null;
        const result = actionFor([card(rank), card(rank)], card(dealer), {
          doubleAllowed: true,
          splitAllowed: true,
          dasRule
        });
        assert.equal(result.action, expectedAction, `pair ${rank}${rank} vs ${dealer}, ${dasRule}`);
        assert.equal(result.alternativeAction || null, expectedAlternative, `alternative for pair ${rank}${rank} vs ${dealer}, ${dasRule}`);
      }
    }
  }
});

test("8-deck expected-value analysis compares available actions with a replacement approximation", () => {
  const soft17 = expectedValueActionAnalysis([card("A"), card(6)], card(3), {
    doubleAllowed: true,
    afterSplit: false
  });
  assert.equal(soft17.bestAction, "DOUBLE");
  assert.ok(soft17.values.double > soft17.values.hit);
  assert.ok(soft17.values.hit > soft17.values.stand);
  assert.equal(soft17.shoe, "8-deck S17 rank probabilities (replacement approximation)");
  assert.equal(soft17.unit, "initial wager");

  assert.equal(expectedValueActionAnalysis([card(10), card(6)], card(10), {
    doubleAllowed: true,
    afterSplit: false
  }), null);
});

test("advisor answer identifies the hand and rule factors used for its recommendation", () => {
  const hardHand = actionForContext([card(10), card(6)], card(10), {
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown"
  });
  assert.match(hardHand.explanation, /Factors considered: published 8-deck, stand-on-soft-17 baseline; hard total 16; 2 player cards; dealer upcard 10/);
  assert.match(hardHand.explanation, /double available; not a pair/);

  const pairHand = actionForContext([card(8), card(8)], card(6), {
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown"
  });
  assert.match(pairHand.explanation, /pair 8; double available; split allowed; DAS unknown/);

  const elevenVsAce = actionForContext([card(5), card(6)], card("A"), {
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown"
  });
  assert.equal(elevenVsAce.action, "HIT");
  assert.equal(elevenVsAce.alternativeAction, "DOUBLE");
  assert.match(elevenVsAce.explanation, /hole-card\/peek rule is unpublished/);
});

test("unsplittable aces use hit instead of soft-12 double advice", () => {
  for (const dealer of dealerCards) {
    const result = actionFor([card("A"), card("A")], card(dealer), {
      doubleAllowed: true,
      splitAllowed: false,
      dasRule: "unknown"
    });
    assert.equal(result.action, "HIT", `A,A vs ${dealer}`);
  }
});

test("hand-history review distinguishes matches, conditional DAS, and unrecorded actions", () => {
  assert.equal(classifyHistoryDecision({ playerAction: "HIT", recommendedAction: "HIT" }), "matched");
  assert.equal(classifyHistoryDecision({
    playerAction: "SPLIT",
    recommendedAction: "HIT",
    alternativeAction: "SPLIT"
  }), "conditional");
  assert.equal(classifyHistoryDecision({ playerAction: "DOUBLE", recommendedAction: "STAND" }), "different");
  assert.equal(classifyHistoryDecision({ playerAction: null, recommendedAction: "HIT" }), "unreviewed");
  assert.equal(classifyHistoryDecision({ playerAction: "BET", recommendedAction: "HIT" }), "unreviewed");
});

test("decision pattern summary groups action differences and ignores hand outcomes", () => {
  const entries = [
    {cards: ["2", "2"], dealer: "4", playerAction: "HIT", recommendedAction: "SPLIT", result: "loss"},
    {cards: ["2", "2"], dealer: "4", playerAction: "HIT", recommendedAction: "SPLIT", result: "win"},
    {cards: ["10", "6"], dealer: "10", playerAction: "STAND", recommendedAction: "HIT", result: "loss"},
    {cards: ["2", "2"], dealer: "2", playerAction: "SPLIT", recommendedAction: "HIT", alternativeAction: "SPLIT", result: "loss"},
    {cards: ["10", "7"], dealer: "6", playerAction: "STAND", recommendedAction: "STAND", result: "loss"},
    {cards: ["9", "7"], dealer: "10", result: "loss"}
  ];
  const summary = summarizeDecisionPatterns(entries);
  assert.equal(summary.reviewed, 5);
  assert.equal(summary.matched, 1);
  assert.equal(summary.conditional, 1);
  assert.equal(summary.different, 3);
  assert.deepEqual(summary.topActionPattern, ["HIT instead of SPLIT", 2]);
  assert.deepEqual(summary.topHandPattern, ["2, 2 vs. 4: HIT instead of SPLIT", 2]);
  const changedOutcomes = entries.map((entry) => ({...entry, result: "push"}));
  assert.deepEqual(summarizeDecisionPatterns(changedOutcomes), summary);
});

test("current-hand history insight compares actions under matching rules and ignores outcomes", () => {
  const cards = [card(2), card(2)];
  const dealer = card(2);
  const options = {doubleAllowed: true, splitAllowed: true, dasRule: "unknown"};
  const entries = [
    {cards: ["2", "2"], dealer: "2", ...options, playerAction: "HIT", recommendedAction: "HIT", result: "loss"},
    {cards: ["2", "2"], dealer: "2", ...options, playerAction: "SPLIT", recommendedAction: "HIT", alternativeAction: "SPLIT", result: "win"},
    {cards: ["2", "2"], dealer: "2", ...options, playerAction: "STAND", recommendedAction: "HIT", alternativeAction: "SPLIT", result: "win"},
    {cards: ["10", "6"], dealer: "2", ...options, playerAction: "HIT"},
    {cards: ["2", "2"], dealer: "2", ...options, playerAction: "STAND", dasRule: "allowed"}
  ];

  const summary = summarizeHandHistory(entries, cards, dealer, options);
  assert.deepEqual(summary, {reviewed: 3, matched: 2, different: 1});
  const changedOutcomes = entries.map((entry, index) => ({
    ...entry,
    result: index % 2 ? "loss" : "win"
  }));
  assert.deepEqual(summarizeHandHistory(changedOutcomes, cards, dealer, options), summary);

  const splitOptions = {...options, splitAllowed: false, afterSplit: true};
  const splitCards = [card(8), card(3)];
  const splitDealer = card(6);
  const splitEntry = {
    cards: ["8", "3"],
    dealer: "6",
    ...splitOptions,
    playerAction: "DOUBLE",
    recommendedAction: "HIT",
    alternativeAction: "DOUBLE"
  };
  assert.deepEqual(
    summarizeHandHistory([splitEntry], splitCards, splitDealer, splitOptions),
    {reviewed: 1, matched: 1, different: 0}
  );
  assert.deepEqual(
    summarizeHandHistory([splitEntry], splitCards, splitDealer, {...splitOptions, afterSplit: false}),
    {reviewed: 0, matched: 0, different: 0}
  );
});

test("bet-history toggle updates visibility, label, and accessible expanded state", () => {
  const elements = {
    betHistoryContent: {hidden: true},
    toggleHistory: {
      textContent: "Show bet history",
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      }
    }
  };
  const toggleHistory = new Function(
    "byId",
    mainScript.slice(toggleHistoryStart, toggleHistoryEnd) + "return toggleHistory;"
  )((id) => elements[id]);

  toggleHistory();
  assert.equal(elements.betHistoryContent.hidden, false);
  assert.equal(elements.toggleHistory.textContent, "Hide bet history");
  assert.equal(elements.toggleHistory.attributes["aria-expanded"], "true");

  toggleHistory();
  assert.equal(elements.betHistoryContent.hidden, true);
  assert.equal(elements.toggleHistory.textContent, "Show bet history");
  assert.equal(elements.toggleHistory.attributes["aria-expanded"], "false");
});

test("history search matches cards, dealer, action, result, and pending hands", () => {
  const entry = {
    time: "2026-10-12T10:00:00.000Z",
    cards: ["8", "8"],
    dealer: "10",
    playerAction: "SPLIT",
    recommendedAction: "SPLIT",
    result: "loss",
    finalPlayerCards: ["8", "A", "3"],
    finalDealerCards: ["10", "7"]
  };
  assert.equal(historyMatchesSearch(entry, ""), true);
  assert.equal(historyMatchesSearch(entry, "8, 8"), true);
  assert.equal(historyMatchesSearch(entry, "dealer 10"), true);
  assert.equal(historyMatchesSearch(entry, "split"), true);
  assert.equal(historyMatchesSearch(entry, "loss"), true);
  assert.equal(historyMatchesSearch({...entry, result: null}, "pending"), true);
  assert.equal(historyMatchesSearch(entry, "win"), false);
});

test("cloud history merge deduplicates entries, favors newer edits, and caps saved records", () => {
  const older = {
    consultationId: "same-hand",
    time: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    cards: ["8", "8"],
    dealer: "6",
    playerAction: null
  };
  const newer = {...older, updatedAt: "2026-03-02T10:00:00.000Z", playerAction: "SPLIT"};
  const legacy = {time: "2026-03-01T11:00:00.000Z", cards: ["10", "6"], dealer: "9", playerAction: "HIT"};
  const merged = mergeHistoryEntries([newer, legacy], [older, {...legacy}]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((entry) => entry.consultationId === "same-hand").playerAction, "SPLIT");

  const entries = Array.from({length: 501}, (_, index) => ({
    consultationId: "hand-" + index,
    time: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    cards: ["10", "7"],
    dealer: "6"
  }));
  assert.equal(mergeHistoryEntries(entries, []).length, 500);
  assert.throws(() => mergeHistoryEntries([{time: "bad", cards: [3], dealer: "A"}], []), /unexpected format/);
});

test("practice accepts a DAS alternative conditionally without changing the baseline", () => {
  assert.equal(practiceAnswerKind("HIT", "HIT", "SPLIT"), "match");
  assert.equal(practiceAnswerKind("SPLIT", "HIT", "SPLIT"), "conditional");
  assert.equal(practiceAnswerKind("STAND", "HIT", "SPLIT"), "different");
  assert.equal(practiceAnswerKind("SPLIT", "HIT", null), "different");
});

test("balance exposure reports only the user's chosen amount", () => {
  assert.deepEqual(calculateExposure(100, 10), {
    percentOfBalance: 10,
    exceedsBalance: false,
    balanceAfterLoss: 90,
    excess: 0
  });
  assert.deepEqual(calculateExposure(100, 120), {
    percentOfBalance: 120,
    exceedsBalance: true,
    balanceAfterLoss: null,
    excess: 20
  });
  assert.throws(() => calculateExposure(0, 10), /balance greater than zero/);
  assert.throws(() => calculateExposure(100, 0), /amount greater than zero/);
});

test("fictional progression sizing uses bankroll, recent practice outcomes, exposure, and session loss", () => {
  assert.equal(calculateSuggestedWager({
    enabled: false,
    balance: 1000,
    sessionLossLimit: 50,
    sessionNet: 0,
    recentHands: [],
    action: "HIT"
  }).amount, null);

  const baseline = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: [],
    action: "HIT"
  });
  assert.equal(baseline.amount, 10);
  assert.equal(baseline.strategy, "flat");
  assert.equal(baseline.baseUnit, 10);

  const martingale = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: [
      {result: "loss", wagerAmount: 10, netResult: -10},
      {result: "loss", wagerAmount: 10, netResult: -10}
    ],
    action: "HIT",
    strategyMode: "martingale"
  });
  assert.equal(martingale.amount, 40);
  assert.equal(martingale.progressionUnits, 4);

  const limited = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: 50,
    sessionNet: 0,
    recentHands: [
      {result: "loss", wagerAmount: 10, netResult: -10},
      {result: "loss", wagerAmount: 10, netResult: -10}
    ],
    action: "DOUBLE",
    strategyMode: "martingale"
  });
  assert.equal(limited.amount, 0);
  assert.equal(limited.reason, "risk-budget-limited");
  assert.equal(limited.exposureMultiplier, 2);

  assert.equal(progressionUnits("martingale", [{result: "loss"}, {result: "loss"}]), 4);
  assert.equal(progressionUnits("dalembert", [{result: "loss"}, {result: "win"}]), 1);
  assert.equal(progressionUnits("paroli", [{result: "win"}, {result: "win"}]), 4);
  const shortHistoryChoice = chooseProgression(Array.from({length: 5}, () => ({result: "win"})));
  assert.equal(shortHistoryChoice.strategy, "flat");
  assert.match(shortHistoryChoice.reason, /twelve resolved/);
  const autoChoice = chooseProgression(Array.from({length: 12}, () => ({result: "win"})));
  assert.equal(autoChoice.strategy, "paroli");
  assert.equal(autoChoice.replay.endingBalance, 135);
  assert.equal(autoChoice.alternatives.length, 4);
  assert.ok(autoChoice.alternatives.every((item) =>
    Number.isFinite(item.meanReturn) && Number.isFinite(item.worstDrawdown) && item.bustedWindows === 0
  ));
  const autoSuggestion = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: Array.from({length: 12}, () =>
      ({result: "win", wagerAmount: 10, netResult: 10})),
    action: "HIT"
  });
  assert.equal(autoSuggestion.strategy, "paroli");
  assert.equal(autoSuggestion.amount, 40);
  assert.deepEqual(fictionalProgressionHistory([
    {result: "win", wagerAmount: 5},
    {result: "loss", wagerAmount: 5, fictionalCredits: true},
    {result: "push", wagerAmount: 5, fictionalCredits: true}
  ]).map((hand) => hand.result), ["loss", "push"]);
  assert.throws(() => fictionalProgressionHistory(null), /unexpected format/);
  assert.equal(replayProgression("flat", [{result: "loss"}]).endingBalance, 99);

  assert.equal(calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: 50,
    sessionNet: -50,
    recentHands: [],
    action: "HIT"
  }).amount, 0);
  assert.throws(() => calculateSuggestedWager({
    enabled: true,
    balance: 100,
    sessionLossLimit: 10,
    sessionNet: 0,
    recentHands: [],
    action: "INVALID"
  }), /unexpected format/);
});

test("hand outcome balance changes use wager defaults, exact net overrides, and never go negative", () => {
  assert.equal(calculateHandBalanceChange("win", 10, null), 10);
  assert.equal(calculateHandBalanceChange("loss", 10, null), -10);
  assert.equal(calculateHandBalanceChange("push", 10, null), 0);
  assert.equal(calculateHandBalanceChange("win", 10, 15), 15);
  assert.equal(calculateHandBalanceChange("loss", null, null), null);

  const elements = {
    manualBalanceAmount: {value: "5.00"},
    manualBalanceCurrency: {value: "CAD"},
    manualBalanceDisplay: {textContent: "5.00 fake credits"},
    manualBalanceStatus: {textContent: "", classList: {remove() {}, add() {}}}
  };
  let stored = JSON.stringify({amount: 5, currency: "CAD"});
  const localStorage = {
    getItem(key) {
      assert.equal(key, "rainbet-advisor-manual-balance-v1");
      return stored;
    },
    setItem(key, value) {
      assert.equal(key, "rainbet-advisor-manual-balance-v1");
      stored = value;
    }
  };
  const updateBalance = createManualBalanceUpdater(elements, localStorage);
  assert.equal(updateBalance(-10).status, "below-zero");
  assert.equal(JSON.parse(stored).amount, 5);
  assert.equal(updateBalance(10).status, "updated");
  assert.equal(JSON.parse(stored).amount, 15);
  assert.equal(JSON.parse(stored).currency, "FAKE");
});

test("legacy balance values migrate 1:1 to fictional credits without a currency conversion", () => {
  const elements = {
    manualBalanceAmount: {value: ""},
    manualBalanceCurrency: {value: ""},
    manualBalanceDisplay: {textContent: ""},
    manualBalanceStatus: {textContent: "", classList: {add() {}}}
  };
  let stored = JSON.stringify({amount: 123.45, currency: "USD"});
  const localStorage = {
    getItem(key) {
      assert.equal(key, "rainbet-advisor-manual-balance-v1");
      return stored;
    },
    setItem(key, value) {
      assert.equal(key, "rainbet-advisor-manual-balance-v1");
      stored = value;
    }
  };
  const saveManualBalanceStart = mainScript.indexOf("      function saveManualBalance()", initializeBalanceStart);
  const initializeManualBalance = new Function(
    "byId",
    "localStorage",
    "manualBalanceKey",
    "balanceCurrencies",
    "legacyBalanceCurrencies",
    "formatManualBalance",
    mainScript.slice(initializeBalanceStart, saveManualBalanceStart) + "return initializeManualBalance;"
  )(
    (id) => elements[id],
    localStorage,
    "rainbet-advisor-manual-balance-v1",
    ["FAKE"],
    ["CAD", "USD", "EUR", "GBP", "AUD"],
    formatManualBalance
  );

  initializeManualBalance();
  assert.equal(elements.manualBalanceAmount.value, "123.45");
  assert.equal(elements.manualBalanceCurrency.value, "FAKE");
  assert.equal(elements.manualBalanceDisplay.textContent, "123.45 fake credits");
  assert.deepEqual(JSON.parse(stored), {amount: 123.45, currency: "FAKE"});
  assert.match(elements.manualBalanceStatus.textContent, /no currency conversion was performed/);
});

test("using the advisor automatically records the server recommendation without an outcome", async () => {
  const elements = {
    playerCards: {value: "2, 2"},
    hitCards: {value: ""},
    splitHandCards: {value: ""},
    splitHand2Cards: {value: ""},
    advisorCardTarget: {value: "split"},
    dealer: {value: "2"},
    doubleAllowed: {checked: true},
    splitAllowed: {checked: true},
    dasRule: {value: "unknown"},
    insurance: {textContent: ""},
    action: {textContent: ""},
    reason: {textContent: ""},
    advisorStatus: {textContent: "", classList: {add() {}, remove() {}}},
    decisionAnalysis: {textContent: ""},
    handSummary: {textContent: ""},
    moveActionPanel: {hidden: true},
    moveActionButtons: {hidden: true},
    moveFollowup: {hidden: true},
    handResultEntry: {hidden: true},
    playerAction: {value: ""},
    handResult: {value: ""},
    handWager: {value: ""},
    handNetResult: {value: ""},
    handResultMessage: {textContent: ""}
  };
  const savedEntries = [];
  let recordCalls = 0;
  let refreshCalls = 0;
  const splitAvailability = [];
  const localStorage = {
    setItem(key, value) {
      assert.equal(key, "rainbet-original-blackjack-history-v1");
      savedEntries.splice(0, savedEntries.length, ...JSON.parse(value));
    }
  };
  const decide = new Function(
    "byId",
    "parseRank",
    "requestStrategyAdvice",
    "AbortController",
    "strategyRequestState",
    "window",
    "updateHandHistoryInsight",
    "setSplitInputAvailability",
    "recordAdvisorConsultation",
    "refreshHistory",
    "formatDecisionAnalysis",
    "getAdvisorInputPrompt",
    "renderSuggestedWager",
    mainScript.slice(decideStart, recordConsultationStart) + "return decide;"
  )(
    (id) => elements[id],
    parseRank,
    async (cards, dealer, options) => actionForContext(cards, dealer, options),
    AbortController,
    {version: 0, controller: null},
    {location: {protocol: "http:"}},
    () => {},
    (available) => { splitAvailability.push(available); },
    (...args) => {
      recordCalls++;
      const recorder = new Function(
        "readHistory",
        "writeHistory",
        "localStorage",
        "historyKey",
        mainScript.slice(recordStart, readHistoryStart) + "return recordAdvisorConsultation;"
      )(
        () => savedEntries,
        (entries) => localStorage.setItem("rainbet-original-blackjack-history-v1", JSON.stringify(entries.slice(0, 500))),
        localStorage,
        "rainbet-original-blackjack-history-v1"
      );
      return recorder(...args);
    },
    () => { refreshCalls++; },
    () => "finite-shoe EV",
    getAdvisorInputPrompt,
    () => {}
  );

  await decide(true);
  assert.equal(recordCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(elements.handResultEntry.hidden, false);
  assert.equal(savedEntries.length, 1);
  assert.equal(savedEntries[0].cards.join(","), "2,2");
  assert.equal(savedEntries[0].dealer, "2");
  assert.equal(savedEntries[0].recommendedAction, "HIT");
  assert.equal(savedEntries[0].alternativeAction, "SPLIT");
  assert.equal(splitAvailability[0], true, "an eligible pair can be split even when the advisor recommends another move");
  assert.equal(savedEntries[0].playerAction, null);
  assert.equal(savedEntries[0].result, null);

  await decide(false);
  assert.equal(recordCalls, 1);
  assert.equal(savedEntries.length, 1);

  elements.playerCards.value = "5, 6";
  elements.hitCards.value = "2";
  elements.dealer.value = "10";
  await decide(false);
  assert.equal(elements.action.textContent, "HIT");
  assert.equal(elements.handSummary.textContent, "Hard 13 vs. dealer 10 (after 1 hit card)");
  assert.equal(savedEntries.length, 1);

  elements.playerCards.value = "10, 6";
  elements.hitCards.value = "4";
  await decide(true);
  assert.equal(elements.action.textContent, "STAND");
  assert.equal(elements.handSummary.textContent, "Hard 20 vs. dealer 10 (after 1 hit card)");
  assert.equal(recordCalls, 2);
  assert.equal(refreshCalls, 2);
  assert.equal(savedEntries.length, 2);
  assert.deepEqual(savedEntries[0].cards, ["10", "6", "4"]);
  assert.equal(savedEntries[0].recommendedAction, "STAND");

  elements.playerCards.value = "8, 8";
  elements.hitCards.value = "";
  elements.splitHandCards.value = "3";
  elements.dealer.value = "6";
  await decide(true);
  assert.equal(elements.action.textContent, "HIT / DOUBLE");
  assert.equal(elements.handSummary.textContent, "Hard 11 vs. dealer 6 (split hand 1)");
  assert.equal(recordCalls, 3);
  assert.equal(refreshCalls, 3);
  assert.equal(savedEntries.length, 3);
  assert.deepEqual(savedEntries[0].cards, ["8", "3"]);
  assert.equal(savedEntries[0].afterSplit, true);
  assert.equal(savedEntries[0].splitAllowed, false);
  assert.equal(savedEntries[0].recommendedAction, "HIT");
  assert.equal(savedEntries[0].alternativeAction, "DOUBLE");
  assert.equal(splitAvailability[4], true, "a recommended SPLIT should unlock split entry");

  elements.splitHandCards.value = "";
  elements.splitHand2Cards.value = "5";
  elements.advisorCardTarget.value = "split2";
  await decide(false);
  assert.equal(elements.handSummary.textContent, "Hard 13 vs. dealer 6 (split hand 2)");
  assert.equal(recordCalls, 3, "advice for the other split hand does not create another history record unless requested");

  elements.playerCards.value = "8, 7";
  await decide(false);
  assert.equal(elements.action.textContent, "CHECK INPUT");
  assert.match(elements.reason.textContent, /original pair/i);
  assert.equal(splitAvailability[6], false, "an invalid split hand should relock split entry");
});

test("final player-card reader combines hit draws and the selected split hand", () => {
  const elements = {
    playerCards: {value: "10, 6"},
    hitCards: {value: "2"},
    splitHandCards: {value: ""},
    splitHand2Cards: {value: ""},
    advisorCardTarget: {value: "split"}
  };
  const readFinalCards = createFinalPlayerCardReader(elements);
  assert.deepEqual(readFinalCards(), ["10", "6", "2"]);

  elements.playerCards.value = "8, 8";
  elements.hitCards.value = "";
  elements.splitHandCards.value = "A, 3";
  assert.deepEqual(readFinalCards(), ["8", "A", "3"]);
  elements.advisorCardTarget.value = "split2";
  elements.splitHandCards.value = "";
  elements.splitHand2Cards.value = "5";
  assert.deepEqual(readFinalCards(), ["8", "5"]);
  assert.doesNotMatch(html, /id="finalPlayerCards"|id="finalDealerCards"/);
});

test("final-card persistence saves player busts without inventing dealer cards, then stores dealer cards", () => {
  const elements = {
    playerCards: {value: "10, 6"},
    hitCards: {value: "5"},
    splitHandCards: {value: ""},
    handResultMessage: {textContent: ""}
  };
  const entries = [{
    consultationId: "consult-1",
    finalPlayerCards: null,
    finalDealerCards: null
  }];
  const persistFinalCards = createFinalCardPersistence(elements, entries);

  persistFinalCards(null);
  assert.deepEqual(entries[0].finalPlayerCards, ["10", "6", "5"]);
  assert.equal(entries[0].finalDealerCards, null);

  persistFinalCards(["10", "7"]);
  assert.deepEqual(entries[0].finalPlayerCards, ["10", "6", "5"]);
  assert.deepEqual(entries[0].finalDealerCards, ["10", "7"]);
});

test("hand-result form saves advisor-entered player cards and preserves dealer cards with outcome and wager", () => {
  const elements = {
    handResult: {value: "loss"},
    playerCards: {value: "2, 2"},
    hitCards: {value: "9"},
    splitHandCards: {value: ""},
    handWager: {value: "10"},
    handNetResult: {value: "-12.50"},
    playerAction: {value: "HIT"},
    handResultMessage: {textContent: ""},
    handResultEntry: {hidden: false},
    manualBalanceAmount: {value: "100.00"},
    manualBalanceCurrency: {value: "CAD"},
    manualBalanceDisplay: {textContent: "100.00 fake credits"},
    manualBalanceStatus: {textContent: "", classList: {remove() {}, add() {}}}
  };
  const entries = [{
    consultationId: "consult-1",
    cards: ["2", "2"],
    dealer: "2",
    recommendedAction: "SPLIT",
    playerAction: null,
    result: null,
    finalDealerCards: ["2", "10"]
  }];
  const localStorage = {
    balanceValue: JSON.stringify({amount: 100, currency: "CAD"}),
    getItem(key) {
      assert.equal(key, "rainbet-advisor-manual-balance-v1");
      return this.balanceValue;
    },
    setItem(key, value) {
      if (key === "rainbet-original-blackjack-history-v1") {
        entries.splice(0, entries.length, ...JSON.parse(value));
      } else {
        assert.equal(key, "rainbet-advisor-manual-balance-v1");
        this.balanceValue = value;
      }
    }
  };
  const saveHandResult = new Function(
    "byId",
    "parseRank",
    "currentFinalPlayerCardRanks",
    "calculateHandBalanceChange",
    "updateManualBalanceForHand",
    "formatManualBalance",
    "readHistory",
    "writeHistory",
    "localStorage",
    "refreshHistory",
    "historyKey",
    "decide",
    "renderSuggestedWager",
    "suggestedWagerAction",
    "let activeConsultationId = 'consult-1';\n" +
      mainScript.slice(saveResultStart, clearHistoryStart) + "return saveHandResult;"
  )(
    (id) => elements[id],
    parseRank,
    createFinalPlayerCardReader(elements),
    calculateHandBalanceChange,
    createManualBalanceUpdater(elements, localStorage),
    formatManualBalance,
    () => entries,
    (newEntries) => localStorage.setItem("rainbet-original-blackjack-history-v1", JSON.stringify(newEntries)),
    localStorage,
    () => {},
    "rainbet-original-blackjack-history-v1",
    () => {},
    () => {},
    "STAND"
  );

  elements.handResult.value = "";
  saveHandResult();
  assert.match(elements.handResultMessage.textContent, /Choose the final outcome/);
  assert.equal(entries[0].result, null);
  elements.handResult.value = "loss";
  saveHandResult();
  assert.equal(entries[0].result, "loss");
  assert.deepEqual(entries[0].finalPlayerCards, ["2", "2", "9"]);
  assert.deepEqual(entries[0].finalDealerCards, ["2", "10"]);
  assert.equal(entries[0].wagerAmount, 10);
  assert.equal(entries[0].netResult, -12.5);
  assert.equal(entries[0].fictionalCredits, true);
  assert.equal(JSON.parse(localStorage.balanceValue).amount, 87.5);
  assert.equal(JSON.parse(localStorage.balanceValue).currency, "FAKE");
  assert.equal(elements.manualBalanceDisplay.textContent, "87.50 fake credits");
  assert.equal(entries[0].playerAction, "HIT");
  assert.equal(elements.handResultEntry.hidden, true);
  assert.match(elements.handResultMessage.textContent, /cards already entered in the advisor/);
  assert.equal(classifyHistoryDecision(entries[0]), "different");
});

test("hand-result form saves entered player cards and leaves unknown dealer cards blank", () => {
  const elements = {
    handResult: {value: "win"},
    playerCards: {value: "10, 7"},
    hitCards: {value: ""},
    splitHandCards: {value: ""},
    handWager: {value: "5"},
    handNetResult: {value: ""},
    playerAction: {value: ""},
    handResultMessage: {textContent: ""},
    handResultEntry: {hidden: false},
    manualBalanceAmount: {value: "100.00"},
    manualBalanceCurrency: {value: "USD"},
    manualBalanceDisplay: {textContent: "100.00 fake credits"},
    manualBalanceStatus: {textContent: "", classList: {remove() {}, add() {}}}
  };
  const entries = [{
    consultationId: "consult-2",
    cards: ["10", "7"],
    dealer: "6",
    recommendedAction: "STAND",
    result: null,
    finalPlayerCards: null,
    finalDealerCards: null
  }];
  const localStorage = {
    balanceValue: JSON.stringify({amount: 100, currency: "USD"}),
    getItem(key) {
      assert.equal(key, "rainbet-advisor-manual-balance-v1");
      return this.balanceValue;
    },
    setItem(key, value) {
      if (key === "rainbet-original-blackjack-history-v1") {
        entries.splice(0, entries.length, ...JSON.parse(value));
      } else {
        assert.equal(key, "rainbet-advisor-manual-balance-v1");
        this.balanceValue = value;
      }
    }
  };
  const saveHandResult = new Function(
    "byId",
    "parseRank",
    "currentFinalPlayerCardRanks",
    "calculateHandBalanceChange",
    "updateManualBalanceForHand",
    "formatManualBalance",
    "readHistory",
    "writeHistory",
    "localStorage",
    "refreshHistory",
    "historyKey",
    "decide",
    "renderSuggestedWager",
    "suggestedWagerAction",
    "let activeConsultationId = 'consult-2';\n" +
      mainScript.slice(saveResultStart, clearHistoryStart) + "return saveHandResult;"
  )(
    (id) => elements[id],
    parseRank,
    createFinalPlayerCardReader(elements),
    calculateHandBalanceChange,
    createManualBalanceUpdater(elements, localStorage),
    formatManualBalance,
    () => entries,
    (newEntries) => localStorage.setItem("rainbet-original-blackjack-history-v1", JSON.stringify(newEntries)),
    localStorage,
    () => {},
    "rainbet-original-blackjack-history-v1",
    () => {},
    () => {},
    "STAND"
  );

  saveHandResult();
  assert.equal(entries[0].result, "win");
  assert.deepEqual(entries[0].finalPlayerCards, ["10", "7"]);
  assert.equal(entries[0].finalDealerCards, null);
  assert.equal(entries[0].netResult, 5);
  assert.equal(JSON.parse(localStorage.balanceValue).amount, 105);
  assert.equal(elements.handResultEntry.hidden, true);
});

test("clearing signed-in history removes local data and deletes the cloud copy", async () => {
  const removedKeys = [];
  const statuses = [];
  let cloudDeleteCalls = 0;
  const elements = {
    handResultEntry: {hidden: false},
    handResultMessage: {textContent: "Pending"},
    historyMessage: {textContent: ""}
  };
  const clearState = new Function(
    "byId",
    "window",
    "localStorage",
    "historyKey",
    "refreshHistory",
    "decide",
    "updateCloudHistoryControls",
    "setCloudHistoryStatus",
    "mergeHistoryEntries",
    "testState",
    "let cloudHistoryClient = {clearHistory: async () => { testState.cloudDeleteCalls++; }};\n" +
      "let cloudHistoryUser = {uid: 'user-1'};\n" +
      "let cloudHistoryReady = true;\n" +
      "let cloudHistorySyncing = false;\n" +
      "let pendingCloudHistory = null;\n" +
      "let cloudHistoryWriteChain = Promise.resolve();\n" +
      "let cloudHistoryWriteVersion = 0;\n" +
      "let cloudHistorySyncedUid = 'user-1';\n" +
      "let activeConsultationId = 'consult-1';\n" +
      mainScript.slice(clearHistoryStart, exportHistoryStart) +
      "return {clearHistory, getState: () => ({cloudHistoryReady, cloudHistorySyncing, cloudHistorySyncedUid, activeConsultationId, cloudDeleteCalls: testState.cloudDeleteCalls})};"
  )(
    (id) => elements[id],
    {confirm: () => true},
    {removeItem: (key) => removedKeys.push(key)},
    "rainbet-original-blackjack-history-v1",
    () => {},
    () => {},
    () => {},
    (message, isError) => statuses.push({message, isError}),
    mergeHistoryEntries,
    {cloudDeleteCalls: 0}
  );
  await clearState.clearHistory();

  assert.deepEqual(removedKeys, ["rainbet-original-blackjack-history-v1"]);
  assert.equal(clearState.getState().cloudDeleteCalls, 1);
  assert.equal(clearState.getState().cloudHistorySyncedUid, "user-1");
  assert.equal(elements.handResultEntry.hidden, true);
  assert.equal(clearState.getState().cloudHistoryReady, true);
  assert.equal(clearState.getState().cloudHistorySyncedUid, "user-1");
  assert.equal(clearState.getState().activeConsultationId, null);
  assert.deepEqual(statuses.at(-1), {message: "Local and cloud history cleared.", isError: false});
});

test("session loss limit persists across reload and can be cleared", () => {
  let storedLimit = "25";
  let renderCalls = 0;
  const elements = {
    sessionLossLimit: {value: ""},
    sessionGuardStatus: {textContent: ""}
  };
  const localStorage = {
    getItem(key) {
      assert.equal(key, "rainbet-blackjack-fictional-session-loss-limit-v1");
      return storedLimit;
    },
    setItem(key, value) {
      assert.equal(key, "rainbet-blackjack-fictional-session-loss-limit-v1");
      storedLimit = value;
    },
    removeItem(key) {
      assert.equal(key, "rainbet-blackjack-fictional-session-loss-limit-v1");
      storedLimit = null;
    }
  };
  const helpers = new Function(
    "byId",
    "localStorage",
    "sessionLossLimitKey",
    "renderSessionGuard",
    mainScript.slice(sessionLimitStart, sessionRenderStart) +
      "return {restoreSessionLossLimit, saveSessionLossLimit};"
  )(
    (id) => elements[id],
    localStorage,
    "rainbet-blackjack-fictional-session-loss-limit-v1",
    () => { renderCalls += 1; }
  );

  assert.equal(helpers.restoreSessionLossLimit(), null);
  assert.equal(elements.sessionLossLimit.value, "25");
  elements.sessionLossLimit.value = "12.5";
  assert.equal(helpers.saveSessionLossLimit(), true);
  assert.equal(storedLimit, "12.5");
  assert.equal(renderCalls, 1);
  storedLimit = "invalid";
  assert.match(helpers.restoreSessionLossLimit(), /Saved value must be a positive number/);
  elements.sessionLossLimit.value = "-1";
  assert.equal(helpers.saveSessionLossLimit(), false);
  assert.match(elements.sessionGuardStatus.textContent, /Enter a positive loss limit/);
  elements.sessionLossLimit.value = "";
  assert.equal(helpers.saveSessionLossLimit(), true);
  assert.equal(storedLimit, null);
});

test("history-prioritized practice replays strategy mismatches, not outcomes or DAS alternatives", () => {
  const scenarios = historyPracticeScenarios([
    {
      cards: ["2", "2"], dealer: "2", playerAction: "SPLIT",
      recommendedAction: "HIT", alternativeAction: "SPLIT",
      doubleAllowed: true, splitAllowed: true, dasRule: "unknown", result: "loss"
    },
    {
      cards: ["8", "8"], dealer: "10", playerAction: "HIT",
      recommendedAction: "STAND", alternativeAction: null,
      doubleAllowed: true, splitAllowed: true, dasRule: "unknown", result: "win"
    },
    {
      cards: ["2", "2"], dealer: "4", playerAction: "HIT",
      recommendedAction: "SPLIT", alternativeAction: null,
      doubleAllowed: true, splitAllowed: true, dasRule: "unknown", result: "loss"
    },
    {cards: ["9", "7"], dealer: "10", result: "loss"}
  ], []);
  assert.equal(scenarios.length, 2);
  assert.ok(scenarios.every((scenario) => scenario.fromHistory));
  assert.ok(scenarios.some((scenario) => scenario.cards.map((item) => item.rank).join(",") === "8,8"));
  assert.ok(scenarios.some((scenario) => scenario.cards.map((item) => item.rank).join(",") === "2,2" && scenario.dealer.rank === "4"));
  assert.throws(() => historyPracticeScenarios([{
    cards: "malformed", dealer: "10", playerAction: "HIT",
    doubleAllowed: true, splitAllowed: true, dasRule: "unknown"
  }], []), /invalid format/);
});

test("split-hand action mismatches get a separate DAS-aware practice scenario", () => {
  const options = {doubleAllowed: true, splitAllowed: false, dasRule: "unknown", afterSplit: true};
  const entry = {
    cards: ["8", "3"],
    dealer: "6",
    ...options,
    playerAction: "STAND",
    recommendedAction: "HIT",
    alternativeAction: "DOUBLE",
    time: "2026-03-01T10:00:00.000Z"
  };
  const scenarios = historyPracticeScenarios([entry], [], "2026-03-01T10:00:00.000Z");
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].options.afterSplit, true);
  assert.equal(scenarios[0].recommendedAction, "HIT");
  assert.equal(scenarios[0].alternativeAction, "DOUBLE");
  assert.notEqual(
    practiceScenarioKey(scenarios[0]),
    practiceScenarioKey({...scenarios[0], options: {...scenarios[0].options, afterSplit: false}})
  );
});

test("persistent learning prioritizes weak scenarios and retires mastered ones until a new miss", () => {
  const firstMiss = {
    time: "2026-01-01T12:00:00.000Z",
    cards: ["2", "2"],
    dealer: "4",
    playerAction: "HIT",
    recommendedAction: "SPLIT",
    alternativeAction: null,
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown",
    result: "loss"
  };
  let candidates = practiceReviewScenarios([firstMiss], []);
  assert.equal(candidates.length, 1);
  const scenario = candidates[0];
  const reversed = {...scenario, cards: [...scenario.cards].reverse()};
  assert.equal(practiceScenarioKey(scenario), practiceScenarioKey(reversed));

  let progress = updateLearningProgress([], scenario, "different", "2026-01-02T12:00:00.000Z");
  assert.equal(progress[0].correctStreak, 0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    progress = updateLearningProgress(progress, scenario, "match", `2026-01-0${attempt + 2}T12:00:00.000Z`);
  }
  assert.equal(progress[0].mastered, true);
  assert.equal(practiceReviewScenarios([firstMiss], progress, "2026-01-06T12:00:00.000Z").length, 0);

  const laterMiss = {...firstMiss, time: "2026-01-06T12:00:00.000Z"};
  candidates = practiceReviewScenarios([laterMiss], progress, "2026-01-06T12:00:00.000Z");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].resetProgress, true);
  progress = updateLearningProgress(progress, candidates[0], "match", "2026-01-07T12:00:00.000Z");
  assert.equal(progress[0].correctStreak, 1);
  assert.equal(progress[0].mastered, false);
});

test("practice progress spaces correct answers and brings misses back sooner", () => {
  const scenario = {
    cards: [card(2), card(2)],
    dealer: card(4),
    options: {doubleAllowed: true, splitAllowed: true, dasRule: "unknown"},
    fromHistory: false
  };
  const firstReview = "2026-03-01T10:00:00.000Z";
  let progress = updateLearningProgress([], scenario, "match", firstReview);
  assert.equal(progress[0].nextReviewAt, "2026-03-02T10:00:00.000Z");
  assert.equal(practiceReviewScenarios([], progress, "2026-03-01T10:00:00.000Z").length, 0);
  assert.equal(practiceReviewScenarios([], progress, "2026-03-02T10:00:00.000Z").length, 1);

  progress = updateLearningProgress(progress, scenario, "conditional", "2026-03-02T10:00:00.000Z");
  assert.equal(progress[0].nextReviewAt, "2026-03-05T10:00:00.000Z");
  progress = updateLearningProgress(progress, scenario, "match", "2026-03-05T10:00:00.000Z");
  assert.equal(progress[0].mastered, true);
  assert.equal(progress[0].nextReviewAt, "2026-03-12T10:00:00.000Z");
  progress = updateLearningProgress(progress, scenario, "match", "2026-03-12T10:00:00.000Z");
  assert.equal(progress[0].nextReviewAt, "2026-03-26T10:00:00.000Z");

  progress = updateLearningProgress(progress, scenario, "different", "2026-03-26T10:00:00.000Z");
  assert.equal(progress[0].correctStreak, 0);
  assert.equal(progress[0].mastered, false);
  assert.equal(progress[0].nextReviewAt, "2026-03-26T10:10:00.000Z");
  assert.equal(practiceReviewScenarios([], progress, "2026-03-26T10:09:00.000Z").length, 0);
  assert.equal(practiceReviewScenarios([], progress, "2026-03-26T10:10:00.000Z").length, 1);
});

test("logged action mismatches wait for their scheduled review time", () => {
  const entry = {
    time: "2026-04-01T10:00:00.000Z",
    cards: ["2", "2"],
    dealer: "4",
    playerAction: "HIT",
    recommendedAction: "SPLIT",
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown"
  };
  const scenario = {
    cards: [card(2), card(2)],
    dealer: card(4),
    options: {doubleAllowed: true, splitAllowed: true, dasRule: "unknown"},
    fromHistory: true
  };
  const progress = updateLearningProgress([], scenario, "different", entry.time);
  assert.equal(practiceReviewScenarios([entry], progress, "2026-04-01T10:09:00.000Z").length, 0);
  assert.equal(practiceReviewScenarios([entry], progress, "2026-04-01T10:10:00.000Z").length, 1);
});

test("weak practice scenarios are scheduled before stronger ones", () => {
  const options = {doubleAllowed: true, splitAllowed: true, dasRule: "unknown"};
  const weaker = {cards: [card(2), card(2)], dealer: card(4), options, fromHistory: false};
  const stronger = {cards: [card(9), card(8)], dealer: card(10), options, fromHistory: false};
  let progress = updateLearningProgress([], weaker, "different", "2026-02-01T12:00:00.000Z");
  progress = updateLearningProgress(progress, stronger, "match", "2026-02-02T12:00:00.000Z");
  progress = updateLearningProgress(progress, stronger, "match", "2026-02-03T12:00:00.000Z");

  const candidates = practiceReviewScenarios([], progress);
  assert.equal(candidates[0].key, practiceScenarioKey(weaker));
  assert.equal(candidates[1].key, practiceScenarioKey(stronger));
});

test("local learning progress survives reload validation and rejects malformed storage", () => {
  const scenario = {
    cards: [card(2), card(2)],
    dealer: card(4),
    options: {doubleAllowed: true, splitAllowed: true, dasRule: "unknown"},
    fromHistory: false
  };
  const records = updateLearningProgress([], scenario, "match", "2026-02-04T12:00:00.000Z");
  learningStorageValue = JSON.stringify({version: 1, records});
  assert.deepEqual(readLearningProgress(), records);

  const legacyRecords = records.map(({nextReviewAt, ...record}) => record);
  learningStorageValue = JSON.stringify({version: 1, records: legacyRecords});
  assert.equal(readLearningProgress()[0].nextReviewAt, "2026-02-04T12:00:00.000Z");

  learningStorageValue = JSON.stringify({version: 1, records: [{key: "corrupt"}]});
  assert.throws(() => readLearningProgress(), /unexpected format/);
  learningStorageValue = null;
});

async function listenForTest(testContext, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  testContext.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return "http://127.0.0.1:" + server.address().port;
}

test("private strategy endpoint validates same-origin requests and does not serve its implementation", async (testContext) => {
  const server = createGeminiServer({apiKey: ""});
  const origin = await listenForTest(testContext, server);
  const options = {doubleAllowed: true, splitAllowed: true, dasRule: "unknown", afterSplit: false};
  const response = await fetch(origin + "/api/advice", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({cards: ["10", "6"], dealer: "10", options})
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    action: "HIT",
    alternativeAction: null,
    explanation: "Basic strategy hits this hand against the dealer upcard. Factors considered: published 8-deck, stand-on-soft-17 baseline; hard total 16; 2 player cards; dealer upcard 10; double available; not a pair.",
    hand: {total: 16, soft: false},
    analysis: null
  });

  const evResponse = await fetch(origin + "/api/advice", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({
      cards: ["A", "6"],
      dealer: "3",
      options: {doubleAllowed: true, splitAllowed: true, dasRule: "unknown", afterSplit: false}
    })
  });
  const evPayload = await evResponse.json();
  assert.equal(evResponse.status, 200);
  assert.equal(evPayload.action, "DOUBLE");
  assert.equal(evPayload.analysis.bestAction, "DOUBLE");
  assert.ok(evPayload.analysis.values.double > evPayload.analysis.values.hit);

  const privateSource = await fetch(origin + "/rainbet-strategy.cjs");
  assert.equal(privateSource.status, 404);
  const foreignRequest = await fetch(origin + "/api/advice", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: "https://example.invalid"},
    body: JSON.stringify({cards: ["10", "6"], dealer: "10", options})
  });
  assert.equal(foreignRequest.status, 403);
  const invalidRequest = await fetch(origin + "/api/advice", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({cards: ["10", "6"], dealer: "X", options})
  });
  assert.equal(invalidRequest.status, 400);
  const wrongMethod = await fetch(origin + "/api/advice", {
    headers: {Origin: origin}
  });
  assert.equal(wrongMethod.status, 405);
});

test("Gemini server serves the app and sends the question with fixed, public reference notes", async (testContext) => {
  let upstreamRequest = null;
  const server = createGeminiServer({
    apiKey: "test-secret",
    model: "gemini-4-carbon",
    fetchImpl: async (url, options) => {
      upstreamRequest = {url, options};
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          outputs: [{type: "text", text: "Use the published rules as assumptions."}]
        })
      };
    }
  });
  const origin = await listenForTest(testContext, server);
  const appResponse = await fetch(origin + "/");
  assert.equal(appResponse.status, 200);
  assert.match(appResponse.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(appResponse.headers.get("content-security-policy"), /https:\/\/www\.gstatic/);
  const appHtml = await appResponse.text();
  assert.match(appHtml, /Ask Gemini/);
  assert.match(appHtml, /initializeCloudHistoryUi\(\)/);
  assert.match(appHtml, /fixed public Rainbet and app-reference notes/);
  assert.match(appHtml, /general help with explanations, writing, coding, calculations/);
  assert.match(appHtml, /maxlength="1200"/);

  const firebaseConfigResponse = await fetch(origin + "/rainbet-firebase-config.js");
  assert.equal(firebaseConfigResponse.status, 200);
  assert.match(firebaseConfigResponse.headers.get("content-type"), /javascript/);
  assert.match(await firebaseConfigResponse.text(), /rainbetFirebaseConfig/);
  const cloudModuleResponse = await fetch(origin + "/rainbet-cloud-history.mjs");
  assert.equal(cloudModuleResponse.status, 200);
  assert.match(cloudModuleResponse.headers.get("content-type"), /javascript/);
  assert.match(await cloudModuleResponse.text(), /signInWithPopup/);

  const foreignRequest = await fetch(origin + "/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: "https://example.invalid"},
    body: JSON.stringify({message: "Explain a rule"})
  });
  assert.equal(foreignRequest.status, 403);
  assert.equal(upstreamRequest, null);

  const response = await fetch(origin + "/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({message: "Explain the basic strategy assumptions."})
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    answer: "Use the published rules as assumptions.",
    model: "gemini-4-carbon"
  });
  assert.equal(upstreamRequest.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(upstreamRequest.options.headers["x-goog-api-key"], "test-secret");
  const upstreamBody = JSON.parse(upstreamRequest.options.body);
  assert.equal(upstreamBody.input, "Explain the basic strategy assumptions.");
  assert.equal(upstreamBody.model, "gemini-4-carbon");
  assert.equal(upstreamBody.store, false);
  assert.deepEqual(upstreamBody.generation_config, {thinking_level: "high", max_output_tokens: 1800});
  assert.deepEqual(Object.keys(upstreamBody).sort(), [
    "generation_config", "input", "model", "store", "system_instruction"
  ]);
  assert.doesNotMatch(upstreamBody.input, /history|balance|cards/i);
  assert.match(upstreamBody.system_instruction, /Rain Group Ltd/);
  assert.match(upstreamBody.system_instruction, /2017-11-26/);
  assert.match(upstreamBody.system_instruction, /Do not invent a founder/i);
  assert.match(upstreamBody.system_instruction, /HMAC-SHA512/);
  assert.match(upstreamBody.system_instruction, /no-DAS baseline/);
  assert.match(upstreamBody.system_instruction, /prior chat messages are not included/);
  assert.match(upstreamBody.system_instruction, /capable general-purpose assistant/);
  assert.match(upstreamBody.system_instruction, /do not fall back to app-only guidance/);
  assert.match(upstreamBody.system_instruction, /prior chat messages are not included/);

  const maxLengthResponse = await fetch(origin + "/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({message: "x".repeat(1200)})
  });
  assert.equal(maxLengthResponse.status, 200);
  assert.equal(JSON.parse(upstreamRequest.options.body).input, "x".repeat(1200));

  const overLimitResponse = await fetch(origin + "/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({message: "x".repeat(1201)})
  });
  assert.equal(overLimitResponse.status, 413);
  assert.match((await overLimitResponse.json()).error, /1200 characters/);
  assert.equal(JSON.parse(upstreamRequest.options.body).input, "x".repeat(1200));
});

test("Gemini server reports missing credentials and provider failures explicitly", async (testContext) => {
  let upstreamCalls = 0;
  const unconfiguredServer = createGeminiServer({apiKey: "", fetchImpl: async () => { upstreamCalls++; }});
  const unconfiguredOrigin = await listenForTest(testContext, unconfiguredServer);
  const noKeyResponse = await fetch(unconfiguredOrigin + "/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: unconfiguredOrigin},
    body: JSON.stringify({message: "Hello"})
  });
  assert.equal(noKeyResponse.status, 503);
  assert.match((await noKeyResponse.json()).error, /set GEMINI_API_KEY in the server environment/);
  assert.equal(upstreamCalls, 0);

  const failedServer = createGeminiServer({
    apiKey: "test-secret",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({error: {message: "Quota exceeded"}})
    })
  });
  const failedOrigin = await listenForTest(testContext, failedServer);
  const failureResponse = await fetch(failedOrigin + "/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: failedOrigin},
    body: JSON.stringify({message: "Hello"})
  });
  assert.equal(failureResponse.status, 429);
  assert.match((await failureResponse.json()).error, /Quota exceeded/);
});

test("cloud-history module reports missing Firebase configuration without network access", () => {
  const moduleSource = fs.readFileSync(path.join(__dirname, "rainbet-cloud-history.mjs"), "utf8");
  const events = [];
  class MockCustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const window = {
    rainbetFirebaseConfig: {},
    dispatchEvent(event) { events.push(event); }
  };
  vm.runInNewContext(moduleSource, {window, CustomEvent: MockCustomEvent});
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "rainbet-cloud-history");
  assert.equal(events[0].detail.status, "unconfigured");
  assert.match(events[0].detail.message, /Local history stays on this device/);
});

test("Gemini response parser accepts interaction text and rejects empty output", () => {
  assert.equal(extractAnswer({
    steps: [
      {type: "user_input", content: [{type: "text", text: "Question"}]},
      {type: "model_output", content: [{type: "text", text: "Answer from Gemini."}]}
    ]
  }), "Answer from Gemini.");
  assert.throws(() => extractAnswer({outputs: []}), /no text answer/);
});
