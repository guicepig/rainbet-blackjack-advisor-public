const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {PassThrough, Readable} = require("node:stream");
const {createServer: createGeminiServer, extractAnswer} = require("./rainbet-gemini-server.cjs");
const {actionFor, actionForContext, expectedValueActionAnalysis} = require("./rainbet-strategy.cjs");
const {
  TrainingContributionError,
  createFirebaseTrainingStore,
  normalizeTrainingContribution
} = require("./rainbet-training-data.cjs");
const {SiteStatsError, createSiteStatsService} = require("./rainbet-site-stats.cjs");

const html = fs.readFileSync(path.join(__dirname, "rainbet-original-blackjack-advisor.html"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "rainbet-gemini-server.cjs"), "utf8");
const firestoreRules = fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const mainScript = scripts[0] && scripts[0][1];
const simulatorScript = scripts[1] && scripts[1][1];
assert.ok(mainScript, "main advisor script should exist");
assert.ok(simulatorScript, "simulator script should exist");

const settingsPanelStart = mainScript.indexOf("      function setActiveSettingsPanel(");
const settingsPanelEnd = mainScript.indexOf("      function initializeAppearanceSettings(", settingsPanelStart);
assert.ok(settingsPanelStart >= 0 && settingsPanelEnd > settingsPanelStart, "settings panel navigation helper should exist");
const setActiveSettingsPanel = new Function(
  mainScript.slice(settingsPanelStart, settingsPanelEnd) + "return setActiveSettingsPanel;"
)();
const aiButtonPreferenceStart = mainScript.indexOf("      function readAiButtonVisibilityPreference(");
const aiButtonPreferenceEnd = mainScript.indexOf("      function initializeInterfaceSettings(", aiButtonPreferenceStart);
assert.ok(aiButtonPreferenceStart >= 0 && aiButtonPreferenceEnd > aiButtonPreferenceStart, "AI button preference reader should exist");
const readAiButtonVisibilityPreference = new Function(
  mainScript.slice(aiButtonPreferenceStart, aiButtonPreferenceEnd) + "return readAiButtonVisibilityPreference;"
)();
const feedbackPreferenceStart = mainScript.indexOf("      function readFeedbackPreference(");
const feedbackPreferenceEnd = mainScript.indexOf("      function showSoundEffectsStatus(", feedbackPreferenceStart);
assert.ok(feedbackPreferenceStart >= 0 && feedbackPreferenceEnd > feedbackPreferenceStart, "feedback preference reader should exist");
const readFeedbackPreference = new Function(
  mainScript.slice(feedbackPreferenceStart, feedbackPreferenceEnd) + "return readFeedbackPreference;"
)();
const commandPaletteFilterStart = mainScript.indexOf("      function filterCommandPaletteCommands(");
const commandPaletteFilterEnd = mainScript.indexOf("      function initializeCommandPalette(", commandPaletteFilterStart);
assert.ok(commandPaletteFilterStart >= 0 && commandPaletteFilterEnd > commandPaletteFilterStart, "command palette filter should exist");
const filterCommandPaletteCommands = new Function(
  mainScript.slice(commandPaletteFilterStart, commandPaletteFilterEnd) + "return filterCommandPaletteCommands;"
)();
const soundPlayerStart = mainScript.indexOf("      function playInterfaceSound(");
const soundPlayerEnd = mainScript.indexOf("      function playVibrationFeedback(", soundPlayerStart);
assert.ok(soundPlayerStart >= 0 && soundPlayerEnd > soundPlayerStart, "interface sound player should exist");
const createInterfaceSoundPlayer = (soundEffectsEnabled, fakeWindow, showStatus) => new Function(
  "soundEffectsEnabled",
  "feedbackAudioUnavailable",
  "feedbackAudioContext",
  "lastInterfaceSoundAt",
  "window",
  "byId",
  "showSoundEffectsStatus",
  mainScript.slice(soundPlayerStart, soundPlayerEnd) + "return playInterfaceSound;"
)(soundEffectsEnabled, false, null, -Infinity, fakeWindow, () => null, showStatus);
const vibrationPlayerStart = mainScript.indexOf("      function playVibrationFeedback(");
const vibrationPlayerEnd = mainScript.indexOf("      function playInterfaceFeedback(", vibrationPlayerStart);
assert.ok(vibrationPlayerStart >= 0 && vibrationPlayerEnd > vibrationPlayerStart, "vibration feedback player should exist");
const createVibrationPlayer = (vibrationFeedbackEnabled, fakeWindow, showStatus) => new Function(
  "vibrationFeedbackEnabled",
  "vibrationFeedbackUnavailable",
  "window",
  "showVibrationFeedbackStatus",
  mainScript.slice(vibrationPlayerStart, vibrationPlayerEnd) + "return playVibrationFeedback;"
)(vibrationFeedbackEnabled, false, fakeWindow, showStatus);
const privateUsernameStart = mainScript.indexOf("      function isValidPrivateUsername(");
const privateUsernameEnd = mainScript.indexOf("      function setProfileNameStatus(", privateUsernameStart);
assert.ok(privateUsernameStart >= 0 && privateUsernameEnd > privateUsernameStart, "private username validator should exist");
const isValidPrivateUsername = new Function(
  mainScript.slice(privateUsernameStart, privateUsernameEnd) + "return isValidPrivateUsername;"
)();
const decisionClassifierStart = mainScript.indexOf("      function classifyHistoryDecision(");
const decisionClassifierEnd = mainScript.indexOf("      function summarizeDecisionPatterns(", decisionClassifierStart);
assert.ok(decisionClassifierStart >= 0 && decisionClassifierEnd > decisionClassifierStart, "history decision classifier should exist");
const classifyHistoryDecisionForStats = new Function(
  mainScript.slice(decisionClassifierStart, decisionClassifierEnd) + "return classifyHistoryDecision;"
)();
const personalStatsStart = mainScript.indexOf("      function calculatePersonalStats(");
const personalStatsEnd = mainScript.indexOf("      function practiceScenarioKey(", personalStatsStart);
assert.ok(personalStatsStart >= 0 && personalStatsEnd > personalStatsStart, "personal stats calculator should exist");
const calculatePersonalStats = new Function(
  "classifyHistoryDecision",
  mainScript.slice(personalStatsStart, personalStatsEnd) + "return calculatePersonalStats;"
)(classifyHistoryDecisionForStats);
const gameOddsStart = mainScript.indexOf("      function combinationCount(");
const gameOddsEnd = mainScript.indexOf("      function formatOddsPercent(", gameOddsStart);
assert.ok(gameOddsStart >= 0 && gameOddsEnd > gameOddsStart, "Keno and Mines probability helpers should exist");
const {
  calculateKenoDistribution,
  drawKenoNumbers,
  toggleKenoSelection,
  calculateKenoExpectedReturn,
  getKenoModeConfig,
  getKenoPayoutMultipliers,
  getKenoPayoutMultiplier,
  formatKenoMultiplier,
  calculateMinesOdds,
  calculateMinesExpectedReturn
} = new Function(
  mainScript.slice(gameOddsStart, gameOddsEnd) +
  "return {calculateKenoDistribution, drawKenoNumbers, toggleKenoSelection, calculateKenoExpectedReturn, getKenoModeConfig, getKenoPayoutMultipliers, getKenoPayoutMultiplier, formatKenoMultiplier, calculateMinesOdds, calculateMinesExpectedReturn};"
)();
const siteStatsValidationStart = mainScript.indexOf("      function isValidSiteStatsPayload(");
const siteStatsValidationEnd = mainScript.indexOf("      function formatVisitDuration(", siteStatsValidationStart);
assert.ok(siteStatsValidationStart >= 0 && siteStatsValidationEnd > siteStatsValidationStart, "site stats response validator should exist");
const isValidSiteStatsPayload = new Function(
  mainScript.slice(siteStatsValidationStart, siteStatsValidationEnd) + "return isValidSiteStatsPayload;"
)();

const analyticsPredicateStart = mainScript.indexOf("      function isAnalyticsOrigin(");
const analyticsPredicateEnd = mainScript.indexOf("      function trackHistoryAccountCreated(", analyticsPredicateStart);
assert.ok(analyticsPredicateStart >= 0 && analyticsPredicateEnd > analyticsPredicateStart, "analytics consent guard should be present");
const {isAnalyticsOrigin, shouldLoadAnalytics} = new Function(
  mainScript.slice(analyticsPredicateStart, analyticsPredicateEnd) +
  "return {isAnalyticsOrigin, shouldLoadAnalytics};"
)();

function validTrainingContribution(overrides = {}) {
  return {
    consultationId: "consultation-1",
    cards: ["10", "6"],
    dealer: "10",
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown",
    afterSplit: false,
    recommendedAction: "HIT",
    alternativeAction: null,
    playerAction: "HIT",
    result: "win",
    ...overrides
  };
}

test("shared-training contributions whitelist only hand context and categorical outcomes", () => {
  const contribution = normalizeTrainingContribution(validTrainingContribution({
    wagerAmount: 500,
    netResult: 450,
    email: "private@example.com",
    finalPlayerCards: ["10", "6", "5"]
  }));
  assert.deepEqual(contribution.scenario, {
    cards: ["10", "6"],
    dealer: "10",
    doubleAllowed: true,
    splitAllowed: true,
    dasRule: "unknown",
    afterSplit: false,
    recommendedAction: "HIT",
    alternativeAction: null,
    playerAction: "HIT"
  });
  assert.equal(Object.hasOwn(contribution, "wagerAmount"), false);
  assert.equal(Object.hasOwn(contribution, "email"), false);
  assert.equal(
    normalizeTrainingContribution(validTrainingContribution({result: "loss"})).scenarioId,
    contribution.scenarioId,
    "changing only the outcome updates an aggregate count, not the scenario key"
  );
  assert.equal(
    normalizeTrainingContribution(validTrainingContribution({playerAction: "STAND"})).contextId,
    contribution.contextId,
    "alternative actions in the same context can be grouped for evaluation"
  );
  assert.notEqual(
    normalizeTrainingContribution(validTrainingContribution({playerAction: "STAND"})).scenarioId,
    contribution.scenarioId
  );
  assert.throws(
    () => normalizeTrainingContribution(validTrainingContribution({result: "unknown"})),
    (error) => error instanceof TrainingContributionError && error.status === 400
  );
  assert.throws(
    () => normalizeTrainingContribution(validTrainingContribution({playerAction: null})),
    (error) => error instanceof TrainingContributionError && error.status === 400
  );
});

test("shared-training consent is explicit, off by default, and revocable", () => {
  const start = mainScript.indexOf("      function initializeTrainingConsent() {");
  const end = mainScript.indexOf("      async function sendTrainingContribution(", start);
  assert.ok(start >= 0 && end > start);
  const toggle = {checked: false, disabled: false, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }};
  const status = {textContent: ""};
  const values = new Map();
  const helpers = new Function(
    "byId",
    "window",
    "console",
    "trainingContributionConsentKey",
    "let trainingContributionConsent = false;\n" +
      mainScript.slice(start, end) +
      "return {initializeTrainingConsent, isEnabled: () => trainingContributionConsent};"
  )(
    (id) => id === "shareTrainingData" ? toggle : status,
    {localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
      removeItem(key) { values.delete(key); }
    }},
    {error() {}},
    "training-consent"
  );
  helpers.initializeTrainingConsent();
  assert.equal(toggle.checked, false);
  assert.equal(helpers.isEnabled(), false);
  assert.match(status.textContent, /Off/);
  toggle.checked = true;
  toggle.listeners.change();
  assert.equal(values.get("training-consent"), "accepted-v1");
  assert.equal(helpers.isEnabled(), true);
  toggle.checked = false;
  toggle.listeners.change();
  assert.equal(values.has("training-consent"), false);
  assert.equal(helpers.isEnabled(), false);
});

test("the browser sends only the minimized fields after a completed hand is opted in", async () => {
  const start = mainScript.indexOf("      async function sendTrainingContribution(entry) {");
  const end = mainScript.indexOf("      function shareCompletedHand(", start);
  assert.ok(start >= 0 && end > start);
  let request = null;
  const send = new Function(
    "window",
    "fetch",
    mainScript.slice(start, end) + "return sendTrainingContribution;"
  )(
    {rainbetCloudHistory: {async getTrainingIdToken() { return "anonymous-token"; }}},
    async (url, options) => {
      request = {url, options};
      return {ok: true, json: async () => ({accepted: true, duplicate: false})};
    }
  );
  await send({
    ...validTrainingContribution(),
    wagerAmount: 500,
    netResult: 450,
    finalPlayerCards: ["10", "6", "5"],
    finalDealerCards: ["10", "8"],
    email: "private@example.com"
  });
  const payload = JSON.parse(request.options.body);
  assert.equal(request.url, "/api/training-contribution");
  assert.equal(request.options.headers.Authorization, "Bearer anonymous-token");
  assert.deepEqual(Object.keys(payload).sort(), [
    "afterSplit", "alternativeAction", "cards", "consultationId", "dasRule",
    "dealer", "doubleAllowed", "playerAction", "recommendedAction", "result", "splitAllowed"
  ].sort());
  assert.equal(payload.wagerAmount, undefined);
  assert.equal(payload.finalPlayerCards, undefined);
});

test("shared-hand submission is blocked until consent and a recorded action exist", async () => {
  const start = mainScript.indexOf("      function shareCompletedHand(entry) {");
  const end = mainScript.indexOf("      const rankNames =", start);
  assert.ok(start >= 0 && end > start);
  const status = {textContent: ""};
  const submitted = [];
  const helpers = new Function(
    "byId",
    "sendTrainingContribution",
    "let trainingContributionConsent = false;\n" +
      mainScript.slice(start, end) +
      "return {shareCompletedHand, setConsent: (value) => { trainingContributionConsent = value; }};"
  )(
    () => status,
    async (entry) => {
      submitted.push(entry.consultationId);
      return {duplicate: false};
    }
  );
  const entry = validTrainingContribution();
  helpers.shareCompletedHand(entry);
  assert.equal(submitted.length, 0);
  helpers.setConsent(true);
  helpers.shareCompletedHand({...entry, playerAction: null});
  assert.equal(submitted.length, 0);
  assert.match(status.textContent, /no first action/);
  helpers.shareCompletedHand(entry);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["consultation-1"]);
  assert.match(status.textContent, /contributed to aggregate shared statistics/);
});

test("shared-training storage accepts anonymous sessions and deduplicates hand submissions", async () => {
  const records = new Map();
  const aggregateWrites = [];
  const firestore = {
    collection(name) {
      return {
        doc(id) {
          return {path: name + "/" + id};
        }
      };
    },
    runTransaction(work) {
      return work({
        async get(reference) {
          return {exists: records.has(reference.path)};
        },
        create(reference, value) {
          records.set(reference.path, value);
        },
        set(reference, value, options) {
          aggregateWrites.push({reference, value, options});
        }
      });
    }
  };
  const store = createFirebaseTrainingStore({
    auth: {
      async verifyIdToken(token) {
        assert.equal(token, "a-valid-anonymous-id-token");
        return {uid: "anonymous-user", firebase: {sign_in_provider: "anonymous"}};
      }
    },
    firestore,
    fieldValue: {
      increment: (amount) => ({increment: amount}),
      serverTimestamp: () => "server-time"
    },
    receiptSecret: "private-server-receipt-secret-that-is-long-enough"
  });
  const input = validTrainingContribution();
  assert.deepEqual(await store.submit("a-valid-anonymous-id-token", input), {duplicate: false});
  assert.deepEqual(await store.submit("a-valid-anonymous-id-token", input), {duplicate: true});
  assert.deepEqual(await store.submit("a-valid-anonymous-id-token", {
    ...input,
    consultationId: "consultation-loss",
    result: "loss"
  }), {duplicate: false});
  assert.deepEqual(await store.submit("a-valid-anonymous-id-token", {
    ...input,
    consultationId: "consultation-push",
    result: "push"
  }), {duplicate: false});
  assert.equal(aggregateWrites.length, 3);
  assert.equal(aggregateWrites[0].reference.path.startsWith("trainingAggregates/"), true);
  assert.equal(aggregateWrites[0].value.winCount.increment, 1);
  assert.equal(aggregateWrites[0].value.scenario.email, undefined);
  assert.deepEqual(
    aggregateWrites.map((item) => item.reference.path),
    Array(3).fill(aggregateWrites[0].reference.path),
    "win, loss, and push samples for the same decision context share one aggregate bucket"
  );
  assert.equal(aggregateWrites[1].value.lossCount.increment, 1);
  assert.equal(aggregateWrites[2].value.pushCount.increment, 1);

  const googleStore = createFirebaseTrainingStore({
    auth: {async verifyIdToken() {
      return {uid: "google-user", firebase: {sign_in_provider: "google.com"}};
    }},
    firestore,
    fieldValue: {
      increment: (amount) => ({increment: amount}),
      serverTimestamp: () => "server-time"
    },
    receiptSecret: "private-server-receipt-secret-that-is-long-enough"
  });
  await assert.rejects(
    googleStore.submit("a-valid-anonymous-id-token", validTrainingContribution({consultationId: "other-hand"})),
    (error) => error instanceof TrainingContributionError && error.status === 401
  );
});

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

