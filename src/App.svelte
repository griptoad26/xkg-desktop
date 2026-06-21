<script>
  import Settings from './Settings.svelte';
</script>

<main>
  <Settings />
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
</style>
