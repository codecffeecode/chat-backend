import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { env } from "../config.js";

function initApp(): App {
  const existing = getApps()[0];
  if (existing) {
    return existing;
  }
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return initializeApp({
      projectId: env.FIREBASE_PROJECT_ID,
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
  if (env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: env.FIREBASE_PROJECT_ID });
  }
  return initializeApp({ projectId: env.FIREBASE_PROJECT_ID, credential: applicationDefault() });
}

let instance: Firestore | undefined;

export function firestore(): Firestore {
  if (!instance) {
    instance = getFirestore(initApp());
    instance.settings({ ignoreUndefinedProperties: true });
  }
  return instance;
}

export function collectionName(name: string): string {
  return `${env.FIRESTORE_COLLECTION_PREFIX}${name}`;
}