test("settings navigation and private usernames enforce their supported states", () => {
  const buttons = ["account", "appearance", "privacy"].map((section) => ({
    dataset: {settingsTarget: section},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  }));
  const panels = ["account", "appearance", "privacy"].map((section) => ({
    dataset: {settingsPanel: section},
    hidden: section !== "account"
  }));
  const description = {textContent: ""};
  const descriptions = {account: "Account settings.", appearance: "Appearance settings.", privacy: "Privacy settings."};

  setActiveSettingsPanel("appearance", buttons, panels, descriptions, description);
  assert.deepEqual(buttons.map((button) => button.attributes["aria-pressed"]), ["false", "true", "false"]);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false, true]);
  assert.equal(description.textContent, "Appearance settings.");
  assert.throws(() => setActiveSettingsPanel("unknown", buttons, panels, descriptions, description), /Unknown settings section/);

  assert.equal(isValidPrivateUsername("Player_7"), true);
  assert.equal(isValidPrivateUsername("abc"), true);
  assert.equal(isValidPrivateUsername("a".repeat(20)), true);
  assert.equal(isValidPrivateUsername("ab"), false);
  assert.equal(isValidPrivateUsername("a".repeat(21)), false);
  assert.equal(isValidPrivateUsername("two words"), false);
  assert.equal(isValidPrivateUsername("name@example"), false);
});

test("AI assistant shortcut is visible by default and supports a saved hidden preference", () => {
  assert.equal(readAiButtonVisibilityPreference(null), true);
  assert.equal(readAiButtonVisibilityPreference("shown"), true);
  assert.equal(readAiButtonVisibilityPreference("hidden"), false);
  assert.throws(() => readAiButtonVisibilityPreference("invalid"), /unexpected value/);
  assert.match(html, /id="toggleHelperChat"[^>]*>Ask assistant/);
  assert.match(html, /id="showAiButton" type="checkbox" checked/);
  assert.match(html, /id="settingsInterface" data-settings-panel="interface"/);
  assert.match(html, /Uncheck this option to remove the assistant shortcut/);
  assert.match(html, /rainbet-advisor-ai-button-visibility-v1/);
});

test("sound and vibration preferences default on and feedback avoids game outcomes", () => {
  assert.equal(readFeedbackPreference(null, "sound-effects"), true);
  assert.equal(readFeedbackPreference("enabled", "vibration"), true);
  assert.equal(readFeedbackPreference("disabled", "sound-effects"), false);
  assert.throws(() => readFeedbackPreference("invalid", "vibration"), /vibration preference has an unexpected value/);
  assert.match(html, /<input id="soundEffects" type="checkbox" aria-describedby="soundEffectsDescription soundEffectsStatus" checked> Play subtle sound effects/);
  assert.match(html, /Sound is on by default/);
  assert.match(html, /<input id="vibrationFeedback" type="checkbox" aria-describedby="vibrationFeedbackDescription vibrationFeedbackStatus" checked> Play short vibration feedback/);
  assert.match(html, /Random draws and game outcomes stay silent/);
  assert.match(html, /id="soundEffectsStatus"[^>]*aria-live="polite"/);
  assert.match(html, /id="vibrationFeedbackStatus"[^>]*aria-live="polite"/);
  const cardPickerStart = mainScript.indexOf("      function bindAdvisorCardPicker()");
  const cardPickerEnd = mainScript.indexOf("      let selectedFollowupSuit", cardPickerStart);
  const kenoSelectionStart = mainScript.indexOf("      function toggleKenoSpot(");
  const kenoSelectionEnd = mainScript.indexOf("      function clearKenoSelection(", kenoSelectionStart);
  const practiceAnswerStart = mainScript.indexOf("      function answerPractice(");
  const practiceAnswerEnd = mainScript.indexOf("      function resetLearningProgress(", practiceAnswerStart);
  assert.match(mainScript.slice(cardPickerStart, cardPickerEnd), /playInterfaceFeedback\("selection"\)/);
  assert.match(mainScript.slice(kenoSelectionStart, kenoSelectionEnd), /playInterfaceFeedback\(wasSelected \? "remove" : "selection"\)/);
  assert.match(mainScript.slice(practiceAnswerStart, practiceAnswerEnd), /if \(isCorrect\) playInterfaceFeedback\("correct"\)/);
});

test("command palette searches tools and settings by names and aliases", () => {
  const commands = [
    {label: "Blackjack advisor", keywords: "cards strategy recommend"},
    {label: "Keno odds", keywords: "numbers draw probability"},
    {label: "Appearance settings", keywords: "theme colors spacing"}
  ];
  assert.deepEqual(filterCommandPaletteCommands(commands, ""), commands);
  assert.deepEqual(filterCommandPaletteCommands(commands, "  BLACKJACK "), [commands[0]]);
  assert.deepEqual(filterCommandPaletteCommands(commands, "numbers"), [commands[1]]);
  assert.deepEqual(filterCommandPaletteCommands(commands, "theme"), [commands[2]]);
  assert.deepEqual(filterCommandPaletteCommands(commands, "no such tool"), []);
  assert.match(html, /id="openCommandPalette"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /id="commandPalette"[^>]*aria-labelledby="commandPaletteTitle"/);
  assert.match(html, /id="commandPaletteSearch" type="search"/);
  assert.match(html, /id="closeCommandPalette"/);
  assert.match(mainScript, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(mainScript, /event\.key === "ArrowDown"/);
  assert.match(mainScript, /event\.key === "Escape"\)\s*\{\s*event\.preventDefault\(\);\s*if \(dialog\.open\) dialog\.close\(\);/);
  assert.match(mainScript, /commandAfterClose = command/);
});

test("interface sounds stay lazy, soft, low-pitched, and rate-limited", () => {
  let contextCount = 0;
  let activeContext = null;
  const soundEvents = [];
  class FakeAudioContext {
    constructor() {
      contextCount++;
      activeContext = this;
      this.state = "running";
      this.currentTime = 2;
      this.destination = {};
    }
    createOscillator() {
      return {
        frequency: {
          setValueAtTime(value, time) { soundEvents.push(["frequency", value, time]); },
          exponentialRampToValueAtTime(value, time) { soundEvents.push(["frequencyRamp", value, time]); }
        },
        connect() {},
        start(time) { soundEvents.push(["start", time]); },
        stop(time) { soundEvents.push(["stop", time]); }
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime(value, time) { soundEvents.push(["gain", value, time]); },
          exponentialRampToValueAtTime(value, time) { soundEvents.push(["gainRamp", value, time]); }
        },
        connect() {}
      };
    }
  }
  const statuses = [];
  const disabledSound = createInterfaceSoundPlayer(false, {AudioContext: FakeAudioContext}, (message, isError) => {
    statuses.push({message, isError});
  });
  disabledSound("selection");
  assert.equal(contextCount, 0);

  const enabledSound = createInterfaceSoundPlayer(true, {AudioContext: FakeAudioContext}, (message, isError) => {
    statuses.push({message, isError});
  });
  enabledSound("correct");
  assert.equal(contextCount, 1);
  assert.ok(soundEvents.some(([name, value]) => name === "frequency" && value === 329.63));
  assert.ok(soundEvents.some(([name, time]) => name === "start" && time === 2));
  assert.ok(soundEvents.some(([name, time]) => name === "stop" && Math.abs(time - 2.12) < 1e-9));
  assert.ok(soundEvents.some(([name, value]) => name === "gainRamp" && value === 0.009));
  const firstSoundEventCount = soundEvents.length;
  enabledSound("correct");
  assert.equal(soundEvents.length, firstSoundEventCount);
  activeContext.currentTime = 2.121;
  enabledSound("selection");
  assert.ok(soundEvents.some(([name, value]) => name === "frequency" && value === 261.63));
  assert.deepEqual(statuses, []);
});

test("vibration feedback stays brief and patterned, stays off when disabled, and reports unsupported devices", () => {
  const requests = [];
  const statuses = [];
  const supportedWindow = {navigator: {vibrate(pattern) { requests.push(pattern); return true; }}};
  createVibrationPlayer(false, supportedWindow, (message, isError) => statuses.push({message, isError}))();
  assert.deepEqual(requests, []);
  createVibrationPlayer(true, supportedWindow, (message, isError) => statuses.push({message, isError}))();
  assert.deepEqual(requests, [8]);
  assert.deepEqual(statuses, []);
  const unsupportedPlayer = createVibrationPlayer(true, {navigator: {}}, (message, isError) => statuses.push({message, isError}));
  unsupportedPlayer();
  unsupportedPlayer();
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].message, /not supported/);
  assert.equal(statuses[0].isError, false);
});

test("personal stats are period-filtered, count conditional DAS as a match, and surface repeated misses", () => {
  const entry = (time, overrides = {}) => ({
    time,
    cards: ["10", "6"],
    dealer: "10",
    playerAction: "HIT",
    recommendedAction: "HIT",
    alternativeAction: null,
    result: null,
    ...overrides
  });
  const entries = [
    entry("2026-03-10T11:00:00.000Z", {playerAction: "SPLIT", recommendedAction: "SPLIT", cards: ["8", "8"], dealer: "6", result: "win"}),
    entry("2026-03-09T11:00:00.000Z", {playerAction: "STAND", recommendedAction: "HIT", result: "loss"}),
    entry("2026-03-08T11:00:00.000Z", {playerAction: "STAND", recommendedAction: "HIT", result: "push"}),
    entry("2026-03-07T11:00:00.000Z", {playerAction: null, result: null}),
    entry("2026-03-05T11:00:00.000Z", {playerAction: "DOUBLE", recommendedAction: "STAND", alternativeAction: "DOUBLE", result: "push"}),
    entry("2026-03-01T11:00:00.000Z", {result: "loss"})
  ];
  const stats = calculatePersonalStats(entries, [
    {attempts: 10, correct: 7},
    {attempts: 3, correct: 2}
  ], "7d", "2026-03-10T12:00:00.000Z");

  assert.equal(stats.handsAdvised, 5);
  assert.equal(stats.activeDays, 5);
  assert.equal(stats.reviewed, 4);
  assert.equal(stats.decisions.matched, 1);
  assert.equal(stats.decisions.conditional, 1);
  assert.equal(stats.decisions.different, 2);
  assert.equal(stats.actionAccuracy, 50);
  assert.deepEqual(stats.outcomes, {win: 1, loss: 1, push: 2});
  assert.equal(stats.practiceAccuracy, 9 / 13 * 100);
  assert.equal(stats.topMisses[0][1], 2);
  assert.match(stats.topMisses[0][0], /10, 6 vs dealer 10 · STAND instead of HIT/);
  assert.equal(calculatePersonalStats(entries, [], "all", "2026-03-10T12:00:00.000Z").handsAdvised, 6);
  assert.throws(() => calculatePersonalStats(entries, [], "90d", "2026-03-10T12:00:00.000Z"), /supported personal stats period/);
});

test("Keno match probabilities use the published ten-number draw and gross payout units", () => {
  const oneSpot = calculateKenoDistribution(1, 40);
  assert.equal(oneSpot.length, 2);
  assert.equal(oneSpot[0].probability, 0.75);
  assert.equal(oneSpot[1].probability, 0.25);
  for (const [spots, poolSize] of [[5, 40], [10, 56]]) {
    const distribution = calculateKenoDistribution(spots, poolSize);
    const totalProbability = distribution.reduce((sum, outcome) => sum + outcome.probability, 0);
    assert.ok(Math.abs(totalProbability - 1) < 1e-12);
  }
  const extreme = calculateKenoDistribution(10, 56);
  const expectedMatches = extreme.reduce((sum, outcome) => sum + outcome.matches * outcome.probability, 0);
  assert.ok(Math.abs(expectedMatches - (100 / 56)) < 1e-12);
  assert.equal(calculateKenoExpectedReturn(oneSpot, [0, 4]), 1);
  assert.throws(() => calculateKenoDistribution(0, 40), /between 1 and 10/);
  assert.throws(() => calculateKenoDistribution(5, 25), /supported Keno pool/);
  assert.throws(() => calculateKenoExpectedReturn(oneSpot, [0, -1]), /nonnegative gross payout/);
});

test("Keno modes expose complete displayed payout tables and mode-specific return odds", () => {
  for (const [mode, expectedPool, expectedRtp, expectedMaximum] of [
    ["classic", 40, 0.99, 100],
    ["low", 40, 0.99, 1000],
    ["medium", 40, 0.99, 1000],
    ["high", 40, 0.99, 1000],
    ["extreme", 56, 0.98, 10000]
  ]) {
    const config = getKenoModeConfig(mode);
    assert.equal(config.poolSize, expectedPool);
    assert.equal(config.maximumMultiplier, expectedMaximum);
    for (let spots = 1; spots <= 10; spots++) {
      const payouts = getKenoPayoutMultipliers(mode, spots);
      assert.equal(payouts.length, spots + 1, `${mode} ${spots}-spot table should cover every match count`);
      assert.ok(payouts.every((payout) => Number.isFinite(payout) && payout >= 0 && payout <= expectedMaximum));
      const distribution = calculateKenoDistribution(spots, expectedPool);
      const totalProbability = distribution.reduce((sum, outcome) => sum + outcome.probability, 0);
      assert.ok(Math.abs(totalProbability - 1) < 1e-12);
      const expectedReturn = calculateKenoExpectedReturn(distribution, payouts);
      assert.ok(Math.abs(expectedReturn - expectedRtp) < 0.02,
        `${mode} ${spots}-spot return should match the displayed mode RTP`);
    }
  }
  assert.deepEqual(getKenoPayoutMultipliers("low", 2), [0, 2, 3.8]);
  assert.equal(getKenoPayoutMultiplier("low", 1, 0), 0.7);
  assert.deepEqual(getKenoPayoutMultipliers("extreme", 10), [0, 0, 0, 0, 3.28, 44, 300, 1500, 5000, 8000, 10000]);
  assert.equal(formatKenoMultiplier(1000), "1,000x");
  assert.throws(() => getKenoModeConfig("unknown"), /supported Keno mode/);
  assert.throws(() => getKenoPayoutMultipliers("classic", 0), /between 1 and 10/);
  assert.throws(() => getKenoPayoutMultiplier("classic", 1, 2), /valid Keno match count/);
});

