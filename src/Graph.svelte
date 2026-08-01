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

  // --- Phase 167 linker state ---
  let rootId = '';
  let depth = 2;
  let threshold = 0.7;
  let topK = 5;
  let subgraph = { nodes: [], edges: [] };
  let linked = [];          // response from `graph_link`
  let linkerBusy = false;
  let linkerError = null;
  let selectedEdge = null;  // { source, target, link_type } to unlink

  async function runSubgraph() {
    if (!rootId.trim()) return;
    linkerBusy = true;
    linkerError = null;
    try {
      const res = await invoke('graph_query', {
        rootId: rootId.trim(),
        depth: depth,
      });
      subgraph = res || { nodes: [], edges: [] };
    } catch (e) {
      linkerError = `graph_query: ${e}`;
    } finally {
      linkerBusy = false;
    }
  }

  async function runLink() {
    if (!rootId.trim()) return;
    linkerBusy = true;
    linkerError = null;
    try {
      const res = await invoke('graph_link', {
        conversationId: rootId.trim(),
        topK: topK,
        threshold: threshold,
      });
      linked = res || [];
      // Re-render the subgraph so newly-persisted edges show up.
      await runSubgraph();
    } catch (e) {
      linkerError = `graph_link: ${e}`;
    } finally {
      linkerBusy = false;
    }
  }

  async function unlinkEdge(edge) {
    linkerBusy = true;
    linkerError = null;
    try {
      await invoke('graph_unlink', {
        source: edge.source,
        target: edge.target,
        linkType: edge.link_type,
      });
      selectedEdge = null;
      await runSubgraph();
    } catch (e) {
      linkerError = `graph_unlink: ${e}`;
    } finally {
      linkerBusy = false;
    }
  }

  // --- Layout: simple concentric circle ---
  // Root at center, depth 1 ring, depth 2 outer ring. Edges are
  // straight lines from source dot to target dot.
  $: layout = (() => {
    const W = 280, H = 280;
    const cx = W / 2, cy = H / 2;
    const r1 = 70, r2 = 120;
    const byDepth = { 0: [], 1: [], 2: [] };
    for (const n of subgraph.nodes) {
      (byDepth[n.depth] || (byDepth[n.depth] = [])).push(n);
    }
    const positions = {};
    for (const d of [0, 1, 2]) {
      const arr = byDepth[d] || [];
      const r = d === 0 ? 0 : (d === 1 ? r1 : r2);
      arr.forEach((n, i) => {
        if (d === 0) {
          positions[n.conversation_id] = { x: cx, y: cy };
        } else {
          const theta = (2 * Math.PI * i) / arr.length;
          positions[n.conversation_id] = {
            x: cx + r * Math.cos(theta),
            y: cy + r * Math.sin(theta),
          };
        }
      });
    }
    return { W, H, cx, cy, positions };
  })();
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
  .linker-sidebar {
    border-top: 1px solid #1f2937;
    padding: 0.75rem 0.5rem 1.5rem;
    margin-top: 1rem;
  }
  .linker-sidebar h3 {
    margin: 0 0 0.5rem;
    font-size: 0.95rem;
    color: #e5e7eb;
  }
  .linker-controls {
    display: flex; flex-direction: column; gap: 0.4rem;
    margin-bottom: 0.75rem;
  }
  .linker-controls label {
    display: flex; justify-content: space-between;
    align-items: center; gap: 0.5rem;
    font-size: 0.8rem; color: #94a3b8;
  }
  .linker-controls input {
    flex: 1;
    background: #1e1e2e; color: #e5e7eb;
    border: 1px solid #2a2a4a; border-radius: 4px;
    padding: 0.2rem 0.4rem;
    font: inherit; font-size: 0.8rem;
  }
  .linker-buttons {
    display: flex; gap: 0.4rem;
  }
  .linker-buttons button {
    flex: 1;
    background: #2a2a4a; color: #e5e7eb;
    border: 1px solid #3a3a5a; border-radius: 4px;
    padding: 0.35rem 0.6rem;
    font: inherit; font-size: 0.85rem;
    cursor: pointer;
  }
  .linker-buttons button:hover:not(:disabled) {
    background: #3a3a5a;
  }
  .linker-buttons button:disabled {
    opacity: 0.5; cursor: not-allowed;
  }
  .linker-error {
    color: #f87171; font-size: 0.8rem;
  }
  .linker-summary {
    color: #34d399; font-size: 0.8rem;
  }
  .linker-svg {
    width: 100%; height: auto; max-width: 320px;
    background: #1e1e2e; border-radius: 6px;
    display: block; margin: 0 auto;
  }
  .linker-edge {
    cursor: pointer;
  }
  .linker-edge.selected {
    stroke: #f59e0b; stroke-width: 2;
  }
  .linker-node {
    cursor: pointer;
  }
  .linker-node:hover circle {
    stroke: #fbbf24; stroke-width: 2;
  }
  .linker-edge-actions {
    margin-top: 0.5rem;
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.8rem; color: #94a3b8;
  }
  .linker-edge-actions button {
    background: #2a2a4a; color: #e5e7eb;
    border: 1px solid #3a3a5a; border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font: inherit; font-size: 0.8rem;
    cursor: pointer;
  }
