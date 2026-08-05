<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  // --- Form state ---
  let serverUrl = 'http://localhost:18050';
  let authToken = '';
  let tokenTouched = false;     // track whether user typed a token

  // --- Sync passphrase (TASK-203 / CS-X1) ---
  // A user-set passphrase enables cross-device sync: when two
  // devices share the same passphrase they derive the same 32-byte
  // AES key via HKDF-SHA256. Without a passphrase we fall back to
  // a per-install random key (which only "syncs" with itself).
  let passphrase = '';
  let passphraseConfigured = false;
  let passphraseBusy = false;
  let passphraseError = null;

  // --- Sync state ---
  let syncing = false;
  let lastResult = null;        // SyncResult | null
  let lastError = null;
  let history = [];             // [{ ts, ok, summary, result?, error? }]
  const HISTORY_MAX = 10;

  // --- Tailscale peer discovery state (Phase 178 / TASK-178) ---
  let peers = [];               // [{ node_id, name, ip, ips, online, last_seen }]
  let peersError = null;        // string | null
  let peersFetchedAt = null;    // unix seconds | null
  let discovering = false;

  // --- Lifecycle: hydrate the auth token with the placeholder
  // `local_encryption_key` value if the user hasn't typed anything yet.
  // Also auto-run peer discovery once on mount so the user immediately
  // sees available Tailscale peers (or an install hint).
  onMount(async () => {
    try {
      const k = await invoke('local_encryption_key');
      if (!tokenTouched && k) authToken = k;
    } catch (e) {
      // Fall back silently — user can still type their own token.
      lastError = `local_encryption_key: ${e}`;
    }
    // Query whether a sync passphrase is already configured. If
    // it is, the auto-filled auth token above is the passphrase
    // (returned by local_encryption_key when set) — that's fine,
    // it works as the input. We just want the UI to show the
    // current state so the user knows sync will round-trip.
    try {
      passphraseConfigured = await invoke('has_sync_passphrase');
    } catch (e) {
      passphraseConfigured = false;
      passphraseError = `has_sync_passphrase: ${e}`;
    }
    // Don't await — let it run in background, the button shows state.
    discoverPeers();
  });

  async function savePassphrase() {
    if (passphraseBusy) return;
    if (!passphrase) return;
    passphraseBusy = true;
    passphraseError = null;
    try {
      await invoke('set_sync_passphrase', { passphrase });
      passphraseConfigured = true;
      // Re-fetch the auto-fill token — once the passphrase is set,
      // local_encryption_key returns the passphrase itself, so the
      // auth-token field should mirror the passphrase the user typed.
      // If `authToken` hasn't been manually edited, refresh it.
      const k = await invoke('local_encryption_key');
      if (!tokenTouched && k) authToken = k;
    } catch (e) {
      passphraseError = `set_sync_passphrase: ${e}`;
    } finally {
      passphraseBusy = false;
    }
  }

  async function clearPassphrase() {
    if (passphraseBusy) return;
    passphraseBusy = true;
    passphraseError = null;
    try {
      await invoke('set_sync_passphrase', { passphrase: '' });
      passphraseConfigured = false;
      passphrase = '';
      // Refresh the auto-fill token — without a passphrase, the
      // random key is returned again.
      const k = await invoke('local_encryption_key');
      if (!tokenTouched && k) authToken = k;
    } catch (e) {
      passphraseError = `clear passphrase: ${e}`;
    } finally {
      passphraseBusy = false;
    }
  }

  async function discoverPeers() {
    if (discovering) return;
    discovering = true;
    peersError = null;
    try {
      const res = await invoke('discover_peers');
      // res shape: { peers, ok, error, fetched_at }
      if (res && Array.isArray(res.peers)) {
        peers = res.peers;
      } else {
        peers = [];
      }
      peersError = res?.error || null;
      peersFetchedAt = res?.fetched_at || Math.floor(Date.now() / 1000);
    } catch (e) {
      peersError = `discover_peers: ${e}`;
      peers = [];
      peersFetchedAt = Math.floor(Date.now() / 1000);
    } finally {
      discovering = false;
    }
  }

  // Use the peer IP as a hub URL. The sync client expects http(s)://host:port
  // — Tailscale IPs are bare addresses, so we wrap them with http://.
  // Port: prefer the current serverUrl's port if any, else 8090 (cluster-hub default).
  function pickPeer(peer) {
    if (!peer || !peer.ip) return;
    let port = '8090';
    try {
      const u = new URL(serverUrl);
      port = u.port || '8090';
    } catch (_) {
      port = '8090';
    }
    const protocol = serverUrl.startsWith('https') ? 'https' : 'http';
    serverUrl = `${protocol}://${peer.ip}:${port}`;
    peersError = `using ${peer.name} (${peer.ip}) — press Sync now to test`;
  }

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

    <div class="field passphrase" data-testid="sync-passphrase-field">
      <label class="label" for="sync-passphrase">
        Sync passphrase
        {#if passphraseConfigured}
          <span class="badge badge-ok" data-testid="sync-passphrase-badge">configured</span>
        {:else}
          <span class="badge badge-idle" data-testid="sync-passphrase-badge">not set</span>
        {/if}
      </label>
      <div class="passphrase-row">
        <input
          id="sync-passphrase"
          type="password"
          autocomplete="off"
          bind:value={passphrase}
          placeholder={passphraseConfigured ? 'enter a new passphrase to replace' : 'type the same passphrase on each device'}
          data-testid="sync-passphrase-input"
          disabled={passphraseBusy}
        />
        <button
          type="button"
          class="secondary"
          on:click={savePassphrase}
          disabled={passphraseBusy || !passphrase}
          data-testid="sync-passphrase-set"
        >
          {passphraseConfigured ? 'Change' : 'Set'}
        </button>
        {#if passphraseConfigured}
          <button
            type="button"
            class="secondary danger"
            on:click={clearPassphrase}
            disabled={passphraseBusy}
            data-testid="sync-passphrase-clear"
          >
            Clear
          </button>
        {/if}
      </div>
      <span class="hint">
        Used to derive the device AES key via HKDF-SHA256. Two devices
        with the same passphrase round-trip encrypted envelopes; without
        it, syncing falls back to a per-install random key.
      </span>
      {#if passphraseError}
        <p class="err" data-testid="sync-passphrase-error">{passphraseError}</p>
      {/if}
    </div>

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

  <section class="peers" data-testid="sync-peers">
    <div class="peers-head">
      <h2>Tailscale peers</h2>
      <button
        class="secondary"
        on:click={discoverPeers}
        disabled={discovering}
        data-testid="sync-discover-button"
      >
        {discovering ? 'Discovering…' : 'Discover'}
      </button>
    </div>

    {#if peersError}
      <p class="peers-hint" data-testid="sync-peers-error">
        {peersError}
        {#if peersError.includes('install')}
          · <a href="https://tailscale.com/download" target="_blank" rel="noopener">install tailscale</a>
        {/if}
      </p>
    {/if}

    {#if peers.length === 0 && !peersError}
      <p class="muted">No peers found yet. Click <strong>Discover</strong> or check that <code>tailscale status</code> works in a terminal.</p>
    {:else if peers.length > 0}
      <ul class="peers-list">
        {#each peers as p (p.node_id || p.ip)}
          <li class="peer-row" data-testid="sync-peer-row">
            <button
              type="button"
              class="peer-pick"
              on:click={() => pickPeer(p)}
              data-testid="sync-peer-pick"
              title="Use {p.name} ({p.ip}) as the hub URL"
            >
              <span class="peer-name">{p.name || p.node_id || p.ip}</span>
              <span class="peer-ip"><code>{p.ip || '—'}</code></span>
              <span class="peer-status peer-status-{p.online ? 'on' : 'off'}">
                {p.online ? '● online' : '○ offline'}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if peersFetchedAt}
        <p class="peers-meta muted">discovered {fmtAgo(peersFetchedAt)}</p>
      {/if}
    {/if}
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

  /* Tailscale peers (Phase 178) */
  .peers {
    margin-top: 1.5rem;
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }
  .peers-head {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 0.6rem;
  }
  .peers h2 {
    margin: 0;
    font-size: 0.95rem;
    color: #e8e8f0;
  }
  .peers-hint {
    font-size: 0.85rem;
    color: #fbbf24;
    margin: 0.4rem 0;
  }
  .peers-hint a {
    color: #60a5fa;
    text-decoration: underline;
  }
  .peers-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 0.4rem;
  }
  .peer-row { margin: 0; }
  .peer-pick {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 0.6rem;
    background: #0f0f1f;
    color: #e8e8f0;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .peer-pick:hover {
    border-color: #3b82f6;
    background: #16213e;
  }
  .peer-name {
    text-align: left;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .peer-ip code {
    background: #1e1e2e;
    color: #93c5fd;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }
  .peer-status {
    font-size: 0.75rem;
    font-variant: small-caps;
  }
  .peer-status-on  { color: #22c55e; }
  .peer-status-off { color: #94a3b8; }
  .peers-meta {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
  }

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

  /* Sync passphrase (TASK-203 / CS-X1) */
  .passphrase-row {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
  }
  .passphrase-row input {
    flex: 1;
  }
  .secondary {
    background: #1a1a2e;
    color: #e8e8f0;
    border: 1px solid #3a3a5a;
    padding: 0 0.85rem;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .secondary:hover:not(:disabled) { background: #2a2a4a; }
  .secondary:disabled { opacity: 0.55; cursor: not-allowed; }
  .secondary.danger {
    border-color: #b91c1c;
    color: #fca5a5;
  }
  .secondary.danger:hover:not(:disabled) {
    background: rgba(239,68,68,0.15);
  }
  .badge {
    display: inline-block;
    font-size: 0.6rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    letter-spacing: 0.05em;
    margin-left: 0.4rem;
    text-transform: uppercase;
    vertical-align: middle;
  }
  .badge-ok   { background: rgba(34,197,94,0.2); color: #86efac; }
  .badge-idle { background: rgba(148,163,184,0.15); color: #94a3b8; }
  .err { color: #fca5a5; font-size: 0.8rem; margin: 0.4rem 0 0; }

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