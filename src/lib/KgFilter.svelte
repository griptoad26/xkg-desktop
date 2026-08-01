<script>
  import { onMount } from 'svelte';

  // KG Filter UI — built for the /api/kg/* endpoints added in v0.8.0.
  // Fetches /api/kg/conversations and /api/kg/links over HTTP, lets the
  // user filter by source (provider), link type, and score range, then
  // renders the matching edges with score badges.
  //
  // Server endpoints used (verified live):
  //   GET  /api/kg/conversations    -> { conversations: [...] }
  //   GET  /api/kg/links            -> { count, links: [...] }
  //   GET  /api/kg/conversations/<id> -> { ..., links: [...] }

  // --- Filter state ---
  let hubUrl = 'http://localhost:8090';
  let sourceFilter = 'all';          // 'all' | 'grok' | 'claude' | 'chatgpt' | 'gemini'
  let linkTypeFilter = new Set();    // multi-select: 'related' | 'reply' | ...
  let scoreMin = 0.0;
  let scoreMax = 1.0;
  let applying = false;
  let lastError = null;

  // --- Data state ---
  let conversations = [];             // all convs from /api/kg/conversations
  let links = [];                     // all links from /api/kg/links
  let filteredLinks = [];             // after applying filters
  let loading = false;
  let lastFetchAt = null;

  // --- On mount: fetch all conversations + links ---
  onMount(async () => {
    await refresh();
  });

  async function refresh() {
    loading = true;
    lastError = null;
    try {
      const [convsRes, linksRes] = await Promise.all([
        fetch(`${hubUrl}/api/kg/conversations`).then(checkOk),
        fetch(`${hubUrl}/api/kg/links`).then(checkOk),
      ]);
      conversations = convsRes.conversations || [];
      links = linksRes.links || [];
      lastFetchAt = Math.floor(Date.now() / 1000);
      applyFilters();
    } catch (e) {
      lastError = `fetch: ${e}`;
      conversations = [];
      links = [];
      filteredLinks = [];
    } finally {
      loading = false;
    }
  }

  async function checkOk(res) {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // --- Filter logic ---
  // Maps source filter → set of conv IDs to keep.
  // For each link, both endpoints must be in that set (so we don't show
  // links between conversations that were filtered out).
  function applyFilters() {
    applying = true;
    try {
      const idSet = new Set(
        conversations
          .filter((c) => sourceFilter === 'all' || c.source === sourceFilter)
          .map((c) => c.id)
      );

      const types = linkTypeFilter.size > 0 ? linkTypeFilter : null;
      const lo = Math.min(scoreMin, scoreMax);
      const hi = Math.max(scoreMin, scoreMax);

      filteredLinks = links.filter((l) => {
        if (!idSet.has(l.source_conv_id) || !idSet.has(l.target_conv_id)) return false;
        if (types && !types.has(l.link_type)) return false;
        if (typeof l.score === 'number' && (l.score < lo || l.score > hi)) return false;
        return true;
      });
    } finally {
      applying = false;
    }
  }

  function toggleLinkType(t) {
    if (linkTypeFilter.has(t)) linkTypeFilter.delete(t);
    else linkTypeFilter.add(t);
    linkTypeFilter = new Set(linkTypeFilter); // trigger reactivity
    applyFilters();
  }

  function clearFilters() {
    sourceFilter = 'all';
    linkTypeFilter = new Set();
    scoreMin = 0.0;
    scoreMax = 1.0;
    applyFilters();
  }

  // --- Derived: distinct sources + link types from data ---
  $: sourceOptions = ['all', ...new Set(conversations.map((c) => c.source))];
  $: linkTypeOptions = [...new Set(links.map((l) => l.link_type))];
  $: convById = new Map(conversations.map((c) => [c.id, c]));
  $: stats = {
      total: links.length,
      shown: filteredLinks.length,
      convs: conversations.length,
  };

  function fmtPct(n) {
    if (typeof n !== 'number') return '—';
    return `${(n * 100).toFixed(1)}%`;
  }

  function fmtTs(secs) {
    if (!secs) return '';
    try {
      return new Date(secs * 1000).toLocaleString();
    } catch (_) {
      return String(secs);
    }
  }

  function fmtAgo(secs) {
    if (!secs) return '';
    const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    return `${Math.floor(d / 3600)}h ago`;
  }
</script>

<div class="kg">
  <header>
    <h1>🕸️ Knowledge Graph — Filter</h1>
    <p class="sub">
      Filter the v0.8.0 <code>/api/kg/*</code> endpoints by source provider,
      link type, and similarity score range.
    </p>
  </header>

  <section class="form">
    <label class="field">
      <span class="label">Hub URL</span>
      <input
        type="text"
        bind:value={hubUrl}
        on:change={refresh}
        placeholder="http://localhost:8090"
        data-testid="kg-hub-input"
      />
    </label>

    <div class="row">
      <label class="field">
        <span class="label">Source provider</span>
        <select bind:value={sourceFilter} on:change={applyFilters} data-testid="kg-source-select">
          {#each sourceOptions as opt}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span class="label">Score range</span>
        <div class="range-row">
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            bind:value={scoreMin}
            on:change={applyFilters}
            data-testid="kg-score-min"
            class="range-input"
          />
          <span class="range-sep">–</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            bind:value={scoreMax}
            on:change={applyFilters}
            data-testid="kg-score-max"
            class="range-input"
          />
        </div>
      </label>
    </div>

    {#if linkTypeOptions.length > 0}
      <div class="field">
        <span class="label">Link types (multi-select)</span>
        <div class="chips">
          {#each linkTypeOptions as t}
            <button
              type="button"
              class="chip"
              class:on={linkTypeFilter.has(t)}
              on:click={() => toggleLinkType(t)}
              data-testid="kg-linktype-{t}"
            >
              {t}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="actions">
      <button
        type="button"
        class="primary"
        on:click={applyFilters}
        disabled={applying || loading}
        data-testid="kg-apply-button"
      >
        Apply
      </button>
      <button
        type="button"
        class="secondary"
        on:click={clearFilters}
        data-testid="kg-clear-button"
      >
        Clear
      </button>
      <button
        type="button"
        class="secondary"
        on:click={refresh}
        disabled={loading}
        data-testid="kg-refresh-button"
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>

    <p class="status" data-testid="kg-status">
      {#if lastError}
        <span class="err">⚠ {lastError}</span>
      {:else if loading}
        <span class="muted">loading…</span>
      {:else}
        <span class="ok">
          ✓ showing {stats.shown} of {stats.total} links across {stats.convs} conversations
          {#if lastFetchAt}
            <span class="muted">· fetched {fmtAgo(lastFetchAt)}</span>
          {/if}
        </span>
      {/if}
    </p>
  </section>

  <section class="results" data-testid="kg-results">
    {#if filteredLinks.length === 0}
      <p class="muted">No links match the current filters.</p>
    {:else}
      <ul class="link-list">
        {#each filteredLinks as link (link.source_conv_id + '-' + link.target_conv_id + '-' + link.link_type)}
          {@const src = convById.get(link.source_conv_id)}
          {@const tgt = convById.get(link.target_conv_id)}
          <li class="link-item" data-testid="kg-link-row">
            <div class="link-head">
              <span class="badge badge-source">{src?.source ?? '?'}</span>
              <span class="arrow">→</span>
              <span class="badge badge-target">{tgt?.source ?? '?'}</span>
              <span class="badge badge-type">{link.link_type}</span>
              <span class="score" data-testid="kg-score">{fmtPct(link.score)}</span>
            </div>
            <div class="link-meta">
              <strong>{src?.title ?? `conv#${link.source_conv_id}`}</strong>
              <span class="muted"> → </span>
              <strong>{tgt?.title ?? `conv#${link.target_conv_id}`}</strong>
            </div>
            <div class="link-ids muted">
              #{link.source_conv_id} → #{link.target_conv_id}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .kg {
    padding: 1rem 1.5rem 2rem;
    max-width: 900px;
    margin: 0 auto;
  }
  header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.4rem;
    color: #f8fafc;
  }
  header .sub {
    margin: 0 0 1.5rem;
    font-size: 0.85rem;
    color: #94a3b8;
  }
  header .sub code {
    background: #0f0f1f;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    color: #a5b4fc;
  }

  .form {
    background: #0f0f1f;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  @media (max-width: 700px) {
    .row { grid-template-columns: 1fr; }
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .label {
    font-size: 0.8rem;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  input[type="text"], select {
    background: #1a1a2e;
    color: #e8e8f0;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    font: inherit;
    font-size: 0.9rem;
  }
  input[type="text"]:focus, select:focus {
    outline: none;
    border-color: #3b82f6;
  }

  .range-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .range-input { width: 80px; }
  .range-sep { color: #64748b; }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .chip {
    background: #1a1a2e;
    color: #94a3b8;
    border: 1px solid #2a2a4a;
    border-radius: 999px;
    padding: 0.3rem 0.75rem;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .chip:hover { color: #e8e8f0; }
  .chip.on {
    background: #3b82f6;
    color: #f8fafc;
    border-color: #3b82f6;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  button.primary {
    background: #3b82f6;
    color: #f8fafc;
    border: none;
    border-radius: 6px;
    padding: 0.55rem 1.25rem;
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    background: transparent;
    color: #94a3b8;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }
  button.secondary:hover { color: #e8e8f0; }

  .status {
    margin: 0;
    font-size: 0.85rem;
  }
  .status .err { color: #ef4444; }
  .status .ok { color: #22c55e; }
  .status .muted { color: #64748b; }
  .muted { color: #64748b; }

  .results {
    background: #0f0f1f;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }

  .link-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .link-item {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 0.75rem 1rem;
  }
  .link-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .arrow { color: #64748b; }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .badge-source { background: #1e3a8a; color: #dbeafe; }
  .badge-target { background: #312e81; color: #ede9fe; }
  .badge-type   { background: #2a2a4a; color: #c7d2fe; margin-left: 0.5rem; }
  .score {
    margin-left: auto;
    background: #064e3b;
    color: #6ee7b7;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .link-meta { font-size: 0.85rem; color: #e8e8f0; }
  .link-ids { font-size: 0.7rem; margin-top: 0.25rem; }
</style>