test("Keno practice draws select unique in-range numbers without replacement", () => {
  const normalDraw = drawKenoNumbers(40, 10, () => 0);
  assert.deepEqual(normalDraw, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const extremeDraw = drawKenoNumbers(56, 10, () => 0.999);
  assert.equal(extremeDraw.length, 10);
  assert.equal(new Set(extremeDraw).size, 10);
  assert.ok(extremeDraw.every((number) => Number.isInteger(number) && number >= 1 && number <= 56));
  assert.throws(() => drawKenoNumbers(48, 10, () => 0), /valid Keno pool/);
  assert.throws(() => drawKenoNumbers(40, 41, () => 0), /valid Keno pool/);
  assert.throws(() => drawKenoNumbers(40, 10, () => 1), /random source/);
});

test("Keno spot selection toggles off and enforces the ten-spot cap", () => {
  const selected = new Set();
  for (let number = 1; number <= 10; number++) {
    assert.equal(toggleKenoSelection(selected, number, 40), "added");
  }
  assert.equal(toggleKenoSelection(selected, 11, 40), "limit");
  assert.equal(selected.size, 10);
  assert.equal(toggleKenoSelection(selected, 1, 40), "removed");
  assert.equal(toggleKenoSelection(selected, 11, 40), "added");
  assert.throws(() => toggleKenoSelection(selected, 41, 40), /active Keno board/);
});

test("Mines survival probabilities compound without replacement and validate board limits", () => {
  const odds = calculateMinesOdds(25, 3, 3);
  assert.equal(odds.steps[0].chanceSafe, 22 / 25);
  assert.equal(odds.steps[1].chanceSafe, 21 / 24);
  assert.ok(Math.abs(odds.survivalProbability - ((22 / 25) * (21 / 24) * (20 / 23))) < 1e-12);
  assert.equal(odds.nextPickSafeProbability, 19 / 22);
  assert.ok(Math.abs(odds.breakEvenGrossMultiplier - 1 / odds.survivalProbability) < 1e-12);
  assert.equal(calculateMinesOdds(64, 1, 63).survivalProbability, 1 / 64);
  assert.equal(calculateMinesExpectedReturn(0.5, 1.9), 0.95);
  assert.throws(() => calculateMinesOdds(25, 24, 2), /no more than the number of safe tiles/);
  assert.throws(() => calculateMinesOdds(25, 0, 1), /number of mines must be/);
  assert.throws(() => calculateMinesOdds(30, 2, 1), /supported Mines grid size/);
  assert.throws(() => calculateMinesExpectedReturn(0.5, -1), /valid survival probability/);
});

test("site stats payload validation accepts aggregate metrics and rejects malformed values", () => {
  const stats = {
    dateRange: "30d",
    visitors: 42,
    visits: 58,
    pageviews: 91,
    visitDurationSeconds: 72.5,
    bounceRate: 31.4,
    topPages: [{path: "/", visitors: 42, pageviews: 50}]
  };
  assert.equal(isValidSiteStatsPayload(stats), true);
  assert.equal(isValidSiteStatsPayload({...stats, bounceRate: 110}), false);
  assert.equal(isValidSiteStatsPayload({...stats, topPages: [{path: "/", visitors: NaN, pageviews: 2}]}), false);
});

test("settings provide private account, appearance, interface, privacy, practice, and data sections", () => {
  const moduleSource = fs.readFileSync(path.join(__dirname, "rainbet-cloud-history.mjs"), "utf8");
  const firebaseConfig = fs.readFileSync(path.join(__dirname, "rainbet-firebase-config.js"), "utf8");
  const renderConfig = fs.readFileSync(path.join(__dirname, "render.yaml"), "utf8");
  ["account", "appearance", "interface", "privacy", "practice", "data"].forEach((section) => {
    assert.match(html, new RegExp(`data-settings-target="${section}"`));
    assert.match(html, new RegExp(`data-settings-panel="${section}"`));
  });
  assert.match(html, /id="themeSelect"/);
  assert.match(html, /id="compactLayout"/);
  assert.match(html, /id="reduceMotion"/);
  assert.match(html, /id="showAiButton"/);
  assert.match(html, /Private to your account and not globally unique/);
  assert.match(html, /restore synced hand history across devices/);
  assert.match(html, /signing in alone does not grant paid access/);
  assert.match(moduleSource, /async loadProfile\(\)/);
  assert.match(moduleSource, /async saveProfile\(displayName\)/);
  assert.match(moduleSource, /async clearProfile\(\)/);
  assert.match(moduleSource, /async mergeHistory\(localEntries, mergeEntries\)/);
  assert.match(firestoreRules, /match \/users\/\{userId\}\/profile\/\{profileId\}/);
  assert.match(firestoreRules, /request\.auth\.uid == userId\s*&&\s*profileId == "current"/);
  assert.match(firestoreRules, /displayName\.matches\("\^\[A-Za-z0-9_-\]\{3,20\}\$"\)/);
  assert.match(html, /data-feature-target="stats"/);
  assert.match(html, /data-feature-panel="stats"/);
  assert.match(html, /id="personalStatsPeriod"/);
  assert.match(html, /id="practiceStatsWeakSpots"/);
  assert.match(html, /id="siteStatsResults"/);
  assert.match(html, /id="loadSiteStats"/);
  assert.match(html, /data-feature-target="keno"/);
  assert.match(html, /data-feature-panel="keno"/);
  assert.match(html, /id="kenoBoard"/);
  assert.match(html, /id="kenoQuickPick"/);
  assert.match(html, /id="kenoClearPicks"/);
  assert.match(html, /id="kenoDrawNumbers"/);
  assert.match(html, /id="kenoOddsRows"/);
  assert.match(html, /Numbers 1–40 · 10 numbers drawn/);
  assert.match(html, /option value="extreme">Extreme · 10,000× max/);
  assert.doesNotMatch(html, /kenoPayoutInputs/);
  assert.match(html, /data-feature-target="mines"/);
  assert.match(html, /data-feature-panel="mines"/);
  assert.match(html, /id="minesOddsRows"/);
  assert.match(moduleSource, /async loadSiteStats\(dateRange\)/);
  assert.match(firebaseConfig, /rainbetAnalyticsDomain/);
  assert.match(renderConfig, /PLAUSIBLE_STATS_API_KEY/);
  assert.match(renderConfig, /PLAUSIBLE_SITE_ID/);
  assert.match(renderConfig, /SITE_STATS_ADMIN_EMAILS/);
  assert.match(renderConfig, /STRIPE_SECRET_KEY/);
  assert.match(renderConfig, /STRIPE_WEBHOOK_SECRET/);
  assert.match(renderConfig, /STRIPE_TRIAL_PRICE_ID/);
  assert.match(renderConfig, /STRIPE_MONTHLY_PRICE_ID/);
});

test("privacy disclosures explain local data, account sync, and optional providers", () => {
  assert.match(html, /Start \$1 intro week/);
  assert.match(html, /Upgrade for \$10\/month/);
  assert.match(html, /\$1 USD today for 7 days, then \$10 USD\/month starting on day 8 unless canceled before renewal/);
  assert.match(html, /id="membershipBillingConsent"/);
  assert.match(mainScript, /api\/billing\/trial/);
  assert.match(mainScript, /api\/billing\/checkout/);
  assert.match(mainScript, /api\/billing\/cancel-intro/);
  assert.match(html, /id="privacyPolicyDialog"/);
  assert.match(html, /id="welcomeDialog"/);
  assert.match(html, /id="welcomePrivacyAccept"/);
  assert.match(html, /id="welcomeUsageAccept"/);
  assert.match(html, /id="acceptWelcome"[^>]*disabled/);
  assert.match(mainScript, /rainbet-welcome-policy-consent-v1/);
  assert.match(mainScript, /accepted-v1/);
  assert.match(html, /id="usagePolicyDialog"/);
  assert.match(html, /guicepig@gmail\.com/);
  assert.match(html, /cards, moves, outcomes, and wager amounts/);
  assert.match(html, /card ranks you enter, dealer upcard, and selected rule toggles are sent to the operator's server/);
  assert.match(html, /offline by default/);
  assert.match(html, /does not connect to Rainbet/);
  assert.match(html, /fictional credits only/);
  assert.match(html, /at least 30 chronological predictions/);
  assert.match(html, /positive approximate paired Brier-improvement lower bound/);
  assert.match(html, /Never use these amounts or progressions for real-money wagers/);
  assert.match(html, /Optional membership features are processed through Stripe/);
  assert.match(html, /L’accès payant, lorsqu’il est configuré, nécessite une connexion Google et est traité par Stripe/);
  assert.doesNotMatch(html, /Aucun abonnement payant ni paiement n’est actuellement offert/);
  assert.match(html, /Firebase must have Google sign-in enabled, the site's domain authorized/);
  assert.match(html, /Your balance, practice progress, preferences, and session-limit entries stay in this browser/);
  assert.match(html, /Optional shared hand statistics/);
  assert.match(html, /Existing history is not uploaded/);
  assert.match(html, /cannot be tied back to an individual/);
  assert.match(html, /FIREBASE_SERVICE_ACCOUNT_JSON/);
  assert.match(firestoreRules, /match \/trainingAggregates\/\{scenarioId\}\s*\{\s*allow read, write: if false;/);
  assert.match(firestoreRules, /match \/trainingReceipts\/\{receiptId\}\s*\{\s*allow read, write: if false;/);
  assert.match(html, /aria-label="Optional analytics preferences"/);
  assert.match(html, /Version française/);
  assert.match(serverSource, /script-src[^"]*https:\/\/plausible\.io/);
  assert.match(serverSource, /connect-src[^"]*https:\/\/plausible\.io/);
});

test("membership purchase is reachable from navigation and the advisor paywall", () => {
  assert.match(html, /id="openMembership">Membership<\/button>/);
  assert.match(html, /id="membershipRequiredPrompt" hidden/);
  assert.match(html, /id="openMembershipFromPrompt">View membership options<\/button>/);
  assert.match(html, /id="membershipOptions" tabindex="-1"/);
  assert.match(mainScript, /byId\("openMembership"\)\.addEventListener\("click", openMembershipOptions\)/);
  assert.match(mainScript, /byId\("openMembershipFromPrompt"\)\.addEventListener\("click", openMembershipOptions\)/);
});

test("Google sign-in errors explain Firebase setup and user-actionable failures", () => {
  const messageStart = mainScript.indexOf("      function getGoogleSignInErrorMessage(");
  const messageEnd = mainScript.indexOf("      function initializeCloudHistoryUi(", messageStart);
  assert.ok(messageStart >= 0 && messageEnd > messageStart, "Google sign-in error mapper should exist");
  const getGoogleSignInErrorMessage = new Function(
    mainScript.slice(messageStart, messageEnd) + "return getGoogleSignInErrorMessage;"
  )();
  assert.match(getGoogleSignInErrorMessage({code: "auth/unauthorized-domain"}), /exact site domain/);
  assert.match(getGoogleSignInErrorMessage({code: "auth/operation-not-allowed"}), /Enable the Google provider/);
  assert.match(getGoogleSignInErrorMessage({code: "auth/popup-closed-by-user"}), /closed before it finished/);
  assert.equal(getGoogleSignInErrorMessage({}), "Check the Firebase Google provider and authorized-domain settings, then try again.");
});

test("Google sign-in failures are visible beside the header account buttons", () => {
  const statusStart = mainScript.indexOf("      function setCloudHistoryStatus(");
  const statusEnd = mainScript.indexOf("      async function refreshMembershipStatus()", statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart, "cloud auth status updater should exist");
  const values = {
    googleHistoryStatus: {
      textContent: "",
      classList: {toggle(name, active) { this[name] = active; }}
    },
    googleHistoryHeaderStatus: {
      textContent: "",
      hidden: true,
      classList: {toggle(name, active) { this[name] = active; }}
    }
  };
  const setCloudHistoryStatus = new Function(
    "byId",
    mainScript.slice(statusStart, statusEnd) + "return setCloudHistoryStatus;"
  )((id) => values[id]);

  setCloudHistoryStatus("Google authentication failed.", true);
  assert.equal(values.googleHistoryHeaderStatus.textContent, "Google authentication failed.");
  assert.equal(values.googleHistoryHeaderStatus.hidden, false);
  assert.equal(values.googleHistoryHeaderStatus.classList.error, true);

  setCloudHistoryStatus("Firebase is ready.", false);
  assert.equal(values.googleHistoryHeaderStatus.hidden, true);
  assert.equal(values.googleHistoryHeaderStatus.classList.error, false);
});

test("Google sign-in supports mobile redirect and recovers popup-blocked desktop sign-in", () => {
  const moduleSource = fs.readFileSync(path.join(__dirname, "rainbet-cloud-history.mjs"), "utf8");
  assert.match(moduleSource, /function shouldUseGoogleSignInRedirect\(\)/);
  assert.match(moduleSource, /authSdk\.signInWithRedirect\(auth, provider\)/);
  assert.match(moduleSource, /authSdk\.signInWithPopup\(auth, provider\)/);
  assert.match(moduleSource, /Allow popups for this site/);
  assert.match(moduleSource, /authSdk\.getRedirectResult\(auth\)/);
  assert.match(moduleSource, /status: "auth-error"/);
});

test("website offers Google account creation alongside sign-in", () => {
  assert.match(html, /id="googleHistorySignUp"[^>]*>Sign up with Google<\/button>/);
  assert.match(html, /id="googleHistorySettingsSignUp"[^>]*>Sign up with Google<\/button>/);
  assert.match(html, /New accounts are created when you continue with Google for the first time/);
  assert.match(html, /id="googleHistoryHeaderStatus"[^>]*aria-live="polite"/);

  const controlsStart = mainScript.indexOf("      function updateCloudHistoryControls()");
  const controlsEnd = mainScript.indexOf("      function queueCloudHistorySave(", controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart, "account controls updater should exist");
  assert.match(mainScript.slice(controlsStart, controlsEnd), /googleHistorySignUp/);
  assert.match(mainScript.slice(controlsStart, controlsEnd), /googleHistorySettingsSignUp/);

  const uiStart = mainScript.indexOf("      function initializeCloudHistoryUi()");
  const uiEnd = mainScript.indexOf("      function toggleHistory()", uiStart);
  assert.ok(uiStart >= 0 && uiEnd > uiStart, "cloud-history UI initializer should exist");
  const uiSource = mainScript.slice(uiStart, uiEnd);
  assert.match(uiSource, /googleHistorySignUp"\)\.addEventListener\("click", \(\) => signInWithGoogle\(\)\)/);
  assert.match(uiSource, /googleHistorySettingsSignUp"\)\.addEventListener\("click", \(\) => signInWithGoogle\(\)\)/);
  assert.match(uiSource, /result\.isNewUser[\s\S]*Your Google account was created/);
});

test("Google create-account button creates new users and still signs in existing users", async () => {
  const uiStart = mainScript.indexOf("      function initializeCloudHistoryUi()");
  const uiEnd = mainScript.indexOf("      function toggleHistory()", uiStart);
  assert.ok(uiStart >= 0 && uiEnd > uiStart, "cloud-history UI initializer should exist");

  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        listeners: {},
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        }
      });
    }
    return elements.get(id);
  };
  const statuses = [];
  let createdAccountEvents = 0;
  const signInResults = [{isNewUser: true}, {isNewUser: false}];
  let signInCalls = 0;
  const initializeCloudHistoryUi = new Function(
    "byId",
    "window",
    "document",
    "handleCloudHistoryEvent",
    "cloudHistoryClient",
    "updateCloudHistoryControls",
    "setCloudHistoryStatus",
    "trackHistoryAccountCreated",
    "getGoogleSignInErrorMessage",
    "savePrivateProfileName",
    "syncCloudHistory",
    "startTrialMembershipCheckout",
    "startMembershipCheckout",
    "cancelUpcomingMembership",
    "openMembershipPortal",
    "let cloudHistorySigningIn = false;\n" +
      mainScript.slice(uiStart, uiEnd) +
      "return initializeCloudHistoryUi;"
  )(
    byId,
    {addEventListener() {}, location: {protocol: "https:"}},
    {
      createElement() {
        return {addEventListener() {}};
      },
      head: {appendChild() {}}
    },
    () => {},
    {signIn: async () => signInResults[signInCalls++]},
    () => {},
    (message) => statuses.push(message),
    () => { createdAccountEvents++; },
    (error) => error.message,
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {}
  );
  initializeCloudHistoryUi();

  await byId("googleHistorySignUp").listeners.click();
  await byId("googleHistorySignIn").listeners.click();

  assert.equal(signInCalls, 2);
  assert.equal(createdAccountEvents, 1, "only a newly created Google account is tracked as a signup");
  assert.ok(statuses.includes("Your Google account was created. Syncing hand history…"));
  assert.ok(statuses.includes("Opening Google sign-in…"));
});

test("membership status refresh updates account controls after the server response", async () => {
  const start = mainScript.indexOf("      async function refreshMembershipStatus()");
  const end = mainScript.indexOf("      async function startTrialMembershipCheckout()", start);
  assert.ok(start >= 0 && end > start, "membership status updater should exist");
  const elements = {
    membershipStatus: {textContent: ""},
    startTrialMembership: {hidden: false, disabled: false},
    upgradeMembership: {hidden: false, disabled: false},
    cancelUpcomingMembership: {hidden: false, disabled: false},
    manageMembership: {hidden: false, disabled: false}
  };
  const state = new Function(
    "byId",
    "cloudHistoryUser",
    "cloudHistoryClient",
    "fetch",
    "let membershipTier = 'free';\n" +
      "let membershipSubscriptionStatus = 'inactive';\n" +
      "let membershipTrialAvailable = true;\n" +
      "let membershipRenewalCanceled = false;\n" +
      "let membershipLoading = false;\n" +
      "let controlsRefreshes = 0;\n" +
      "function updateCloudHistoryControls() { controlsRefreshes++; }\n" +
      mainScript.slice(start, end) +
      "return {refreshMembershipStatus, getState: () => ({membershipTier, membershipLoading, controlsRefreshes})};"
  )(
    (id) => elements[id],
    {uid: "user-1"},
    {getBillingIdToken: async () => "id-token"},
    async () => ({
      ok: true,
      json: async () => ({tier: "paid", subscriptionStatus: "active"})
    })
  );
  await state.refreshMembershipStatus();
  assert.equal(state.getState().membershipTier, "paid");
  assert.equal(state.getState().membershipLoading, false);
  assert.equal(state.getState().controlsRefreshes, 1);
  assert.equal(elements.manageMembership.hidden, false);
  assert.equal(elements.startTrialMembership.hidden, true);
});

test("membership checkout buttons stay gated until consent and send the agreed billing flag", async () => {
  const start = mainScript.indexOf("      async function startTrialMembershipCheckout()");
  const end = mainScript.indexOf("      async function cancelUpcomingMembership()", start);
  assert.ok(start >= 0 && end > start, "membership checkout handlers should exist");
  const elements = {
    membershipBillingConsent: {checked: false},
    membershipStatus: {textContent: ""},
    startTrialMembership: {disabled: false},
    upgradeMembership: {disabled: false}
  };
  const requests = [];
  const redirects = [];
  const handlers = new Function(
    "byId",
    "cloudHistoryUser",
    "cloudHistoryClient",
    "fetch",
    "window",
    "let membershipLoading = false;\n" +
      "function updateCloudHistoryControls() {}\n" +
      mainScript.slice(start, end) +
      "return {startTrialMembershipCheckout, startMembershipCheckout};"
  )(
    (id) => elements[id],
    {uid: "user-1"},
    {getBillingIdToken: async () => "id-token"},
    async (url, options) => {
      requests.push({url, options});
      return {ok: true, json: async () => ({url: "https://checkout.stripe.test/session"})};
    },
    {location: {assign: (url) => redirects.push(url)}}
  );
  await handlers.startTrialMembershipCheckout();
  await handlers.startMembershipCheckout();
  assert.equal(requests.length, 0);

  elements.membershipBillingConsent.checked = true;
  await handlers.startTrialMembershipCheckout();
  await handlers.startMembershipCheckout();
  assert.deepEqual(requests.map(({url}) => url), ["/api/billing/trial", "/api/billing/checkout"]);
  assert.equal(requests.every(({options}) => JSON.parse(options.body).acceptRecurringBilling === true), true);
  assert.deepEqual(redirects, [
    "https://checkout.stripe.test/session",
    "https://checkout.stripe.test/session"
  ]);
});

test("saved-hand snapshot metrics recalculate whenever history refreshes", () => {
  const snapshotStart = mainScript.indexOf("      function updatePremiumSessionSnapshot(");
  const snapshotEnd = mainScript.indexOf("      let historySearchTimer", snapshotStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, "session snapshot updater should exist");
  const values = new Map();
  const updatePremiumSessionSnapshot = new Function(
    "byId",
    mainScript.slice(snapshotStart, snapshotEnd) + "return updatePremiumSessionSnapshot;"
  )((id) => ({
    set textContent(value) { values.set(id, value); }
  }));
  updatePremiumSessionSnapshot([
    {result: "win", playerAction: "HIT", recommendedAction: "HIT", netResult: 1.5},
    {result: null, playerAction: "STAND", recommendedAction: "HIT", netResult: -0.5}
  ]);
  assert.equal(values.get("premiumHandsSaved"), "2");
  assert.equal(values.get("premiumResolvedHands"), "1");
  assert.equal(values.get("premiumMatches"), "1/2");
  assert.equal(values.get("premiumSessionNet"), "+1.00 fake");

  const refreshStart = mainScript.indexOf("      function refreshHistory() {");
  const refreshEnd = mainScript.indexOf("      function saveHandResult()", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.match(mainScript.slice(refreshStart, refreshEnd), /updatePremiumSessionSnapshot\(entries\)/);
});

test("public page omits the strategy implementation and detailed action tables", () => {
  assert.doesNotMatch(mainScript, /\bfunction (?:actionFor|actionForContext|actionForSplitHand|hardAction|pairAction)\s*\(/);
  assert.doesNotMatch(html, /<td>8 or less<\/td>/);
  assert.doesNotMatch(html, /Soft 13–14/);
  assert.match(html, /exact decision implementation runs on the advisor server/i);
});

test("sticky advisor recommendation stays visible with a view-advice control", () => {
  assert.match(html, /id="stickyAdvisorRecommendation"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /id="stickyAdvisorAction"/);
  assert.match(html, /id="stickyAdvisorHand"/);
  assert.match(html, /id="showStickyAdvisor"/);
  assert.match(mainScript, /syncStickyAdvisorRecommendation/);
  assert.match(mainScript, /MutationObserver/);
  assert.match(mainScript, /sticky\.hidden = !advisorVisible \|\| hiddenForInput \|\| moveFollowupVisible/);
  assert.match(mainScript, /attributeFilter: \["hidden"\]/);
});

test("move follow-up panel stays in page flow to avoid covering the card table", () => {
  assert.match(html, /\.move-action-panel\s*\{\s*margin:/);
  assert.doesNotMatch(html, /\.move-action-panel\s*\{[^}]*position:\s*sticky/);
  assert.match(html, /What did you do\?/);
  assert.match(html, /What did you choose to do\?/);
});

test("navigation and advisor workflow use clear professional labels", () => {
  assert.match(html, /<h2 id="hand-title">Blackjack decision<\/h2>/);
  assert.match(html, /<span>1<\/span> Enter cards/);
  assert.match(html, /<span>2<\/span> Review advice/);
  assert.match(html, /<span>3<\/span> Record move/);
  assert.match(html, />Hand history<\/button>/);
  assert.match(html, />Practice<\/button>/);
  assert.match(html, /<summary>Tools<\/summary>/);
  assert.match(html, />Search tools<\/span>/);
  assert.match(html, />Ask assistant<\/button>/);
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
assert.ok(helperToggleStart >= 0 && helperToggleStart < helperReplyStart, "helper chat controls should be present");
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
  mainScript.slice(strategyStart, strategyEnd) + "return { handTotal, getAdvisorInputPrompt, calculateExposure, progressionUnits, fictionalWagerOutcomeHistory, handOutcomeQuarterKellyFraction, smoothOutcomeCounts, summarizeWagerOutcomes, calculateOutcomePatternModel, calculateSuggestedWager, classifyHistoryDecision, summarizeDecisionPatterns, historyPracticeScenarios, practiceAnswerKind, practiceScenarioKey, readLearningProgress, updateLearningProgress, practiceReviewScenarios };"
)(["unknown", "allowed", "not-allowed"], parseRank, "test-learning-progress", 250, 3, learningStorage, [1, 3, 7, 14], 10);
const {
  handTotal,
  getAdvisorInputPrompt,
  calculateExposure,
  progressionUnits,
  fictionalWagerOutcomeHistory,
  handOutcomeQuarterKellyFraction,
  smoothOutcomeCounts,
  summarizeWagerOutcomes,
  calculateOutcomePatternModel,
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
  const buttons = ["advisor", "simulator", "strategy", "practice", "keno", "mines"].map((feature) => ({
    dataset: {featureTarget: feature},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  }));
  const panels = ["advisor", "advisor", "simulator", "strategy", "practice", "keno", "mines"].map((feature) => ({
    dataset: {featurePanel: feature},
    hidden: true
  }));

  setActiveFeature("practice", buttons, panels);
  assert.deepEqual(buttons.map((button) => button.attributes["aria-pressed"]),
    ["false", "false", "false", "true", "false", "false"]);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, true, true, true, false, true, true]);

  setActiveFeature("keno", buttons, panels);
  assert.deepEqual(buttons.map((button) => button.attributes["aria-pressed"]),
    ["false", "false", "false", "false", "true", "false"]);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, true, true, true, true, false, true]);

  setActiveFeature("mines", buttons, panels);
  assert.deepEqual(buttons.map((button) => button.attributes["aria-pressed"]),
    ["false", "false", "false", "false", "false", "true"]);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, true, true, true, true, true, false]);

  setActiveFeature("advisor", buttons, panels);
  assert.deepEqual(panels.map((panel) => panel.hidden), [false, false, true, true, true, true, true]);
  assert.throws(() => setActiveFeature("unknown", buttons, panels), /Unknown advisor feature/);
});

test("sticky navigation AI control opens accessibly and does not float over page content", () => {
  const navStart = html.indexOf('<nav class="quick-nav"');
  const navEnd = html.indexOf("</nav>", navStart);
  assert.ok(navStart >= 0 && navEnd > navStart, "sticky feature navigation should exist");
  assert.match(html.slice(navStart, navEnd), /id="toggleHelperChat"/);
  assert.doesNotMatch(html, /class="ai-launcher"/);

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
  const aborts = [];
  const strategyRequestState = {
    version: 0,
    controller: {abort() { aborts.push(true); }}
  };
  const timers = new Map();
  let nextTimerId = 0;
  const window = {
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback, delay) {
      assert.equal(delay, 80);
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    }
  };
  const bindLiveAdvisorInputs = new Function(
    "byId",
    "window",
    "strategyRequestState",
    "decide",
    mainScript.slice(liveInputBinderStart, liveInputBinderEnd) + "return bindLiveAdvisorInputs;"
  )((id) => fields[id], window, strategyRequestState, (...args) => calls.push(args));

  bindLiveAdvisorInputs();
  fields.playerCards.listeners.input();
  fields.hitCards.listeners.input();
  fields.splitHandCards.listeners.input();
  fields.splitHand2Cards.listeners.input();
  fields.dealer.listeners.change();
  fields.doubleAllowed.listeners.change();
  fields.splitAllowed.listeners.change();
  assert.equal(aborts.length, 1);
  assert.equal(strategyRequestState.version, 1);
  assert.equal(strategyRequestState.controller, null);
  assert.equal(calls.length, 0);
  assert.equal(timers.size, 1);
  Array.from(timers.values())[0]();
  assert.deepEqual(calls, [[]]);
});

test("visual card picker adds and removes selected cards in the advice input state", () => {
  assert.match(html, /<select id="advisorCardRank" aria-describedby="advisorCardInstruction">/);
  assert.match(html, /class="suit-picker" role="group" aria-labelledby="advisorSuitLabel" aria-describedby="advisorCardInstruction"/);
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
      },
      scrollIntoView(options) { this.scrollOptions = options; },
      focus(options) { this.focusOptions = options; }
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
    advisorCardControls: fakeElement(),
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
  let prefersReducedMotion = false;
  const fakeWindow = {
    setTimeout() {},
    matchMedia(query) {
      assert.equal(query, "(prefers-reduced-motion: reduce)");
      return {matches: prefersReducedMotion};
    }
  };
  const picker = new Function(
    "byId",
    "document",
    "parseRank",
    "handTotal",
    "decide",
    "window",
    "playInterfaceFeedback",
    "playVibrationFeedback",
    mainScript.slice(pickerStart, pickerEnd) +
      "return {bindAdvisorCardPicker, setSplitVisualActive, setSplitInputAvailability, updateSplitHandProgress, setSplitInitialDealStep(value) { splitInitialDealStep = value; }, setActiveSplitHand(value) { activeSplitHand = value; }, setSplitHandFinished(handNumber, value) { splitHandFinished[handNumber - 1] = value; }};"
  )((id) => elements[id], document, parseRank, handTotal, () => { previewUpdates++; }, fakeWindow, () => {}, () => {});

  picker.bindAdvisorCardPicker();
  assert.equal(elements.advisorPlayerCards.children.length, 2);
  targetButtons[0].click();
  assert.equal(elements.addAdvisorCard.textContent, "Set dealer upcard");
  assert.match(elements.advisorCardInstruction.textContent, /Selected area: dealer upcard/);
  assert.equal(targetButtons[0].attributes["aria-label"], "Choose dealer upcard as the card-entry area");
  assert.deepEqual(elements.advisorCardControls.scrollOptions, {behavior: "smooth", block: "center"});
  assert.deepEqual(elements.advisorCardRank.focusOptions, {preventScroll: true});
  prefersReducedMotion = true;
  targetButtons[1].click();
  assert.equal(elements.advisorCardControls.scrollOptions.behavior, "auto");
  prefersReducedMotion = false;
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

  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  targetButtons[0].click();
  for (const rank of ranks) {
    elements.advisorCardRank.value = rank;
    for (const suitButton of suitButtons) {
      suitButton.click();
      elements.addAdvisorCard.click();
      assert.equal(elements.dealer.value, rank);
      assert.deepEqual(
        elements.advisorDealerCards.children[0].children[0].children.map((part) => part.textContent),
        [rank, {"diamonds": "♦", "hearts": "♥", "spades": "♠", "clubs": "♣"}[suitButton.dataset.advisorSuit]]
      );
    }
  }
  assert.equal(elements.playerCards.value, "10, 6", "testing every card choice preserves the starting hand");
  targetButtons[1].click();
  elements.advisorCardRank.value = "4";
  suitButtons[1].click();

  picker.setSplitInputAvailability(true);
  targetButtons[4].click();
  assert.equal(elements.advisorCardTarget.value, "player", "split hand targets stay locked until the split is active");
  picker.setSplitVisualActive(true);
  assert.equal(elements.advisorSplitPresentation.hidden, false);
  assert.equal(elements.advisorPlayerZone.hidden, true);
  assert.equal(elements.advisorHitZone.hidden, true);
  assert.equal(elements.advisorSplitHandOneCards.children[0].classList.contains("split-card-left"), true);
  assert.equal(elements.advisorSplitHandTwoCards.children[0].classList.contains("split-card-right"), true);
  picker.setSplitInitialDealStep(1);
  elements.advisorCardControls.hidden = true;
  picker.updateSplitHandProgress();
  assert.equal(targetButtons[3].disabled, true, "split targets stay unavailable while the move panel deals the initial cards");
  assert.equal(targetButtons[4].disabled, true);
  elements.advisorCardTarget.value = "split";
  elements.addAdvisorCard.click();
  assert.equal(elements.splitHandCards.value, "", "the card picker cannot bypass the required first card for each split hand");
  assert.match(elements.advisorCardStatus.textContent, /using the move follow-up/);
  picker.setSplitInitialDealStep(0);
  elements.advisorCardControls.hidden = false;
  picker.updateSplitHandProgress();
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
  picker.setSplitHandFinished(1, true);
  picker.setActiveSplitHand(2);
  picker.updateSplitHandProgress();
  assert.equal(targetButtons[3].disabled, true, "the completed hand cannot be selected");
  assert.equal(targetButtons[4].disabled, false, "the next hand becomes selectable");
  targetButtons[4].click();
  elements.advisorCardRank.value = "7";
  suitButtons[3].click();
  elements.addAdvisorCard.click();
  assert.equal(elements.splitHand2Cards.value, "7");
  assert.deepEqual(
    elements.advisorSplitHandTwoCards.children[1].children[0].children.map((part) => part.textContent),
    ["7", "♣"]
  );
  elements.advisorSplitHandTwoCards.children[1].children[1].click();
  assert.equal(elements.splitHand2Cards.value, "");

  picker.setSplitVisualActive(false);
  assert.equal(elements.advisorSplitPresentation.hidden, true);
  assert.equal(elements.advisorPlayerZone.hidden, false);
  assert.equal(elements.advisorHitZone.hidden, false);
  elements.advisorCardControls.hidden = true;
  picker.setSplitInputAvailability(false);
  assert.equal(elements.advisorCardControls.hidden, false, "leaving split mode restores the card picker");
  assert.equal(elements.splitHandCards.value, "");
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

test("standing on split hand 1 advances advice to split hand 2", async () => {
  const elements = {
    moveFollowupAction: {value: "STAND"},
    moveFollowupResponse: {textContent: ""},
    moveFollowup: {hidden: false},
    moveActionPanel: {hidden: false},
    moveActionButtons: {hidden: false},
    advisorCardControls: {hidden: true}
  };
  const splitHandFinished = [true, false];
  const selectedTargets = [];
  let decisionCount = 0;
  const advanceStart = mainScript.indexOf("      async function advanceSplitHand(");
  const advanceEnd = mainScript.indexOf("      function currentFinalPlayerCardRanks()", advanceStart);
  assert.ok(advanceStart >= 0 && advanceEnd > advanceStart, "split-hand advance function should be present");
  const state = new Function(
    "byId",
    "splitHandFinished",
    "selectAdvisorCardTarget",
    "updateMoveFollowupControls",
    "decide",
    "beginDealerTurn",
    "let activeSplitHand = 1;" +
      mainScript.slice(advanceStart, advanceEnd) +
      "return {advanceSplitHand, get activeSplitHand() { return activeSplitHand; }};"
  )(
    (id) => elements[id],
    splitHandFinished,
    (target) => selectedTargets.push(target),
    () => {},
    async () => { decisionCount++; },
    () => { throw new Error("dealer turn should not start while split hand 2 is unfinished"); }
  );

  await state.advanceSplitHand("Split hand 1 stood.");
  assert.equal(state.activeSplitHand, 2);
  assert.deepEqual(selectedTargets, ["split2"]);
  assert.equal(elements.moveFollowupResponse.textContent, "Split hand 1 stood. Now play split hand 2.");
  assert.equal(decisionCount, 1);
});

test("split aces auto-stand both hands after their initial cards", async () => {
  const elements = {
    moveFollowupAction: {value: "SPLIT"},
    moveFollowupRank: {value: "4"},
    moveFollowupResponse: {textContent: ""},
    splitHandCards: {value: "2"},
    splitHand2Cards: {value: ""}
  };
  const advisorCardState = {
    player: [{rank: "A", suit: "spades"}, {rank: "A", suit: "hearts"}],
    dealer: [],
    hit: [],
    split: [{rank: "2", suit: "clubs"}],
    split2: []
  };
  const finished = [false, false];
  const results = [];
  let advanceReason = "";
  const applyStart = mainScript.indexOf("      async function applyMoveFollowup() {");
  const applyEnd = mainScript.indexOf("      function bindMoveFollowup()", applyStart);
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
    mainScript.slice(applyStart, applyEnd) + "return applyMoveFollowup;"
  )(
    (id) => elements[id],
    parseRank,
    handTotal,
    [{id: "hearts", name: "Hearts"}],
    advisorCardState,
    true,
    "hearts",
    () => { elements.splitHand2Cards.value = advisorCardState.split2.map((card) => card.rank).join(", "); },
    () => {},
    {querySelectorAll() { return []; }},
    async () => {},
    false,
    () => {},
    () => {},
    true,
    2,
    2,
    finished,
    (handNumber, result) => {
      finished[handNumber - 1] = true;
      results[handNumber - 1] = result;
    },
    async (reason) => { advanceReason = reason; }
  );

  await applyMoveFollowup();
  assert.deepEqual(advisorCardState.split2, [{rank: "4", suit: "hearts"}]);
  assert.deepEqual(finished, [true, true]);
  assert.match(results[0], /stood automatically/i);
  assert.match(results[1], /stood automatically/i);
  assert.equal(advanceReason, "Both split hands received their first card.");
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
    assert.match(helperReply(greeting), /Keno and Mines odds tools/);
  }
  assert.match(helperReply("How do Keno and Mines odds work?"), /tap 1–10 board numbers.*draw 10 practice numbers/s);
  assert.match(helperReply("What is DAS?"), /DAS means double after split/);
  assert.match(helperReply("How do I use the advisor?"), /click Add here/);
  assert.match(helperReply("How does the simulator work?"), /fictional credits/);
  assert.match(helperReply("How does practice learning work?"), /missed scenarios return sooner/);
  assert.match(helperReply("Are you as capable as you?"), /not a general-purpose generative AI/);
  assert.match(helperReply("How much should I wager?"), /fictional pre-deal stake/);
  assert.match(helperReply("How much should I wager?"), /recent-20 W\/P\/L pattern/);
  assert.match(helperReply("What is a soft hand?"), /ace currently counted as 11/);
  assert.match(helperReply("What does split mean?"), /separates a pair into two hands/);
  assert.match(helperReply("What does 3:2 mean?"), /1\.5 times the original wager/);
  assert.match(helperReply("Can I count cards?"), /does not count cards/);
  assert.match(helperReply("What factors does the advisor use?"), /8-deck S17 rank-probability model/);
  assert.match(helperReply("What factors does the advisor use?"), /does not track earlier hands/);
  assert.match(helperReply("I want the advisor to learn based on history of past bets"), /uses saved outcomes for a separate fictional pre-deal stake/);
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

test("advisor accepts every two-card rank pair across dealer cards and table-rule settings", () => {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const rankCard = (rank) => ({
    rank,
    value: rank === "A" ? 11 : ["J", "Q", "K"].includes(rank) ? 10 : Number(rank)
  });
  const actions = new Set(["HIT", "STAND", "DOUBLE", "SPLIT"]);
  let cases = 0;
  for (const firstRank of ranks) {
    for (const secondRank of ranks) {
      for (const dealer of dealerCards) {
        for (const doubleAllowed of [false, true]) {
          for (const splitAllowed of [false, true]) {
            for (const dasRule of ["unknown", "allowed", "not-allowed"]) {
              const result = actionFor([rankCard(firstRank), rankCard(secondRank)], card(dealer), {
                doubleAllowed,
                splitAllowed,
                dasRule
              });
              assert.ok(actions.has(result.action), `${firstRank},${secondRank} vs ${dealer}: action`);
              assert.ok(result.alternativeAction === null || actions.has(result.alternativeAction));
              assert.ok(Number.isInteger(result.hand.total) && result.hand.total >= 2 && result.hand.total <= 21);
              cases++;
            }
          }
        }
      }
    }
  }
  assert.equal(cases, ranks.length ** 2 * dealerCards.length * 2 * 2 * 3);
});

test("advisor accepts all three-card rank combinations against every dealer upcard", () => {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const rankCard = (rank) => ({
    rank,
    value: rank === "A" ? 11 : ["J", "Q", "K"].includes(rank) ? 10 : Number(rank)
  });
  const actions = new Set(["HIT", "STAND", "DOUBLE"]);
  let cases = 0;
  for (const firstRank of ranks) {
    for (const secondRank of ranks) {
      for (const thirdRank of ranks) {
        for (const dealer of dealerCards) {
          const result = actionFor(
            [rankCard(firstRank), rankCard(secondRank), rankCard(thirdRank)],
            card(dealer),
            {doubleAllowed: true, splitAllowed: false, dasRule: "unknown"}
          );
          assert.ok(actions.has(result.action), `${firstRank},${secondRank},${thirdRank} vs ${dealer}: action`);
          assert.ok(Number.isInteger(result.hand.total) && result.hand.total >= 3 && result.hand.total <= 30);
          cases++;
        }
      }
    }
  }
  assert.equal(cases, ranks.length ** 3 * dealerCards.length);
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
  for (const action of ["hit", "stand", "double"]) {
    const probabilities = soft17.outcomeProbabilities[action];
    assert.ok(probabilities, `${action} outcome probabilities are available`);
    assert.ok(Math.abs(probabilities.win + probabilities.push + probabilities.loss - 1) < 1e-12);
  }
  assert.ok(Math.abs(soft17.values.double -
    2 * (soft17.outcomeProbabilities.double.win - soft17.outcomeProbabilities.double.loss)) < 1e-12,
  "double EV reflects twice the initial wager");

  assert.equal(expectedValueActionAnalysis([card(10), card(6)], card(10), {
    doubleAllowed: true,
    afterSplit: false
  }), null);
});

test("recommendation panel exposes visible win push and loss percentages", () => {
  assert.match(html, /id="currentHandOutcomeCard"/);
  assert.match(html, /advisor-wager-details/);
  assert.match(html, /How this stake is calculated/);
  assert.match(html, /id="primaryMove"/);
  assert.match(html, /id="primaryStake"/);
  assert.match(html, /id="primaryWinChance"/);
  assert.match(html, /id="primaryPushChance"/);
  assert.match(html, /id="primaryLossChance"/);
  assert.match(html, /id="currentHandWinChance"/);
  assert.match(html, /id="currentHandPushChance"/);
  assert.match(html, /id="currentHandLossChance"/);
  assert.match(html, /function renderCurrentHandOutcome\(result\)/);
  assert.match(html, /Estimated for " \+ actionKey\.toUpperCase\(\)/);
});

test("advisor can render current-hand outcome percentages", () => {
  const renderStart = mainScript.indexOf("      function renderCurrentHandOutcome(");
  const refreshStart = mainScript.indexOf("      function refreshHistory()");
  const saveResultStart = mainScript.indexOf("      function saveHandResult()", refreshStart);
  assert.ok(renderStart >= 0 && refreshStart > renderStart, "outcome renderer should be outside refreshHistory");
  assert.ok(saveResultStart > refreshStart, "history refresh function should exist");
  assert.doesNotMatch(mainScript.slice(refreshStart, saveResultStart), /function renderCurrentHandOutcome/,
    "outcome renderer should not be scoped inside refreshHistory");
  const ids = [
    "currentHandWinChance", "currentHandPushChance", "currentHandLossChance",
    "currentHandOutcomeNote", "primaryWinChance", "primaryPushChance", "primaryLossChance"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, {textContent: "—"}]));
  const renderCurrentHandOutcome = new Function(
    "byId",
    mainScript.slice(renderStart, refreshStart) + "return renderCurrentHandOutcome;"
  )((id) => elements[id] || null);

  renderCurrentHandOutcome({
    hand: {total: 18},
    action: "HIT",
    analysis: {
      bestAction: "stand",
      outcomeProbabilities: {stand: {win: 0.45, push: 0.1, loss: 0.45}}
    }
  });

  assert.equal(elements.currentHandWinChance.textContent, "45.0%");
  assert.equal(elements.currentHandPushChance.textContent, "10.0%");
  assert.equal(elements.currentHandLossChance.textContent, "45.0%");
  assert.equal(elements.primaryWinChance.textContent, "45.0%");
  assert.equal(elements.primaryPushChance.textContent, "10.0%");
  assert.equal(elements.primaryLossChance.textContent, "45.0%");
  assert.match(elements.currentHandOutcomeNote.textContent, /Estimated for STAND/);
});

test("current-hand outcome distributions normalize for all supported starting hands and dealer upcards", () => {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  for (const first of ranks) {
    for (const second of ranks) {
      for (const dealer of [2, 3, 4, 5, 6, 7, 8, 9]) {
        const analysis = expectedValueActionAnalysis([card(first), card(second)], card(dealer), {
          doubleAllowed: true,
          afterSplit: false
        });
        assert.ok(analysis);
        for (const [action, outcomes] of Object.entries(analysis.outcomeProbabilities)) {
          assert.ok(Math.abs(outcomes.win + outcomes.push + outcomes.loss - 1) < 1e-12,
            `${first},${second} vs ${dealer} ${action} probabilities sum to one`);
        }
        if (analysis.values.double !== undefined) {
          assert.ok(Math.abs(analysis.values.double -
            2 * (analysis.outcomeProbabilities.double.win - analysis.outcomeProbabilities.double.loss)) < 1e-12);
        }
      }
    }
  }
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

test("split aces automatically stand after receiving one card", () => {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const rankCard = (rank) => ({
    rank,
    value: rank === "A" ? 11 : ["J", "Q", "K"].includes(rank) ? 10 : Number(rank)
  });
  let cases = 0;
  for (const drawRank of ranks) {
    for (const dealer of dealerCards) {
      const result = actionForContext([card("A"), rankCard(drawRank)], card(dealer), {
        doubleAllowed: true,
        splitAllowed: false,
        dasRule: "allowed",
        afterSplit: true
      });
      assert.equal(result.action, "STAND", `split A,${drawRank} vs ${dealer}`);
      assert.equal(result.alternativeAction, null);
      assert.match(result.explanation, /split-ace rule.*one card.*stands automatically/i);
      cases++;
    }
  }
  assert.equal(cases, ranks.length * dealerCards.length);
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

test("history search coalesces typing and updates only the filtered list", () => {
  const rendererStart = mainScript.indexOf("      function renderHistoryEntries(entries) {");
  const rendererEnd = mainScript.indexOf("      function refreshHistorySearchResults() {", rendererStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, "history list renderer should exist");

  const elements = {
    historyList: {
      children: [],
      textContent: "",
      appendChild(item) { this.children.push(item); }
    },
    historySearch: {value: "split"},
    historyFilterSummary: {textContent: ""}
  };
  const renderHistoryEntries = new Function(
    "byId",
    "document",
    "historyMatchesSearch",
    "classifyHistoryDecision",
    mainScript.slice(rendererStart, rendererEnd) + "return renderHistoryEntries;"
  )((id) => elements[id], {createElement: () => ({textContent: ""})},
  historyMatchesSearch, classifyHistoryDecisionForStats);
  const entries = [
    {time: "2026-10-12T10:00:00.000Z", cards: ["8", "8"], dealer: "10", playerAction: "SPLIT", result: "loss"},
    {time: "2026-10-13T10:00:00.000Z", cards: ["9", "7"], dealer: "A", result: null}
  ];

  renderHistoryEntries(entries);
  assert.equal(elements.historyList.children.length, 1);
  assert.match(elements.historyList.children[0].textContent, /8, 8 vs\. 10/);
  assert.equal(elements.historyFilterSummary.textContent, "1 of 2 saved hands match.");

  const searchRefreshStart = rendererEnd;
  const searchRefreshEnd = mainScript.indexOf("      let historySearchTimer = null;", searchRefreshStart);
  assert.ok(searchRefreshEnd > searchRefreshStart, "search-only refresh should exist");
  let renderedEntries;
  const refreshHistorySearchResults = new Function(
    "byId",
    "readHistory",
    "renderHistoryEntries",
    mainScript.slice(searchRefreshStart, searchRefreshEnd) + "return refreshHistorySearchResults;"
  )((id) => elements[id], () => entries, (value) => { renderedEntries = value; });
  refreshHistorySearchResults();
  assert.equal(renderedEntries, entries);

  const timerEnd = mainScript.indexOf("      function refreshHistory() {", searchRefreshEnd);
  const timers = new Map();
  let timerId = 0;
  let refreshCount = 0;
  const scheduleHistorySearchRefresh = new Function(
    "window",
    "refreshHistorySearchResults",
    mainScript.slice(searchRefreshEnd, timerEnd) + "return scheduleHistorySearchRefresh;"
  )({
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    }
  }, () => { refreshCount++; });
  scheduleHistorySearchRefresh();
  scheduleHistorySearchRefresh();
  scheduleHistorySearchRefresh();
  assert.equal(timers.size, 1);
  Array.from(timers.values())[0]();
  assert.equal(refreshCount, 1);
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

test("Auto sizes fictional wagers from recorded outcomes and returns while respecting risk caps", () => {
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
  assert.equal(baseline.strategyReason, "practice-baseline");

  const safeMode = calculateSuggestedWager({
    enabled: true, balance: 1000, sessionLossLimit: null, sessionNet: 0,
    recentHands: [], action: "HIT", riskMode: "safe"
  });
  const chillMode = calculateSuggestedWager({
    enabled: true, balance: 1000, sessionLossLimit: null, sessionNet: 0,
    recentHands: [], action: "HIT", riskMode: "chill"
  });
  const riskMode = calculateSuggestedWager({
    enabled: true, balance: 1000, sessionLossLimit: null, sessionNet: 0,
    recentHands: [], action: "HIT", riskMode: "risk"
  });
  assert.equal(safeMode.amount, 5);
  assert.equal(chillMode.amount, 10);
  assert.equal(riskMode.amount, 15);
  assert.equal(safeMode.riskProfile.exposureMultiplier, 1);
  assert.equal(chillMode.riskProfile.exposureMultiplier, 2);
  assert.equal(riskMode.riskProfile.exposureMultiplier, 4);

  const winHeavyHistory = [
    ...Array.from({length: 70}, () => ({result: "win"})),
    ...Array.from({length: 30}, () => ({result: "loss"}))
  ];
  const lossHeavyHistory = [
    ...Array.from({length: 30}, () => ({result: "win"})),
    ...Array.from({length: 70}, () => ({result: "loss"}))
  ];
  const historyHigh = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: winHeavyHistory,
    action: "HIT"
  });
  const historyLow = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: lossHeavyHistory,
    action: "HIT"
  });
  assert.equal(historyHigh.amount, 10);
  assert.equal(historyLow.amount, 10);
  assert.equal(historyHigh.historyWeight, 0);
  assert.equal(historyLow.historyWeight, 0);
  assert.equal(historyHigh.historyValidation.samples, 0,
    "untimed W/P/L history cannot pass chronological validation");

  const historyIndependentOfCurrentHand = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: winHeavyHistory,
    action: "DOUBLE",
    analysis: {
      outcomeProbabilities: {
        double: {win: 0.9, push: 0.05, loss: 0.05}
      }
    }
  });
  const alternativeCurrentHand = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: winHeavyHistory,
    action: "SPLIT",
    analysis: {
      outcomeProbabilities: {
        split: {win: 0.05, push: 0.05, loss: 0.9}
      }
    }
  });
  assert.equal(historyIndependentOfCurrentHand.amount, 10);
  assert.equal(alternativeCurrentHand.amount, 10);
  assert.equal(historyIndependentOfCurrentHand.exposureMultiplier, 2);
  assert.equal(historyIndependentOfCurrentHand.historyWeight, 0);

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
  const allWins = Array.from({length: 12}, () =>
    ({result: "win", wagerAmount: 10, netResult: 10}));
  const allLosses = Array.from({length: 12}, () =>
    ({result: "loss", wagerAmount: 500, netResult: -500}));
  const autoAfterWins = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: allWins,
    action: "HIT"
  });
  const autoAfterLosses = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: allLosses,
    action: "HIT"
  });
  assert.equal(autoAfterWins.strategy, "flat");
  assert.equal(autoAfterWins.amount, 10);
  assert.equal(autoAfterLosses.strategy, "flat");
  assert.equal(autoAfterLosses.amount, autoAfterWins.amount);
  assert.equal(autoAfterLosses.baseUnit, autoAfterWins.baseUnit);
  const smallSample = summarizeWagerOutcomes([
    ...Array.from({length: 6}, () => ({result: "win"})),
    ...Array.from({length: 6}, () => ({result: "loss"}))
  ]);
  assert.equal(smallSample.sampleSize, 12);
  assert.equal(smallSample.wins, 6);
  assert.equal(smallSample.losses, 6);
  assert.equal(smallSample.pushes, 0);
  assert.equal(smallSample.practiceFraction, 0.01, "small samples retain the practice unit");
  assert.ok(smallSample.winInterval.upper > 0.5, "small-sample uncertainty includes 50%");

  const supportedWinRate = summarizeWagerOutcomes([
    ...Array.from({length: 70}, () => ({result: "win"})),
    ...Array.from({length: 30}, () => ({result: "loss"}))
  ]);
  assert.equal(supportedWinRate.winRate, 0.7);
  assert.ok(supportedWinRate.winInterval.lower > 0.5);
  assert.equal(supportedWinRate.returnSampleSize, 0, "win rate alone does not determine stake size");
  assert.equal(supportedWinRate.practiceFraction, 0.01);
  assert.ok(handOutcomeQuarterKellyFraction({win: 0.6, push: 0.1, loss: 0.3}, "HIT") > 0);
  assert.equal(handOutcomeQuarterKellyFraction({win: 0.4, push: 0.1, loss: 0.5}, "DOUBLE"), 0);
  assert.equal(handOutcomeQuarterKellyFraction({win: 0.6, push: 0.1, loss: 0.3}, "DOUBLE"), 0.01,
    "modeled double sizing uses doubled exposure and remains capped at 1%");
  assert.throws(() => handOutcomeQuarterKellyFraction({win: 0.6, push: 0.1, loss: 0.4}, "HIT"),
    /unexpected format/);
  const modeledPositive = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: [],
    action: "DOUBLE",
    analysis: {
      outcomeProbabilities: {
        double: {win: 0.6, push: 0.1, loss: 0.3}
      }
    }
  });
  assert.equal(modeledPositive.amount, 10);
  assert.equal(modeledPositive.sizingBasis, "practice-baseline");
  const modeledNegative = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: [],
    action: "DOUBLE",
    analysis: {
      outcomeProbabilities: {
        double: {win: 0.4, push: 0.1, loss: 0.5}
      }
    }
  });
  assert.equal(modeledNegative.amount, 10);
  assert.equal(modeledNegative.reason, "ready");
  const supportedLossRate = summarizeWagerOutcomes([
    ...Array.from({length: 30}, () => ({result: "win"})),
    ...Array.from({length: 70}, () => ({result: "loss"}))
  ]);
  assert.equal(supportedLossRate.practiceFraction, 0.01);
  const withPushes = summarizeWagerOutcomes([
    ...Array.from({length: 10}, () => ({result: "win"})),
    ...Array.from({length: 10}, () => ({result: "loss"})),
    ...Array.from({length: 10}, () => ({result: "push"}))
  ]);
  assert.equal(withPushes.winRate, 0.5);
  assert.equal(withPushes.pushRate, 1 / 3);
  assert.equal(withPushes.practiceFraction, 0.01);
  const actionHistory = summarizeWagerOutcomes([
    ...Array.from({length: 8}, () => ({result: "win", playerAction: "DOUBLE"})),
    {result: "push", playerAction: "DOUBLE"},
    {result: "loss", playerAction: "DOUBLE"},
    ...Array.from({length: 10}, () => ({result: "loss", playerAction: "STAND"}))
  ]);
  assert.equal(actionHistory.actionOutcomes.DOUBLE.sampleSize, 10);
  assert.equal(actionHistory.actionOutcomes.DOUBLE.pushes, 1);
  assert.equal(actionHistory.actionOutcomes.SPLIT.sampleSize, 0);
  const shrunkDoubleOutcomes = smoothOutcomeCounts(
    {wins: 8, pushes: 1, losses: 1},
    {win: 0.4, push: 0.2, loss: 0.4}
  );
  assert.deepEqual(shrunkDoubleOutcomes, {
    win: 16 / 30,
    push: 5 / 30,
    loss: 9 / 30
  });
  assert.ok(Math.abs(Object.values(shrunkDoubleOutcomes)
    .reduce((sum, probability) => sum + probability, 0) - 1) < 1e-12);

  const makeActionHistory = (double, stand) => [
    ...Array.from({length: double.wins}, () => ({result: "win", playerAction: "DOUBLE"})),
    ...Array.from({length: double.pushes}, () => ({result: "push", playerAction: "DOUBLE"})),
    ...Array.from({length: double.losses}, () => ({result: "loss", playerAction: "DOUBLE"})),
    ...Array.from({length: stand.wins}, () => ({result: "win", playerAction: "STAND"})),
    ...Array.from({length: stand.pushes}, () => ({result: "push", playerAction: "STAND"})),
    ...Array.from({length: stand.losses}, () => ({result: "loss", playerAction: "STAND"}))
  ];
  const doubleWinHistory = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: makeActionHistory(
      {wins: 24, pushes: 2, losses: 4},
      {wins: 20, pushes: 5, losses: 45}
    ),
    action: "DOUBLE"
  });
  const doubleLossHistory = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: makeActionHistory(
      {wins: 6, pushes: 2, losses: 22},
      {wins: 38, pushes: 5, losses: 27}
    ),
    action: "DOUBLE"
  });
  assert.equal(doubleWinHistory.outcomeEstimate.actionOutcomes.DOUBLE.sampleSize, 30);
  assert.equal(doubleWinHistory.outcomeEstimate.actionOutcomes.DOUBLE.pushes, 2);
  assert.equal(doubleWinHistory.amount, 10);
  assert.equal(doubleLossHistory.amount, 10,
    "first-action outcome differences must not change a pre-deal suggestion");
  assert.equal(doubleWinHistory.historyValidation.samples, 0);
  const splitHistory = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: makeActionHistory(
      {wins: 6, pushes: 2, losses: 22},
      {wins: 38, pushes: 5, losses: 27}
    ).map((hand) => hand.playerAction === "DOUBLE"
      ? {...hand, playerAction: "SPLIT"}
      : hand),
    action: "SPLIT"
  });
  const splitWinHistory = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: makeActionHistory(
      {wins: 24, pushes: 2, losses: 4},
      {wins: 20, pushes: 5, losses: 45}
    ).map((hand) => hand.playerAction === "DOUBLE"
      ? {...hand, playerAction: "SPLIT"}
      : hand),
    action: "SPLIT"
  });
  assert.equal(splitHistory.outcomeEstimate.actionOutcomes.SPLIT.sampleSize, 30);
  assert.equal(splitHistory.outcomeEstimate.actionOutcomes.SPLIT.pushes, 2);
  assert.equal(splitWinHistory.amount, splitHistory.amount,
    "round-level split results remain descriptive, not pre-deal sizing inputs");

  const limitedExactSample = summarizeWagerOutcomes(Array.from({length: 12}, () =>
    ({result: "win", wagerAmount: 10, netResult: 15, netResultExact: true})));
  assert.equal(limitedExactSample.returnLowerBound, null);
  assert.equal(limitedExactSample.practiceFraction, 0.01);
  assert.throws(() => summarizeWagerOutcomes(Array.from({length: 30}, () =>
    ({result: "win", wagerAmount: 1, netResult: Number.MAX_VALUE / 2, netResultExact: true}))),
  /too large to estimate safely/);

  const positiveReturnHands = Array.from({length: 70}, () =>
    ({result: "win", wagerAmount: 10, netResult: 10, netResultExact: true}))
    .concat(Array.from({length: 30}, () =>
      ({result: "loss", wagerAmount: 10, netResult: -10, netResultExact: true})));
  const supportedReturns = summarizeWagerOutcomes(positiveReturnHands);
  assert.equal(supportedReturns.returnSampleSize, 100);
  assert.equal(supportedReturns.meanReturn, 0.4);
  assert.ok(supportedReturns.returnLowerBound > 0);
  assert.equal(supportedReturns.kellyFraction, 0.02, "quarter Kelly is capped at 2% of bankroll");
  assert.equal(supportedReturns.practiceFraction, 0.02);
  const positiveReturnSuggestion = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: positiveReturnHands,
    action: "HIT"
  });
  assert.equal(positiveReturnSuggestion.amount, 10);
  assert.equal(positiveReturnSuggestion.practiceFraction, 0.01);

  const negativeReturnHands = Array.from({length: 30}, () =>
    ({result: "win", wagerAmount: 10, netResult: 10, netResultExact: true}))
    .concat(Array.from({length: 70}, () =>
      ({result: "loss", wagerAmount: 10, netResult: -10, netResultExact: true})));
  const supportedNegativeReturns = summarizeWagerOutcomes(negativeReturnHands);
  assert.ok(supportedNegativeReturns.returnUpperBound < 0);
  assert.equal(supportedNegativeReturns.sizingBasis, "negative-edge-no-wager");
  const negativeReturnSuggestion = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: negativeReturnHands,
    action: "HIT",
    analysis: {
      outcomeProbabilities: {
        hit: {win: 0.6, push: 0.1, loss: 0.3}
      }
    }
  });
  assert.equal(negativeReturnSuggestion.amount, 0);
  assert.equal(negativeReturnSuggestion.reason, "negative-edge");

  const uncertainReturnHands = Array.from({length: 55}, () =>
    ({result: "win", wagerAmount: 10, netResult: 10, netResultExact: true}))
    .concat(Array.from({length: 45}, () =>
      ({result: "loss", wagerAmount: 10, netResult: -10, netResultExact: true})));
  const uncertainReturns = summarizeWagerOutcomes(uncertainReturnHands);
  assert.ok(uncertainReturns.returnLowerBound <= 0);
  assert.ok(uncertainReturns.returnUpperBound >= 0);
  assert.equal(uncertainReturns.practiceFraction, 0.01, "uncertain edge retains a small practice unit");

  const unequalWagers = summarizeWagerOutcomes([
    ...Array.from({length: 70}, () =>
      ({result: "win", wagerAmount: 20, netResult: 20, netResultExact: true})),
    ...Array.from({length: 30}, () =>
      ({result: "loss", wagerAmount: 5, netResult: -5, netResultExact: true}))
  ]);
  assert.ok(Math.abs(unequalWagers.meanReturn - 0.8064516129032258) < 1e-12,
    "return estimate reflects total net results over total recorded wager exposure");
  assert.ok(unequalWagers.returnEffectiveSampleSize < unequalWagers.returnSampleSize,
    "unequal wager sizes reduce the effective sample size");
  assert.equal(summarizeWagerOutcomes(positiveReturnHands.map(({netResultExact, ...hand}) => hand))
    .returnSampleSize, 0, "assumed default payouts are not used as exact return data");

  const inferredReturnHands = [
    ...Array.from({length: 70}, () => ({
      result: "win", wagerAmount: 20, playerAction: "STAND", cards: ["10", "7"],
      netResultExact: false, fictionalCredits: true
    })),
    ...Array.from({length: 30}, () => ({
      result: "loss", wagerAmount: 5, playerAction: "HIT", cards: ["9", "8"],
      netResultExact: false, fictionalCredits: true
    }))
  ];
  const inferredReturns = summarizeWagerOutcomes(inferredReturnHands);
  assert.equal(inferredReturns.returnSampleSize, 100);
  assert.equal(inferredReturns.exactReturnSampleSize, 0);
  assert.equal(inferredReturns.inferredReturnSampleSize, 100);
  assert.ok(Math.abs(inferredReturns.meanReturn - 0.8064516129032258) < 1e-12);
  const inferredSuggestion = calculateSuggestedWager({
    enabled: true,
    balance: 1000,
    sessionLossLimit: null,
    sessionNet: 0,
    recentHands: inferredReturnHands,
    action: "STAND"
  });
  assert.ok(inferredSuggestion.amount >= 10,
    "recorded ordinary-hand outcomes and wager exposure affect Auto's practice amount");
  const unsupportedInferredReturns = summarizeWagerOutcomes([
    {result: "win", wagerAmount: 10, playerAction: "DOUBLE", cards: ["10", "7"]},
    {result: "win", wagerAmount: 10, playerAction: "SPLIT", cards: ["8", "8"]},
    {result: "win", wagerAmount: 10, playerAction: "STAND", cards: ["A", "K"]},
    {result: "win", wagerAmount: 10, cards: ["10", "7"]}
  ]);
  assert.equal(unsupportedInferredReturns.returnSampleSize, 0,
    "ambiguous double/split/natural or unrecorded actions need exact net results");

  assert.deepEqual(fictionalWagerOutcomeHistory([
    {result: "win", wagerAmount: 5},
    {result: "loss", wagerAmount: 5, fictionalCredits: true},
    {result: "push", wagerAmount: 5, fictionalCredits: true}
  ]).map((hand) => hand.result), ["loss", "push"]);
  assert.throws(() => fictionalWagerOutcomeHistory(null), /unexpected format/);
  assert.throws(() => summarizeWagerOutcomes(null), /unexpected format/);

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
  }), /supported blackjack action/);
});

