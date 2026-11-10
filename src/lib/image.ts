/**
 * Image intake: camera/upload → compressed JPEG → base64 for the model.
 *
 * Two things this module gets right, both from the red-team notes:
 *  1. DATA PLAN: a 4 MB phone photo becomes a ~140 KB JPEG before anything
 *     leaves the device. Tier-3 users on a 1.5 GB/day plan never pay for our
 *     pixels.
 *  2. ON-DEVICE COMPATIBILITY: Chrome's Prompt API (and therefore Firebase AI
 *     Logic's on-device adapter) only accepts image/jpeg and image/png.
 *     Everything is normalized to JPEG here so the on-device path can never
 *     fail on a mime-type rejection.
 *
 * PDFs are rendered client-side with pdf.js — page 1 becomes the "photo" so
 * the exact same extraction prompt works for paper and PDF.
 */

import { IMAGE_JPEG_QUALITY, IMAGE_MAX_EDGE_PX, IMAGE_MAX_EDGE_PX_ON_DEVICE } from '../config/config';

export interface ProcessedImage {
  blob: Blob;
  /** bare base64 (no data: prefix) — what Firebase AI Logic wants. */
  base64: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  /** data URL for display only. */
  dataUrl: string;
  /** true when the source was a PDF we rasterized. */
  fromPdf: boolean;
  pageCount?: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = src;
  });
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('File read failed'));
    fr.readAsDataURL(file);
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => reject(fr.error ?? new Error('Blob read failed'));
    fr.readAsDataURL(blob);
  });
}

/** Downscale + re-encode to JPEG. Returns null if canvas is unavailable. */
async function canvasCompress(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxEdge: number,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D unavailable');
  // White background: JPEG has no alpha, and form photos are paper.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
  );
  if (!blob) throw new Error('JPEG encode failed');
  return { blob, width: w, height: h };
}

/**
 * Process a user-picked file (photo or PDF) into something both inference
 * paths accept.
 *
 * @param forOnDevice when true, target the smaller edge budget — Nano's
 *   vision is the slow half and it gains nothing from 1600px.
 */
export async function processFile(file: File, forOnDevice = false): Promise<ProcessedImage> {
  const maxEdge = forOnDevice ? IMAGE_MAX_EDGE_PX_ON_DEVICE : IMAGE_MAX_EDGE_PX;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

  if (isPdf) {
    const { blob, pageCount } = await renderPdfFirstPage(file, maxEdge);
    const base64 = await blobToBase64(blob);
    const dims = await imageSize(blob);
    return {
      blob,
      base64,
      mimeType: 'image/jpeg',
      width: dims.width,
      height: dims.height,
      bytes: blob.size,
      dataUrl: await readAsDataUrl(blob),
      fromPdf: true,
      pageCount,
    };
  }

  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const compressed = await canvasCompress(
    img,
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
    maxEdge,
    IMAGE_JPEG_QUALITY,
  );
  return {
    blob: compressed.blob,
    base64: await blobToBase64(compressed.blob),
    mimeType: 'image/jpeg',
    width: compressed.width,
    height: compressed.height,
    bytes: compressed.blob.size,
    dataUrl: await readAsDataUrl(compressed.blob),
    fromPdf: false,
  };
}

async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Render page 1 of a PDF to a JPEG blob using pdf.js.
 * pdf.js is imported dynamically so the 400 KB library is never in the boot
 * payload — PDF is the rarer intake path, and it must not cost a photo user
 * anything.
 */
async function renderPdfFirstPage(
  file: File,
  maxEdge: number,
): Promise<{ blob: Blob; pageCount: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, maxEdge / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', IMAGE_JPEG_QUALITY),
  );
  if (!blob) throw new Error('PDF page encode failed');
  return { blob, pageCount: doc.numPages };
}

/** Grab a single frame from the camera stream (used by the live camera mode
 *  when getUserMedia is available; the capture="" input covers everything
 *  else, including iOS Safari). */
export async function captureFrameFromStream(
  stream: MediaStream,
  maxEdge = IMAGE_MAX_EDGE_PX,
): Promise<ProcessedImage> {
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings() ?? {};
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  const w = settings.width ?? video.videoWidth;
  const h = settings.height ?? video.videoHeight;
  const compressed = await canvasCompress(video, w, h, maxEdge, IMAGE_JPEG_QUALITY);
  video.pause();
  video.srcObject = null;
  return {
    blob: compressed.blob,
    base64: await blobToBase64(compressed.blob),
    mimeType: 'image/jpeg',
    width: compressed.width,
    height: compressed.height,
    bytes: compressed.blob.size,
    dataUrl: await readAsDataUrl(compressed.blob),
    fromPdf: false,
  };
}

/** A drawn thumbnail for the session list — cheap, 240px. */
export async function makeThumb(source: Blob): Promise<Blob> {
  const url = URL.createObjectURL(source);
  try {
    const img = await loadImage(url);
    const { blob } = await canvasCompress(
      img,
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
      240,
      0.6,
    );
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
