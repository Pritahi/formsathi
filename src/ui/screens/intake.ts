/**
 * Form intake - MVP feature 1.
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

import { h, toast, openSheet, confirmSheet } from '../dom';
import { go, screenHeader } from '../shell';
import { badge, provenanceLine } from '../badges';
import { openRouterLog } from '../routerLog';
import { processFile, type ProcessedImage } from '../../lib/image';
import { routeExtract, setSessionContext } from '../../ai/router';
import { newSession, saveSession, saveImage } from '../../services/sessions';
import { state } from '../../store/app';
import { SCHOLARSHIP_SAMPLE, BANK_SAMPLE } from '../../data/sampleLayouts';
import { formatBytes } from '../../lib/util';

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
          title: 'Add a form',
          subtitle: 'Photo, PDF or sample - whatever you have',
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
      screenHeader({ title: 'Could not read', back: () => go('home') }),
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
        'Try again',
      ),
      h('button', { class: 'btn btn-ghost btn-block mt-8', onclick: () => go('how') }, 'Need help?'),
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
          <div class="card-title">Take a photo</div>
          <div class="text-xs muted">Keep the form straight, full page in frame</div>
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
          <div class="card-title">Choose from gallery</div>
          <div class="text-xs muted">Photo or PDF - both work</div>
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
          <div class="card-title">See it with a sample form</div>
          <div class="text-xs muted">No camera - ready forms for the demo</div>
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
          h('div', {}, h('b', {}, 'Offline mode is on. '), 'Reading the form still works - it is on-device. Only cloud verify goes into the queue.'),
        ),
      );
    }
    return wrap;
  }

  function tips(): HTMLElement {
    return h(
      'div',
      { class: 'card-flat mt-16' },
      h('b', { class: 'text-sm' }, 'For a good photo'),
      h(
        'ul',
        { class: 'text-xs muted', style: 'margin:8px 0 0;padding-left:18px;line-height:1.7' },
        h('li', {}, 'Place the form on a table in good light'),
        h('li', {}, 'The full page must fit in the frame - no cut corners'),
        h('li', {}, 'Shadows or tilted photos blur the fields'),
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
      h('h1', { style: 'font-size:21px' }, isReading ? 'Reading the form…' : 'Preparing the photo…'),
      h(
        'p',
        { class: 'text-sm muted mt-8' },
        isReading
          ? 'Demo uses mock extraction. Live shows the actual source result badge; cloud fallback is off for personal forms.'
          : 'Shrinking the photo so it uses less data.',
      ),
      preview
        ? h(
            'div',
            { class: 'viewer mt-16' },
            h('img', { src: preview.dataUrl, alt: 'Your chosen form' }),
          )
        : null,
      h('div', { class: 'progress progress-indeterminate mt-16' }, h('i', { style: 'width:40%' })),
      h(
        'div',
        { class: 'row center gap-8 mt-16' },
        h('span', { class: 'text-xs muted' }, 'Processing - after the source result'),
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
      toast('File too big (over 40 MB)', { tone: 'error' });
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
      errorMessage = err instanceof Error ? err.message : 'There was a problem reading the file.';
      paint();
    }
  }

  async function handleSample(key: 'scholarship' | 'bank') {
    if (!state.settings.demoMode && sessionStorage.getItem('formsathi-cloud-eligible') !== 'yes') {
      const eligible = await confirmSheet({
        title: 'Adult developer prototype - synthetic samples only',
        message: 'Live cloud mode is only for developers age 18+ outside the EEA, Switzerland and UK. Only bundled fictional samples are sent to the unpaid Gemini API; Google may use these inputs/outputs to improve its products. Never send personal, sensitive or confidential data. Confirm that you meet these limits. Otherwise use Demo mode.',
        confirmLabel: 'I meet these limits',
      });
      if (!eligible) return;
      sessionStorage.setItem('formsathi-cloud-eligible', 'yes');
    }
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
      errorMessage = err instanceof Error ? err.message : 'Sample failed to load.';
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
        language: 'en',
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

      // Images stay in local IndexedDB. No Storage upload or billing dependency.

      showExtractionSummary(session, log);
    } catch (err) {
      stage = 'error';
      const offline = err instanceof Error && /offline/i.test(err.message);
      errorMessage = offline
        ? 'No internet and the on-device model is not ready. Download Gemini Nano from Settings, or try again when the network returns.'
        : err instanceof Error
          ? err.message
          : 'Extraction failed.';
      paint();
    }
  }

  function showExtractionSummary(session: FormSession, log: ReturnType<typeof routeExtract> extends Promise<infer R> ? (R extends { log: infer L } ? L : never) : never) {
    const extraction = session.extraction!;
    const body = h('div', { class: 'col gap-12' });
    body.innerHTML = `
      <div class="row wrap gap-6">
        ${badge({ kind: log.actualPath.includes('cloud') ? 'cloud' : 'on-device', label: log.actualPath.includes('cloud') ? 'Cloud extraction (not official validation)' : 'On-device extraction' })}
        ${state.settings.demoMode ? badge({ kind: 'demo' }) : ''}
        <span class="text-xs muted">${extraction.fields.length} fields found</span>
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
                <div class="text-2xs muted">${f.type}${f.required ? ' · required' : ''}${f.hint ? ` · ${escape(f.hint)}` : ''}</div>
              </div>
            </div>`,
          )
          .join('')}
      </div>
    `;

    const footer = h('div', { class: 'row gap-8' });
    const start = h('button', { class: 'btn btn-primary flex1' }, 'Start →');
    start.addEventListener('click', () => {
      sheet.close();
      go('interview', session.id);
    });
    const logBtn = h('button', { class: 'btn btn-ghost btn-sm' }, '🛰 Log');
    logBtn.addEventListener('click', () => openRouterLog());
    footer.append(start, logBtn);

    const sheet = openSheet({
      title: 'Form read',
      subtitle: state.settings.demoMode ? 'DEMO: mock extraction, not live inference' : undefined,
      body,
      footer,
    });
  }

  function openSamplePicker(): void {
    const body = h('div', { class: 'col gap-12' });
    body.innerHTML = `
      <p class="text-sm muted">Two forms are ready for the demo. Fill the scholarship form first, then the bank form - you will see how much the Answer Vault fills in automatically.</p>
      <div class="row gap-8">
        <div style="flex:1">
          <img class="sample-thumb" src="${SCHOLARSHIP_SAMPLE.image}" alt="Scholarship form sample" />
          <button class="btn btn-primary btn-sm btn-block mt-8" data-sample="scholarship">Scholarship form</button>
          <div class="text-2xs muted center-text mt-2">20 fields · realistic</div>
        </div>
        <div style="flex:1">
          <img class="sample-thumb" src="${BANK_SAMPLE.image}" alt="Bank form sample" />
          <button class="btn btn-secondary btn-sm btn-block mt-8" data-sample="bank">Bank form</button>
          <div class="text-2xs muted center-text mt-2">14 fields · vault test</div>
        </div>
      </div>
      <div class="note">
        <span>💡</span>
        <div>Personal photos need real on-device Nano. They never fall back to unpaid cloud. Bundled samples are fictional.</div>
      </div>
    `;
    const sheet = openSheet({ title: 'Choose a sample form', body });
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
  return String(s ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]!);
}