test("wager suggestion is prominent and displays a history-based estimate", () => {
  assert.match(html, /id="wagerRiskMode"/);
  assert.match(html, /Safe · small, tightly capped stakes/);
  assert.match(html, /Chill · balanced fictional sizing/);
  assert.match(html, /Risk-taker · more aggressive, still capped/);
  assert.match(html, /Saved W\/P\/L history and validated historical patterns inform this amount/);
  assert.match(html, /@keyframes advisor-action-pop/);
  assert.match(html, /@keyframes advisor-selection-pulse/);
  assert.match(mainScript, /popRecommendedAction/);
  assert.match(mainScript, /tones\.forEach/);
  assert.match(mainScript, /kind === "correct" \? \[10, 28, 12\]/);
  assert.match(html, /class="advisor-pattern-details"/);
  assert.match(html, /View recent-20 breakdown/);
  assert.match(html, /id="premiumQuickstart"/);
  assert.match(html, /id="premiumHandsSaved"/);
  assert.match(html, /id="premiumResolvedHands"/);
  assert.match(html, /id="premiumMatches"/);
  assert.match(html, /id="premiumSessionNet"/);
  assert.match(html, /id="copyAdviceSummary"/);
  assert.match(mainScript, /premiumQuickstartKey/);
  assert.match(mainScript, /Recommendation summary copied/);
  assert.match(html, /class="advisor-wager-card" aria-labelledby="advisorWagerTitle"/);
  assert.match(html, /id="suggestedWagerAmount" aria-live="polite"/);
  assert.match(html, /id="wagerHistorySummary" aria-live="polite"/);
  assert.match(html, /id="outcomePatternProbability" aria-live="polite"/);
  assert.match(html, /id="actionOutcomeSummary" aria-live="polite"/);
  assert.match(mainScript, /not conditioned on the current cards/);
  assert.match(html, /Saved W\/P\/L history and validated historical patterns inform this amount/);
  assert.match(html, /Previous 20 results/);
  assert.match(html, /Smoothed W\/P\/L/);
  assert.match(html, /Auto · adjust from history \(fictional only\)/);
  assert.match(mainScript, /inferredReturnSampleSize/);
  assert.match(mainScript, /effective sample/);
  assert.match(html, /History-based W\/L sizing assumes even-money returns/);
  assert.match(mainScript, /Auto uses a validated recent-20 W\/P\/L pattern/);
  assert.match(mainScript, /amount is chosen before cards/);
  assert.match(html, /\.advisor-wager-card\s*\{[^}]*box-shadow/s);
  assert.match(mainScript, /renderOutcomePatternEstimate\(recentHands, outcomes\)/);
  assert.match(mainScript, /Current-hand model \(W\/P\/L = win\/push\/loss/);
  assert.match(mainScript, /handOutcomeQuarterKellyFraction/);
  assert.match(mainScript, /Auto uses conservative empirical return evidence/);
  assert.match(mainScript, /negative-edge-no-wager/);
});

test("recent-20 outcome model estimates streak contexts with shrinkage and chronological validation", () => {
  const history = (results) => results.map((item, index) => ({
    time: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    result: typeof item === "string" ? item : item.result,
    fictionalCredits: true
  })).reverse();
  const lossStreak = calculateOutcomePatternModel(history([
    ...Array(20).fill("loss"),
    "win",
    ...Array(20).fill("loss")
  ]));
  assert.equal(lossStreak.sampleSize, 41);
  assert.equal(lossStreak.currentCondition, "allLosses");
  assert.deepEqual(lossStreak.currentWindowCounts, {wins: 0, losses: 20, pushes: 0});
  const allLosses = lossStreak.contexts.find((context) => context.key === "allLosses");
  assert.equal(allLosses.samples, 1);
  assert.equal(allLosses.wins, 1);
  assert.ok(lossStreak.currentWinProbability > lossStreak.baselineProbability,
    "the small conditional observation moves the estimate only slightly from the baseline");
  assert.ok(lossStreak.currentWinProbability < 0.12, "one matching observation is strongly shrunk");
  assert.equal(lossStreak.walkForward.samples, 21);

  const winStreak = calculateOutcomePatternModel(history([
    ...Array(20).fill("win"),
    "loss",
    ...Array(20).fill("win")
  ]));
  assert.equal(winStreak.currentCondition, "allWins");
  assert.ok(winStreak.currentWinProbability < winStreak.baselineProbability,
    "one loss after a 20-win context is shrunk toward the overall baseline");

  const shortHistory = calculateOutcomePatternModel(history([
    ...Array(19).fill("win"),
    "push",
    {result: null}
  ]));
  assert.equal(shortHistory.sampleSize, 20);
  assert.equal(shortHistory.currentCondition, "mostlyWins");
  assert.deepEqual(shortHistory.currentWindowCounts, {wins: 19, losses: 0, pushes: 1});
  assert.deepEqual(
    Object.keys(shortHistory.currentOutcomeProbabilities).sort(),
    ["loss", "push", "win"]
  );
  assert.ok(Math.abs(Object.values(shortHistory.currentOutcomeProbabilities)
    .reduce((sum, probability) => sum + probability, 0) - 1) < 1e-12);
  assert.throws(() => calculateOutcomePatternModel(null), /unexpected format/);
  assert.throws(() => calculateOutcomePatternModel([], 1), /between 2 and 100/);
  assert.throws(() => calculateOutcomePatternModel([], 20, 0), /greater than zero/);
});

test("recent-20 model can learn a synthetic streak effect but measures it against a walk-forward baseline", () => {
  const results = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    results.push(...Array(30).fill("loss"), ...Array(30).fill("win"));
  }
  const hands = results.map((result, index) => ({
    time: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    result
  })).reverse();
  const model = calculateOutcomePatternModel(hands);
  assert.equal(model.sampleSize, 100, "the estimator uses a bounded recent sample");
  assert.equal(model.walkForward.samples, 80);
  assert.ok(model.walkForward.modelBrier < model.walkForward.baselineBrier,
    "streak context improves forecasts on data that actually contains a streak effect");
  assert.ok(model.walkForward.validated,
    "Auto requires a positive approximate 95% lower bound on out-of-sample Brier improvement");
  assert.ok(model.walkForward.improvementLowerBound > 0);
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
    primaryMove: {textContent: ""},
    reason: {textContent: ""},
    advisorStatus: {textContent: "", classList: {add() {}, remove() {}}},
    membershipRequiredPrompt: {hidden: true},
    decisionAnalysis: {textContent: ""},
    handSummary: {textContent: ""},
    moveActionPanel: {hidden: true, scrollIntoView() {}},
    moveActionHeading: {textContent: ""},
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
  const flowSteps = [];
  const splitAvailability = [];
  let requestFailure = null;
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
    "renderCurrentHandOutcome",
    "advisorRequestErrorMessage",
    "setAdvisorFlowStep",
    mainScript.slice(decideStart, recordConsultationStart) + "return decide;"
  )(
    (id) => elements[id],
    parseRank,
    async (cards, dealer, options) => {
      if (requestFailure) throw requestFailure;
      return actionForContext(cards, dealer, options);
    },
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
    () => {},
    () => {},
    (error) => error && typeof error.message === "string" ? error.message : "The advisor request failed.",
    (step) => { flowSteps.push(step); }
  );

  await decide(true);
  assert.equal(flowSteps[flowSteps.length - 1], 3, "a completed recommendation advances to recording the move");
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

  elements.playerCards.value = "10, 6";
  elements.hitCards.value = "";
  elements.splitHand2Cards.value = "";
  elements.advisorCardTarget.value = "player";
  requestFailure = Object.assign(new Error("Active membership required."), {status: 402});
  await decide(false);
  assert.equal(elements.membershipRequiredPrompt.hidden, false, "membership errors expose the direct purchase path");

  requestFailure = Object.assign(new Error("Billing is temporarily unavailable."), {status: 503});
  await decide(false);
  assert.equal(elements.membershipRequiredPrompt.hidden, true, "non-membership service errors do not show purchase prompts");
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
  const sharedHands = [];
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
    "shareCompletedHand",
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
    "STAND",
    (entry) => sharedHands.push(entry.consultationId)
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
  assert.equal(entries[0].netResultExact, true);
  assert.equal(entries[0].fictionalCredits, true);
  assert.equal(JSON.parse(localStorage.balanceValue).amount, 87.5);
  assert.equal(JSON.parse(localStorage.balanceValue).currency, "FAKE");
  assert.equal(elements.manualBalanceDisplay.textContent, "87.50 fake credits");
  assert.equal(entries[0].playerAction, "HIT");
  assert.equal(elements.handResultEntry.hidden, true);
  assert.match(elements.handResultMessage.textContent, /cards already entered in the advisor/);
  assert.equal(classifyHistoryDecision(entries[0]), "different");
  assert.deepEqual(sharedHands, ["consult-1"]);
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
  const sharedHands = [];
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
    "shareCompletedHand",
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
    "STAND",
    (entry) => sharedHands.push(entry.consultationId)
  );

  saveHandResult();
  assert.equal(entries[0].result, "win");
  assert.deepEqual(entries[0].finalPlayerCards, ["10", "7"]);
  assert.equal(entries[0].finalDealerCards, null);
  assert.equal(entries[0].netResult, 5);
  assert.equal(entries[0].netResultExact, false);
  assert.equal(JSON.parse(localStorage.balanceValue).amount, 105);
  assert.equal(elements.handResultEntry.hidden, true);
  assert.deepEqual(sharedHands, ["consult-2"]);
});

