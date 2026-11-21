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

function shouldUseGoogleSignInRedirect() {
  const nav = window.navigator;
  if (nav.userAgentData && typeof nav.userAgentData.mobile === "boolean") {
    return nav.userAgentData.mobile;
  }

  function googleIdentityClientId() {
    return "566237267938-tmksjltnr83upcpeb8356v5igvub42oj.apps.googleusercontent.com";
  }

  function requestGoogleAccessToken() {
    return new Promise((resolve, reject) => {
      const googleIdentity = window.google && window.google.accounts && window.google.accounts.oauth2;
      if (!googleIdentity || typeof googleIdentity.initTokenClient !== "function") {
        reject(Object.assign(new Error("Google Identity Services could not load."), {
          code: "auth/popup-blocked"
        }));
        return;
      }
      const tokenClient = googleIdentity.initTokenClient({
        client_id: googleIdentityClientId(),
        scope: "openid email profile",
        prompt: "select_account",
        callback: (response) => {
          if (response && response.access_token) resolve(response.access_token);
          else reject(Object.assign(new Error("Google sign-in did not return an access token."), {
            code: response && response.error ? response.error : "auth/popup-closed-by-user"
          }));
        },
        error_callback: (error) => reject(Object.assign(
          new Error(error && error.type ? "Google sign-in was canceled or blocked." : "Google sign-in failed."),
          {code: "auth/popup-closed-by-user"}
        ))
      });
      tokenClient.requestAccessToken();
    });
  }
  return /Android|iPhone|iPad|iPod|IEMobile|Windows Phone/i.test(nav.userAgent || "") ||
    /Macintosh/i.test(nav.userAgent || "") && nav.maxTouchPoints > 1;
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
    const trainingApp = appSdk.initializeApp(config, "rainbet-shared-training");
    const trainingAuth = authSdk.getAuth(trainingApp);
    await authSdk.setPersistence(trainingAuth, authSdk.browserLocalPersistence);
    const database = firestoreSdk.getFirestore(app);
    const historyDocument = (uid) => firestoreSdk.doc(database, "users", uid, "history", "current");
    const profileDocument = (uid) => firestoreSdk.doc(database, "users", uid, "profile", "current");

    window.rainbetCloudHistory = {
      async signIn() {
        const provider = new authSdk.GoogleAuthProvider();
        if (!shouldUseGoogleSignInRedirect()) {
          try {
            const accessToken = await requestGoogleAccessToken();
            const credential = provider.credential(null, accessToken);
            const loginCredential = await authSdk.signInWithCredential(auth, credential);
            const accountInfo = authSdk.getAdditionalUserInfo(loginCredential);
            return {isNewUser: Boolean(accountInfo && accountInfo.isNewUser)};
          } catch (error) {
            if (!error || error.code === "auth/popup-blocked" ||
                error.code === "auth/popup-closed-by-user") {
              try {
                const credential = await authSdk.signInWithPopup(auth, provider);
                const accountInfo = authSdk.getAdditionalUserInfo(credential);
                return {isNewUser: Boolean(accountInfo && accountInfo.isNewUser)};
              } catch (popupError) {
                if (!popupError || popupError.code !== "auth/popup-blocked") throw popupError;
              }
            } else {
              throw error;
            }
          }
        }
        if (shouldUseGoogleSignInRedirect()) {
          await authSdk.signInWithRedirect(auth, provider);
          return {redirecting: true};
        }
        let credential;
        try {
          credential = await authSdk.signInWithPopup(auth, provider);
        } catch (error) {
          if (!error || error.code !== "auth/popup-blocked") throw error;
          await authSdk.signInWithRedirect(auth, provider);
          return {redirecting: true};
        }
        const accountInfo = authSdk.getAdditionalUserInfo(credential);
        return {isNewUser: Boolean(accountInfo && accountInfo.isNewUser)};
      },
      signOut() {
        return authSdk.signOut(auth);
      },
      async getTrainingIdToken() {
        let user = trainingAuth.currentUser;
        if (!user) {
          const credential = await authSdk.signInAnonymously(trainingAuth);
          user = credential.user;
        }
        if (!user || !user.isAnonymous) {
          throw new Error("The shared-training session is not anonymous.");
        }
        return user.getIdToken();
      },
      async getBillingIdToken() {
        const user = auth.currentUser;
        if (!user || user.isAnonymous) throw new Error("Sign in with Google before managing membership.");
        return user.getIdToken();
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
      },
      async loadProfile() {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in with Google before loading your private username.");
        const snapshot = await firestoreSdk.getDoc(profileDocument(user.uid));
        if (!snapshot.exists()) return "";
        const profile = snapshot.data();
        if (profile.schemaVersion !== 1 ||
            typeof profile.displayName !== "string" ||
            !/^[A-Za-z0-9_-]{3,20}$/.test(profile.displayName)) {
          throw new Error("The saved private username has an unsupported format.");
        }
        return profile.displayName;
      },
      async saveProfile(displayName) {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in with Google before saving your private username.");
        if (typeof displayName !== "string" || !/^[A-Za-z0-9_-]{3,20}$/.test(displayName)) {
          throw new Error("Use 3-20 letters, numbers, underscores, or hyphens.");
        }
        await firestoreSdk.setDoc(profileDocument(user.uid), {
          schemaVersion: 1,
          displayName,
          updatedAt: firestoreSdk.serverTimestamp()
        });
      },
      async clearProfile() {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in with Google before clearing your private username.");
        await firestoreSdk.deleteDoc(profileDocument(user.uid));
      },
      async loadSiteStats(dateRange) {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in with Google before viewing site analytics.");
        if (!["7d", "30d", "90d", "all"].includes(dateRange)) {
          throw new Error("Choose a supported analytics date range.");
        }
        const idToken = await user.getIdToken();
        const response = await fetch("/api/site-stats", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + idToken,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({dateRange})
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error("The site analytics service returned an invalid response.");
        }
        if (!response.ok) {
          throw new Error(payload && typeof payload.error === "string"
            ? payload.error
            : "Could not load site analytics.");
        }
        return payload;
      }
    };

    emitCloudEvent({status: "ready"});
    authSdk.onAuthStateChanged(auth, (user) => {
      emitCloudEvent({
        status: "auth",
        user: user && !user.isAnonymous
          ? {uid: user.uid, displayName: user.displayName || "", email: user.email || ""}
          : null
      });
    }, () => {
      emitCloudEvent({
        status: "error",
        message: "Could not check the Google sign-in state. Reload the page and try again."
      });
    });
    try {
      const credential = await authSdk.getRedirectResult(auth);
      if (credential) {
        const accountInfo = authSdk.getAdditionalUserInfo(credential);
        emitCloudEvent({
          status: "sign-in-result",
          isNewUser: Boolean(accountInfo && accountInfo.isNewUser)
        });
      }
    } catch (error) {
      emitCloudEvent({
        status: "auth-error",
        code: error && typeof error.code === "string" ? error.code : "",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitCloudEvent({
      status: "error",
      message: "Firebase could not be initialized: " + message
    });
  }
}

initializeCloudHistory();
