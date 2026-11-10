<div align="center">

# FormSathi · फ़ॉर्मसाथी

**The offline-first form-filling agent.**
Photo of a form → Hinglish interview → filled form.
Personal data never leaves the phone. Works in airplane mode.

`#BuildHybridAI 2026` · Firebase AI Logic hybrid inference (Gemini Nano on-device + cloud Gemini)

</div>

---

```
        ╔══════════════════════════════════════════════════════════════════╗
        ║  India fills ~100 crore forms a year.                            ║
        ║  The people who need them most have the worst internet,          ║
        ║  the least English confidence, and nobody to ask for help.       ║
        ╚══════════════════════════════════════════════════════════════════╝
```

FormSathi is a mobile-first installable PWA that turns a photo of **any** Indian form — scholarship, exam, government scheme, bank account — into a friendly voice-and-chat interview in Hinglish, then hands back a correctly filled form plus a copyable answer sheet.

The interesting part is **not** the form filling. It is *where each step runs*.

---

## Table of contents

1. [Run it in 60 seconds](#run-it-in-60-seconds)
2. [The hybrid inference map](#the-hybrid-inference-map) ← the core of the project
3. [Architecture](#architecture)
4. [How the on-device constraint shaped the product](#how-the-on-device-constraint-shaped-the-product)
5. [Privacy model, stated precisely](#privacy-model-stated-precisely)
6. [Feature → code map (MVP 1–7)](#feature--code-map-mvp-17)
7. [Going live on Firebase (Spark only)](#going-live-on-firebase-spark-only)
8. [Demo script & what to click](#demo-script--what-to-click)
9. [Testing](#testing)
10. [Project structure](#project-structure)
11. [Judging criteria → what to look at](#judging-criteria--what-to-look-at)
12. [Honest limitations](#honest-limitations)
13. [Licence](#licence)

---

## Run it in 60 seconds

```bash
npm install
npm run dev          # → http://localhost:5173
```

**No keys. No Firebase project. No sign-up.** The app boots in **DEMO MODE**: every AI call returns a realistic mock (with realistic latency, realistic JSON, mock field extraction from the bundled sample forms, and a mock cloud verify that catches real mistakes), while the Answer Vault does *real* WebCrypto encryption.

To walk the whole product with zero typing:

1. **Vault** → “Bina passphrase” → “Demo data” (15 real-looking answers now encrypted on this device)
2. **Ghar** → **Sample form se demo dekhein** → **Scholarship form** (20 fields extracted)
3. **Shuru karein** → watch 15 of 20 fields pre-fill from the vault, then answer 5 in Hinglish
4. Header **☰** → checklist with traffic lights → **☁️ Cloud verify**
5. **Sample instructions** → **Verify shuru karein** → it catches a monthly-vs-annual income error
6. **Final form** → annotated overlay + answer sheet + this form's hybrid ledger
7. Tap **🛰** (top bar) any time for the **Model Router log** — every call, which half ran, why

Flip **DEMO MODE** off in **⚙️ Settings** once `src/config/config.ts` is filled in.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server, `0.0.0.0:5173` |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the built app |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | 41 unit tests (redaction, router, vault crypto, label matching) |
| `python3 test/e2e_flow.py` | Drives the real app in Chromium end to end (Playwright) |
| `python3 scripts/make-samples.py` | Regenerates the bundled sample forms + their geometry |
| `python3 scripts/make-icons.py` | Regenerates PWA icons |

---

## The hybrid inference map

This table is the product. It is defined **once**, in code, at
`src/ai/router.ts → ROUTE_TABLE`, and is rendered verbatim in the app
(*Kaise?* screen and the Router log drawer). `test/router.test.ts` asserts the
code agrees with this table, so the documentation cannot drift from the binary.

| # | AI step | Runs on | Why it runs there | Offline? | Sees personal data? |
|---|---|---|---|---|---|
| 1 | **Form intake** — read the photo, extract `{label, type, required, hint, box}` | 📱 **On-device** (Gemini Nano) | The form photo is the most personal artifact in the flow: it carries the applicant's handwriting, Aadhaar box, bank details. On-device supports text+image input and structured JSON output, which is exactly this task. The photo is never uploaded. | ✅ | ✅ yes — and stays local |
| 2 | **Interview turn** — one Hinglish question at a time | 📱 **On-device** (Gemini Nano) | This is where Aadhaar numbers, income and addresses are spoken aloud. On-device inference is single-turn only, so each question is a *stateless prompt with the whole state packed in* (see below). No transcript is ever accumulated. | ✅ | ✅ yes — and stays local |
| 3 | **Answer normalization** — “pachas hazaar” → `50000`, “12 August 2004” → `2004-08-12` | 📱 **On-device** (Gemini Nano) | Operates directly on the raw spoken answer, so it must stay local for the same reason as #2. Cheap, short, and a huge share of real rejection-causing errors. | ✅ | ✅ yes — and stays local |
| 4 | **Answer Vault** — save/reuse answers across forms | 📱 **On-device** (IndexedDB + WebCrypto) | Not a model call at all, and that is the point: reusable identity data is *stored* locally, AES-GCM encrypted, and never synced. Rule matching across forms is a deterministic classifier, not a guess. | ✅ | ✅ yes — never leaves |
| 5 | **Cloud verify** — check the filled form against the form's *official instruction page* | ☁️ **Cloud** (Gemini) | Needs long-context reasoning over a dense instruction page, plus cross-field consistency. The bigger model wins. The payload contains **labels, non-identity values, and locally-computed format facts** — never Aadhaar/PAN/bank/mobile/DOB/address. | ⚠️ queued, replays on reconnect | ⚠️ redacted, provably |
| 6 | **Review summary** — a calm Hinglish wrap-up + next steps | ☁️ **Cloud** (Gemini) | A readability task with no new personal data; benefits from the bigger model. Has a deterministic local template fallback so the final screen is never empty offline. | ⚠️ local fallback | ❌ no |
| 7 | **Free-form chat** — “kagaz kaunse chahiye?” | ☁️ **Cloud** (Gemini) | This genuinely needs multi-turn history, and **on-device inference does not support multi-turn chat**. Routing it to cloud is the honest engineering choice, and the router log shows it as `freeform_chat → cloud` so nobody can accuse the app of hiding it. | ❌ needs net | ❌ no |
| 8 | **Fill output** — annotated overlay + answer sheet | 📱 **On-device** (Canvas) | Pure local rendering. Zero network, works on a dead battery-saver connection. | ✅ | ✅ yes |

**Split: 5 steps on-device, 3 in the cloud.** The cloud never receives an identity value; the on-device half never needs the internet.

### How the router actually decides

```ts
// src/ai/router.ts (abridged)
export function planRoute(task: RouteTask): RoutePlan {
  const decision = ROUTE_TABLE[task];
  if (decision.path === 'cloud' || NEVER_ON_DEVICE.has(task)) → cloud
  if (routerState.onDeviceDisabled)          → cloud  (error budget spent)
  if (canUseOnDevice(capability) === false)  → cloud  (with the reason logged)
  return on-device
}
```

Everything the router decides is written to an audit log
(`routerState.logs`) with `requestedPath`, `actualPath`, `model`, `latencyMs`,
`imageBytes`, `redacted`, `offline` and a human reason. That log is the **only**
source for the UI badges and for the “hybrid hisaab” panel on the final screen.
Nothing is hardcoded to look good.

### On the real SDK call (not a wrapper)

```ts
// src/ai/firebaseAi.ts — the live path, inactive until config is filled
genModel = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,      // ← the hybrid contract
  inCloudParams:  { model: 'gemini-3.5-flash-lite', generationConfig },
  onDeviceParams: { createOptions: {
    expectedInputs:  [{ type: 'text', languages: ['en'] }, { type: 'image' }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  }},
});

const result = await genModel.generateContent(request);
result.response.inferenceSource;   // 'on_device' | 'in_cloud'  ← the badge
```

`initializeDeviceModel(progress)` is bound to the **Download Gemini Nano** button
in Settings, because Chrome requires a user gesture before a model download.

---

## Architecture

```
┌──────────────────────────────── PHONE (trusted) ───────────────────────────────┐
│                                                                                │
│   Camera / Gallery / PDF ──► image.ts ─────────────────────────────────┐       │
│   (compressed to ~150 KB JPEG, long edge 1600px, always image/jpeg)    │       │
│                                                                        ▼       │
│                        ┌───────────────────────────────────────────────────┐   │
│                        │            src/ai/router.ts                       │   │
│                        │  ┌─────────────────────────────────────────────┐  │   │
│   prompts.ts ─────────►│  │  planRoute(task)  ← ROUTE_TABLE             │  │   │
│   (single-turn,        │  └──────────────┬──────────────────────────────┘  │   │
│    packed state)       │       on-device  │  cloud                         │   │
│                        │  ┌──────────────▼─────────┐  ┌──────────────────┐  │   │
│                        │  │ firebaseAi.ts          │  │ firebaseAi.ts    │  │   │
│                        │  │ InferenceMode.         │  │ cloud model only │  │   │
│                        │  │  PREFER_ON_DEVICE      │  │                  │  │   │
│                        │  └────────────────────────┘  └──────────────────┘  │   │
│                        │  ┌─────────────────────────────────────────────┐  │   │
│                        │  │ audit log {requested, actual, model, bytes, │  │   │
│                        │  │            redacted, offline, reason}       │  │   │
│                        │  └─────────────────────────────────────────────┘  │   │
│                        └───────────┬──────────────────────────┬────────────┘   │
│                                    │                          │               │
│      ┌─────────────────────────────▼──────────┐   ┌───────────▼────────────┐  │
│      │ services/interview.ts (state machine)  │   │ ai/redact.ts           │  │
│      │ services/verify.ts                     │   │  shape + FORMAT FACTS  │  │
│      └───────────┬────────────────────────────┘   └───────────┬────────────┘  │
│                  │                                            │               │
│   ┌──────────────▼───────────────┐            ┌───────────────▼────────────┐  │
│   │ services/sessions.ts         │            │ the ONLY networked call    │  │
│   │ IndexedDB: sessions, images  │            │ (Firebase AI Logic / SDK)  │  │
│   └──────────────────────────────┘            └────────────────────────────┘  │
│   ┌──────────────────────────────┐                                            │
│   │ vault/vault.ts + crypto.ts   │   AES-GCM-256 · PBKDF2 310k · per-record IV │
│   │ ciphertext only in IndexedDB │   never imported by any Firebase module    │
│   └──────────────────────────────┘                                            │
│   ┌──────────────────────────────┐                                            │
│   │ services/sync.ts             │   offline queue: session IDs only          │
│   └──────────────────────────────┘                                            │
└───────────────────────────────────────────────────────────────────────────────┘
                                    │
                    only for verify + summary (redacted)
                                    ▼
┌────────────────────────── FIREBASE (Spark free tier) ─────────────────────────┐
│  Anonymous Auth        → silent identity, owner-scoped rules                   │
│  Firestore             → form METADATA only (labels, lights, status, hashes)   │
│                           rules REJECT any doc containing an answer value      │
│  Storage               → forms/{uid}/{sessionId}.jpg, private, ≤5 MB           │
│  Firebase AI Logic     → Gemini, proxied through the project (no key in app)   │
│  Cloud Functions       → NONE deployed in the default build (needs Blaze)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Data flow in one sentence:** the photo, the interview and the vault live and
die on the phone; only a redacted schema, a handful of non-identity values, and
the instruction text ever cross the network, and the instruction text is the
form's own published text, not the user's.

---

## How the on-device constraint shaped the product

This is the part most hybrid demos get wrong, so it is worth being blunt.

Firebase AI Logic's on-device path (Gemini Nano through Chrome's Prompt API) on
the web supports **single-turn generation only**. `startChat()` and multi-turn
history do not exist there. It *does* support structured JSON output, and text +
image input (JPEG/PNG only).

The naive way to build a form interview is a chat loop. That would silently push
the entire interview — with the Aadhaar number in it — to the cloud, and the
whole privacy story would be marketing.

**So the interview is not a chat. It is a sequence of single-turn prompts with
the state packed in.** Every turn sends:

```
FORM: "POST MATRIC SCHOLARSHIP 2026-27" (scholarship)
AB TAK BHARA:
- full_name: Priya Kumari
- mobile: ********10          ← sensitive values are masked in the prompt itself
BAKI FIELDS:
- annual_family_income | "Annual Family Income" | type=number | hint=in figures only
- bank_account | "Bank Account Number" | type=text
CURRENT FIELD: annual_family_income
USER NE ABHI KAHA: "5000"
→ respond with exactly one JSON interview turn
```

Four things fall out of that design, all of them good:

| Consequence | Why it matters |
|---|---|
| No conversation transcript exists | An Aadhaar number is never sitting in a growing context window, in memory, or in a devtools network log |
| Resume is free | After tab eviction or a dead battery, the next turn is just another packed prompt — no server-side session to restore |
| Airplane mode works | The interview has no server dependency at all |
| It is inspectable | The router log records `promptChars` per turn, so a judge can see the packed state is short (~1–2 KB), not a transcript |

Free-form chat — where a user genuinely needs history — is **routed to cloud on
purpose**, and labelled as such.

### Where on-device actually runs (we do not hide this)

| Environment | On-device (Nano) | What the app does |
|---|---|---|
| **Desktop Chrome 139+**, model downloaded | ✅ available | Full hybrid: steps 1–4 locally, 5–7 in cloud |
| Desktop Chrome 139+, model not downloaded | ⬇️ downloadable | “Download Gemini Nano” button in Settings (user gesture); until then cloud |
| Android Chrome / Safari / Firefox / Edge | ❌ unavailable | Cloud path for steps 1–3, with the badge honestly reading `Cloud` + the reason in the log |
| Installed PWA (any platform) | same as above | Same behaviour, plus real offline app shell |

The red-team answer to “so is the hybrid claim marketing on my phone?” is: the
badge and the log never claim on-device when it did not happen, the README says
where it *does* happen, and the **privacy** half of the story survives either
way — because redaction is a property of the payload, not of the hardware.

> **Cyber-cafe angle:** one operator desktop with the model downloaded serves a
> whole village's forms — offline, on-device, all day. That is the deployment
> story the constraint accidentally makes *better*.

---

## Privacy model, stated precisely

Most privacy claims are unfalsifiable. These are not — they are code and tests.

### 1. The Answer Vault is encrypted at rest, on-device

| Property | Value |
|---|---|
| Cipher | AES-GCM-256, `crypto.subtle` |
| Key derivation | PBKDF2-SHA256, **310,000** iterations, 16-byte random salt |
| Key handling | Imported as **non-extractable**; the raw bytes are unreadable even by our own JS |
| Per-record IV | Fresh 12-byte IV per answer; one corrupted record cannot take the vault down |
| Integrity | The record's sensitivity tag is authenticated as AES-GCM `additionalData` — a record cannot be re-labelled from “normal” to “sensitive” |
| Passphrase mode | Nothing usable is written to disk except a canary ciphertext |
| Quick mode | A random key stored as a `CryptoKey` object in IndexedDB (structured clone, raw bytes unreachable) |
| Storage | `IndexedDB → vault` store, ciphertext only |

Verified in the app: **Vault → 🔬 Ciphertext dikhayein** dumps the actual bytes
sitting in IndexedDB. They are opaque.

### 2. Identity values never reach the cloud — and the tests prove it

`src/ai/redact.ts` is the only path from a vault value to a cloud payload, and
`test/redact.test.ts` asserts, against realistic data, that a serialized payload
does **not** contain the Aadhaar number, the mobile number, the home address, the
date of birth, the bank account, the IFSC code or the pincode.

### 3. The cloud still gets enough to be useful: format facts

This is the subtle bit. Cloud verify must be able to say *“+91 lag gaya hai”* —
which requires knowing the shape of the number, not the number. So the device
computes the check locally and sends the verdict:

```
mobile    → "10-digit number (mobile-like) [format: digits=10, chars=10]"
aadhaar   → "12-digit number (aadhaar-like) [format: digits=12, chars=12]"
ifsc      → "11-character code (IFSC-like) [format: chars=11, digits=4, ifsc-valid]"
+91 case  → "10-digit number (mobile-like) [format: digits=10, chars=10, has-91-prefix, has-plus-prefix]"
```

The model can now flag the `+91` rule, the IFSC length rule and the digit-count
rule **without ever seeing a value** — and the app shows the exact payload before
sending (**Cloud ko kya jayega → Dekhein**).

Income is the deliberate exception: the instructions impose a *numeric* ceiling
(₹2,50,000), so income travels as a number. Sending the number is what makes the
money-shot catch — “5000 is monthly, put 60000” — real rather than scripted.

### 4. Three layers of defence, in order

1. **Build** — `buildCloudPayload()` replaces identity values with descriptors + facts
2. **Scrub** — `scrubPrompt()` greps the assembled prompt string for any sensitive raw value and replaces it (belt and braces for hints/instruction text)
3. **Sanitize** — if the model ignores instructions and echoes a value back in `suggestedValue`, `sanitizeVerifyResult()` **drops it** before it is shown or stored

### 5. What this does *not* protect against — said plainly in the app too

Browser-level encryption protects your data **at rest** and **from your own
cloud**. It does not protect against malicious JavaScript running in this origin
while the vault is unlocked, nor against a compromised device with an unlocked
vault in memory. That is why passphrase mode is recommended over quick mode, and
why the Vault screen states the limit in the same breath as the guarantee.

---

## Feature → code map (MVP 1–7)

| # | MVP feature | Where it lives |
|---|---|---|
| 1 | **Form intake** — photo/PDF → structured field list | `ui/screens/intake.ts`, `lib/image.ts`, `ai/prompts.ts:buildExtractionPrompt`, `ai/router.ts:routeExtract` |
| 2 | **Interview mode** — Hinglish, voice in/out, vault-aware skipping | `services/interview.ts` (state machine), `ui/screens/interview.ts`, `lib/voice.ts`, `ai/prompts.ts:buildInterviewPrompt` |
| 3 | **Answer Vault** — encrypted, reusable, on-device | `vault/crypto.ts`, `vault/vault.ts`, `ui/screens/vault.ts` |
| 4 | **Cloud verify pass** — instruction-page grounded, per-field flags | `services/verify.ts`, `ai/redact.ts`, `ai/prompts.ts:buildCloudVerifyPrompt`, `ai/router.ts:routeCloudVerify` |
| 5 | **Fill output** — annotated overlay + copyable answer sheet | `services/export.ts`, `ui/screens/result.ts` |
| 6 | **Offline-first** — 1-3 & 5 in airplane mode, 4 queues and replays | `public/sw.js`, `lib/idb.ts`, `services/sync.ts` |
| 6b | **Cold offline launch** — precached app shell + hashed bundles, so a phone in airplane mode opens the app instantly | `public/sw.js:precacheBuildAssets` |
| 7 | **Confidence UI** — traffic lights per field | `services/sessions.ts:computeLight`, `ui/badges.ts`, `ui/screens/checklist.ts` |

Plus, for the hybrid story specifically:
`ai/router.ts` (the map + audit log), `ui/routerLog.ts` (the drawer),
`ui/screens/howItWorks.ts` (the explainer), `ai/capabilities.ts` (the honest probe).

### The offline queue, in one paragraph

Verify is the only step that needs the network, so it is the only step that can
wait. Tap **Verify** with no connection and the app does not fail: it writes the
intent to IndexedDB (`services/sync.ts`), shows the banner *"verify queue mein
hai"* with an amber dot, and moves on — the user is never blocked from finishing
the form by hand. When the browser fires `online`, the queue drains itself, the
verify runs, and any open screen repaints with the verdicts (each screen adopts
the freshly loaded session rather than holding a stale object). DEMO MODE obeys
the same rule on purpose: the demo mock refuses cloud work while offline, because
otherwise the airplane-mode beat in the demo script would be theatre.

Stretch features from the brief (extra languages, share-as-image, install
prompt) are deliberately **not** shipped; the install experience is native PWA
behaviour and the answer sheet is already WhatsApp-pasteable.

### The traffic-light rule

Computed in exactly one function, `computeLight()`, so it can never drift:

| Light | Meaning | Rule |
|---|---|---|
| 🟢 green | Filled and trustworthy | cloud-verified, or vault-sourced, or confidence ≥ 0.85 |
| 🟡 yellow | Filled, needs a look | a cloud flag exists, or confidence 0.55–0.85 |
| 🔴 red | Missing | no value (the checklist separately marks optional empties as skippable) |

Conservative on purpose: a field only turns green when there is a *reason*.
Over-promising green is how a real form gets rejected.

---

## Going live on Firebase (Spark only)

Everything below is on the **free** tier. There is no credit card step, no paid
API, and no API key anywhere in the client bundle.

1. **Create the project** — [console.firebase.google.com](https://console.firebase.google.com) → Spark plan.
2. **Authentication** → Sign-in method → enable **Anonymous**.
3. **Firestore Database** → Create → production mode.
4. **Storage** → Get started (5 GB free).
5. **Project settings → Your apps → Web** → copy the config object.
6. **Paste it into one file** — `src/config/config.ts`:
   ```ts
   export const FIREBASE_CONFIG = {
     apiKey: '...',  authDomain: '...',  projectId: '...',
     storageBucket: '...',  messagingSenderId: '...',  appId: '...',
   };
   ```
   While any value still contains `PASTE_`, Firebase stays disabled and the app
   runs fully local. It never throws.
7. **AI Logic** → Get started (Gemini Developer API backend, free tier — no key
   is copied into this file; Firebase AI Logic proxies through your project).
8. **Turn DEMO MODE off** — `DEFAULT_DEMO_MODE = false` in `config.ts`, or just
   toggle it in **⚙️ Settings** at runtime (a judge can flip it without a rebuild).
9. **Deploy**:
   ```bash
   npm run build
   npx firebase-tools login
   npx firebase-tools use --add          # pick your project, alias it "default"
   npx firebase-tools deploy --only hosting,firestore:rules,storage
   ```

**Vercel instead of Firebase Hosting?** `vercel.json` is already included —
`vercel` (or import the repo) and it builds with `npm run build`, `dist/` as
output, SPA rewrites, and long-cache headers on hashed assets. The app is
static; only Firebase services need a project.

### Optional: server-side verify (only if you leave Spark)

The brief's architecture note mentions a callable that receives “only the field
schema + instruction text, never the Answer Vault”. That contract is implemented
and hardened in **`functions/src/index.ts`** — including a server-side check that
refuses any field claiming to be redacted while still containing a raw identity
number. It is **not** in the default deploy because Cloud Functions require the
Blaze plan. Deploy it deliberately:

```bash
cd functions && npm install && cd ..
firebase functions:secrets:set GEMINI_API_KEY
firebase deploy --only functions
```

---

## Demo script & what to click

A three-minute path that shows every claim, with no typing required:

| Time | Beat | Clicks |
|---|---|---|
| 0:00 | Hook | Home screen: “Form ki photo lo. Baaki hum karenge.” |
| 0:15 | **Airplane mode** | ⚙️ Settings → *Airplane mode (simulate)* → on. Top bar shows ✈️ Offline. |
| 0:25 | On-device extraction | Sample form → scholarship. Extraction runs with the radio off. Badge: **On-device**, 0 KB uploaded. |
| 0:50 | Vault prefill | Answer 5 fields by voice/typing. Open the **bank** form → fields pre-fill from the vault with zero typing. |
| 1:20 | **Privacy moment** | Vault → 🔬 *Ciphertext dikhayein*. Opaque bytes. Then **Cloud ko kya jayega → Dekhein**: Aadhaar is a format descriptor, not a number. |
| 1:45 | Cloud verify | Airplane mode off → ☁️ Verify (or watch the queue replay by itself). Set the demo mistake to *monthly income* → it catches it, in Hinglish, with a one-tap fix. Badge flips to **Cloud-verified**. |
| 2:20 | Output | Final form → annotated overlay with traffic-light borders + answer sheet + “is form ka hybrid hisaab” (calls on-device vs cloud, KB uploaded). |
| 2:40 | Architecture | 🛰 Router log → **Hybrid map** tab. Then **Device** tab: honest browser/Nano status. |

**Demo Mode** (🧪 badge) means mocks with realistic latency and realistic
outputs. **Live Mode** is the same UI against real Firebase AI Logic — switch in
Settings, no rebuild.

### The demo's planted mistake

Settings → *Demo galti* switches which error the verify pass reproduces:

| Profile | What verify catches |
|---|---|
| `monthly income` | Income `5000` → “limit ₹2,50,000 saalana hai, yeh mahine ki lag rahi hai” → suggests `60000` |
| `+91 mobile` | `+919876543210` → “+91 lag gaya hai, sirf 10 digit” (caught from format facts, without the number) |
| `galat IFSC` | `SBIN12345` → “IFSC 11 characters ka hota hai” |
| `sab theek` | No flags, green everywhere |

---

## Testing

```bash
npm run typecheck    # strict TS, zero errors
npm test             # 41 unit tests
python3 test/e2e_flow.py   # real Chromium, full flow, fails on any console error
```

What the suite actually guards:

| File | Guards |
|---|---|
| `test/redact.test.ts` | **No identity value can serialise into a cloud payload.** Format facts still work. Prompt scrub. Echo-back sanitisation. |
| `test/router.test.ts` | The hybrid map matches this README. Interview turns are single, packed (prompt length bounded 200–2000 chars), and log truthfully. Verify is never routed on-device. Monthly income is caught. |
| `test/vault.test.ts` | AES-GCM round-trip, unique IVs, **authentication failure when a sensitivity tag is swapped**, wrong-key rejection, PBKDF2 verifier, cross-form label matching (including “father never becomes mother”). |
| `test/e2e_flow.py` | Boot → vault → extraction → interview → checklist → verify → result → router log → offline → zero console errors. |

The e2e script also writes annotated screenshots to `test/shots/` — useful as
storyboard frames for the video.

---

## Project structure

```
formsathi/
├── index.html                     # shell + boot skeleton
├── src/
│   ├── main.ts                    # boot order: state → shell → SW → queue
│   ├── styles.css                 # design system (tokens, components, dark mode)
│   ├── config/config.ts           # ★ the only file you edit (Firebase + models + flags)
│   ├── lib/
│   │   ├── types.ts               # the AI + domain contract
│   │   ├── idb.ts                 # tiny IndexedDB wrapper (no deps)
│   │   ├── image.ts               # camera/PDF → ~150 KB JPEG (on-device compatible)
│   │   ├── voice.ts               # Web Speech in/out, hi-IN preferred
│   │   └── util.ts                # ids, JSON salvage, hashing
│   ├── vault/
│   │   ├── crypto.ts              # AES-GCM, PBKDF2, non-extractable keys
│   │   └── vault.ts               # encrypted records + cross-form matching
│   ├── ai/
│   │   ├── router.ts              # ★ ROUTE_TABLE, planRoute, audit log
│   │   ├── prompts.ts             # every prompt, all single-turn
│   │   ├── redact.ts              # ★ shape + format facts, scrubbing, sanitising
│   │   ├── capabilities.ts        # honest Gemini Nano probe
│   │   ├── firebaseAi.ts          # real PREFER_ON_DEVICE + cloud calls
│   │   ├── logCursor.ts           # log read helpers for screens
│   │   └── mock/fixtures.ts       # DEMO MODE: realistic outputs + latencies
│   ├── services/
│   │   ├── interview.ts           # interview state machine (packed state)
│   │   ├── verify.ts              # redact → call → sanitise → apply
│   │   ├── sessions.ts            # persistence + computeLight (single source)
│   │   ├── sync.ts                # offline queue, online replay
│   │   ├── export.ts              # overlay canvas + answer sheet
│   │   └── firebase.ts            # anonymous auth, metadata-only Firestore, Storage
│   ├── store/app.ts               # settings, boot, global state
│   ├── data/sampleLayouts.ts      # generated sample-form geometry
│   └── ui/
│       ├── dom.ts                 # esc/html/h/sheets/toasts
│       ├── badges.ts              # provenance badges + traffic lights
│       ├── routerLog.ts           # the audit drawer + hybrid map table
│       ├── shell.ts               # top bar, nav, hash router
│       ├── settings.ts            # demo mode, airplane mode, diagnostics
│       └── screens/               # home, intake, interview, checklist, verify,
│                                  # result, vault, howItWorks
├── public/
│   ├── sw.js                      # offline app shell (never caches Firebase)
│   ├── manifest.webmanifest
│   ├── icons/                     # generated, no external assets
│   └── samples/                   # generated sample forms + instruction page
├── functions/                     # OPTIONAL server-side verify (Blaze only)
├── scripts/                       # make-samples.py, make-icons.py
├── test/                          # unit tests + Playwright flow
├── firestore.rules                # rejects docs containing answer values
├── storage.rules                  # owner-only, 5 MB, jpeg/png
├── firebase.json · vercel.json    # both deploy targets, Spark-friendly
└── LICENSE                        # MIT
```

---

## Judging criteria → what to look at

| Criterion | Where the evidence is |
|---|---|
| **Technological Implementation** | `ai/router.ts` (per-step split + audit log), `ai/firebaseAi.ts` (`InferenceMode.PREFER_ON_DEVICE`, `initializeDeviceModel`, `response.inferenceSource`), `vault/crypto.ts` (non-extractable AES-GCM keys with authenticated sensitivity tags), `ai/prompts.ts` (single-turn packed-state interview), `test/redact.test.ts` (the privacy claim, executable) |
| **Design** | One-tap flow from home to camera; traffic lights computed in one function; Hinglish voice-first copy throughout; badges that tell the truth on every surface, including the ones where Nano cannot run; honest empty/queued/error states; dark mode; 44px touch targets; works at 360px |
| **Potential Impact** | The hook is in the app: 100 crore forms, worst internet, rejection cost. The cyber-cafe operator desktop becomes a *feature* of the on-device constraint. Named forms: Post-Matric Scholarship, PM Jan Dhan. The vault means the second form is 80% free. |
| **Quality of Idea** | Hybrid inference here is not a fallback trick — it is the privacy architecture *and* the offline architecture. The single-turn constraint is disclosed and turned into an advantage (no transcript, free resume, packed-state replay). Redaction by *format facts* lets the cloud verify what it could otherwise never see. |

---

## Honest limitations

Written down because a judge will find them anyway, and because the design
choices above only make sense if you know them.

1. **On-device web inference is desktop-Chrome-only today.** Gemini Nano via the
   Prompt API needs desktop Chrome 139+ with the model downloaded. Phones, Safari
   and Firefox run the cloud path for steps 1–3. The app says so, badges it, and
   logs it. Nothing pretends otherwise. (Android on-device needs a native app and
   a Nano-supported device.)
2. **The DEMO MODE extractor recognises the bundled sample forms.** Upload an
   arbitrary photo in demo mode and it falls back to the scholarship layout with
   a note saying so. Live mode reads your actual form.
3. **Browser-level encryption ≠ endpoint security.** Explained in-app: it protects
   data at rest and from the cloud, not from malicious JS in this origin while
   unlocked.
4. **OCR of the instruction page uses the cloud.** That is intentional and safe —
   an instruction page is published text with no personal data — but it does mean
   the verify beat needs a connection (or queues until it has one).
5. **Free-tier quota applies in live mode.** Spark + Gemini free tier is ample for
   a demo and for a single cyber-cafe operator, not for a thousand users a day.
6. **The app never submits anything to a government portal.** It fills the form and
   hands it back. Auto-submission and Aadhaar authentication are explicitly out of
   scope, and no Aadhaar API is touched.

---

## Licence

[MIT](./LICENSE) © 2026 FormSathi contributors.

Built for the **#BuildHybridAI 2026** hackathon. Not affiliated with, or endorsed
by, any government body. Sample forms are synthetic and generated by
`scripts/make-samples.py` — they are not real government documents.
