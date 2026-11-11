# FormSathi

A form-filling prototype with a Hinglish interview, an encrypted local Answer Vault,
field checklists and an answer sheet. Built for the #BuildHybridAI 2026 challenge.

## Current status (November 11, 2026)

**Not yet submission-ready.** Do not confuse the working mock walkthrough with
verified Gemini inference.

- [Mock walkthrough](https://pritahi.github.io/formsathi/): sample extraction,
  interview, checklist and answer sheet use mock AI. The WebCrypto vault is real.
- [Firebase deployment](https://formsathi.web.app/): hosting is deployed. Real AI
  inference has not succeeded yet: provider setup/App Check remain unfinished.
- TypeScript check, production build and **45 unit tests pass** locally.
- Real Gemini Nano execution, production App Check and end-to-end live cloud
  inference are **not verified**. There is no Android wrapper yet.

## Run locally

```sh
npm ci
npm run dev
# Open the printed localhost URL.
npm run typecheck
npm test
npm run build
```

The source currently defaults to Demo mode so a fresh checkout can be explored
without credentials or an inference service. The Settings toggle changes modes.
Production must not be represented as live until actual inference is verified.

## What the demo does

1. Choose a bundled fictional scholarship or bank form.
2. Read extracted fields and confidence scores from a mock fixture.
3. Answer one question at a time in Hinglish.
4. Review the checklist and copy-ready answer sheet.
5. Save reusable answers in an encrypted device-local vault.

Mock verification and confidence scores are illustrative. They do not establish
eligibility for a scholarship or certify that an official form is correct.
Always check the issuing authority's current instructions yourself.

## Inference and privacy boundaries

- All model requests go through `src/ai/firebaseAi.ts` and the router.
- Personal form images and personal-answer prompts use Firebase AI Logic's
  `ONLY_ON_DEVICE` mode. There is **no cloud retry** on device failure.
- Without Nano, interview questions and normalization use labeled local rules,
  not a cloud model. They are logged as `local`, with `local-template (no AI)`.
- Only bundled synthetic sample extraction may opt into the free cloud API,
  after an eligible-adult-developer confirmation. That path still needs live
  service verification.
- Arbitrary cloud verification and free-form personal prompts are blocked at the
  model boundary. Local summaries/help are not AI verification.
- Form photos stay in IndexedDB. There are no automatic Firebase Storage uploads.
- The Answer Vault uses WebCrypto encryption. Device compromise, an unlocked
  session or a malicious browser extension can still expose data.
- Metadata sync uses anonymous Firebase Auth and owner-scoped Firestore rules.
  Anonymous identity does not promise cross-device recovery.

The unpaid Gemini API terms prohibit submitting personal, confidential or
sensitive information. This prototype is for adult developers using synthetic
samples, not a production student service. The live cloud path is not offered
to users in the EEA, Switzerland or UK. Demo mode sends no inference traffic.
See [Gemini API terms](https://ai.google.dev/gemini-api/terms).

## Firebase setup and cost limits

The configured project is on Spark. No billing account or Blaze upgrade is used.
The public Firebase web configuration identifies the project; it is not a
Gemini service credential. Protect the app with App Check and security rules.

1. Create/register a Firebase web app and obtain its web configuration.
2. In **AI Logic**, use the guided Gemini Developer API setup. Enabling API
   services alone does not create the provider configuration.
3. Review and accept the provider's current terms under your own authority.
4. Configure a production App Check attestation provider and initialize its SDK.
5. Enable anonymous Auth and deploy the Firestore rules/indexes if using sync.
6. Verify successful model output before using live mode in a submission.
7. Deploy Hosting only when the live build is tested.

**Storage is not part of the free deployment.** The current console requires
Blaze for new Storage setup. Do not upgrade billing to follow older instructions.
Images are stored locally instead.

```sh
npx firebase-tools login
npx firebase-tools deploy --only hosting,firestore:rules,firestore:indexes \
  --project YOUR_PROJECT_ID
```

Check `firebase.json` and the hosting site before deploying. Do not deploy the
Storage or Functions directories as part of this free prototype.

## Code map

- `src/ai/router.ts`: route decisions, mock paths and provenance log
- `src/ai/firebaseAi.ts`: Firebase AI Logic SDK, privacy boundary
- `src/ai/redact.ts`: format facts for the planned verification flow
- `src/vault/`: local encrypted Answer Vault
- `src/services/`: sessions, local data and optional metadata sync
- `src/ui/`: PWA views, badges, Settings and Router Log
- `test/privacyBoundary.test.ts`: rejects arbitrary unpaid cloud payloads;
  keeps interview/normalization local when Nano is unavailable

The older cloud-verification design needs more work before production use.
Do not infer that a feature is verified solely because a route is implemented.

## Submission checklist

- [ ] Read official rules after publication and check eligibility
- [ ] Complete free AI Logic provider setup and production App Check
- [ ] Verify real cloud extraction on a synthetic sample
- [ ] Verify real Nano inference on a supported desktop
- [ ] Re-record video with verified sources and truthful limitations
- [ ] Approve video publication words and upload
- [ ] Complete Devpost fields, validate all links and submit

License: MIT. This is a prototype, not an official government or bank service.
