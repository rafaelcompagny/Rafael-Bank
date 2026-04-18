import { watchAuth } from "./auth.js";
import { getUserProfile } from "./db.js";

let firebaseUser = null;
let profile = null;

export function getFirebaseUser() {
  return firebaseUser;
}

export function getProfile() {
  return profile;
}

export async function loadSession() {
  return new Promise((resolve) => {
    watchAuth(async (user) => {
      if (!user) {
        firebaseUser = null;
        profile = null;
        resolve(null);
        return;
      }

      firebaseUser = user;
      profile = await getUserProfile(user.uid);
      resolve({ firebaseUser, profile });
    });
  });
}

export function setProfile(newProfile) {
  profile = newProfile;
}