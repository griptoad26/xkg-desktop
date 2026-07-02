<script>
  import Settings from './Settings.svelte';
  import Capture from './Capture.svelte';

  let view = 'capture';   // 'capture' | 'settings'
</script>

<main>
  <nav class="tabs">
    <button
      class:active={view === 'capture'}
      on:click={() => (view = 'capture')}
      data-testid="tab-capture"
    >📚 Capture</button>
    <button
      class:active={view === 'settings'}
      on:click={() => (view = 'settings')}
      data-testid="tab-settings"
    >⚙️ Settings</button>
  </nav>

  {#if view === 'capture'}
    <Capture />
  {:else}
    <Settings />
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #1a1a2e;
    color: #e8e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  :global(*) { box-sizing: border-box; }
  main {
    min-height: 100vh;
    padding: 0;
  }

  .tabs {
    display: flex;
    gap: 0;
    padding: 0.75rem 1.5rem 0;
    background: #0f0f1f;
    border-bottom: 1px solid #2a2a4a;
  }
  .tabs button {
    background: transparent;
    color: #94a3b8;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.55rem 1.1rem;
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    border-radius: 4px 4px 0 0;
  }
  .tabs button:hover { color: #e8e8f0; background: rgba(255,255,255,0.03); }
  .tabs button.active {
    color: #f8fafc;
    background: #1a1a2e;
    border-bottom-color: #3b82f6;
  }
</style>