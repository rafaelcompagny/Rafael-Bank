// firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// CONFIG (la tienne)
const firebaseConfig = {
  apiKey: "AIzaSyD60apIr6kLvE6tjKJ-2jSA1YmU3ea3ANI",
  authDomain: "simulateur-bank-5645e.firebaseapp.com",
  projectId: "simulateur-bank-5645e",
  storageBucket: "simulateur-bank-5645e.firebasestorage.app",
  messagingSenderId: "642409703095",
  appId: "1:642409703095:web:1afa4df9f7d9007a6acf32",
  measurementId: "G-0M9NBFGP4H"
};

// INIT
const app = initializeApp(firebaseConfig);

// EXPORTS (UNE SEULE FOIS ⚠️)
export const auth = getAuth(app);
export const db = getFirestore(app);