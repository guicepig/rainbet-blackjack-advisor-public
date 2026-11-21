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
  return /Android|iPhone|iPad|iPod|IEMobile|Windows Phone/i.test(nav.userAgent || "") ||
    /Macintosh/i.test(nav.userAgent || "") && nav.maxTouchPoints > 1;
}

async function rejectUnregisteredGoogleAccount(authSdk, auth, user) {
  try {
    await authSdk.deleteUser(user);
  } catch (deleteError) {
    try {
      await authSdk.signOut(auth);
    } catch (signOutError) {
      throw Object.assign(new Error(
        "This Google account is not registered, and Firebase could not remove or sign out the new account. Contact support before trying again."
      ), {code: "auth/google-account-cleanup-failed", cause: signOutError});
    }
    throw Object.assign(new Error(
      "This Google account was not registered. Firebase could not remove the account it just created. Contact support before trying again."
    ), {code: "auth/google-account-cleanup-failed", cause: deleteError});
  }
  throw Object.assign(new Error(
    "No account is registered for this Google sign-in yet. Switch to Sign up to create one."
  ), {code: "auth/google-account-not-found"});
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
    const googleSignInModeStorageKey = "rainbet-google-sign-in-mode";
    let googleSignInMode = null;
    let googleSignInModeStored = false;
    let redirectResultPending = true;
    try {
      const savedMode = window.sessionStorage.getItem(googleSignInModeStorageKey);
      if (savedMode === "signin" || savedMode === "signup") {
        googleSignInMode = savedMode;
        googleSignInModeStored = true;
      }
    } catch {
      googleSignInMode = null;
    }
    const clearGoogleSignInMode = () => {
      googleSignInMode = null;
      if (googleSignInModeStored) {
        window.sessionStorage.removeItem(googleSignInModeStorageKey);
        googleSignInModeStored = false;
      }
    };
    const emitCurrentAuthState = () => {
      const user = auth.currentUser;
      const unverifiedPasswordUser = user && user.providerData.some((provider) => provider.providerId === "password") &&
        !user.emailVerified;
      emitCloudEvent({
        status: "auth",
        user: user && !user.isAnonymous && !unverifiedPasswordUser
          ? {uid: user.uid, displayName: user.displayName || "", email: user.email || ""}
          : null
      });
    };
    const trainingApp = appSdk.initializeApp(config, "rainbet-shared-training");
    const trainingAuth = authSdk.getAuth(trainingApp);
    await authSdk.setPersistence(trainingAuth, authSdk.browserLocalPersistence);
    const database = firestoreSdk.getFirestore(app);
    const historyDocument = (uid) => firestoreSdk.doc(database, "users", uid, "history", "current");
    const profileDocument = (uid) => firestoreSdk.doc(database, "users", uid, "profile", "current");

    window.rainbetCloudHistory = {
      async signIn({allowCreate = false} = {}) {
        googleSignInMode = allowCreate ? "signup" : "signin";
        const provider = new authSdk.GoogleAuthProvider();
        if (shouldUseGoogleSignInRedirect()) {
          try {
            window.sessionStorage.setItem(googleSignInModeStorageKey, googleSignInMode);
            googleSignInModeStored = true;
            await authSdk.signInWithRedirect(auth, provider);
            return {redirecting: true};
          } catch (error) {
            clearGoogleSignInMode();
            throw error;
          }
        }
        let credential;
        try {
          credential = await authSdk.signInWithPopup(auth, provider);
        } catch (error) {
          clearGoogleSignInMode();
          if (error && error.code === "auth/popup-blocked") {
            throw Object.assign(new Error("Allow popups for this site, then try Sign in with Google again."), {
              code: "auth/popup-blocked"
            });
          }
          throw error;
        }
        const accountInfo = authSdk.getAdditionalUserInfo(credential);
        const isNewUser = Boolean(accountInfo && accountInfo.isNewUser);
        if (isNewUser && !allowCreate) {
          try {
            await rejectUnregisteredGoogleAccount(authSdk, auth, credential.user);
          } finally {
            clearGoogleSignInMode();
            emitCurrentAuthState();
          }
        }
        clearGoogleSignInMode();
        emitCurrentAuthState();
        return {isNewUser};
      },
      async createAccount(email, password) {
        const credential = await authSdk.createUserWithEmailAndPassword(auth, email, password);
        try {
          await authSdk.sendEmailVerification(credential.user);
        } catch (error) {
          await authSdk.signOut(auth);
          throw Object.assign(new Error(
            "Your account was created, but Firebase could not send the verification email. Check Firebase's email configuration, then sign in to request another verification link."
          ), {code: error && error.code ? error.code : "auth/verification-email-failed"});
        }
        await authSdk.signOut(auth);
        return {emailVerificationSent: true};
      },
      async signInWithPassword(email, password) {
        const credential = await authSdk.signInWithEmailAndPassword(auth, email, password);
        if (!credential.user.emailVerified) {
          let verificationEmailError;
          try {
            await authSdk.sendEmailVerification(credential.user);
          } catch (error) {
            verificationEmailError = error;
          } finally {
            await authSdk.signOut(auth);
          }
          if (verificationEmailError) {
            throw Object.assign(new Error(
              "Your email is not verified, and Firebase could not resend the verification link. Check Firebase's email configuration and try again."
            ), {code: "auth/verification-email-failed"});
          }
          throw Object.assign(new Error(
            "Your email is not verified yet. We sent another verification link; check your inbox, then sign in again."
          ), {code: "auth/email-not-verified"});
        }
        return {isNewUser: false};
      },
      sendPasswordReset(email) {
        return authSdk.sendPasswordResetEmail(auth, email);
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
        if (!user || user.isAnonymous) throw new Error("Sign in before managing membership.");
        if (user.providerData.some((provider) => provider.providerId === "password") && !user.emailVerified) {
          throw new Error("Verify your email address before managing membership.");
        }
        return user.getIdToken();
      },
      async mergeHistory(localEntries, mergeEntries) {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in before syncing history.");
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
        if (!user) throw new Error("Sign in before clearing cloud history.");
        await firestoreSdk.deleteDoc(historyDocument(user.uid));
      },
      async loadProfile() {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in before loading your private username.");
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
        if (!user) throw new Error("Sign in before saving your private username.");
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
        if (!user) throw new Error("Sign in before clearing your private username.");
        await firestoreSdk.deleteDoc(profileDocument(user.uid));
      },
      async loadSiteStats(dateRange) {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in before viewing site analytics.");
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
      if (redirectResultPending || googleSignInMode === "signin") return;
      const unverifiedPasswordUser = user && user.providerData.some((provider) => provider.providerId === "password") &&
        !user.emailVerified;
      emitCloudEvent({
        status: "auth",
        user: user && !user.isAnonymous && !unverifiedPasswordUser
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
        const isNewUser = Boolean(accountInfo && accountInfo.isNewUser);
        if (isNewUser && googleSignInMode !== "signup") {
          await rejectUnregisteredGoogleAccount(authSdk, auth, credential.user);
        }
        clearGoogleSignInMode();
        redirectResultPending = false;
        emitCloudEvent({
          status: "sign-in-result",
          isNewUser
        });
        emitCurrentAuthState();
      } else {
        if (googleSignInMode) clearGoogleSignInMode();
        redirectResultPending = false;
        emitCurrentAuthState();
      }
    } catch (error) {
      clearGoogleSignInMode();
      redirectResultPending = false;
      emitCurrentAuthState();
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
