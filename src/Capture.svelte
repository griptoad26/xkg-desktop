<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  // --- Local xkg-core state ---
  let conversations = [];
  let selectedConvId = null;
  let messages = [];
  let searchResults = null;   // null = "no search in progress"; [] = searched, no hits
  let searchQuery = '';
  let stats = { conversations: 0, messages: 0, db_path: '' };

  // --- Phase 5a: advanced search filters ---
  // filterLlm: 'all' | 'chatgpt' | 'claude' | 'grok'
  // dateRange: 'all' | 'today' | 'week' | 'month' | 'custom'
  // customRange: { start: string, end: string } — ISO date strings
  // hasCode: boolean
  // hasCitations: boolean
  let filterLlm = 'all';
  let dateRange = 'all';
  let customRange = { start: '', end: '' };
  let hasCode = false;
  let hasCitations = false;
  let dateRangeOpen = false; // for the Custom… popover

  // Capture textarea
  let captureHtml = '';
  let captureLlm = 'chatgpt'; // 'chatgpt' | 'claude' | 'grok'
  let captureStatus = null;   // 'idle' | 'saving' | 'ok' | 'err'
  let captureMsg = '';

  // Continue-in-browser feedback
  let continueStatus = null;  // null | 'saving' | 'ok' | 'err'
  let continueMsg = '';

  let loading = true;
  let lastError = null;

  // --- Lifecycle ---
  onMount(async () => {
    await refreshStats();
    await refreshConversations();
    loading = false;
  });

  async function refreshStats() {
    try {
      stats = await invoke('xkg_stats');
    } catch (e) {
      lastError = `stats: ${e}`;
    }
  }

  async function refreshConversations() {
    try {
      conversations = await invoke('list_conversations');
    } catch (e) {
      lastError = `list_conversations: ${e}`;
    }
  }

  async function selectConversation(id) {
    selectedConvId = id;
    searchResults = null;
    try {
      messages = await invoke('get_conversation_messages', { conversationId: id });
    } catch (e) {
      lastError = `get_conversation_messages: ${e}`;
      messages = [];
    }
  }

  // --- Phase 5a: advanced search ---

  // Build the {llm, start_ts, end_ts} filter payload for the
  // `search_advanced` Tauri command. Only sets fields the user has
  // actually restricted; missing fields mean "no restriction".
  function buildSearchFilters() {
    const f = {};
    if (filterLlm !== 'all') f.llm = filterLlm;
    const range = resolveDateRange();
    if (range.start !== null) f.start_ts = range.start;
    if (range.end !== null) f.end_ts = range.end;
    if (hasCode) f.has_code = true;
    if (hasCitations) f.has_citations = true;
    return f;
  }

  // Translate the UI date-range dropdown into a (start_ts, end_ts)
  // pair, both as unix-seconds integers (matching what
  // CaptureStore::search_advanced expects). Custom range uses the
  // user-typed YYYY-MM-DD strings.
  function resolveDateRange() {
    if (dateRange === 'all') return { start: null, end: null };
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0,
    );
    if (dateRange === 'today') {
      return { start: Math.floor(startOfToday.getTime() / 1000), end: null };
    }
    if (dateRange === 'week') {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 7);
      return { start: Math.floor(start.getTime() / 1000), end: null };
    }
    if (dateRange === 'month') {
      const start = new Date(startOfToday);
      start.setMonth(start.getMonth() - 1);
      return { start: Math.floor(start.getTime() / 1000), end: null };
    }
    if (dateRange === 'custom') {
      let s = null, e = null;
      if (customRange.start) {
        const d = new Date(`${customRange.start}T00:00:00`);
        if (!isNaN(d.getTime())) s = Math.floor(d.getTime() / 1000);
      }
      if (customRange.end) {
        const d = new Date(`${customRange.end}T23:59:59`);
        if (!isNaN(d.getTime())) e = Math.floor(d.getTime() / 1000);
      }
      return { start: s, end: e };
    }
    return { start: null, end: null };
  }

  async function runSearch() {
    const q = searchQuery.trim();
    if (!q) {
      searchResults = null;
      return;
    }
    try {
      const filters = buildSearchFilters();
      const hits = await invoke('search_advanced', {
        query: q,
        filters,
        limit: 100,
      });
      searchResults = hits;
    } catch (e) {
      lastError = `search_advanced: ${e}`;
      searchResults = [];
    }
  }

  // Re-run the active search whenever any filter changes — but only
  // if the user has already kicked off a search (so the empty-state
  // hint doesn't fire repeatedly while they're fiddling with the
  // dropdowns before typing).
  let _filterDebounce;
  function onFiltersChanged() {
    if (searchResults === null) return; // no active search
    clearTimeout(_filterDebounce);
    _filterDebounce = setTimeout(() => {
      runSearch();
    }, 200);
  }
  $: filterLlm, dateRange, customRange, hasCode, hasCitations, onFiltersChanged();

  function clearSearch() {
    searchQuery = '';
    searchResults = null;
  }

  // --- Phase 5a: continue in browser ---
  // The Rust side (`build_continue_url` in xkg.rs) owns the URL
  // templates for each LLM. We just forward `llm` + `title` and let
  // the Tauri shell plugin launch the system browser.
  async function continueInBrowser(llm, title) {
    continueStatus = 'saving';
    continueMsg = '';
    try {
      await invoke('continue_in_browser', { llm, title });
      continueStatus = 'ok';
      continueMsg = `Opened ${llm} in your browser.`;
      // Clear the ok state after a few seconds so the UI doesn't
      // accumulate stale "Opened…" toasts.
      setTimeout(() => {
        if (continueStatus === 'ok') {
          continueStatus = null;
          continueMsg = '';
        }
      }, 4000);
    } catch (e) {
      continueStatus = 'err';
      continueMsg = String(e);
    }
  }

  // --- Capture box (unchanged from Phase 2) ---
  async function captureNow() {
    const html = captureHtml.trim();
    if (!html) {
      captureStatus = 'err';
      captureMsg = 'Paste some DOM HTML first';
      return;
    }
    captureStatus = 'saving';
    captureMsg = '';
    try {
      const result = await invoke('capture_html', { html, llm: captureLlm });
      captureStatus = 'ok';
      const llmLabel = captureLlm.charAt(0).toUpperCase() + captureLlm.slice(1);
      captureMsg = `[${llmLabel}] Captured ${result.inserted}/${result.extracted} messages${
        result.title ? ` · "${result.title}"` : ''
      }`;
      // Refresh sidebar + stats so the new conversation shows up.
      await refreshConversations();
      await refreshStats();
      // Auto-select the conversation we just created.
      if (result.conversation_id) {
        await selectConversation(result.conversation_id);
      }
      captureHtml = '';
    } catch (e) {
      captureStatus = 'err';
      captureMsg = String(e);
    }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch (_) {
      return iso;
    }
  }

  function convLabel(c) {
    return c.title || '(untitled)';
  }

  function roleClass(role) {
    return `role role-${role}`;
  }

  // Color-coded LLM chip. ChatGPT = blue, Claude = orange, Grok =
  // green. Returns a CSS class suffix so the styling stays in the
  // <style> block.
  function llmClass(llm) {
    const v = (llm || '').toLowerCase();
    if (v === 'chatgpt') return 'llm-chip-llm-chatgpt';
    if (v === 'claude') return 'llm-chip-llm-claude';
    if (v === 'grok') return 'llm-chip-llm-grok';
    return 'llm-chip-llm-other';
  }

  // Wrap occurrences of any term in `query` (case-insensitive,
  // whitespace-split) with `<mark>` so the UI can highlight the
  // actual FTS5 hit. Returns the input string with `<mark>…</mark>`
  // segments injected; the caller is responsible for rendering the
  // result with `{@html}` because Svelte escapes angle brackets by
  // default.
  function highlightSnippet(snippet, query) {
    const q = (query || '').trim();
    if (!q || !snippet) return escapeHtml(snippet || '');
    const terms = q
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map(escapeRegex);
    if (terms.length === 0) return escapeHtml(snippet);
    const re = new RegExp(`(${terms.join('|')})`, 'gi');
    return escapeHtml(snippet).replace(re, '<mark>$1</mark>');
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // The "best" title to use when continuing a hit's conversation in
  // the browser — prefer the conversation title (set by the
  // extractor), then the first 80 chars of the first user message
  // body, then a stable fallback. Keeps the `?q=` deep link
  // meaningful instead of just `?q=`.
  function hitTitle(h) {
    if (h.conversation_title) return h.conversation_title;
    // We don't have full messages in a SearchHit, just the snippet;
    // snippet-as-title is a reasonable fallback.
    return (h.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }
</script>

<div class="capture">
  <header>
    <h1>📚 xkg-desktop — Capture</h1>
    <p class="sub">
      Local SQLite + FTS5 search across every LLM conversation you've captured.
      <span class="faint">
        ({stats.conversations} conversations · {stats.messages} messages · {stats.db_path})
      </span>
    </p>
  </header>

  <!-- ============ TOP BAR: SEARCH + FILTERS ============ -->
  <section class="search-bar">
    <form on:submit|preventDefault={runSearch}>
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Search all messages… (FTS5)"
        data-testid="xkg-search-input"
      />
      <button type="submit" data-testid="xkg-search-button">Search</button>
      {#if searchResults !== null}
        <button type="button" class="cancel" on:click={clearSearch}>Clear</button>
      {/if}
    </form>

    <!-- Phase 5a: filter row -->
    <div class="filters" data-testid="xkg-search-filters">
      <label class="filter-field">
        <span class="filter-label">LLM</span>
        <select bind:value={filterLlm} data-testid="xkg-filter-llm">
          <option value="all">All</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="claude">Claude</option>
          <option value="grok">Grok</option>
        </select>
      </label>

      <label class="filter-field">
        <span class="filter-label">Date</span>
        <select
          bind:value={dateRange}
          on:change={() => (dateRangeOpen = dateRange === 'custom')}
          data-testid="xkg-filter-date"
        >
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
          <option value="custom">Custom…</option>
        </select>
      </label>

      {#if dateRange === 'custom'}
        <div class="custom-range">
          <input
            type="date"
            bind:value={customRange.start}
            data-testid="xkg-filter-date-start"
            aria-label="Start date"
          />
          <span class="range-sep">→</span>
          <input
            type="date"
            bind:value={customRange.end}
            data-testid="xkg-filter-date-end"
            aria-label="End date"
          />
        </div>
      {/if}

      <label class="filter-toggle">
        <input type="checkbox" bind:checked={hasCode} data-testid="xkg-filter-code" />
        <span>Has code</span>
      </label>

      <label class="filter-toggle">
        <input type="checkbox" bind:checked={hasCitations} data-testid="xkg-filter-citations" />
        <span>Has citations</span>
      </label>
    </div>

    {#if continueMsg}
      <p class="status status-{continueStatus}">{continueMsg}</p>
    {/if}
    {#if lastError}
      <p class="error">{lastError}</p>
    {/if}
  </section>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else}
    <div class="panes">
      <!-- ============ LEFT PANEL: CONVERSATIONS ============ -->
      <aside class="left">
        <h2>Conversations</h2>
        {#if conversations.length === 0}
          <p class="muted">No conversations yet. Paste ChatGPT HTML below to capture one.</p>
        {:else}
          <ul class="conv-list">
            {#each conversations as c (c.id)}
              <li>
                <button
                  class="conv-btn"
                  class:active={c.id === selectedConvId}
                  on:click={() => selectConversation(c.id)}
                  data-testid="conv-{c.id}"
                >
                  <div class="conv-title">{convLabel(c)}</div>
                  <div class="conv-meta">
                    <span class="llm llm-{c.llm}">{c.llm}</span>
                    <span class="dot">·</span>
                    <span class="time">{fmtDate(c.updated_at)}</span>
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>

      <!-- ============ RIGHT PANEL: MESSAGES / SEARCH RESULTS ============ -->
      <main class="right">
        {#if searchResults !== null}
          <div class="panel-head">
            <h2>
              Search results
              <span class="faint">({searchResults.length} hit{searchResults.length === 1 ? '' : 's'})</span>
            </h2>
          </div>
          {#if searchResults.length === 0}
            <p class="muted">No messages match "{searchQuery}".</p>
          {:else}
            <ul class="msg-list" data-testid="xkg-search-results">
              {#each searchResults as h (h.message_id)}
                <li class="msg search-hit" data-testid="hit-{h.message_id}">
                  <div class="msg-head">
                    <div class="msg-head-left">
                      <span class="llm-chip {llmClass(h.llm)}">{h.llm}</span>
                      <span class="hit-title" title={h.conversation_title || ''}>
                        {h.conversation_title || '(untitled)'}
                      </span>
                    </div>
                    <div class="msg-head-right">
                      <span class={roleClass(h.role)}>{h.role}</span>
                      <span class="time">{fmtDate(new Date(h.timestamp * 1000).toISOString())}</span>
                      <button
                        class="continue-btn"
                        on:click={() => continueInBrowser(h.llm, hitTitle(h))}
                        title="Open this conversation in {h.llm}'s web UI"
                        data-testid="continue-{h.message_id}"
                      >
                        Continue ↗
                      </button>
                    </div>
                  </div>
                  <div class="msg-body search-snippet">
                    {@html highlightSnippet(h.snippet, searchQuery)}
                    {#if h.has_code}
                      <span class="code-badge" title="Message contains a code block">{'<pre>'}</span>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if selectedConvId}
          <div class="panel-head">
            <h2>Conversation</h2>
            {#if messages.length > 0}
              <button
                class="continue-btn"
                on:click={() => {
                  const conv = conversations.find((c) => c.id === selectedConvId);
                  const llm = (conv && conv.llm) || 'chatgpt';
                  const title = (conv && conv.title) || (messages[0] && messages[0].body) || '';
                  continueInBrowser(llm, title.slice(0, 80));
                }}
                title="Open this conversation in the matching LLM's web UI"
                data-testid="xkg-continue-conversation"
              >
                Continue ↗
              </button>
            {/if}
          </div>
          {#if messages.length === 0}
            <p class="muted">No messages in this conversation.</p>
          {:else}
            <ul class="msg-list">
              {#each messages as m (m.id)}
                <li class="msg">
                  <div class="msg-head">
                    <span class={roleClass(m.role)}>{m.role}</span>
                    <span class="time">{fmtDate(m.created_at)}</span>
                  </div>
                  <div class="msg-body">{m.body}</div>
                </li>
              {/each}
            </ul>
          {/if}
        {:else}
          <h2>Select a conversation</h2>
          <p class="muted">
            Pick one from the left, run a search above, or paste a ChatGPT DOM
            dump in the Capture box below to start capturing.
          </p>
        {/if}
      </main>
    </div>

    <!-- ============ BOTTOM: CAPTURE ============ -->
    <section class="capture-box">
      <h2>Capture LLM HTML</h2>
      <p class="hint">
        Paste the inner HTML of a conversation page (open the page in your
        browser DevTools, copy <code>document.documentElement.outerHTML</code>,
        paste here). Choose which LLM's extractor to run — Phase 2 supports
        ChatGPT, Claude, and Grok.
      </p>
      <div class="capture-controls">
        <label for="capture-llm">LLM:</label>
        <select id="capture-llm" bind:value={captureLlm} data-testid="xkg-capture-llm-select">
          <option value="chatgpt">ChatGPT</option>
          <option value="claude">Claude</option>
          <option value="grok">Grok</option>
        </select>
      </div>
      <textarea
        bind:value={captureHtml}
        placeholder={'<!doctype html><html>… paste a ChatGPT / Claude / Grok DOM dump here …</html>'}
        rows="6"
        data-testid="xkg-capture-textarea"
      ></textarea>
      <div class="capture-actions">
        <button
          on:click={captureNow}
          disabled={captureStatus === 'saving'}
          data-testid="xkg-capture-button"
        >
          {captureStatus === 'saving' ? 'Capturing…' : 'Capture'}
        </button>
        {#if captureMsg}
          <span class="status status-{captureStatus}">{captureMsg}</span>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .capture {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 4rem;
  }
  header h1 { margin: 0; font-size: 1.4rem; }
  header .sub { margin: 0.25rem 0 0; color: #94a3b8; font-size: 0.85rem; }

  h2 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin: 1rem 0 0.5rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid #2a2a4a;
  }

  /* Top-bar search */
  .search-bar { margin-top: 1rem; }
  .search-bar form {
    display: flex; gap: 0.5rem;
  }
  .search-bar input {
    flex: 1; padding: 0.55rem 0.75rem;
    background: #2a2a4a; color: #e8e8f0;
    border: 1px solid #3a3a5a; border-radius: 4px;
    font: inherit; font-size: 0.95rem;
  }
  .search-bar input:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
  .search-bar button {
    background: #3b82f6; color: white; border: none;
    padding: 0.55rem 1.1rem; border-radius: 4px; cursor: pointer;
    font: inherit; font-size: 0.9rem; font-weight: 500;
  }
  .search-bar button:hover { background: #2563eb; }
  .search-bar button.cancel { background: #475569; }
  .search-bar button.cancel:hover { background: #334155; }

  /* Phase 5a: filter row */
  .filters {
    display: flex; flex-wrap: wrap; gap: 0.6rem;
    margin-top: 0.6rem; align-items: center;
  }
  .filter-field {
    display: flex; align-items: center; gap: 0.4rem;
    font-size: 0.85rem;
  }
  .filter-label {
    color: #94a3b8; font-weight: 500;
  }
  .filter-field select {
    background: #1a1a2e; color: #e8e8f0;
    border: 1px solid #3a3a5a; border-radius: 4px;
    padding: 0.3rem 0.5rem; font: inherit; font-size: 0.85rem;
    cursor: pointer;
  }
  .filter-field select:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
  .filter-toggle {
    display: flex; align-items: center; gap: 0.35rem;
    background: #1a1a2e; border: 1px solid #3a3a5a;
    border-radius: 4px; padding: 0.3rem 0.55rem;
    color: #cbd5e1; font-size: 0.85rem; cursor: pointer;
    user-select: none;
  }
  .filter-toggle input { margin: 0; }
  .filter-toggle:has(input:checked) {
    background: #2a2a4a; border-color: #3b82f6; color: #e8e8f0;
  }
  .custom-range {
    display: flex; align-items: center; gap: 0.35rem;
    background: #1a1a2e; border: 1px solid #3a3a5a;
    border-radius: 4px; padding: 0.25rem 0.5rem;
  }
  .custom-range input[type="date"] {
    background: #1a1a2e; color: #e8e8f0; border: none;
    padding: 0.2rem; font: inherit; font-size: 0.85rem;
    color-scheme: dark;
  }
  .range-sep { color: #94a3b8; font-size: 0.85rem; }

  .error { color: #fca5a5; font-size: 0.85rem; margin: 0.4rem 0 0; }

  /* Panes */
  .panes {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 1.25rem;
    margin-top: 0.75rem;
  }
  aside.left, main.right {
    background: #16162a;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 0.75rem 0.75rem 1rem;
    min-height: 320px;
  }
  main.right { overflow-y: auto; max-height: 60vh; }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 0.75rem; margin-bottom: 0.4rem;
  }
  .panel-head h2 { margin: 0; padding: 0; border: none; }

  /* Conversation list */
  .conv-list { list-style: none; margin: 0; padding: 0; }
  .conv-list li { margin: 0; }
  .conv-btn {
    display: block; width: 100%; text-align: left;
    background: transparent; color: #e8e8f0;
    border: 1px solid transparent; border-radius: 4px;
    padding: 0.5rem 0.6rem; cursor: pointer;
    font: inherit; margin-bottom: 0.25rem;
  }
  .conv-btn:hover { background: #22223d; }
  .conv-btn.active { background: #2a2a4a; border-color: #3b82f6; }
  .conv-title {
    font-weight: 600; font-size: 0.9rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .conv-meta {
    color: #64748b; font-size: 0.75rem; margin-top: 0.15rem;
    display: flex; gap: 0.35rem;
  }
  .conv-meta .llm {
    background: #2a2a4a; padding: 0 0.35rem; border-radius: 3px;
    text-transform: uppercase; font-weight: 600;
  }
  .conv-meta .llm.llm-chatgpt { background: rgba(16,163,127,0.2); color: #6ee7b7; }
  .conv-meta .llm.llm-claude  { background: rgba(217,119,6,0.2);  color: #fcd34d; }
  .conv-meta .llm.llm-grok    { background: rgba(59,130,246,0.2); color: #93c5fd; }

  /* Messages / search hits */
  .msg-list { list-style: none; margin: 0; padding: 0; }
  .msg {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    padding: 0.7rem 0.85rem;
    margin-bottom: 0.6rem;
  }
  .msg-head {
    display: flex; justify-content: space-between; align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .msg-head-left, .msg-head-right {
    display: flex; align-items: center; gap: 0.5rem;
  }
  .msg-body {
    white-space: pre-wrap; word-break: break-word;
    color: #e8e8f0; font-size: 0.9rem; line-height: 1.45;
  }
  .role {
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    padding: 0.1rem 0.5rem; border-radius: 8px; letter-spacing: 0.04em;
  }
  .role-user { background: rgba(59,130,246,0.2); color: #93c5fd; }
  .role-assistant { background: rgba(34,197,94,0.2); color: #86efac; }
  .role-system { background: rgba(168,85,247,0.2); color: #d8b4fe; }
  .role-tool { background: rgba(234,179,8,0.2); color: #fde68a; }
  .time { color: #64748b; font-size: 0.75rem; }
  .muted { color: #64748b; font-size: 0.85rem; padding: 0.4rem 0; }
  .faint { color: #64748b; font-size: 0.75rem; }

  /* Phase 5a: LLM color-coded chip on search hits */
  .llm-chip {
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    padding: 0.1rem 0.5rem; border-radius: 8px; letter-spacing: 0.04em;
  }
  .llm-chip-llm-chatgpt { background: rgba(16,163,127,0.25); color: #6ee7b7; }
  .llm-chip-llm-claude  { background: rgba(217,119,6,0.25);  color: #fcd34d; }
  .llm-chip-llm-grok    { background: rgba(59,130,246,0.25); color: #93c5fd; }
  .llm-chip-llm-other   { background: rgba(148,163,184,0.25); color: #cbd5e1; }

  /* Hit title (conversation title) */
  .hit-title {
    font-weight: 600; font-size: 0.9rem; color: #e8e8f0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 280px;
  }

  /* Snippet with <mark> highlights */
  .search-snippet :global(mark) {
    background: rgba(250,204,21,0.35); color: #fef3c7;
    padding: 0 2px; border-radius: 2px;
  }
  .code-badge {
    display: inline-block; margin-left: 0.5rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.7rem; color: #94a3b8;
    background: #0a0a1a; border: 1px solid #2a2a4a;
    padding: 0 0.35rem; border-radius: 3px; vertical-align: middle;
  }

  /* Continue button (panel header + per-hit) */
  .continue-btn {
    background: #475569; color: white; border: none;
    padding: 0.3rem 0.7rem; border-radius: 4px; cursor: pointer;
    font: inherit; font-size: 0.78rem; font-weight: 500;
  }
  .continue-btn:hover { background: #334155; }
  .continue-btn:disabled { opacity: 0.6; cursor: wait; }

  /* Capture box */
  .capture-box {
    margin-top: 1.25rem;
    background: #16162a;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 0.75rem 1rem 1rem;
  }
  .capture-box h2 { margin-top: 0; }
  .hint { color: #94a3b8; font-size: 0.8rem; margin: 0.25rem 0 0.6rem; }
  .hint code {
    background: #2a2a4a; padding: 0.05rem 0.35rem; border-radius: 3px;
    font-size: 0.85em;
  }
  .capture-controls {
    display: flex; align-items: center; gap: 0.5rem;
    margin: 0.25rem 0 0.6rem;
  }
  .capture-controls label {
    color: #94a3b8; font-size: 0.85rem; font-weight: 500;
  }
  .capture-controls select {
    background: #1a1a2e; color: #e8e8f0;
    border: 1px solid #3a3a5a; border-radius: 4px;
    padding: 0.35rem 0.6rem; font: inherit; font-size: 0.85rem;
    cursor: pointer;
  }
  .capture-controls select:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
  .capture-box textarea {
    width: 100%;
    background: #1a1a2e; color: #e8e8f0;
    border: 1px solid #3a3a5a; border-radius: 4px;
    padding: 0.6rem; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.8rem; resize: vertical; outline: none;
  }
  .capture-box textarea:focus { border-color: #3b82f6; }
  .capture-actions {
    display: flex; align-items: center; gap: 0.75rem; margin-top: 0.6rem;
  }
  .capture-actions button {
    background: #3b82f6; color: white; border: none;
    padding: 0.5rem 1.2rem; border-radius: 4px; cursor: pointer;
    font: inherit; font-size: 0.9rem; font-weight: 500;
  }
  .capture-actions button:hover { background: #2563eb; }
  .capture-actions button:disabled { opacity: 0.6; cursor: wait; }
  .status {
    font-size: 0.85rem; padding: 0.25rem 0.6rem; border-radius: 4px;
  }
  .status-ok { background: rgba(34,197,94,0.15); color: #86efac; }
  .status-err { background: rgba(239,68,68,0.15); color: #fca5a5; }
  .status-saving { background: rgba(59,130,246,0.15); color: #93c5fd; }
</style>
