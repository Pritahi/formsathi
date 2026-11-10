/**
 * Form intake — MVP feature 1.
 *
 * Accepts: camera capture, gallery photo, PDF, or one of the bundled sample
 * forms (demo path with zero keys). Then:
 *   1. compress to a ~150 KB JPEG (image.ts)      ← data-plan friendly
 *   2. route to field extraction (on-device)      ← badges the result
 *   3. save session + image, then go to the interview
 *
 * The screen states are explicit because a slow first model call on a cheap
 * phone must never look like a crash: choosing → compressing → reading →
 * done/failed, each with honest copy.
 */

import { h, toast, openSheet } from '../dom';
import { go, screenHeader } from '../shell';
import { badge, provenanceLine } from '../badges';
import { openRouterLog } from '../routerLog';
import { processFile, type ProcessedImage } from '../../lib/image';
import { routeExtract, setSessionContext } from '../../ai/router';
import { newSession, saveSession, saveImage } from '../../services/sessions';
import { state } from '../../store/app';
import { SCHOLARSHIP_SAMPLE, BANK_SAMPLE } from '../../data/sampleLayouts';
import { formatBytes } from '../../lib/util';
import { uploadFormImage, currentUid } from '../../services/firebase';
import type { FormSession } from '../../lib/types';
import type { SampleKey } from '../../ai/mock/fixtures';

type Stage = 'choose' | 'compressing' | 'reading' | 'error';

