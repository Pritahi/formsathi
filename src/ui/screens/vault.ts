/**
 * Answer Vault screen — MVP feature 3's user-facing half.
 *
 * The point of this screen in the demo is one number: how many fields the vault
 * can already answer on the NEXT form. So the header shows exactly that, and
 * the "sample data se bharein" button exists because a judge should not have to
 * type 15 answers to see the vault work.
 *
 * It is also where the encryption claims are made honestly: what AES-GCM with
 * PBKDF2 does protect, what it cannot protect against, and a live check that
 * ciphertext really is what sits in IndexedDB.
 */

import { h, toast, openSheet, confirmSheet } from '../dom';
import { go, screenHeader } from '../shell';
import { state, notify, subscribe } from '../../store/app';
import {
  createVault,
  unlockVault,
  lockVault,
  destroyVault,
  getAllAnswers,
  putAnswer,
  deleteAnswer,
  getVaultMeta,
  canonicalKeyFor,
  isSensitiveField,
  vaultExists,
  type VaultRecord,
} from '../../vault/vault';
import { idb, STORE, storageEstimate } from '../../lib/idb';
import { VAULT_CRYPTO_PARAMS, hasWebCrypto } from '../../vault/crypto';
import { SAMPLE_VAULT_SEED } from '../../ai/mock/fixtures';
import { formatBytes } from '../../lib/util';

