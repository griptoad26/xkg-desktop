<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  // --- Local state ---
  let query = '';
  let graph = { nodes: [], edges: [] };   // response from `graph_query`
  let selectedIdx = null;                  // index into `graph.nodes`, or null
  let loading = false;
  let lastError = null;

  // --- Lifecycle ---
  onMount(() => {
    // Run a default search on first mount so the user immediately sees
    // *something* (instead of an empty canvas).
    if (graph.nodes.length === 0) {
      runQuery('rust');
    }
  });

  async function runQuery(q) {
    const trimmed = (q ?? query ?? '').trim();
    if (!trimmed) {
      graph = { nodes: [], edges: [] };
      return;
    }
    loading = true;
    lastError = null;
    try {
      const res = await invoke('graph_query', { query: trimmed });
      graph = res || { nodes: [], edges: [] };
      selectedIdx = null;
    } catch (e) {
      lastError = `graph_query: ${e}`;
      graph = { nodes: [], edges: [] };
    } finally {
      loading = false;
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    runQuery();
  }

  function selectNode(idx) {
    selectedIdx = selectedIdx === idx ? null : idx;
  }

  // --- Geometry ---
  // Lay out up to `n` dots evenly around a circle of radius `r`.
  // Returns an array of [cx, cy] pairs in SVG coords.
  function layoutNodes(n, r) {
    const cx = 250, cy = 250;
    const out = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / Math.max(n, 1)) * 2 * Math.PI - Math.PI / 2;
      out.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    return out;
  }

  // Tiny color picker based on topic index so adjacent topics don't
  // collide visually.
  function dotFill(i) {
    const palette = ['#3b82f6', '#22c55e', '#a855f7', '#eab308', '#ec4899', '#06b6d4', '#f97316', '#84cc16'];
    return palette[i % palette.length];
  }

  // Truncate a topic for the SVG label.
  function shortLabel(s, n = 18) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  $: positions = layoutNodes(graph.nodes.length, 200);
  $: selectedNode = selectedIdx != null ? graph.nodes[selectedIdx] : null;
</script>