test("hand-result form saves an outcome without inventing an unknown wager or net result", () => {
  const elements = {
    handResult: {value: "win"},
    playerCards: {value: "J, J"},
    hitCards: {value: ""},
    splitHandCards: {value: ""},
    handWager: {value: ""},
    handNetResult: {value: ""},
    playerAction: {value: "STAND"},
    handResultMessage: {textContent: ""},
    handResultEntry: {hidden: false}
  };
  const entries = [{
    consultationId: "consult-no-stake",
    cards: ["J", "J"],
    dealer: "6",
    recommendedAction: "STAND",
    result: null,
    finalPlayerCards: null,
    finalDealerCards: ["6", "2", "7", "A", "K"]
  }];
  const localStorage = {
    getItem(key) {
      assert.equal(key, "rainbet-advisor-manual-balance-v1");
      return null;
    },
    setItem(key, value) {
      assert.equal(key, "rainbet-original-blackjack-history-v1");
      entries.splice(0, entries.length, ...JSON.parse(value));
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
    "shareCompletedHand",
    "let activeConsultationId = 'consult-no-stake';\n" +
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
    "STAND",
    () => {}
  );

  saveHandResult();
  assert.equal(entries[0].result, "win");
  assert.equal(entries[0].wagerAmount, null);
  assert.equal(entries[0].netResult, null);
  assert.equal(entries[0].netResultExact, false);
  assert.equal(entries[0].fictionalCredits, true);
  assert.equal(elements.handResultEntry.hidden, true);
  assert.match(elements.handResultMessage.textContent, /No wager or exact net result was entered/);
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

function createBillingTestStore(initialMembership) {
  const memberships = new Map();
  const documentPaths = [];
  const checkoutCalls = [];
  const canceledSchedules = [];
  const scheduleCalls = [];
  let webhookEvent = null;
  const membershipPath = "users/google-user/membership/current";
  if (initialMembership) memberships.set(membershipPath, {...initialMembership});
  const firestore = {
    doc(...segments) {
      assert.equal(segments.length, 1, "Firestore Admin doc() must receive one path string");
      const path = segments[0];
      documentPaths.push(path);
      return {
        async get() {
          const value = memberships.get(path);
          return {exists: Boolean(value), data: () => value && {...value}};
        },
        async set(value, options) {
          memberships.set(path, options && options.merge
            ? {...(memberships.get(path) || {}), ...value}
            : {...value});
        }
      };
    },
    async runTransaction(callback) {
      return callback({
        async get(reference) {
          return reference.get();
        },
        set(reference, value, options) {
          return reference.set(value, options);
        }
      });
    }
  };
  const stripe = {
    prices: {
      async retrieve(id) {
        return id === "price_trial"
          ? {active: true, currency: "usd", unit_amount: 100, type: "one_time"}
          : {active: true, currency: "usd", unit_amount: 1000, recurring: {interval: "month", interval_count: 1}};
      }
    },
    customers: {
      async create() {
        return {id: "cus_test"};
      }
    },
    checkout: {
      sessions: {
        async create(options) {
          checkoutCalls.push(options);
          return {url: "https://checkout.stripe.test/session"};
        }
      }
    },
    paymentIntents: {
      async retrieve(id) {
        assert.equal(id, "pi_test");
        return {payment_method: "pm_test"};
      }
    },
    refunds: {
      async create() {
        return {id: "re_test"};
      }
    },
    subscriptionSchedules: {
      async create(options, requestOptions) {
        scheduleCalls.push({options, requestOptions});
        return {id: "sub_sched_test"};
      },
      async retrieve(id) {
        return {id, status: "not_started"};
      },
      async cancel(id) {
        canceledSchedules.push(id);
        return {id, status: "canceled"};
      }
    },
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        assert.equal(signature, "test-signature");
        assert.equal(secret, "whsec_test");
        assert.ok(Buffer.isBuffer(rawBody));
        return webhookEvent;
      }
    }
  };
  return {
    store: {
      auth: {
        async verifyIdToken(token) {
          if (token === "google-token") {
            return {uid: "google-user", email: "user@example.test", firebase: {sign_in_provider: "google.com"}};
          }
          if (token === "test-token") {
            return {uid: "test-user", email: "tester@example.test", firebase: {sign_in_provider: "google.com"}};
          }
          if (token === "other-token") {
            return {uid: "google-user", firebase: {sign_in_provider: "password"}};
          }
          throw new Error("invalid token");
        }
      },
      firestore,
      stripe,
      webhookSecret: "whsec_test",
      trialPriceId: "price_trial",
      priceId: "price_monthly"
    },
    memberships,
    documentPaths,
    checkoutCalls,
    canceledSchedules,
    scheduleCalls,
    setWebhookEvent(event) {
      webhookEvent = event;
    }
  };
}

test("test account allowlist grants advisor access without a Stripe membership", async (testContext) => {
  const mock = createBillingTestStore();
  const server = createGeminiServer({
    apiKey: "",
    billingStore: mock.store,
    appPublicUrl: "https://advisor.example",
    testAccessEmails: ["tester@example.test"]
  });
  const origin = await listenForTest(testContext, server);
  const request = (path, token, body) => fetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Authorization: "Bearer " + token
    },
    body: JSON.stringify(body || {})
  });

  const status = await request("/api/billing/status", "test-token");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    tier: "paid",
    subscriptionStatus: "test",
    trialExpiresAt: null,
    trialAvailable: false,
    renewalCanceled: false,
    testAccess: true
  });
  assert.equal((await request("/api/billing/trial", "test-token", {acceptRecurringBilling: true})).status, 409);
  assert.equal(mock.checkoutCalls.length, 0);
});

