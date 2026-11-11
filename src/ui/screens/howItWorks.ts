import { h } from '../dom';
import { go, screenHeader } from '../shell';
import { openRouterLog } from '../routerLog';
import { downloadOnDeviceModel } from '../../ai/router';
import { toast } from '../dom';

export async function renderHowItWorks(host: HTMLElement): Promise<() => void> {
  const screen = h('div', { class: 'screen' });
  host.append(screen);
  screen.append(screenHeader({ title: 'Prototype status and privacy', back: () => go('home') }));
  const card = h('div', { class: 'card' });
  card.innerHTML = `<h2>Adult-developer prototype</h2>
    <p>Use fictional samples. This is not an official government or bank service.</p>
    <h3>Demo mode</h3><p>Every AI response is mocked. The encrypted local Answer Vault is real. Demo badges do not prove Gemini Nano execution.</p>
    <h3>Live mode</h3><p>Real synthetic cloud extraction is verified; Nano execution is not verified yet. Personal images and answer prompts use ONLY_ON_DEVICE, with no cloud retry. If Nano is unavailable, interview and normalization use labeled local rules.</p>
    <p>Only bundled synthetic samples may opt into unpaid cloud extraction after adult-developer and region confirmation. Arbitrary personal verification prompts are blocked. Local summaries are not AI verification.</p>
    <h3>Data and costs</h3><p>Photos stay in local IndexedDB. Answer Vault values are encrypted locally. No Storage upload or billing upgrade is used. Device compromise or an unlocked session can expose data.</p>
    <p>Unpaid Gemini inputs may be used to improve Google products. Never submit personal, confidential or sensitive information. The live cloud path is not offered in EEA, Switzerland or UK.</p>`;
  screen.append(card);
  const log = h('button', { class: 'btn btn-secondary mt-12' }, 'Router log');
  log.addEventListener('click', () => openRouterLog());
  const download = h('button', { class: 'btn btn-secondary mt-12' }, 'Try on-device model setup');
  download.addEventListener('click', async () => {
    try { await downloadOnDeviceModel(); toast('Setup finished. Check the actual source badge on a model result.'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Model setup failed', { tone: 'error' }); }
  });
  screen.append(log, download);
  return () => {};
}
