// Firebase setup. The web config is public by design: it identifies the
// project; access is enforced by Firebase Auth and the Firestore rules.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyCtlPD0wd7bCeq0HYzqXnCY404Bm2aYzpo",
  authDomain: "counteroffer-storefront.firebaseapp.com",
  projectId: "counteroffer-storefront",
  storageBucket: "counteroffer-storefront.firebasestorage.app",
  messagingSenderId: "781632534088",
  appId: "1:781632534088:web:83c34188fcd03080c54a7d"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");

// Plain-English auth errors.
const AUTH_ERRORS = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-email": "Enter your email address.",
  "auth/missing-password": "Enter your password.",
  "auth/user-not-found": "No account with that email. Create one instead?",
  "auth/wrong-password": "Wrong email or password.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/invalid-login-credentials": "Wrong email or password.",
  "auth/email-already-in-use": "An account with that email already exists. Sign in instead.",
  "auth/weak-password": "Password is too weak. Use at least 6 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
  "auth/popup-closed-by-user": "The Google sign-in window was closed before finishing.",
  "auth/cancelled-popup-request": "The Google sign-in window was closed before finishing.",
  "auth/popup-blocked": "Your browser blocked the Google popup. Allow popups for this site and try again.",
  "auth/unauthorized-domain": "This domain isn't authorized for sign-in yet. Use counteroffer-storefront.web.app.",
  "auth/operation-not-allowed": "That sign-in method isn't enabled.",
  "auth/user-disabled": "This account has been disabled."
};
export function authMessage(err) {
  const code = err && err.code;
  return AUTH_ERRORS[code] || "Something went wrong" + (code ? " (" + code + ")" : "") + ". Try again.";
}