test("membership checkout requires explicit consent and validates the Google account", async (testContext) => {
  const mock = createBillingTestStore();
  const server = createGeminiServer({
    apiKey: "",
    billingStore: mock.store,
    appPublicUrl: "https://advisor.example"
  });
  const origin = await listenForTest(testContext, server);
  const request = (path, token, body) => fetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(token ? {Authorization: "Bearer " + token} : {})
    },
    body: JSON.stringify(body || {})
  });

  assert.equal((await request("/api/billing/status", null)).status, 401);
  assert.equal((await request("/api/billing/trial", "other-token", {acceptRecurringBilling: true})).status, 403);
  assert.equal((await request("/api/billing/trial", "google-token")).status, 400);
  assert.equal(mock.checkoutCalls.length, 0);

  const introResponse = await request("/api/billing/trial", "google-token", {acceptRecurringBilling: true});
  assert.equal(introResponse.status, 200);
  assert.equal((await introResponse.json()).url, "https://checkout.stripe.test/session");
  assert.equal(mock.checkoutCalls[0].mode, "payment");
  assert.equal(mock.checkoutCalls[0].payment_intent_data.setup_future_usage, "off_session");
  assert.equal(mock.checkoutCalls[0].metadata.termsVersion, "membership-terms-v1");
  assert.equal(mock.documentPaths.every((path) => path === "users/google-user/membership/current"), true);

  const monthlyResponse = await request("/api/billing/checkout", "google-token", {acceptRecurringBilling: true});
  assert.equal(monthlyResponse.status, 200);
  assert.equal(mock.checkoutCalls[1].mode, "subscription");
  assert.equal(mock.checkoutCalls[1].line_items[0].price, "price_monthly");
});

