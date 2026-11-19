"use strict";

const firebaseVersion = "13.4.0";
const firebaseBase = "https://www.gstatic.com/firebasejs/" + firebaseVersion + "/";

function emitCloudEvent(detail) {
  window.dispatchEvent(new CustomEvent("rainbet-cloud-history", {detail}));
}

function hasFirebaseConfig(config) {
  return config &&
    typeof config.apiKey === "string" && config.apiKey.trim() &&
    typeof config.authDomain === "string" && config.authDomain.trim() &&
    typeof config.projectId === "string" && config.projectId.trim() &&
    typeof config.appId === "string" && config.appId.trim();
}

async function initializeCloudHistory() {
  const config = window.rainbetFirebaseConfig;
  if (!hasFirebaseConfig(config)) {
    emitCloudEvent({
      status: "unconfigured",
      message: "Cloud sync is not configured. Local history stays on this device until Firebase is set up."
    });
    return;
  }

  try {
    const [appSdk, authSdk, firestoreSdk] = await Promise.all([
      import(firebaseBase + "firebase-app.js"),
      import(firebaseBase + "firebase-auth.js"),
      import(firebaseBase + "firebase-firestore.js")
    ]);
    const app = appSdk.initializeApp(config);
    const auth = authSdk.getAuth(app);
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    const database = firestoreSdk.getFirestore(app);
    const historyDocument = (uid) => firestoreSdk.doc(database, "users", uid, "history", "current");

    window.rainbetCloudHistory = {
      async signIn() {
        const credential = await authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider());
        const accountInfo = authSdk.getAdditionalUserInfo(credential);
        return {isNewUser: Boolean(accountInfo && accountInfo.isNewUser)};
      },
      signOut() {
        return authSdk.signOut(auth);
      },
      async mergeHistory(localEntries, mergeEntries) {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in with Google before syncing history.");
        if (!Array.isArray(localEntries) || typeof mergeEntries !== "function") {
          throw new Error("History sync received invalid local data.");
        }
        return firestoreSdk.runTransaction(database, async (transaction) => {
          const reference = historyDocument(user.uid);
          const snapshot = await transaction.get(reference);
          const cloudEntries = snapshot.exists() ? snapshot.data().entries : [];
          if (!Array.isArray(cloudEntries)) {
            throw new Error("The saved cloud history has an unexpected format.");
          }
          const entries = mergeEntries(localEntries, cloudEntries);
          if (entries.length > 500) {
            throw new Error("Cloud history is limited to 500 hands. Export or clear older history before syncing.");
          }
          const payload = {schemaVersion: 1, entries};
          if (new TextEncoder().encode(JSON.stringify(payload)).length > 900000) {
            throw new Error("Cloud history is too large to sync. Export or clear older history first.");
          }
          transaction.set(reference, {...payload, updatedAt: firestoreSdk.serverTimestamp()});
          return entries;
        });
      },
      async clearHistory() {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in with Google before clearing cloud history.");
        await firestoreSdk.deleteDoc(historyDocument(user.uid));
      }
    };

    emitCloudEvent({status: "ready"});
    authSdk.onAuthStateChanged(auth, (user) => {
      emitCloudEvent({
        status: "auth",
        user: user ? {uid: user.uid, displayName: user.displayName || "", email: user.email || ""} : null
      });
    }, () => {
      emitCloudEvent({
        status: "error",
        message: "Could not check the Google sign-in state. Reload the page and try again."
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitCloudEvent({
      status: "error",
      message: "Firebase could not be initialized: " + message
    });
  }
}

initializeCloudHistory();
