<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  // --- Form state ---
  let serverUrl = 'http://localhost:18050';
  let authToken = '';
  let tokenTouched = false;     // track whether user typed a token

  // --- Sync state ---
  let syncing = false;
  let lastResult = null;        // SyncResult | null
  let lastError = null;
  let history = [];             // [{ ts, ok, summary, result?, error? }]
  const HISTORY_MAX = 10;

  // --- Lifecycle: hydrate the auth token with the placeholder
  // `local_encryption_key` value if the user hasn't typed anything yet.
  onMount(async () => {
    try {
      const k = await invoke('local_encryption_key');
      if (!tokenTouched && k) authToken = k;
    } catch (e) {
      // Fall back silently — user can still type their own token.
      lastError = `local_encryption_key: ${e}`;
    }
  });

  function fmtAgo(secs) {
    if (!secs) return 'never';
    const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    if (d < 5) return 'just now';
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function fmtTs(secs) {
    if (!secs) return '';
    try {
      return new Date(secs * 1000).toLocaleString();
    } catch (_) {
      return String(secs);
    }
  }

  function platformLabel() {
    // The Tauri command accepts whatever we pass; we use the JS-side
    // user-agent to pick something plausible. Real detection is OS-level
    // and Tauri has `window.__TAURI__.os` for it, but the navigator
    // fallback works fine for the MVP UI.
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent || '').toLowerCase();
    if (ua.includes('mac')) return 'macos';
    if (ua.includes('win')) return 'windows';
    if (ua.includes('linux') || ua.includes('x11')) return 'linux';
    return 'linux';
  }

  async function syncNow() {
    if (syncing) return;
    syncing = true;
    lastError = null;
    try {
      const result = await invoke('sync_now', {
        serverUrl,
        authToken,
        platform: platformLabel(),
        appVersion: '0.2.0',
      });
      lastResult = result;
      pushHistory({
        ts: result.finished_at || Math.floor(Date.now() / 1000),
        ok: true,
        summary: `+${result.conversations_uploaded} convs · +${result.messages_uploaded} msgs · ${fmtBytes(result.bytes)}`,
        result,
      });
    } catch (e) {
      const msg = String(e);
      lastError = msg;
      pushHistory({
        ts: Math.floor(Date.now() / 1000),
        ok: false,
        summary: `failed: ${msg}`,
        error: msg,
      });
    } finally {
      syncing = false;
    }
  }

  function pushHistory(entry) {
    history = [entry, ...history].slice(0, HISTORY_MAX);
  }

  function clearHistory() {
    history = [];
  }

  // Auto-refresh the "synced Xm ago" label every 15s.
  let now = Math.floor(Date.now() / 1000);
  let tickHandle = null;
  onMount(() => {
    tickHandle = setInterval(() => {
      now = Math.floor(Date.now() / 1000);
    }, 15000);
    return () => tickHandle && clearInterval(tickHandle);
  });

  $: lastSyncTs = lastResult?.finished_at || null;
  $: lastSyncAgo = lastSyncTs ? fmtAgo(lastSyncTs) : null;
  $: statusLabel = lastError
    ? `sync failed: ${lastError}`
    : lastResult
    ? `synced ${lastSyncAgo}`
    : 'never synced';
  $: statusClass = lastError ? 'err' : (lastResult ? 'ok' : 'idle');
</script>