<div class="graph">
  <header>
    <h1>🕸️ xkg-desktop — Knowledge Graph</h1>
    <p class="sub">
      Topics extracted from messages matching your query. Each dot is a
      topic; lines connect topics co-mentioned by the same message.
    </p>
  </header>

  <section class="search-bar">
    <form on:submit={onSubmit}>
      <input
        type="text"
        bind:value={query}
        placeholder='Try "rust borrow checker" or any topic you’ve captured…'
        data-testid="graph-search-input"
      />
      <button
        type="submit"
        disabled={loading}
        data-testid="graph-search-button"
      >{loading ? 'Searching…' : 'Search'}</button>
    </form>
    {#if lastError}
      <p class="error">{lastError}</p>
    {/if}
  </section>

  <div class="panes">
    <!-- ============ LEFT: SVG GRAPH ============ -->
    <div class="canvas-wrap">
      {#if graph.nodes.length === 0}
        <p class="empty">
          {loading ? 'Searching…' : 'No topics found. Try a different query.'}
        </p>
      {:else}
        <svg
          class="graph-svg"
          viewBox="0 0 500 500"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Topic graph"
        >
          <!-- Edges first so dots render on top -->
          {#each graph.edges as [a, b, w]}
            {#if positions[a] && positions[b]}
              <line
                x1={positions[a][0]}
                y1={positions[a][1]}
                x2={positions[b][0]}
                y2={positions[b][1]}
                stroke="#475569"
                stroke-width={Math.min(1 + w * 0.6, 4)}
                stroke-opacity={Math.min(0.25 + w * 0.15, 0.85)}
              />
            {/if}
          {/each}

          {#each graph.nodes as node, i}
            {#if positions[i]}
              <g
                class="node"
                class:selected={selectedIdx === i}
                on:click={() => selectNode(i)}
                on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectNode(i)}
                role="button"
                tabindex="0"
                aria-label={node.topic}
                data-testid={`graph-node-${i}`}
              >
                <circle
                  cx={positions[i][0]}
                  cy={positions[i][1]}
                  r={selectedIdx === i ? 16 : 12}
                  fill={dotFill(i)}
                  stroke={selectedIdx === i ? '#f8fafc' : 'transparent'}
                  stroke-width="2"
                />
                <text
                  x={positions[i][0]}
                  y={positions[i][1] + 30}
                  text-anchor="middle"
                  fill="#e8e8f0"
                  font-size="11"
                  font-family="-apple-system, BlinkMacSystemFont, sans-serif"
                >{shortLabel(node.topic)}</text>
              </g>
            {/if}
          {/each}
        </svg>
        <p class="meta">
          {graph.nodes.length} node{graph.nodes.length === 1 ? '' : 's'} ·
          {graph.edges.length} edge{graph.edges.length === 1 ? '' : 's'}
        </p>
      {/if}
    </div>

    <!-- ============ RIGHT: NODE DETAIL ============ -->
    <aside class="detail">
      {#if selectedNode}
        <h2>{selectedNode.topic}</h2>
        <p class="faint">
          Mentioned in {selectedNode.message_ids.length}
          message{selectedNode.message_ids.length === 1 ? '' : 's'} ·
          connected to {graph.edges.filter(([a, b]) => a === selectedIdx || b === selectedIdx).length}
          other node{graph.edges.filter(([a, b]) => a === selectedIdx || b === selectedIdx).length === 1 ? '' : 's'}
        </p>

        <h3>Messages</h3>
        {#if selectedNode.message_ids.length === 0}
          <p class="muted">No messages tagged with this topic.</p>
        {:else}
          <ul class="msg-ids">
            {#each selectedNode.message_ids as mid}
              <li><code>{mid}</code></li>
            {/each}
          </ul>
        {/if}

        <h3>Linked topics</h3>
        {#if graph.edges.filter(([a, b]) => a === selectedIdx || b === selectedIdx).length === 0}
          <p class="muted">No other topics share a message with this one.</p>
        {:else}
          <ul class="links">
            {#each graph.edges.filter(([a, b]) => a === selectedIdx || b === selectedIdx) as [a, b, w]}
              {@const otherIdx = a === selectedIdx ? b : a}
              {@const other = graph.nodes[otherIdx]}
              <li>
                <button class="link-btn" on:click={() => selectNode(otherIdx)}>
                  {other.topic}
                  <span class="weight">×{w}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <h2>Click a node</h2>
        <p class="muted">
          Tap any dot in the graph to see the messages that mention that
          topic and the other topics it co-occurs with.
        </p>
        <h3>All topics</h3>
        <ul class="all-topics">
          {#each graph.nodes as node, i}
            <li>
              <button class="topic-btn" on:click={() => selectNode(i)}>
                <span class="swatch" style="background: {dotFill(i)}"></span>
                {node.topic}
                <span class="count">{node.message_ids.length}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>
  </div>
</div>

<style>
  .graph {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 4rem;
  }
  header h1 { margin: 0; font-size: 1.4rem; }
  header .sub { margin: 0.25rem 0 0; color: #94a3b8; font-size: 0.85rem; }

  /* Search bar */
  .search-bar { margin-top: 1rem; }
  .search-bar form { display: flex; gap: 0.5rem; }
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
  .search-bar button:disabled { opacity: 0.6; cursor: wait; }
  .error { color: #fca5a5; font-size: 0.85rem; margin: 0.4rem 0 0; }

  /* Two-pane layout */
  .panes {
    display: grid;
    grid-template-columns: 500px 1fr;
    gap: 1.25rem;
    margin-top: 1rem;
  }
  .canvas-wrap, .detail {
    background: #16162a;
    border: 1px solid #2a2a4a;
    border-radius: 6px;
    padding: 0.75rem;
    min-height: 520px;
  }

  /* SVG canvas */
  .graph-svg {
    display: block; width: 100%; height: auto;
    background: radial-gradient(circle at center, #1a1a2e 0%, #0f0f1f 100%);
    border-radius: 4px;
  }
  .node {
    cursor: pointer;
    transition: transform 0.1s ease;
  }
  .node:hover circle {
    filter: brightness(1.2);
  }
  .node:focus { outline: none; }
  .node:focus-visible circle { stroke: #f8fafc; stroke-width: 3; }
  .node.selected circle { filter: drop-shadow(0 0 6px rgba(255,255,255,0.6)); }

  .empty {
    color: #64748b; font-size: 0.9rem;
    padding: 3rem 1rem; text-align: center;
  }
  .meta {
    color: #64748b; font-size: 0.75rem;
    text-align: center; margin: 0.4rem 0 0;
  }

  /* Detail panel */
  .detail h2 {
    margin: 0 0 0.5rem; font-size: 1.1rem;
    color: #f8fafc; text-transform: none; letter-spacing: 0;
    border: none; padding: 0;
  }
  .detail h3 {
    margin: 1rem 0 0.4rem;
    font-size: 0.7rem; text-transform: uppercase;
    letter-spacing: 0.05em; color: #94a3b8;
  }
  .faint { color: #64748b; font-size: 0.75rem; margin: 0 0 0.5rem; }
  .muted { color: #64748b; font-size: 0.85rem; padding: 0.2rem 0; }

  .msg-ids {
    list-style: none; margin: 0; padding: 0;
    max-height: 160px; overflow-y: auto;
  }
  .msg-ids li { padding: 0.2rem 0; }
  .msg-ids code {
    background: #2a2a4a; padding: 0.1rem 0.4rem; border-radius: 3px;
    font-size: 0.78rem; color: #cbd5e1;
  }

  .links, .all-topics {
    list-style: none; margin: 0; padding: 0;
  }
  .link-btn, .topic-btn {
    display: flex; align-items: center; gap: 0.5rem;
    width: 100%; text-align: left;
    background: transparent; color: #e8e8f0;
    border: 1px solid transparent; border-radius: 4px;
    padding: 0.35rem 0.5rem; cursor: pointer;
    font: inherit; font-size: 0.85rem; margin-bottom: 0.15rem;
  }
  .link-btn:hover, .topic-btn:hover {
    background: #22223d; border-color: #3a3a5a;
  }
  .swatch {
    display: inline-block;
    width: 10px; height: 10px; border-radius: 50%;
  }
  .count {
    margin-left: auto;
    background: #2a2a4a; padding: 0.05rem 0.4rem;
    border-radius: 8px; font-size: 0.7rem; color: #94a3b8;
  }
  .weight {
    margin-left: auto;
    background: #1f2937; padding: 0.05rem 0.4rem;
    border-radius: 8px; font-size: 0.7rem; color: #cbd5e1;
  }
</style>