test("paid intro webhook provisions one seven-day intro and one monthly schedule", async (testContext) => {
  const mock = createBillingTestStore();
  const created = Math.floor(Date.now() / 1000);
  mock.setWebhookEvent({
    id: "evt_intro_paid",
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        id: "cs_intro",
        mode: "payment",
        payment_status: "paid",
        client_reference_id: "google-user",
        customer: "cus_test",
        payment_intent: "pi_test",
        metadata: {purchaseType: "seven-day-trial"}
      }
    }
  });
  const server = createGeminiServer({apiKey: "", billingStore: mock.store});
  const origin = await listenForTest(testContext, server);
  const deliverWebhook = () => fetch(origin + "/api/billing/webhook", {
    method: "POST",
    headers: {"Content-Type": "application/json", "Stripe-Signature": "test-signature"},
    body: "{}"
  });

  assert.equal((await deliverWebhook()).status, 200);
  const membership = mock.memberships.get("users/google-user/membership/current");
  assert.equal(membership.tier, "paid");
  assert.equal(membership.subscriptionStatus, "trialing");
  assert.equal(membership.trialExpiresAt, new Date((created + 7 * 24 * 60 * 60) * 1000).toISOString());
  assert.equal(membership.trialClaimedAt, new Date(created * 1000).toISOString());
  assert.equal(membership.subscriptionScheduleId, "sub_sched_test");
  assert.equal(mock.scheduleCalls.length, 1);
  assert.equal(mock.scheduleCalls[0].options.start_date, created + 7 * 24 * 60 * 60);
  assert.equal(mock.scheduleCalls[0].options.default_settings.default_payment_method, "pm_test");
  assert.equal(mock.scheduleCalls[0].options.phases[0].items[0].price, "price_monthly");
  assert.equal(mock.scheduleCalls[0].requestOptions.idempotencyKey, "rainbet-seven-day-conversion-cs_intro");

  assert.equal((await deliverWebhook()).status, 200);
  assert.equal(mock.scheduleCalls.length, 1, "replayed checkout event must not create a second schedule");
});

