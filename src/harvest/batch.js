// batch.js — writes a harvest batch into the Downloads folder.
//
// chrome.downloads cannot escape the browser's download directory, which is
// the whole reason the review stage reads from there rather than from a path
// of its choosing.

const ROOT = 'follow-back-review';

/** e.g. "2026-07-28-1432". Sortable, and readable in a file dialog. */
export function newBatchId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-') + `-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// A few hundred KB to local disk is near-instant, so anything still running
// this long is not "slow" — it's stuck, almost always behind an OS Save-As
// dialog waiting on a human (chrome.downloads.download always passes
// saveAs: false, but a user-set "ask where to save each file" browser
// setting overrides that). Timing out turns a batch-wide hang into one
// reported failure.
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * A blob URL stays valid only until it is revoked, and revoking it before the
 * download finishes truncates the file. So every write waits for the download
 * to reach a terminal state.
 */
function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    // Guards both the double-fire race (onChanged and the search below can
    // each try to settle) and leaks: whichever path wins removes the
    // listener and cancels the timeout so the loser is a no-op.
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      fn(value);
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        settle(resolve);
      } else if (delta.state.current === 'interrupted') {
        settle(reject, new Error('download interrupted'));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    // The download can reach a terminal state before the listener above is
    // attached, in which case onChanged never fires for it at all — so check
    // whatever state it is already in as soon as we're listening for more.
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (!item) return;
      if (item.state === 'complete') settle(resolve);
      else if (item.state === 'interrupted') settle(reject, new Error('download interrupted'));
    }).catch(() => {
      // Ignore — onChanged and the timeout below still cover this download.
    });

    timer = setTimeout(() => {
      settle(reject, new Error(
        `download ${downloadId} did not finish within ${DOWNLOAD_TIMEOUT_MS}ms — ` +
        'likely stuck behind an OS "Save As" dialog; check for one and dismiss it',
      ));
    }, DOWNLOAD_TIMEOUT_MS);
  });
}

export async function writeBlob({ batchId, name, blob }) {
  const filename = `${ROOT}/${batchId}/${name}`;
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'overwrite',
    });
    await waitForDownload(downloadId);
    console.log('[Harvest] wrote', filename, `(${blob.size} bytes, download ${downloadId})`);
  } catch (err) {
    // Every account writes files, so a failure here is worth naming with the
    // path that failed — a bare rejection bubbling up through the queue is how
    // a whole batch once failed without saying anything.
    console.error('[Harvest] FAILED to write', filename, err);
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function writeJson({ batchId, name, value }) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  return writeBlob({ batchId, name, blob });
}

/**
 * A 50-account batch is over 100 files. Without this the download bubble opens
 * on every one of them.
 */
export async function suppressDownloadUi(suppressed) {
  try {
    await chrome.downloads.setUiOptions({ enabled: !suppressed });
  } catch {
    // Not fatal — the batch still writes, it is just noisy.
  }
}