</style>
<!-- ====================================================================
     PHASE 167 SIDEBAR — conversation-link subgraph (BFS over typed edges)
     ====================================================================

     Renders a small "circle of dots" SVG for the sub-graph returned by
     `graph_query(root_id, depth)`. Each node is a dot; each edge is a
     line. Clicking a node fires a new `graph_query` rooted at that
     conversation, letting the user navigate the link graph 2 hops at
     a time.

     Buttons in the footer dispatch `graph_link` (compute TF-IDF cosine
     similarity from a conversation) and `graph_unlink` (delete a
     typed edge). Together with the existing topic-graph canvas above,
     the user can both *discover* (FTS5 topic graph) and *navigate*
     (link BFS) the same corpus from the same tab.
     ==================================================================== -->


<div class="linker-sidebar">
  <h3>Conversation links</h3>
  <div class="linker-controls">
    <label>
      Conversation id
      <input bind:value={rootId} placeholder="conv-… or any id" />
    </label>
    <label>
      Depth <input type="number" bind:value={depth} min="1" max="5" />
    </label>
    <label>
      Threshold
      <input type="number" bind:value={threshold} min="0" max="1" step="0.05" />
    </label>
    <label>
      Top-K <input type="number" bind:value={topK} min="1" max="20" />
    </label>
    <div class="linker-buttons">
      <button on:click={runSubgraph} disabled={linkerBusy || !rootId.trim()}>
        Query graph
      </button>
      <button on:click={runLink} disabled={linkerBusy || !rootId.trim()}>
        Compute links
      </button>
    </div>
    {#if linkerError}
      <div class="linker-error">{linkerError}</div>
    {/if}
    {#if linked.length}
      <div class="linker-summary">
        Persisted {linked.length} related link{linked.length === 1 ? '' : 's'}
        (top score {linked[0].score.toFixed(3)}).
      </div>
    {/if}
  </div>

  <svg viewBox="0 0 {layout.W} {layout.H}" class="linker-svg" aria-label="subgraph">
    {#each subgraph.edges as e}
      {#if layout.positions[e.source] && layout.positions[e.target]}
        <line
          x1={layout.positions[e.source].x}
          y1={layout.positions[e.source].y}
          x2={layout.positions[e.target].x}
          y2={layout.positions[e.target].y}
          stroke="#4b5563"
          stroke-width="1"
          class="linker-edge"
          class:selected={selectedEdge && selectedEdge.source === e.source && selectedEdge.target === e.target}
          on:click={() => (selectedEdge = e)}
        />
      {/if}
    {/each}
    {#each subgraph.nodes as n}
      {#if layout.positions[n.conversation_id]}
        <g
          class="linker-node"
          class:is-root={n.depth === 0}
          on:click={() => (rootId = n.conversation_id)}
        >
          <circle
            cx={layout.positions[n.conversation_id].x}
            cy={layout.positions[n.conversation_id].y}
            r={n.depth === 0 ? 8 : 5}
            fill={n.depth === 0 ? '#f59e0b' : '#60a5fa'}
          />
          <text
            x={layout.positions[n.conversation_id].x}
            y={layout.positions[n.conversation_id].y + (n.depth === 0 ? 22 : 16)}
            text-anchor="middle"
            font-size="9"
            fill="#cbd5e1"
          >{n.conversation_id}</text>
        </g>
      {/if}
    {/each}
  </svg>

  {#if selectedEdge}
    <div class="linker-edge-actions">
      <span>{selectedEdge.source} → {selectedEdge.target} ({selectedEdge.link_type})</span>
      <button on:click={() => unlinkEdge(selectedEdge)} disabled={linkerBusy}>
        Unlink
      </button>
      <button on:click={() => (selectedEdge = null)}>Cancel</button>
    </div>
  {/if}
</div>