export async function renderIntake(host: HTMLElement, intent?: string): Promise<() => void> {
  const screen = h('div', { class: 'screen' });
  host.append(screen);

  let stage: Stage = 'choose';
  let staged: { image: ProcessedImage; file: File | null; sample: SampleKey } | null = null;
  let errorMessage = '';

  const paint = () => {
    if (stage === 'choose') {
      screen.replaceChildren(
        screenHeader({
          title: 'Form add karein',
          subtitle: 'Photo, PDF ya sample — jo aapke paas ho',
          back: () => go('home'),
        }),
        picker(),
        tips(),
      );
      if (intent === 'photo') {
        // Auto-open the camera on arrival from the home CTA.
        setTimeout(() => (screen.querySelector<HTMLInputElement>('#camera-input') as HTMLInputElement | null)?.click(), 120);
      }
      return;
    }

    if (stage === 'compressing' || stage === 'reading') {
      screen.replaceChildren(working());
      return;
    }

    screen.replaceChildren(
      screenHeader({ title: 'Nahi padh paye', back: () => go('home') }),
      h('div', { class: 'note note-danger mb-16' }, h('span', {}, '⚠️'), h('div', {}, errorMessage)),
      h(
        'button',
        {
          class: 'btn btn-primary btn-block',
          onclick: () => {
            stage = 'choose';
            paint();
          },
        },
        'Dobara koshish karein',
      ),
      h('button', { class: 'btn btn-ghost btn-block mt-8', onclick: () => go('how') }, 'Madad chahiye?'),
    );
  };

  /* ── picker ─────────────────────────────────────────────────────────── */

  function picker(): HTMLElement {
    const wrap = h('div', { class: 'col gap-12' });

    // Camera input: capture=environment opens the rear camera directly on
    // Android and iOS. No getUserMedia needed, which avoids permission
    // differences between browsers.
    const camInput = h('input', {
      type: 'file',
      accept: 'image/*',
      capture: 'environment',
      id: 'camera-input',
      class: 'hidden',
    }) as HTMLInputElement;
    camInput.addEventListener('change', () => {
      const f = camInput.files?.[0];
      if (f) void handleFile(f, 'unknown');
    });

    const galInput = h('input', {
      type: 'file',
      accept: 'image/*,application/pdf',
      id: 'gallery-input',
      class: 'hidden',
    }) as HTMLInputElement;
    galInput.addEventListener('change', () => {
      const f = galInput.files?.[0];
      if (f) void handleFile(f, 'unknown');
    });

    const cameraCard = h('button', { class: 'card card-tap' });
    cameraCard.innerHTML = `
      <div class="row gap-12">
        <span class="avatar" style="width:44px;height:44px;font-size:20px" aria-hidden="true">📷</span>
        <div style="flex:1">
          <div class="card-title">Photo kheenchein</div>
          <div class="text-xs muted">Form ko seedha rakhein, poora page frame mein aaye</div>
        </div>
        <span aria-hidden="true" style="font-size:18px;color:var(--ink-4)">›</span>
      </div>
    `;
    cameraCard.addEventListener('click', () => camInput.click());

    const galleryCard = h('button', { class: 'card card-tap' });
    galleryCard.innerHTML = `
      <div class="row gap-12">
        <span class="avatar" style="width:44px;height:44px;font-size:20px" aria-hidden="true">🖼️</span>
        <div style="flex:1">
          <div class="card-title">Gallery se chunein</div>
          <div class="text-xs muted">Photo ya PDF — dono chalenge</div>
        </div>
        <span aria-hidden="true" style="font-size:18px;color:var(--ink-4)">›</span>
      </div>
    `;
    galleryCard.addEventListener('click', () => galInput.click());

    const sampleCard = h('button', { class: 'card card-tap' });
    sampleCard.innerHTML = `
      <div class="row gap-12">
        <span class="avatar" style="width:44px;height:44px;font-size:20px" aria-hidden="true">🎬</span>
        <div style="flex:1">
          <div class="card-title">Sample form se dekhein</div>
          <div class="text-xs muted">Bina camera — demo ke liye ready forms</div>
        </div>
        <span aria-hidden="true" style="font-size:18px;color:var(--ink-4)">›</span>
      </div>
    `;
    sampleCard.addEventListener('click', () => openSamplePicker());

    wrap.append(camInput, galInput, cameraCard, galleryCard, sampleCard);

    if (state.settings.simulatedOffline) {
      wrap.append(
        h(
          'div',
          { class: 'note note-warn mt-8' },
          h('span', {}, '✈️'),
          h('div', {}, h('b', {}, 'Offline mode on hai. '), 'Form padhna phir bhi chalega — on-device hai. Sirf cloud verify queue mein jayega.'),
        ),
      );
    }
    return wrap;
  }

  function tips(): HTMLElement {
    return h(
      'div',
      { class: 'card-flat mt-16' },
      h('b', { class: 'text-sm' }, 'Achhi photo ke liye'),
      h(
        'ul',
        { class: 'text-xs muted', style: 'margin:8px 0 0;padding-left:18px;line-height:1.7' },
        h('li', {}, 'Form ko table par rakhein, roshni mein'),
        h('li', {}, 'Poora page frame ke andar aaye — kona na kate'),
        h('li', {}, 'Chhaya ya tirchi photo se fields blur ho jati hain'),
      ),
    );
  }

  /* ── working state ──────────────────────────────────────────────────── */

  function working(): HTMLElement {
    const isReading = stage === 'reading';
    const preview = staged?.image;
    return h(
      'div',
      { class: 'screen', style: 'padding-top:8px' },
      h('h1', { style: 'font-size:21px' }, isReading ? 'Form padh raha hoon…' : 'Photo taiyaar kar raha hoon…'),
      h(
        'p',
        { class: 'text-sm muted mt-8' },
        isReading
          ? 'Gemini Nano aapke phone par hi fields nikaal raha hai. Photo kahin upload nahi ho rahi.'
          : 'Photo chhoti kar raha hoon taaki data kam lage.',
      ),
      preview
        ? h(
            'div',
            { class: 'viewer mt-16' },
            h('img', { src: preview.dataUrl, alt: 'Aapki chuni hui form' }),
          )
        : null,
      h('div', { class: 'progress progress-indeterminate mt-16' }, h('i', { style: 'width:40%' })),
      h(
        'div',
        { class: 'row center gap-8 mt-16' },
        badge({ kind: 'on-device', label: 'On-device', title: 'Form padhna on-device chalta hai' }),
        state.settings.demoMode ? badge({ kind: 'demo' }) : '',
      ),
      preview
        ? h('p', { class: 'text-2xs muted center-text mt-12' }, `${preview.width}×${preview.height} · ${formatBytes(preview.bytes)}${preview.fromPdf ? ` · PDF page 1/${preview.pageCount ?? 1}` : ''}`)
        : null,
    );
  }

  /* ── flow ───────────────────────────────────────────────────────────── */

  async function handleFile(file: File, sample: SampleKey) {
    if (file.size > 40 * 1024 * 1024) {
      toast('File bahut badi hai (40 MB se zyada)', { tone: 'error' });
      return;
    }
    stage = 'compressing';
    paint();
    try {
      const processed = await processFile(file, false);
      staged = { image: processed, file, sample };
      await extractAndContinue(processed, sample);
    } catch (err) {
      stage = 'error';
      errorMessage = err instanceof Error ? err.message : 'File padhne mein dikkat aayi.';
      paint();
    }
  }

  async function handleSample(key: 'scholarship' | 'bank') {
    const layout = key === 'bank' ? BANK_SAMPLE : SCHOLARSHIP_SAMPLE;
    stage = 'compressing';
    paint();
    try {
      const res = await fetch(layout.image);
      const blob = await res.blob();
      const file = new File([blob], layout.image.split('/').pop() ?? 'sample.jpg', { type: 'image/jpeg' });
      const processed = await processFile(file, false);
      staged = { image: processed, file, sample: key };
      await extractAndContinue(processed, key);
    } catch (err) {
      stage = 'error';
      errorMessage = err instanceof Error ? err.message : 'Sample load nahi hua.';
      paint();
    }
  }

  async function extractAndContinue(image: ProcessedImage, sample: SampleKey) {
    stage = 'reading';
    paint();

    const session = newSession();
    setSessionContext(session.id);

    try {
      const { extraction, log } = await routeExtract({
        image: { base64: image.base64, mimeType: image.mimeType, bytes: image.bytes },
        sample,
        language: 'hinglish',
      });

      session.title = extraction.title;
      session.formType = extraction.formType;
      session.authority = extraction.authority;
      session.extraction = extraction;
      session.extractStatus = 'done';
      session.sourceImageKey = session.id;
      session.sourceImageMime = image.mimeType;
      session.isPdf = image.fromPdf;
      session.notes = extraction.notes ?? [];

      await saveSession(session, true);
      await saveImage(session.id, image.blob);

      // Optional: keep the user's own photo in their private bucket. Never
      // blocks; failure is fine (Spark quota, offline, rules).
      if (currentUid() && !state.settings.simulatedOffline) {
        void uploadFormImage(session.id, currentUid()!, image.blob);
      }

      showExtractionSummary(session, log);
    } catch (err) {
      stage = 'error';
      const offline = err instanceof Error && /offline/i.test(err.message);
      errorMessage = offline
        ? 'Internet nahi hai aur on-device model abhi ready nahi hai. Settings se Gemini Nano download karein, ya net aane par dobara try karein.'
        : err instanceof Error
          ? err.message
          : 'Extraction fail ho gaya.';
      paint();
    }
  }

  function showExtractionSummary(session: FormSession, log: ReturnType<typeof routeExtract> extends Promise<infer R> ? (R extends { log: infer L } ? L : never) : never) {
    const extraction = session.extraction!;
    const body = h('div', { class: 'col gap-12' });
    body.innerHTML = `
      <div class="row wrap gap-6">
        ${badge({ kind: log.actualPath.includes('cloud') ? 'cloud' : 'on-device' })}
        ${state.settings.demoMode ? badge({ kind: 'demo' }) : ''}
        <span class="text-xs muted">${extraction.fields.length} fields mile</span>
      </div>
      ${provenanceLine(log)}
      <div class="card-flat">
        <div class="strong text-sm">${escape(extraction.title)}</div>
        <div class="text-xs muted mt-2">${escape(extraction.authority ?? '')} · ${escape(extraction.formType)}</div>
      </div>
      ${
        extraction.notes && extraction.notes.length
          ? `<div class="note note-warn"><span>⚠️</span><div>${extraction.notes.map(escape).join('<br/>')}</div></div>`
          : ''
      }
      <div class="col gap-6" style="max-height:34vh;overflow:auto">
        ${extraction.fields
          .map(
            (f) => `<div class="row gap-8" style="align-items:flex-start">
              <span class="text-2xs muted" style="width:52px;flex:none">${Math.round(f.confidence * 100)}%</span>
              <div style="flex:1;min-width:0">
                <div class="text-xs strong">${escape(f.label)}</div>
                <div class="text-2xs muted">${f.type}${f.required ? ' · zaroori' : ''}${f.hint ? ` · ${escape(f.hint)}` : ''}</div>
              </div>
            </div>`,
          )
          .join('')}
      </div>
    `;

    const footer = h('div', { class: 'row gap-8' });
    const start = h('button', { class: 'btn btn-primary flex1' }, 'Shuru karein →');
    start.addEventListener('click', () => {
      sheet.close();
      go('interview', session.id);
    });
    const logBtn = h('button', { class: 'btn btn-ghost btn-sm' }, '🛰 Log');
    logBtn.addEventListener('click', () => openRouterLog());
    footer.append(start, logBtn);

    const sheet = openSheet({
      title: 'Form padh liya',
      subtitle: state.settings.demoMode ? 'DEMO: mock extraction (asli mode mein Gemini Nano)' : undefined,
      body,
      footer,
    });
  }

  function openSamplePicker(): void {
    const body = h('div', { class: 'col gap-12' });
    body.innerHTML = `
      <p class="text-sm muted">Demo ke liye do forms ready hain. Pehle scholarship form bharein, phir bank form — aap dekhenge ki Answer Vault se kitna kuch apne aap bhar jata hai.</p>
      <div class="row gap-8">
        <div style="flex:1">
          <img class="sample-thumb" src="${SCHOLARSHIP_SAMPLE.image}" alt="Scholarship form sample" />
          <button class="btn btn-primary btn-sm btn-block mt-8" data-sample="scholarship">Scholarship form</button>
          <div class="text-2xs muted center-text mt-2">20 fields · asli jaisa</div>
        </div>
        <div style="flex:1">
          <img class="sample-thumb" src="${BANK_SAMPLE.image}" alt="Bank form sample" />
          <button class="btn btn-secondary btn-sm btn-block mt-8" data-sample="bank">Bank form</button>
          <div class="text-2xs muted center-text mt-2">14 fields · vault test</div>
        </div>
      </div>
      <div class="note">
        <span>💡</span>
        <div>Asli photo bhi try karein — camera button se. Demo mein model sample form pehchan leta hai; asli mode mein aapki apni form padhega.</div>
      </div>
    `;
    const sheet = openSheet({ title: 'Sample form chunein', body });
    body.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-sample]');
      if (!btn) return;
      sheet.close();
      void handleSample(btn.dataset.sample as 'scholarship' | 'bank');
    });
  }

  paint();
  return () => {
    /* nothing to clean up: inputs are garbage collected with the screen */
  };
}

function escape(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
