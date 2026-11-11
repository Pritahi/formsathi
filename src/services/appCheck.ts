import type { FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';

/** Public site key, restricted to the production app domains. Not a secret. */
export const APP_CHECK_SITE_KEY = '6LdMcxouAAAAANr9eK8xSj1Puv0tjAU9OWYqsUsI';
let instance: AppCheck | null = null;
export function ensureAppCheck(app: FirebaseApp): AppCheck | null {
  if (typeof window === 'undefined' || !['formsathi.web.app', 'formsathi.firebaseapp.com', 'pritahi.github.io'].includes(location.hostname)) return null;
  if (!instance) instance = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
  return instance;
}
