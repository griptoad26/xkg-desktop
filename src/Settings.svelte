<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { isEnabled, enable, disable } from '@tauri-apps/plugin-autostart';

  // --- state ---
  let autostartEnabled = false;
  let autostartSupported = true;
  let autostartError = null;
  let loading = true;

  // For testing: show platform info
  let platform = '';
  let osVersion = '';

  // Capture endpoint status (read-only display)
  let hubUrl = 'http://127.0.0.1:8090';
  let lastImport = null;
  let testStatus = null;  // 'idle' | 'testing' | 'ok' | 'fail'
  let testError = null;

  // --- lifecycle ---
  onMount(async () => {
    loading = true;
    try {
      // Load current autostart state
      autostartEnabled = await isEnabled();
    } catch (e) {
      // Plugin may not be available on this platform/build
      autostartSupported = false;
      autostartError = String(e);
    }
    try {
      const info = await invoke('get_platform_info');
      platform = info.platform || '';
      osVersion = info.os_version || '';
    } catch (_) {
      // Non-fatal
    }
    try {
      const last = await invoke('get_last_import_info');
      lastImport = last;
    } catch (_) {
      // Non-fatal
    }
    loading = false;
  });

  // --- handlers ---
  async function toggleAutostart() {
    const newVal = !autostartEnabled;
    autostartError = null;
    try {
      if (newVal) {
        await enable();
      } else {
        await disable();
      }
      autostartEnabled = newVal;
    } catch (e) {
      autostartError = String(e);
    }
  }

  async function testConnection() {
    testStatus = 'testing';
    testError = null;
    try {
      const result = await invoke('test_hub_connection', { url: hubUrl });
      testStatus = result.ok ? 'ok' : 'fail';
      testError = result.error || null;
    } catch (e) {
      testStatus = 'fail';
      testError = String(e);
    }
  }

  function platformSpecificHint(p) {
    if (p === 'macos') {
      return 'Toggled in System Settings → General → Login Items. The app is registered as a LaunchAgent.';
    } else if (p === 'windows') {
      return 'Toggled via the Windows Registry (HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run). You can also verify in Task Manager → Startup apps.';
    } else if (p === 'linux') {
      return 'Toggled via XDG autostart: ~/.config/autostart/xkg-desktop.desktop';
    }
    return 'The autostart mechanism is platform-specific.';
  }
</script>

