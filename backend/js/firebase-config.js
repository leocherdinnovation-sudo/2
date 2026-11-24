import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

// Sumji Fabrics Firebase Configuration (shared with Frontend)
export const firebaseConfig = {
  apiKey: "AIzaSyAAeOLowuW-_FW6OvLY1tQ9aQ9_62DKuxc",
  authDomain: "sumji-fabrics.firebaseapp.com",
  projectId: "sumji-fabrics",
  storageBucket: "sumji-fabrics.firebasestorage.app",
  messagingSenderId: "980791398956",
  appId: "1:980791398956:web:d5219bd7b22a28ca52f789",
  measurementId: "G-VHS926DHZ8"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

setPersistence(auth, browserLocalPersistence).catch(() => {});
