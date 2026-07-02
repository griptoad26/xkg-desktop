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

  // Capture textarea
  let captureHtml = '';
  let captureLlm = 'chatgpt'; // 'chatgpt' | 'claude' | 'grok'
  let captureStatus = null;   // 'idle' | 'saving' | 'ok' | 'err'
  let captureMsg = '';

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

  async function runSearch() {
    const q = searchQuery.trim();
    if (!q) {
      searchResults = null;
      return;
    }
    try {
      const hits = await invoke('search_messages', { query: q });
      searchResults = hits;
    } catch (e) {
      lastError = `search_messages: ${e}`;
      searchResults = [];
    }
  }

  function clearSearch() {
    searchQuery = '';
    searchResults = null;
  }

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

  <!-- ============ TOP BAR: SEARCH ============ -->
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
                    <span class="llm">{c.llm}</span>
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
          <h2>
            Search results
            <span class="faint">({searchResults.length} hit{searchResults.length === 1 ? '' : 's'})</span>
          </h2>
          {#if searchResults.length === 0}
            <p class="muted">No messages match "{searchQuery}".</p>
          {:else}
            <ul class="msg-list">
              {#each searchResults as m (m.id)}
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
        {:else if selectedConvId}
          <h2>Conversation</h2>
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

  /* Messages */
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
    margin-bottom: 0.4rem;
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