test("intro renewal cancellation keeps paid access through the seven-day period", async (testContext) => {
  const mock = createBillingTestStore({
    tier: "paid",
    subscriptionStatus: "trialing",
    trialClaimedAt: new Date().toISOString(),
    trialExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    subscriptionScheduleId: "sub_sched_test"
  });
  const server = createGeminiServer({apiKey: "", billingStore: mock.store});
  const origin = await listenForTest(testContext, server);
  const response = await fetch(origin + "/api/billing/cancel-intro", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Authorization: "Bearer google-token"
    },
    body: "{}"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    canceled: true,
    trialExpiresAt: mock.memberships.get("users/google-user/membership/current").trialExpiresAt
  });
  assert.deepEqual(mock.canceledSchedules, ["sub_sched_test"]);
  const statusResponse = await fetch(origin + "/api/billing/status", {
    method: "POST",
    headers: {Origin: origin, Authorization: "Bearer google-token"}
  });
  assert.deepEqual(await statusResponse.json(), {
    tier: "paid",
    subscriptionStatus: "trialing",
    trialExpiresAt: mock.memberships.get("users/google-user/membership/current").trialExpiresAt,
    trialAvailable: false,
    renewalCanceled: true
  });
});

test("shared-training endpoint requires same-origin anonymous auth and accepts only when configured", async (testContext) => {
  const submissions = [];
  const server = createGeminiServer({
    apiKey: "",
    trainingStore: {
      async submit(token, value) {
        submissions.push({token, value});
        return {duplicate: false};
      }
    }
  });
  const origin = await listenForTest(testContext, server);
  const request = (headers = {}, body = validTrainingContribution()) => fetch(origin + "/api/training-contribution", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin, ...headers},
    body: JSON.stringify(body)
  });
  const advice = () => fetch(origin + "/api/advice", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({
      cards: ["10", "6"],
      dealer: "10",
      options: {doubleAllowed: true, splitAllowed: true, dasRule: "unknown", afterSplit: false}
    })
  }).then((response) => response.json());

  const adviceBeforeContribution = await advice();
  const missingAuth = await request();
  assert.equal(missingAuth.status, 401);
  const accepted = await request({Authorization: "Bearer anonymous-token"});
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {accepted: true, duplicate: false});
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].token, "anonymous-token");
  assert.equal(submissions[0].value.wagerAmount, undefined);
  assert.equal(submissions[0].value.netResult, undefined);
  assert.deepEqual(await advice(), adviceBeforeContribution, "shared outcome data is isolated from live recommendations");

  const wrongOrigin = await fetch(origin + "/api/training-contribution", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: "https://other.example", Authorization: "Bearer anonymous-token"},
    body: JSON.stringify(validTrainingContribution())
  });
  assert.equal(wrongOrigin.status, 403);

  const disabledServer = createGeminiServer({apiKey: "", firebaseServiceAccountJson: ""});
  const disabledOrigin = await listenForTest(testContext, disabledServer);
  const disabled = await fetch(disabledOrigin + "/api/training-contribution", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: disabledOrigin, Authorization: "Bearer anonymous-token"},
    body: JSON.stringify(validTrainingContribution())
  });
  assert.equal(disabled.status, 503);
  assert.match((await disabled.json()).error, /remains only in local history/);
});

test("site stats service verifies the owner, returns aggregate Plausible metrics, and caches by range", async () => {
  const claims = new Map([
    ["owner-session-token-000000000000", {
      email: "OWNER@example.com",
      email_verified: true,
      firebase: {sign_in_provider: "google.com"}
    }],
    ["other-session-token-000000000000", {
      email: "other@example.com",
      email_verified: true,
      firebase: {sign_in_provider: "google.com"}
    }],
    ["anonymous-session-token-0000000000", {
      email: "owner@example.com",
      email_verified: true,
      firebase: {sign_in_provider: "anonymous"}
    }],
    ["unverified-session-token-00000000", {
      email: "owner@example.com",
      email_verified: false,
      firebase: {sign_in_provider: "google.com"}
    }]
  ]);
  const requests = [];
  const service = createSiteStatsService({
    auth: {
      async verifyIdToken(token, checkRevoked) {
        assert.equal(checkRevoked, true);
        if (token === "expired-session-token-000000000") throw new Error("expired");
        return claims.get(token);
      }
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({url, options, body});
      return {
        ok: true,
        async json() {
          return body.dimensions
            ? {results: [
              {dimensions: ["/"], metrics: [40, 55]},
              {dimensions: ["/#history-title"], metrics: [15, 20]}
            ]}
            : {results: [{metrics: [42, 58, 91, 72.5, 31.4]}]};
        }
      };
    },
    apiKey: "plausible-secret",
    siteId: "advisor.example",
    adminEmails: ["Owner@example.com", "not-an-email"]
  });

  await assert.rejects(service.getStats("owner-session-token-000000000000", "1y"), (error) =>
    error instanceof SiteStatsError && error.status === 400);
  await assert.rejects(service.getStats("expired-session-token-000000000", "30d"), (error) =>
    error instanceof SiteStatsError && error.status === 401);
  await assert.rejects(service.getStats("other-session-token-000000000000", "30d"), (error) =>
    error instanceof SiteStatsError && error.status === 403);
  await assert.rejects(service.getStats("anonymous-session-token-0000000000", "30d"), (error) =>
    error instanceof SiteStatsError && error.status === 403);
  await assert.rejects(service.getStats("unverified-session-token-00000000", "30d"), (error) =>
    error instanceof SiteStatsError && error.status === 403);

  const stats = await service.getStats("owner-session-token-000000000000", "30d");
  assert.deepEqual(stats, {
    dateRange: "30d",
    visitors: 42,
    visits: 58,
    pageviews: 91,
    visitDurationSeconds: 72.5,
    bounceRate: 31.4,
    topPages: [
      {path: "/", visitors: 40, pageviews: 55},
      {path: "/#history-title", visitors: 15, pageviews: 20}
    ]
  });
  assert.equal(Object.hasOwn(stats, "email"), false);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({url, options, body}) =>
    url === "https://plausible.io/api/v2/query" &&
    options.headers.Authorization === "Bearer plausible-secret" &&
    body.site_id === "advisor.example" &&
    body.date_range === "30d"));
  assert.deepEqual(await service.getStats("owner-session-token-000000000000", "30d"), stats);
  assert.equal(requests.length, 2, "cached reads should not call Plausible again");

  assert.throws(() => createSiteStatsService({
    auth: {verifyIdToken() {}},
    fetchImpl: async () => {},
    apiKey: "",
    siteId: "advisor.example",
    adminEmails: ["owner@example.com"]
  }), /require Firebase Admin Auth/);
});

test("site stats endpoint requires same-origin requests and configured owner authentication", async (testContext) => {
  assert.throws(() => createGeminiServer({
    apiKey: "",
    plausibleStatsApiKey: "plausible-secret",
    plausibleSiteId: "advisor.example",
    siteStatsAdminEmails: "owner@example.com",
    firebaseServiceAccountJson: ""
  }), /require FIREBASE_SERVICE_ACCOUNT_JSON/);

  const calls = [];
  const server = createGeminiServer({
    apiKey: "",
    siteStatsService: {
      async getStats(token, range) {
        calls.push({token, range});
        if (token !== "owner-session-token-000000000") {
          throw new SiteStatsError(403, "This account is not authorized.");
        }
        return {dateRange: range, visitors: 10};
      }
    }
  });
  const origin = await listenForTest(testContext, server);
  const request = (headers = {}, body = {dateRange: "30d"}) => fetch(origin + "/api/site-stats", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin, ...headers},
    body: JSON.stringify(body)
  });

  assert.equal((await request()).status, 401);
  const wrongOrigin = await request({
    Origin: "https://other.example",
    Authorization: "Bearer owner-session-token-000000000"
  });
  assert.equal(wrongOrigin.status, 403);
  const authorized = await request({Authorization: "Bearer owner-session-token-000000000"});
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {dateRange: "30d", visitors: 10});
  assert.deepEqual(calls, [{token: "owner-session-token-000000000", range: "30d"}]);
  assert.equal((await fetch(origin + "/api/site-stats", {headers: {Origin: origin}})).status, 405);

  const disabledServer = createGeminiServer({apiKey: "", siteStatsService: null});
  const disabledOrigin = await listenForTest(testContext, disabledServer);
  const disabled = await fetch(disabledOrigin + "/api/site-stats", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: disabledOrigin},
    body: JSON.stringify({dateRange: "30d"})
  });
  assert.equal(disabled.status, 503);
});

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

  const splitAceResponse = await fetch(origin + "/api/advice", {
    method: "POST",
    headers: {"Content-Type": "application/json", Origin: origin},
    body: JSON.stringify({
      cards: ["A", "6"],
      dealer: "10",
      options: {doubleAllowed: true, splitAllowed: false, dasRule: "allowed", afterSplit: true}
    })
  });
  const splitAcePayload = await splitAceResponse.json();
  assert.equal(splitAceResponse.status, 200);
  assert.equal(splitAcePayload.action, "STAND");
  assert.equal(splitAcePayload.alternativeAction, null);
  assert.match(splitAcePayload.explanation, /split-ace rule.*stands automatically/i);

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

test("Firebase auth helpers proxy requests and responses without redirecting or blocking the helper iframe", async (testContext) => {
  const calls = [];
  const server = createGeminiServer({
    apiKey: "",
    firebaseAuthRequestImpl: (options, callback) => {
      const request = new PassThrough();
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("finish", () => {
        calls.push({
          options,
          body: Buffer.concat(chunks).toString("utf8")
        });
        const response = Readable.from(["firebase-helper"]);
        response.statusCode = 200;
        response.headers = {"Content-Type": "text/plain; charset=utf-8"};
        callback(response);
      });
      return request;
    }
  });
  const origin = await listenForTest(testContext, server);

  const iframe = await fetch(origin + "/__/auth/iframe?mode=test");
  assert.equal(iframe.status, 200);
  assert.equal(await iframe.text(), "firebase-helper");
  assert.equal(iframe.headers.get("location"), null);
  assert.equal(iframe.headers.get("x-frame-options"), null);

  const callback = await fetch(origin + "/__/auth/handler?mode=test", {
    method: "POST",
    headers: {"Content-Type": "text/plain"},
    body: "callback-body"
  });
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), "firebase-helper");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({options}) => ({
    hostname: options.hostname,
    method: options.method,
    path: options.path,
    hostHeader: options.headers.host
  })), [
    {
      hostname: "rainbet-advisor-history.firebaseapp.com",
      method: "GET",
      path: "/__/auth/iframe?mode=test",
      hostHeader: undefined
    },
    {
      hostname: "rainbet-advisor-history.firebaseapp.com",
      method: "POST",
      path: "/__/auth/handler?mode=test",
      hostHeader: undefined
    }
  ]);
  assert.equal(calls[1].body, "callback-body");
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
  const cloudModule = await cloudModuleResponse.text();
  assert.match(cloudModule, /signInWithRedirect/);
  assert.match(cloudModule, /getRedirectResult/);

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
