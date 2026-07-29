// harvest-content.js — Instagram API operations used only by the follow-back
// harvest feature. Split out of content.js so the harvest feature can be
// added or removed by editing manifest.json alone, without touching the
// shared operation table content.js exposes to every other content script.
//
// Runs in the same isolated world as content.js and registers into its
// OPERATIONS table via window.__requestBlaster.register(); see content.js for
// igFetch, API_ROOT and the classify() error contract these calls rely on.

(() => {
  // Deliberately not guarded against double-injection the way banner.js is.
  // Registering is idempotent — the same names overwrite themselves — and a
  // guard here caused a real failure: it was set before the destructure below,
  // so if content.js had not run yet the destructure threw with the flag
  // already true, and every later injection returned early. That left the
  // world permanently without these operations, failing every call with
  // "unknown op: followers".
  const bridge = window.__requestBlaster;
  if (!bridge?.register) {
    console.error('[Request Blaster] harvest ops not registered: content.js has not run in this frame');
    return;
  }

  const { igFetch, API_ROOT, readCookie, register } = bridge;

  register({
    /**
     * The viewer's own followers, paginated. `userId` defaults to the signed-in
     * user from the ds_user_id cookie, so callers never have to know it.
     */
    followers({ userId, maxId, count = 200 }) {
      const id = userId || readCookie('ds_user_id');
      if (!id) return Promise.resolve({ ok: false, status: 0, error: 'no viewer id' });

      const params = new URLSearchParams({ count: String(count) });
      if (maxId) params.set('max_id', maxId);
      return igFetch(`${API_ROOT}/friendships/${id}/followers/?${params}`, { method: 'GET' });
    },

    /**
     * Followers the viewer and this account have in common.
     *
     * web_profile_info carries `edge_mutual_followed_by` with an accurate
     * count but only three names. This returns the actual list — verified
     * 2026-07-28 to answer with 53 users where the edge gave 3. That matters
     * most for private accounts, where mutuals are one of only three signals
     * available at all.
     */
    mutualFollowers({ pk }) {
      if (!pk) return Promise.resolve({ ok: false, status: 0, error: 'no pk' });
      return igFetch(`${API_ROOT}/friendships/${encodeURIComponent(pk)}/mutual_followers/`, {
        method: 'GET',
      });
    },

    /**
     * A user's own media feed. web_profile_info caps at 12 posts, which is not
     * enough for a contact sheet, so the harvest pages this instead.
     */
    userFeed({ pk, maxId, count = 33 }) {
      if (!pk) return Promise.resolve({ ok: false, status: 0, error: 'no pk' });

      const params = new URLSearchParams({ count: String(count) });
      if (maxId) params.set('max_id', maxId);
      return igFetch(`${API_ROOT}/feed/user/${encodeURIComponent(pk)}/?${params}`, { method: 'GET' });
    },
  });
})();
