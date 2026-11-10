/**
 * Firebase wiring — every function here is OPTIONAL and no-ops when
 * config/config.ts still has placeholders.
 *
 * Spark-plan-only design decisions:
 *  • Anonymous Auth            → no login UI, no email costs, no user friction
 *  • Firestore                 → only form METADATA (field labels, lights,
 *                                timestamps). Never an answer value.
 *  • Storage                   → the form photo, under
 *                                forms/{uid}/{sessionId}.jpg, private rules
 *  • No Cloud Functions deployed → nothing to pay for, nothing to cold-start
 *  • No Remote Config / Analytics / App Check → not needed for the demo
 */

import type { FirebaseWebConfig } from '../config/config';
import { COL, FEATURES, FIREBASE_CONFIG, FIREBASE_CONFIGURED, STORAGE_PREFIX } from '../config/config';
import type { FormSession } from '../lib/types';
import { fingerprint } from '../lib/util';

export interface FirebaseStatus {
  configured: boolean;
  ready: boolean;
  uid: string | null;
  firestore: boolean;
  storage: boolean;
  error: string | null;
}

export const firebaseStatus: FirebaseStatus = {
  configured: FIREBASE_CONFIGURED,
  ready: false,
  uid: null,
  firestore: false,
  storage: false,
  error: null,
};

let appMod: typeof import('firebase/app') | null = null;
let authMod: typeof import('firebase/auth') | null = null;
let fsMod: typeof import('firebase/firestore') | null = null;
let storageMod: typeof import('firebase/storage') | null = null;
let dbRef: import('firebase/firestore').Firestore | null = null;
let storageRef: import('firebase/storage').FirebaseStorage | null = null;
let initPromise: Promise<FirebaseStatus> | null = null;

/** Boot Firebase. Resolves (never rejects) so the app always starts. */
export async function initFirebase(): Promise<FirebaseStatus> {
  if (!FIREBASE_CONFIGURED) {
    firebaseStatus.configured = false;
    firebaseStatus.error = 'Firebase config missing — local-only mode (vault still works).';
    return firebaseStatus;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const [app, auth, fs, storage] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
        import('firebase/firestore'),
        import('firebase/storage'),
      ]);
      appMod = app;
      authMod = auth;
      fsMod = fs;
      storageMod = storage;

      const cfg = FIREBASE_CONFIG as FirebaseWebConfig;
      const firebaseApp = app.getApps().length ? app.getApp() : app.initializeApp(cfg);

      dbRef = fs.getFirestore(firebaseApp);
      storageRef = storage.getStorage(firebaseApp);
      firebaseStatus.firestore = true;
      firebaseStatus.storage = true;

      // Anonymous auth: silent, free, and enough for owner-scoped rules.
      const auth0 = auth.getAuth(firebaseApp);
      const cred = auth0.currentUser
        ? { user: auth0.currentUser }
        : await auth.signInAnonymously(auth0);
      firebaseStatus.uid = cred.user.uid;

      // Persist the (uid, displayName) so a returning user keeps the same
      // anonymous identity if the SDK's local persistence is cleared.
      firebaseStatus.ready = true;
      firebaseStatus.error = null;
      return firebaseStatus;
    } catch (err) {
      firebaseStatus.error = err instanceof Error ? err.message : String(err);
      firebaseStatus.ready = false;
      return firebaseStatus;
    }
  })();
  return initPromise;
}

export function currentUid(): string | null {
  return firebaseStatus.uid;
}

/** The Firestore document for a session. Metadata only — no answer values. */
export interface SessionDoc {
  id: string;
  uid: string;
  title: string;
  formType: string;
  createdAt: number;
  updatedAt: number;
  /** field id → traffic light, so a judge can see the skeleton sync. */
  lights: Record<string, 'green' | 'yellow' | 'red'>;
  fieldCount: number;
  verifyStatus: string;
  /** FNV hash of instruction text: proves verify ran without storing the text. */
  instructionFingerprint: string | null;
  appVersion: string;
}

export async function syncSessionMetadata(session: FormSession, uid: string): Promise<boolean> {
  if (!FEATURES.syncMetadata || !firebaseStatus.ready || !dbRef || !fsMod) return false;
  try {
    const doc: SessionDoc = {
      id: session.id,
      uid,
      title: session.title,
      formType: session.formType,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lights: Object.fromEntries(
        Object.entries(session.answers).map(([k, a]) => [k, a.confidenceLight]),
      ),
      fieldCount: session.extraction?.fields.length ?? 0,
      verifyStatus: session.verifyStatus,
      instructionFingerprint: session.instructionText ? fingerprint(session.instructionText) : null,
      appVersion: '1.0.0',
    };
    await fsMod.setDoc(fsMod.doc(dbRef, COL.sessions, session.id), doc, { merge: true });
    return true;
  } catch {
    return false;
  }
}

export async function deleteSessionMetadata(sessionId: string): Promise<void> {
  if (!firebaseStatus.ready || !dbRef || !fsMod) return;
  try {
    await fsMod.deleteDoc(fsMod.doc(dbRef, COL.sessions, sessionId));
  } catch {
    /* offline or rules — fine */
  }
}

/** Upload the compressed form photo to the user's private folder.
 *  Returns the storage path (not a download URL: rules keep the object
 *  owner-only, so a URL would be useless to anyone else anyway). */
export async function uploadFormImage(
  sessionId: string,
  uid: string,
  blob: Blob,
): Promise<string | null> {
  if (!firebaseStatus.ready || !storageRef || !storageMod) return null;
  try {
    const path = `${STORAGE_PREFIX}/${uid}/${sessionId}.jpg`;
    const ref = storageMod.ref(storageRef, path);
    await storageMod.uploadBytes(ref, blob, { contentType: 'image/jpeg' });
    return path;
  } catch {
    return null;
  }
}

export async function deleteFormImage(sessionId: string, uid: string): Promise<void> {
  if (!firebaseStatus.ready || !storageRef || !storageMod) return;
  try {
    await storageMod.deleteObject(storageMod.ref(storageRef, `${STORAGE_PREFIX}/${uid}/${sessionId}.jpg`));
  } catch {
    /* not present */
  }
}

/** Read back sessions for the "synced across devices" note. Metadata only. */
export async function listSyncedSessions(): Promise<SessionDoc[]> {
  if (!firebaseStatus.ready || !dbRef || !fsMod || !firebaseStatus.uid) return [];
  try {
    const q = fsMod.query(
      fsMod.collection(dbRef, COL.sessions),
      fsMod.where('uid', '==', firebaseStatus.uid),
      fsMod.orderBy('updatedAt', 'desc'),
      fsMod.limit(20),
    );
    const snap = await fsMod.getDocs(q);
    return snap.docs.map((d) => d.data() as SessionDoc);
  } catch {
    return [];
  }
}

/** Human-readable status for the Settings sheet. */
export function firebaseStatusLabel(): string {
  if (!firebaseStatus.configured) return 'Local only (Firebase config nahi bhara)';
  if (!firebaseStatus.ready) return `Firebase error: ${firebaseStatus.error ?? 'unknown'}`;
  return `Connected · uid ${firebaseStatus.uid?.slice(0, 6)}…`;
}

export { appMod, authMod, fsMod, storageMod };