export async function renderVault(host: HTMLElement): Promise<() => void> {
  const screen = h('div', { class: 'screen' });
  host.append(screen);

  let records: VaultRecord[] = [];
  let revealAll = false;
  let storage: { usage: number; quota: number } | null = null;
  let sealedCount = 0;

  const refresh = async (): Promise<void> => {
    state.vaultPresent = await vaultExists();
    state.vaultMode = (await getVaultMeta())?.mode ?? null;
    records = state.vaultUnlocked ? await getAllAnswers() : [];
    storage = await storageEstimate();
    sealedCount = state.vaultPresent ? (await idb.keys(STORE.vault)).length : 0;
    paint();
  };

  const paint = (): void => {
    screen.replaceChildren(
      screenHeader({ title: 'Answer Vault', subtitle: 'Aapke jawab, aapke phone mein, encrypted' }),
      ...(hasWebCrypto() ? [] : [cryptoWarning()]),
      !state.vaultPresent ? setupCard() : !state.vaultUnlocked ? unlockCard() : openVault(),
      securityCard(),
      footerNote(),
    );
  };

  /* ── states ─────────────────────────────────────────────────────────── */

  function cryptoWarning(): HTMLElement {
    return h(
      'div',
      { class: 'note note-danger mb-12' },
      h('span', {}, '⚠️'),
      h('div', {}, 'Is browser mein WebCrypto nahi hai (HTTPS zaroori hai). Vault yahan kaam nahi karega — par form bharna chalta rahega.'),
    );
  }

  function setupCard(): HTMLElement {
    const card = h('div', { class: 'card mb-12' });
    card.innerHTML = `
      <div class="card-title">Vault banayein</div>
      <p class="text-sm muted mt-8">Ek baar apna naam, DOB, address, category bhar dein. Aage jo bhi form aayega, woh apne aap bhar jayega — kyunki jawab aapke phone mein encrypted rehte hain, kisi server par nahi.</p>
    `;

    const passWrap = h('div', { class: 'mt-12' });
    passWrap.innerHTML = `
      <label class="label" for="vault-pass">Passphrase (kam se kam 6 characters)</label>
      <input class="input" id="vault-pass" type="password" autocomplete="new-password" placeholder="Yaad rakhne wala password" />
      <p class="hint">💡 Isse aapka vault key banta hai. Hum ise kabhi save nahi karte — bhool gaye to jawab dobara bharne padenge.</p>
    `;

    const row = h('div', { class: 'col gap-8 mt-12' });
    const createPass = h('button', { class: 'btn btn-primary btn-block' }, '🔐 Passphrase se vault banayein');
    createPass.addEventListener('click', async () => {
      const pw = (passWrap.querySelector('#vault-pass') as HTMLInputElement).value;
      try {
        await createVault({ mode: 'passphrase', passphrase: pw });
        state.vaultUnlocked = true;
        toast('Vault ban gaya — ab jawab save honge', { tone: 'success' });
        await refresh();
        notify();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Vault nahi bana', { tone: 'error' });
      }
    });

    const quick = h('button', { class: 'btn btn-secondary btn-block' }, '⚡ Bina passphrase (is device par)');
    quick.addEventListener('click', () => {
      void (async () => {
        const ok = await confirmSheet({
          title: 'Bina passphrase?',
          message:
            'Key is device par hi rehti hai (non-extractable CryptoKey). Demo aur cyber-cafe ke liye aasan hai, lekin phone kisi aur ke haath lage to vault khul sakta hai. Asli istemal ke liye passphrase behtar hai.',
          confirmLabel: 'Aage badhein',
        });
        if (!ok) return;
        try {
          await createVault({ mode: 'quick' });
          state.vaultUnlocked = true;
          toast('Vault ready (device key)', { tone: 'success' });
          await refresh();
          notify();
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Vault nahi bana', { tone: 'error' });
        }
      })();
    });

    const seed = h('button', { class: 'btn btn-ghost btn-block' }, '🎬 Demo data se bharein');
    seed.addEventListener('click', () => void seedDemo());
    seed.title = 'Sample answers — demo ke liye';

    row.append(createPass, quick, seed);
    card.append(passWrap, row);
    return card;
  }

  function unlockCard(): HTMLElement {
    const meta = state.vaultMode;
    const card = h('div', { class: 'card mb-12' });
    card.innerHTML = `
      <div class="row gap-8 mb-8"><span class="avatar">🔒</span><div>
        <div class="card-title">Vault locked hai</div>
        <div class="text-xs muted">${meta === 'passphrase' ? 'Passphrase daal kar unlock karein' : 'Device key se unlock'}</div>
      </div></div>
    `;

    if (meta === 'passphrase') {
      const input = h('input', { class: 'input mt-8', type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password' }) as HTMLInputElement;
      const btn = h('button', { class: 'btn btn-primary btn-block mt-8' }, 'Unlock karein');
      const doUnlock = async () => {
        const ok = await unlockVault(input.value);
        if (ok) {
          state.vaultUnlocked = true;
          toast('Vault khul gaya', { tone: 'success' });
          await refresh();
          notify();
        } else {
          toast('Passphrase galat hai', { tone: 'error' });
        }
      };
      btn.addEventListener('click', () => void doUnlock());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void doUnlock();
      });
      card.append(input, btn);
    } else {
      const btn = h('button', { class: 'btn btn-primary btn-block mt-8' }, 'Unlock karein');
      btn.addEventListener('click', async () => {
        const { unlockQuick } = await import('../../vault/vault');
        const ok = await unlockQuick();
        state.vaultUnlocked = ok;
        if (ok) toast('Vault khul gaya', { tone: 'success' });
        await refresh();
        notify();
      });
      card.append(btn);
    }
    return card;
  }

  function openVault(): HTMLElement {
    const wrap = h('div', { class: 'col gap-12' });

    // The headline stat: how many fields the next form can pre-fill.
    const stat = h('div', { class: 'card' });
    stat.innerHTML = `
      <div class="row between">
        <div>
          <div class="text-2xs strong muted" style="text-transform:uppercase;letter-spacing:.05em">Vault mein</div>
          <div style="font-size:32px;font-weight:800;letter-spacing:-.02em;line-height:1.1">${records.length}</div>
          <div class="text-xs muted">jawab · agla form inhe apne aap bharega</div>
        </div>
        <div class="col gap-6" style="align-items:flex-end">
          <span class="badge badge-device"><span class="badge-ic">📱</span><span class="badge-tx">On-device only</span></span>
          <span class="text-2xs muted">${sealedCount} encrypted records</span>
        </div>
      </div>
    `;
    wrap.append(stat);

    const tools = h('div', { class: 'row wrap gap-8' });
    const reveal = h('button', { class: 'btn btn-ghost btn-sm' }, revealAll ? '🙈 Chhupayein' : '👁 Dikhayein');
    reveal.addEventListener('click', () => {
      revealAll = !revealAll;
      paint();
    });
    const addBtn = h('button', { class: 'btn btn-secondary btn-sm' }, '➕ Jawab jodein');
    addBtn.addEventListener('click', () => openAddSheet());
    const lockBtn = h('button', { class: 'btn btn-ghost btn-sm' }, '🔒 Lock');
    lockBtn.addEventListener('click', () => {
      lockVault();
      state.vaultUnlocked = false;
      toast('Vault lock ho gaya');
      void refresh();
      notify();
    });
    tools.append(reveal, addBtn, lockBtn);
    if (records.length === 0) {
      const seed = h('button', { class: 'btn btn-saffron btn-sm' }, '🎬 Demo data');
      seed.addEventListener('click', () => void seedDemo());
      tools.append(seed);
    }
    wrap.append(tools);

    if (records.length === 0) {
      wrap.append(
        h(
          'div',
          { class: 'card empty' },
          h('span', { class: 'ic' }, '🗂'),
          h('div', { class: 'text-sm' }, 'Vault khali hai.'),
          h('div', { class: 'text-xs muted mt-2' }, 'Interview mein diye jawab apne aap yahan aa jayenge.'),
          h('button', { class: 'btn btn-primary btn-sm mt-12', onclick: () => go('intake', 'samples') }, 'Sample form bharein'),
        ),
      );
      return wrap;
    }

    const list = h('div', { class: 'col gap-8' });
    for (const r of records) {
      const row = h('div', { class: 'card card-tight' });
      const shown = revealAll ? r.value : mask(r.value);
      row.innerHTML = `
        <div class="row between gap-8">
          <div style="flex:1;min-width:0">
            <div class="text-2xs muted">${escape(r.label)}</div>
            <div class="text-sm strong" style="word-break:break-word">${escape(shown)}</div>
            <div class="row wrap gap-4 mt-2">
              ${r.sensitive ? `<span class="badge badge-fallback badge-sm"><span class="badge-ic">🔒</span><span class="badge-tx">sensitive</span></span>` : ''}
              ${r.uses > 0 ? `<span class="text-2xs muted">${r.uses}× form bhara</span>` : `<span class="text-2xs muted">abhi use nahi hua</span>`}
            </div>
          </div>
          <button class="icon-btn sm ghost" data-del aria-label="Delete">🗑</button>
        </div>
      `;
      row.querySelector('[data-del]')?.addEventListener('click', async () => {
        const ok = await confirmSheet({
          title: 'Jawab hataayein?',
          message: `"${r.label}" vault se hat jayega. Purane forms par koi asar nahi padega.`,
          confirmLabel: 'Hataayein',
          danger: true,
        });
        if (ok) {
          await deleteAnswer(r.id);
          toast('Hata diya');
          await refresh();
        }
      });
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  function securityCard(): HTMLElement {
    const card = h('div', { class: 'card-flat mt-12' });
    card.innerHTML = `
      <b class="text-sm">🔐 Andar se kya hota hai</b>
      <dl class="kv mt-8">
        <dt>Algorithm</dt><dd>${VAULT_CRYPTO_PARAMS.algorithm} ${VAULT_CRYPTO_PARAMS.keyBits}-bit</dd>
        <dt>Key derivation</dt><dd>${VAULT_CRYPTO_PARAMS.kdf} · ${VAULT_CRYPTO_PARAMS.iterations.toLocaleString('en-IN')} rounds</dd>
        <dt>Per-record IV</dt><dd>${VAULT_CRYPTO_PARAMS.ivBytes} bytes, har jawab ke liye naya</dd>
        <dt>Storage</dt><dd>IndexedDB, sirf ciphertext</dd>
        <dt>Server</dt><dd>Kuch nahi — Firestore mein jawab kabhi nahi jate</dd>
        ${storage ? `<dt>Device storage</dt><dd>${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}</dd>` : ''}
      </dl>
      <p class="text-2xs muted mt-8" style="line-height:1.6">
        <b>Sach bhi:</b> yeh browser ke andar ka encryption hai. Agar koi malicious app ya script aapke browser mein chal raha ho
        jab vault khula hai, to woh jawab padh sakta hai. Server-side data leak se yeh aapko bachata hai — aapke phone par
        pade malware se nahi. Isliye passphrase mode recommend karte hain.
      </p>
      <button class="btn btn-ghost btn-sm mt-8" id="prove">🔬 Ciphertext dikhayein</button>
    `;
    card.querySelector('#prove')?.addEventListener('click', () => void showCiphertext());
    return card;
  }

  async function showCiphertext(): Promise<void> {
    const sealed = await idb.all<{ id: string; ciphertext: string; iv: string; sensitive: boolean }>(STORE.vault);
    const body = h('div', { class: 'col gap-8' });
    body.innerHTML = `
      <p class="text-sm muted">Yeh woh hai jo is waqt aapke phone ke IndexedDB mein pada hai. Dhyan se dekhein — koi naam, koi number, kuch bhi padhne layak nahi.</p>
      <pre class="code" style="max-height:40vh">${escape(
        sealed
          .slice(0, 3)
          .map((s) => JSON.stringify({ id: s.id, iv: s.iv, ciphertext: `${s.ciphertext.slice(0, 64)}…` }, null, 2))
          .join('\n\n') || 'Vault khali hai',
      )}</pre>
      <div class="note note-ok"><span>✓</span><div>${sealed.length} records — sab ciphertext. Server par kuch nahi bheja gaya.</div></div>
    `;
    openSheet({ title: 'IndexedDB mein kya pada hai', body });
  }

  async function seedDemo(): Promise<void> {
    if (!state.vaultUnlocked) {
      toast('Pehle vault banayein/unlock karein', { tone: 'warn' });
      return;
    }
    for (const item of SAMPLE_VAULT_SEED) {
      await putAnswer({
        id: canonicalKeyFor(item.label),
        label: item.label,
        value: item.value,
        sensitive: isSensitiveField(item.label),
      });
    }
    toast(`${SAMPLE_VAULT_SEED.length} demo jawab vault mein aa gaye`, { tone: 'success' });
    await refresh();
  }

  function openAddSheet(): void {
    const body = h('div', { class: 'col gap-10' });
    body.innerHTML = `
      <div><label class="label" for="v-label">Label</label>
      <input class="input" id="v-label" placeholder="Jaise: Date of Birth" /></div>
      <div><label class="label" for="v-value">Jawab</label>
      <input class="input" id="v-value" placeholder="Jawab likhein" /></div>
      <p class="text-2xs muted">Label wahi rakhein jo form par likha hota hai — tab hi agla form ise pehchan payega.</p>
    `;
    const save = h('button', { class: 'btn btn-primary btn-block' }, 'Vault mein save karein');
    const sheet = openSheet({ title: 'Naya jawab', body, footer: save });
    save.addEventListener('click', async () => {
      const label = (body.querySelector('#v-label') as HTMLInputElement).value.trim();
      const value = (body.querySelector('#v-value') as HTMLInputElement).value.trim();
      if (!label || !value) {
        toast('Label aur jawab dono chahiye', { tone: 'warn' });
        return;
      }
      await putAnswer({ id: canonicalKeyFor(label), label, value, sensitive: isSensitiveField(label) });
      sheet.close();
      toast('Save ho gaya', { tone: 'success' });
      await refresh();
    });
  }

  function footerNote(): HTMLElement {
    return h(
      'div',
      { class: 'mt-16 col gap-8' },
      h(
        'button',
        { class: 'btn btn-ghost btn-sm', onclick: () => go('how') },
        '🔐 Encryption ke baare mein aur padhein',
      ),
      h(
        'button',
        { class: 'btn btn-danger btn-sm' },
        'Vault poora mita dein',
      ),
    );
  }

  // Wire the destroy button (needs confirm + async).
  setTimeout(() => {
    const btn = Array.from(screen.querySelectorAll('button')).find((b) => b.textContent?.includes('poora mita'));
    btn?.addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: 'Vault mitayein?',
        message: 'Saare encrypted jawab hamesha ke liye chale jayenge. Yeh undo nahi hota.',
        confirmLabel: 'Sab mita dein',
        danger: true,
      });
      if (!ok) return;
      await destroyVault();
      state.vaultUnlocked = false;
      state.vaultPresent = false;
      toast('Vault mit gaya');
      await refresh();
      notify();
    });
  }, 0);

  paint();
  await refresh();
  const unsub = subscribe(() => {
    /* settings changes don't alter the vault; painted on demand */
  });
  return () => unsub();
}

function mask(v: string): string {
  if (v.length <= 3) return '•••';
  return `${'•'.repeat(Math.min(10, v.length - 2))}${v.slice(-2)}`;
}

function escape(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
