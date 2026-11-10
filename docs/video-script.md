# FormSathi demo video — script and storyboard

Final video: 1:07, 1280x720, captioned (no voiceover required).
Demo data is fictional (Aarav / Rajesh / Meena Sharma, example.com).

| # | Scene | Dur | On-screen caption | Visual |
|---|-------|-----|-------------------|--------|
| 1 | Title | 4.5s | FormSathi — form bharne ka dost. #BuildHybridAI 2026 | Title card |
| 2 | Problem | 6s | Har saal lakhon students scholarship forms adhoore chhod dete hain. | Problem card, 4 bullets |
| 3 | Home | 5.5s | Ek mobile PWA. Demo mode mein bina key ke pura flow. | App home, demo banner |
| 4 | Sample picker | 4s | Sample forms se shuru — camera ki zaroorat nahi. | Intake + sample dialog |
| 5 | Extraction | 7s | Form padha — 20 fields mile. Photo phone se bahar nahi jaati. | Field list + confidence, On-device badge |
| 6 | Interview | 6s | Sawaal simple Hinglish mein. | First question screen |
| 7 | Live mapping | 6s | Jawab seedha sahi field mein — traffic-light status. | 3 answers mapped, Theek ticks |
| 8 | Checklist | 4.5s | Kaunsa field bhara, kaunsa baaki, kaunsa cloud-verified. | Field checklist sheet |
| 9 | Answer sheet | 7s | Copy-ready jawab, official instructions se matched. | Final form + cloud summary |
| 10 | Vault | 6s | WebCrypto se encrypted, sirf aapke phone par. | Answer Vault screen |
| 11 | Architecture | 10s | Teen steps phone par (Gemini Nano), teen steps cloud (Firebase AI Logic). Personal VALUES redacted. | Diagram card |
| 12 | Closing | 6s | Live demo + repo links. DEMO MODE: koi key nahi, koi paisa nahi. | Closing card |

## Optional voiceover (if re-recorded with narration)

1. "FormSathi — form bharne ka dost. Scholarship, exam aur sarkari forms, ab aapki bhasha mein."
2. "Har saal lakhon students forms adhoore chhod dete hain — English fields, paperwork, aur cyber-cafe ki line ki wajah se."
3. "FormSathi ek mobile PWA hai. Camera se form ki photo kheenchein — demo mode mein bina kisi key ke pura flow chalta hai."
4. "Demo ke liye do sample forms bundled hain."
5. "Gemini Nano aapke phone par hi form padhta hai — bees fields, confidence score ke saath. Photo kabhi upload nahi hoti."
6. "Phir sawaal aate hain — simple Hinglish mein, ek-ek karke."
7. "Har jawab turant sahi field se map hota hai — traffic-light status ke saath."
8. "Checklist hamesha dikhati hai kya bhara aur kya baaki hai."
9. "Aakhir mein copy-ready answer sheet — official instructions se matched, galtiyan pehle pakdi gayi."
10. "Aur Answer Vault — aapke jawab WebCrypto se encrypted, sirf aapke phone par. Agla form almost khud bhar jaata hai."
11. "Teen steps on-device — Gemini Nano. Teen steps cloud — Firebase AI Logic. Personal values redact hoke hi aage jaate hain."
12. "FormSathi. Demo abhi try karein — koi key nahi, koi paisa nahi."

## Production pipeline (fully scripted)

- `capture.js` / `capture2.js` / `capture3.js` — puppeteer-core over a locally served build, mobile viewport, fictional demo data
- `composite.py` — PIL scene compositor (cards + phone shots + captions)
- `assemble.py` — ffmpeg xfade chain → `formsathi-demo.mp4`
- To re-shoot against the live Firebase URL: point `BASE` at the deployed site, re-run the three captures, then composite + assemble (~15 min).
