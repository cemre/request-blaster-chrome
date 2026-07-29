// sheet.js — composites post thumbnails into contact-sheet JPEGs.
//
// Kept apart from model.js because OffscreenCanvas is not available under
// `node --test`. The geometry this consumes lives in model.js and is tested
// there; what remains here is drawing, verified by looking at the output.

import { call } from '../api.js';

const HEADER_PX = 64;
const BACKGROUND = '#111111';
const BADGE_BACKGROUND = 'rgba(0, 0, 0, 0.55)';

/**
 * One thumbnail, via the content script.
 *
 * Instagram's CDN sets Cross-Origin-Resource-Policy, so the panel cannot fetch
 * these directly — the request has to originate from an instagram.com page.
 * Returns null on failure so one dead image leaves a hole rather than losing
 * the whole sheet.
 */
export async function fetchBitmap(url) {
  try {
    const result = await call('media', { url });
    if (!result?.ok || !result.data?.dataUrl) return null;
    const blob = await (await fetch(result.data.dataUrl)).blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Center-crop a bitmap to fill a square cell without distorting it. */
function drawCover(ctx, bitmap, x, y, size) {
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;

  // Cover-scaling deliberately oversizes whichever dimension isn't the
  // limiting one, so the draw always overshoots the cell on one axis.
  // Without clipping, that overshoot paints over the next cell (or, for
  // row 0, the header) instead of being cropped away.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  ctx.drawImage(bitmap, x + (size - width) / 2, y + (size - height) / 2, width, height);
  ctx.restore();
}

function drawBadge(ctx, label, x, y, cell) {
  ctx.font = `${Math.round(cell * 0.07)}px system-ui, sans-serif`;
  const padding = Math.round(cell * 0.03);
  const width = ctx.measureText(label).width + padding * 2;
  const height = Math.round(cell * 0.12);

  ctx.fillStyle = BADGE_BACKGROUND;
  ctx.fillRect(x + cell - width - padding, y + padding, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + cell - width, y + padding + height / 2);
}

function drawHeader(ctx, { avatarBitmap, username, sheetNumber, sheetTotal }, width) {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, HEADER_PX);

  const inset = 8;
  const size = HEADER_PX - inset * 2;
  if (avatarBitmap) drawCover(ctx, avatarBitmap, inset, inset, size);

  ctx.fillStyle = '#ffffff';
  ctx.font = '28px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`@${username}`, inset * 2 + size, HEADER_PX / 2);

  ctx.fillStyle = '#999999';
  ctx.font = '22px system-ui, sans-serif';
  const label = `${sheetNumber}/${sheetTotal}`;
  ctx.fillText(label, width - ctx.measureText(label).width - inset * 2, HEADER_PX / 2);
}

/**
 * Render one JPEG per sheet in `plan`.
 *
 * @param media  normalized media items, newest first
 * @param plan   output of planSheets(media.length)
 * @param header { username, avatarUrl } — drawn on every sheet so a JPEG found
 *               on its own is still identifiable
 * @returns { blobs, failedIds } — one Blob per sheet in plan order, plus the
 *   ids of media items whose thumbnail fetch failed (drawn as a blank tile),
 *   so the caller can mark those entries rather than pairing a caption with
 *   a hole silently.
 */
export async function renderSheets({ media, plan, header }) {
  if (plan.length === 0) return { blobs: [], failedIds: [] };

  const avatarBitmap = header?.avatarUrl ? await fetchBitmap(header.avatarUrl) : null;
  const failedIds = [];
  try {
    const blobs = [];

    for (const sheet of plan) {
      const slice = media.slice(sheet.start, sheet.start + sheet.count);
      const bitmaps = [];
      for (const item of slice) {
        const bitmap = await fetchBitmap(item.url);
        if (!bitmap) failedIds.push(item.id);
        bitmaps.push(bitmap);
      }

      // A batch renders thousands of bitmaps; if convertToBlob or a draw call
      // throws partway through a sheet, every bitmap fetched for it still
      // needs closing or the decoded image memory leaks for the rest of the
      // call. Closing happens here rather than inline in the draw loop so it
      // still runs — exactly once per bitmap — on the throwing path too.
      try {
        const canvas = new OffscreenCanvas(sheet.width, sheet.height + HEADER_PX);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        drawHeader(ctx, {
          avatarBitmap,
          username: header?.username || '',
          sheetNumber: sheet.index + 1,
          sheetTotal: plan.length,
        }, sheet.width);

        bitmaps.forEach((bitmap, cellIndex) => {
          const x = (cellIndex % sheet.cols) * sheet.cell;
          const y = HEADER_PX + Math.floor(cellIndex / sheet.cols) * sheet.cell;
          if (bitmap) drawCover(ctx, bitmap, x, y, sheet.cell);
          const kind = slice[cellIndex]?.type;
          if (kind === 'video') drawBadge(ctx, 'VIDEO', x, y, sheet.cell);
          if (kind === 'carousel') drawBadge(ctx, 'MULTI', x, y, sheet.cell);
        });

        blobs.push(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
      } finally {
        for (const bitmap of bitmaps) bitmap?.close();
      }
    }

    return { blobs, failedIds };
  } finally {
    if (avatarBitmap) avatarBitmap.close();
  }
}

/**
 * One CDN image as a Blob, ready to write straight to disk.
 *
 * Used for the profile picture, which is written as its own file rather than
 * only being shrunk into a sheet header — for a private account it is the only
 * photograph available at all, so it has to survive at full size.
 */
export async function fetchImageBlob(url) {
  try {
    const result = await call('media', { url });
    if (!result?.ok || !result.data?.dataUrl) return null;
    return await (await fetch(result.data.dataUrl)).blob();
  } catch {
    return null;
  }
}
