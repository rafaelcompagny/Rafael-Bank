import { db } from "./firebase.js";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export async function createUserProfile(uid, data) {
  await setDoc(doc(db, "users", uid), data);
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

export async function updateUserProfile(uid, data) {
  await updateDoc(doc(db, "users", uid), data);
}

export async function replaceUserProfile(uid, data) {
  await setDoc(doc(db, "users", uid), data);
}

export async function getGlobalMarket() {
  const snap = await getDoc(doc(db, "market", "global"));
  return snap.exists() ? snap.data() : null;
}

export async function setGlobalMarket(data) {
  await setDoc(doc(db, "market", "global"), data);
}

export async function updateGlobalMarket(data) {
  await updateDoc(doc(db, "market", "global"), data);
}