<div class="settings">
  <header>
    <h1>⚙️ xkg-desktop Settings</h1>
    <p class="sub">Global shortcut capture for the X Knowledge Graph</p>
  </header>

  {#if loading}
    <div class="loading">Loading settings…</div>
  {:else}
    <!-- ===== AUTOSTART ===== -->
    <section>
      <h2>Startup</h2>
      <label class="row">
        <span class="row-label">
          <span class="row-title">Start xkg-desktop on system login</span>
          <span class="row-desc">
            Launches the global shortcut listener in the background when you log in.
            {#if !autostartSupported}
              <em>(not supported on this platform / build)</em>
            {/if}
          </span>
        </span>
        <span class="switch">
          <input
            type="checkbox"
            disabled={!autostartSupported}
            checked={autostartEnabled}
            on:change={toggleAutostart}
            data-testid="autostart-toggle"
          />
          <span class="slider"></span>
        </span>
      </label>
      {#if autostartError}
        <div class="error">
          <strong>Error:</strong> {autostartError}
        </div>
      {/if}
      <p class="hint">
        {platformSpecificHint(platform)}
      </p>
      {#if platform}
        <p class="hint faint">
          Platform: <code>{platform}</code>{#if osVersion} · OS: <code>{osVersion}</code>{/if}
        </p>
      {/if}
    </section>

    <!-- ===== HUB CONNECTION ===== -->
    <section>
      <h2>Hub connection</h2>
      <div class="row column">
        <label for="hub-url" class="row-label">
          <span class="row-title">Cluster Hub URL</span>
          <span class="row-desc">
            The desktop shortcut posts captured nodes to <code>/api/import</code> on this address.
          </span>
        </label>
        <div class="input-row">
          <input
            id="hub-url"
            type="text"
            bind:value={hubUrl}
            placeholder="http://127.0.0.1:8090"
            data-testid="hub-url"
          />
          <button on:click={testConnection} disabled={testStatus === 'testing'} data-testid="test-connection">
            {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {#if testStatus === 'ok'}
          <p class="ok">✓ Hub reachable</p>
        {:else if testStatus === 'fail'}
          <p class="error">✗ {testError || 'Connection failed'}</p>
        {/if}
      </div>
    </section>

    <!-- ===== CAPTURE STATUS ===== -->
    {#if lastImport}
      <section>
        <h2>Last import</h2>
        <dl class="kv">
          <dt>Captured at</dt>
          <dd>{new Date(lastImport.created_at || Date.now()).toLocaleString()}</dd>
          <dt>Label</dt>
          <dd class="ellipsis">{lastImport.label || '(empty)'}</dd>
          <dt>Node ID</dt>
          <dd><code>{lastImport.id}</code></dd>
          {#if lastImport.duplicate}
            <dt>Status</dt>
            <dd><span class="badge warn">duplicate (no new node)</span></dd>
          {/if}
        </dl>
      </section>
    {/if}

    <footer>
      <p class="faint">
        xkg-desktop v0.1.0 · <a href="https://github.com/griptoad26/xkg-desktop" target="_blank" rel="noopener">github</a>
      </p>
    </footer>
  {/if}
</div>

<style>
  .settings {
    max-width: 640px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }
  header h1 { margin: 0; font-size: 1.4rem; }
  header .sub { margin: 0.25rem 0 0; color: #94a3b8; font-size: 0.9rem; }
  h2 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin: 2rem 0 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid #2a2a4a;
  }
  section { margin-bottom: 1.5rem; }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 0.75rem 0;
  }
  .row.column { flex-direction: column; align-items: stretch; }
  .row-label { flex: 1; }
  .row-title { display: block; font-weight: 600; color: #f8fafc; }
  .row-desc { display: block; color: #94a3b8; font-size: 0.85rem; margin-top: 0.2rem; line-height: 1.4; }
  .hint { color: #94a3b8; font-size: 0.8rem; margin: 0.4rem 0 0; }
  .hint.faint { color: #64748b; font-size: 0.75rem; }
  .hint code, .row-desc code, dd code {
    background: #2a2a4a;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    font-size: 0.85em;
  }
  .loading { color: #94a3b8; padding: 2rem; text-align: center; }
  .error { color: #fca5a5; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); padding: 0.5rem 0.75rem; border-radius: 4px; margin: 0.5rem 0; font-size: 0.85rem; }
  .ok { color: #4ade80; font-size: 0.85rem; margin: 0.4rem 0 0; }
  footer { margin-top: 2rem; text-align: center; font-size: 0.8rem; }
  footer a { color: #60a5fa; }
  .faint { color: #64748b; }

  /* iOS-style switch */
  .switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; margin-top: 0.1rem; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; inset: 0;
    background: #475569; border-radius: 12px; transition: 0.2s;
  }
  .slider::before {
    position: absolute; content: '';
    height: 18px; width: 18px;
    left: 3px; bottom: 3px;
    background: white; border-radius: 50%;
    transition: 0.2s;
  }
  .switch input:checked + .slider { background: #3b82f6; }
  .switch input:checked + .slider::before { transform: translateX(20px); }
  .switch input:disabled + .slider { opacity: 0.4; cursor: not-allowed; }

  /* Hub URL input + button */
  .input-row { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .input-row input {
    flex: 1; padding: 0.5rem 0.7rem;
    background: #2a2a4a; color: #e8e8f0;
    border: 1px solid #3a3a5a; border-radius: 4px;
    font: inherit; font-size: 0.9rem;
  }
  .input-row input:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
  .input-row button {
    background: #3b82f6; color: white; border: none;
    padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;
    font: inherit; font-size: 0.9rem;
  }
  .input-row button:hover { background: #2563eb; }
  .input-row button:disabled { opacity: 0.5; cursor: wait; }

  /* Captured last-import dl */
  dl.kv { display: grid; grid-template-columns: 100px 1fr; gap: 0.4rem 0.75rem; margin: 0; font-size: 0.85rem; }
  dl.kv dt { color: #94a3b8; }
  dl.kv dd { margin: 0; color: #e8e8f0; word-break: break-all; }
  dl.kv dd.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge.warn { background: rgba(251, 191, 36, 0.2); color: #fbbf24; padding: 0.1rem 0.5rem; border-radius: 8px; font-size: 0.75rem; }
</style>