<div class="sync">
  <header>
    <h1>🔄 xkg-desktop — Sync</h1>
    <p class="sub">
      Push your local captures to a sync server. End-to-end encrypted with
      AES-GCM — the server only ever sees opaque blobs.
      <span class="faint">
        (History is local-only; clear with the button below.)
      </span>
    </p>
  </header>

  <section class="form">
    <label class="field">
      <span class="label">Server URL</span>
      <input
        type="text"
        bind:value={serverUrl}
        placeholder="http://localhost:18050"
        data-testid="sync-server-input"
      />
    </label>

    <label class="field">
      <span class="label">Auth token</span>
      <input
        type="text"
        bind:value={authToken}
        on:input={() => (tokenTouched = true)}
        placeholder="auto-filled with a local placeholder"
        data-testid="sync-token-input"
      />
      <span class="hint">
        Placeholder derived from your install path. Replace with a real
        token once the server supports it.
      </span>
    </label>

    <button
      class="primary"
      on:click={syncNow}
      disabled={syncing || !serverUrl || !authToken}
      data-testid="sync-now-button"
    >
      {syncing ? 'Syncing…' : 'Sync now'}
    </button>

    <p class="status status-{statusClass}" data-testid="sync-status">
      <span class="dot"></span>
      {statusLabel}
    </p>
  </section>

  <section class="history">
    <div class="history-head">
      <h2>History</h2>
      {#if history.length > 0}
        <button class="clear" on:click={clearHistory} data-testid="sync-clear-history">
          Clear
        </button>
      {/if}
    </div>

    {#if history.length === 0}
      <p class="muted">No syncs yet. Press <strong>Sync now</strong> to start.</p>
    {:else}
      <ul class="history-list">
        {#each history as h (h.ts + '-' + h.summary)}
          <li class="history-item history-{h.ok ? 'ok' : 'err'}" data-testid="sync-history-item">
            <div class="history-line">
              <span class="badge badge-{h.ok ? 'ok' : 'err'}">{h.ok ? 'OK' : 'ERR'}</span>
              <span class="time">{fmtTs(h.ts)}</span>
            </div>
            <div class="summary">{h.summary}</div>
            {#if h.result}
              <div class="details faint">
                device <code>{h.result.device_id}</code> · cursors
                <code>conv={h.result.conv_cursor}</code>
                <code>msg={h.result.msg_cursor}</code>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .sync {
    max-width: 800px;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 4rem;
  }
  header h1 { margin: 0; font-size: 1.4rem; }
  header .sub { margin: 0.25rem 0 0; color: #94a3b8; font-size: 0.85rem; }
  .faint { color: #64748b; font-size: 0.75rem; }

  /* Form */
  .form {
    margin-top: 1.25rem;
    background: #16162a;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 1rem 1.1rem 1.1rem;
  }
  .field { display: block; margin-bottom: 0.85rem; }
  .label {
    display: block;
    color: #94a3b8;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.3rem;
  }
  .field input {
    width: 100%;
    background: #1a1a2e;
    color: #e8e8f0;
    border: 1px solid #3a3a5a;
    border-radius: 4px;
    padding: 0.55rem 0.75rem;
    font: inherit;
    font-size: 0.95rem;
  }
  .field input:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
  .hint {
    display: block;
    color: #64748b;
    font-size: 0.75rem;
    margin-top: 0.25rem;
  }

  /* Primary sync button */
  .primary {
    display: block;
    width: 100%;
    background: #3b82f6;
    color: white;
    border: none;
    padding: 0.85rem 1rem;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 1rem;
    font-weight: 600;
    margin-top: 0.5rem;
    letter-spacing: 0.02em;
  }
  .primary:hover:not(:disabled) { background: #2563eb; }
  .primary:disabled { opacity: 0.6; cursor: wait; }

  /* Status pill */
  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.85rem 0 0;
    padding: 0.55rem 0.75rem;
    border-radius: 4px;
    font-size: 0.9rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .status .dot {
    width: 10px; height: 10px; border-radius: 50%;
    display: inline-block;
  }
  .status-idle { background: rgba(148,163,184,0.1); color: #94a3b8; }
  .status-idle .dot { background: #94a3b8; }
  .status-ok { background: rgba(34,197,94,0.12); color: #86efac; }
  .status-ok .dot { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.6); }
  .status-err { background: rgba(239,68,68,0.12); color: #fca5a5; }
  .status-err .dot { background: #ef4444; box-shadow: 0 0 6px rgba(239,68,68,0.6); }

  /* History */
  .history { margin-top: 1.25rem; }
  .history-head {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .history h2 {
    margin: 0;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    border-bottom: 1px solid #2a2a4a;
    padding-bottom: 0.4rem;
    flex: 1;
  }
  .clear {
    background: transparent;
    color: #94a3b8;
    border: 1px solid #2a2a4a;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
  }
  .clear:hover { color: #e8e8f0; background: #22223d; }

  .muted { color: #64748b; font-size: 0.85rem; padding: 0.5rem 0; }

  .history-list { list-style: none; margin: 0; padding: 0; }
  .history-item {
    background: #16162a;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    padding: 0.55rem 0.75rem;
    margin-bottom: 0.45rem;
  }
  .history-item.history-err { border-color: rgba(239,68,68,0.3); }
  .history-line {
    display: flex; align-items: center; gap: 0.5rem;
    margin-bottom: 0.2rem;
  }
  .time { color: #64748b; font-size: 0.75rem; }
  .summary { font-size: 0.9rem; color: #e8e8f0; }
  .details { font-size: 0.75rem; margin-top: 0.2rem; }
  .details code {
    background: #2a2a4a;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    margin-left: 0.2rem;
  }
  .badge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    letter-spacing: 0.05em;
  }
  .badge-ok { background: rgba(34,197,94,0.2); color: #86efac; }
  .badge-err { background: rgba(239,68,68,0.2); color: #fca5a5; }
</style>