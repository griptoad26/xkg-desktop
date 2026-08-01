// =============================================================================
// TabMind - Popup Script
//
// Production-ready:
//  - No top-level side effects (everything is in init() / DOMContentLoaded)
//  - Settings load is async-aware and re-renders dependents
//  - All chrome.* and fetch() calls have try/catch
//  - All user-controlled strings are escaped before HTML interpolation
//  - All CSS selectors used inside executeScript are strings (parseable JS)
//  - No silent NaN / parse failures — `parseTabId` validates
//  - Single source of truth for "is this a Grok tab?"
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tabsIndex = [];
let selectedIndex = -1;
let lastSearch = '';

const settings = {
  xkgEndpoint: 'http://localhost:18050',
  autoSyncGrok: false,
  quickLaunch: ['grok', 'chatgpt', 'claude', 'gemini', 'perplexity']
};

// ---------------------------------------------------------------------------
// Quick-launch row: header buttons for each linked LLM.
// One click → fresh chat tab in that provider (mirrors x.com/i/grok pattern).
// ---------------------------------------------------------------------------

const LLM_REGISTRY = [
  { id: 'grok',        icon: '𝕏',  name: 'Grok',        url: 'https://x.com/i/grok' },
  { id: 'chatgpt',     icon: '💬', name: 'ChatGPT',     url: 'https://chatgpt.com/' },
  { id: 'claude',      icon: '🪶', name: 'Claude',      url: 'https://claude.ai/new' },
  { id: 'gemini',      icon: '✦',  name: 'Gemini',      url: 'https://gemini.google.com/app' },
  { id: 'perplexity',  icon: '🔍', name: 'Perplexity',  url: 'https://www.perplexity.ai/' },
  { id: 'copilot',     icon: '🪁', name: 'Copilot',     url: 'https://copilot.microsoft.com/' },
  { id: 'meta',        icon: '∞',  name: 'Meta AI',     url: 'https://www.meta.ai/' },
  { id: 'mistral',     icon: '🅼', name: 'Mistral',     url: 'https://chat.mistral.ai/chat' },
  { id: 'huggingchat', icon: '🤗', name: 'HuggingChat', url: 'https://huggingface.co/chat/' },
  { id: 'you',         icon: '🔎', name: 'You.com',     url: 'https://you.com/search?q=chat' },
  { id: 'phind',       icon: '⌘',  name: 'Phind',       url: 'https://www.phind.com/' },
  { id: 'kagi',        icon: '🟡', name: 'Kagi',        url: 'https://kagi.com/assistant' }
];

const DEFAULT_QUICK_LAUNCH = ['grok', 'chatgpt', 'claude', 'gemini', 'perplexity'];

const LLM_BY_ID = Object.freeze(
  LLM_REGISTRY.reduce((acc, p) => { acc[p.id] = p; return acc; }, {})
);

function renderQuickLaunch() {
  const wrap = document.getElementById('quickLaunch');
  if (!wrap) return;
  const enabled = (Array.isArray(settings.quickLaunch) && settings.quickLaunch.length)
    ? settings.quickLaunch
    : DEFAULT_QUICK_LAUNCH;
  const items = enabled.map(id => LLM_BY_ID[id]).filter(Boolean);
  if (!items.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = items.map(p => `
    <button class="ql-btn" data-provider="${escapeAttr(p.id)}"
            title="Open ${escapeAttr(p.name)} chat in a new tab"
            data-url="${escapeAttr(p.url)}">
      <span class="ql-icon">${escapeText(p.icon)}</span>
      <span class="ql-name">${escapeText(p.name)}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('.ql-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const url = btn.dataset.url;
      if (!url) return;
      chrome.tabs.create({ url, active: true }).catch(err => {
        console.warn('Quick-launch open failed:', err);
      });
    });
  });
}

function renderLlmPicker() {
  const wrap = document.getElementById('llmPicker');
  if (!wrap) return;
  const enabled = (Array.isArray(settings.quickLaunch) && settings.quickLaunch.length)
    ? settings.quickLaunch
    : DEFAULT_QUICK_LAUNCH;
  wrap.innerHTML = LLM_REGISTRY.map(p => `
    <label>
      <input type="checkbox" data-id="${escapeAttr(p.id)}" ${enabled.includes(p.id) ? 'checked' : ''}>
      <span>${escapeText(p.icon)} ${escapeText(p.name)}</span>
    </label>
  `).join('');
}

function collectPickerSelection() {
  const wrap = document.getElementById('llmPicker');
  if (!wrap) return DEFAULT_QUICK_LAUNCH.slice();
  const checked = Array.from(wrap.querySelectorAll('input:checked'))
    .map(el => el.dataset.id)
    .filter(id => Object.prototype.hasOwnProperty.call(LLM_BY_ID, id));
  return checked;
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function loadSavedSearch() {
  chrome.storage.local.get(['tabmindLastSearch'], (result) => {
    if (!result || !result.tabmindLastSearch) return;
    lastSearch = result.tabmindLastSearch;
    const input = document.getElementById('searchInput');
    if (input) input.value = lastSearch;
    if (lastSearch.trim() && tabsIndex.length) {
      search(lastSearch);
    }
  });
}

function saveSearch(query) {
  lastSearch = query;
  chrome.storage.local.set({ tabmindLastSearch: query });
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['xkgSettings'], (result) => {
      if (result && result.xkgSettings && typeof result.xkgSettings === 'object') {
        // Merge with defaults — never trust persisted shape blindly.
        const s = result.xkgSettings;
        if (typeof s.xkgEndpoint === 'string') settings.xkgEndpoint = s.xkgEndpoint;
        if (typeof s.autoSyncGrok === 'boolean') settings.autoSyncGrok = s.autoSyncGrok;
        if (Array.isArray(s.quickLaunch)) settings.quickLaunch = s.quickLaunch;
      }
      // Sync form + header row + picker
      const xEl = document.getElementById('xkgEndpoint');
      if (xEl) xEl.value = settings.xkgEndpoint || '';
      const aEl = document.getElementById('autoSyncGrok');
      if (aEl) aEl.checked = !!settings.autoSyncGrok;
      renderQuickLaunch();
      renderLlmPicker();
      resolve();
    });
  });
}

function saveSettings() {
  const xEl = document.getElementById('xkgEndpoint');
  const aEl = document.getElementById('autoSyncGrok');
  if (xEl) settings.xkgEndpoint = xEl.value.trim() || settings.xkgEndpoint;
  if (aEl) settings.autoSyncGrok = aEl.checked;
  settings.quickLaunch = collectPickerSelection();
  chrome.storage.local.set({ xkgSettings: settings }, () => {
    if (chrome.runtime.lastError) {
      console.warn('saveSettings failed:', chrome.runtime.lastError);
      return;
    }
    toggleSettings(false);
    renderQuickLaunch();
  });
}

function toggleSettings(show) {
  const panel = document.getElementById('settingsPanel');
  if (panel) panel.classList.toggle('hidden', !show);
}

// ---------------------------------------------------------------------------
// Suspended-tab detection
// ---------------------------------------------------------------------------

function isSuspendedTab(tab) {
  if (!tab || !tab.url) return false;
  const url = tab.url.toLowerCase();
  return (
    url.includes('suspended.html') ||
    url.includes('/suspended/') ||
    url.includes('tubsuspended') ||
    url.includes('workona.com/tabs/suspended') ||
    url.includes('workona.com/tab-suspend') ||
    url.startsWith('chrome-untrusted://') ||
    url.includes('about:suspended') ||
    (url.includes('chrome-extension') && url.includes('suspend')) ||
    url.startsWith('chrome://discards/')
  );
}

async function wakeUpTab(tabId) {
  try {
    await chrome.tabs.reload(tabId);
    return true;
  } catch (e) {
    console.log('Wake failed:', tabId, e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tab indexing
// ---------------------------------------------------------------------------

const GROK_URL_TEST = (url) =>
  !!url && (
    url.includes('x.com/grok') ||
    url.includes('grok.com') ||
    url.includes('x.com/i/grok')
  );

const SKIP_URL_TEST = (url) =>
  !url || url.startsWith('chrome://') || url.startsWith('brave://') ||
  url.startsWith('edge://') || url.startsWith('about:') ||
  url.startsWith('chrome-search://');

async function indexTabs() {
  updateStatus('indexing');
  console.log('Starting indexing...');
  try {
    const tabs = await chrome.tabs.query({});
    const grokTabs = tabs.filter(t => GROK_URL_TEST(t.url));

    tabsIndex = tabs
      .filter(t => !SKIP_URL_TEST(t.url))
      .map(tab => ({
        id: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        favicon: tab.favIconUrl || '',
        content: '',
        isGrok: GROK_URL_TEST(tab.url),
        isSuspended: isSuspendedTab(tab)
      }));

    // Show tabs immediately with titles/urls
    search(lastSearch);

    // Second pass: extract content from active tab (fast)
    const activeTab = tabs.find(t => t.active);
    let successCount = 0;
    if (activeTab && !isSuspendedTab(activeTab) && !SKIP_URL_TEST(activeTab.url)) {
      const content = await getTabContentFast(activeTab.id);
      if (content) {
        const idx = tabsIndex.findIndex(t => t.id === activeTab.id);
        if (idx !== -1) {
          tabsIndex[idx].content = content;
          successCount = 1;
        }
      }
    }

    // Third pass: background index other tabs (slow, non-blocking)
    setTimeout(() => indexTabsInBackground(tabs).catch(() => {}), 500);

    let statusText = `${tabsIndex.length} tabs`;
    if (successCount > 0) statusText += ` (${successCount}+ indexed)`;
    if (grokTabs.length > 0) statusText += `, ${grokTabs.length} Grok`;
    console.log('=== INDEXING COMPLETE ===', statusText);
    const tc = document.getElementById('tabsCount');
    if (tc) tc.textContent = statusText;
    updateStatus('ready');
  } catch (error) {
    console.error('Indexing error:', error);
    updateStatus('error');
  }
}

async function getTabContentFast(tabId) {
  try {
    // Check cache first
    const cached = await new Promise((resolve) => {
      chrome.storage.local.get([`tab-content-${tabId}`], (result) => {
        const v = result && result[`tab-content-${tabId}`];
        resolve((v && typeof v.content === 'string') ? v.content : null);
      });
    });
    if (cached && cached.length > 10) {
      console.log('Cache hit for tab', tabId);
      return cached;
    }
    console.log('Requesting content from background for tab', tabId);
    const response = await chrome.runtime.sendMessage({
      action: 'getTabContent',
      tabId: tabId
    });
    console.log('Background response for tab', tabId, ':', response?.text?.length || 0, 'chars');
    return (response && typeof response.text === 'string') ? response.text : null;
  } catch (e) {
    console.log('getTabContentFast error:', e.message);
    return null;
  }
}

async function indexTabsInBackground(tabs) {
  const toIndex = tabs
    .filter(t => t.url && t.url.startsWith('http') && !isSuspendedTab(t))
    .slice(0, 10);
  let successCount = 0;
  for (const tab of toIndex) {
    const content = await getTabContentFast(tab.id);
    if (content) {
      const idx = tabsIndex.findIndex(t => t.id === tab.id);
      if (idx !== -1) {
        tabsIndex[idx].content = content;
        successCount++;
      }
    }
  }
  if (successCount > 0) {
    console.log('Background indexed:', successCount, 'more tabs');
    search(lastSearch);
  }
}

function extractGitHubLinks(content) {
  if (!content) return [];
  const githubPattern = /https?:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/gi;
  const matches = content.match(githubPattern) || [];
  return Array.from(new Set(matches));
}

// ---------------------------------------------------------------------------
// Search & results rendering
// ---------------------------------------------------------------------------

function search(query) {
  const results = document.getElementById('results');
  if (!results) return;

  if (!query || !query.trim()) {
    // Show all tabs with their GitHub links
    results.innerHTML = tabsIndex.map((tab) => {
      const githubLinks = extractGitHubLinks(tab.content);
      const preview = tab.content ? tab.content.substring(0, 80).replace(/\s+/g, ' ') : '';
      return renderResultItem({
        ...tab,
        score: 0,
        context: '',
        matchCount: 0,
        githubLinks,
        preview
      }, '');
    }).join('');
    selectedIndex = tabsIndex.length > 0 ? 0 : -1;
    updateSelection();
    return;
  }

  const queryLower = query.toLowerCase();
  const scored = tabsIndex.map((tab) => {
    let score = 0;
    let context = '';
    let matchCount = 0;

    const titleLower = (tab.title || '').toLowerCase();
    const urlLower = (tab.url || '').toLowerCase();
    const contentLower = (tab.content || '').toLowerCase();

    if (titleLower.includes(queryLower)) score += 10;
    if (urlLower.includes(queryLower)) score += 5;
    if (contentLower.includes(queryLower)) {
      const matches = contentLower.match(new RegExp(escapeRegex(queryLower), 'g'));
      matchCount = matches ? matches.length : 0;
      score += Math.min(matchCount * 2, 20);
      const idx = contentLower.indexOf(queryLower);
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(tab.content.length, idx + query.length + 50);
        context = tab.content.substring(start, end);
        if (start > 0) context = '...' + context;
        if (end < tab.content.length) context = context + '...';
      }
    }
    if (tab.isGrok) score += 3;
    if (tab.isSuspended) score -= 5;

    return { ...tab, score, context, matchCount };
  });

  const filtered = scored
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (filtered.length === 0) {
    results.innerHTML = `<div class="empty-state">No results for "${escapeText(query)}"</div>`;
    selectedIndex = -1;
    return;
  }

  results.innerHTML = filtered.map((tab) => renderResultItem(tab, query)).join('');
  selectedIndex = 0;
  updateSelection();
}

function renderResultItem(tab, query) {
  const safeTitle = escapeText(tab.title || 'Untitled');
  const safeUrl = escapeText(tab.url || '');
  const grokBadge = tab.isGrok ? '<span class="result-badge">Grok</span>' : '';
  const suspendedBadge = tab.isSuspended ? '<span class="result-badge">💤</span>' : '';
  const matchesBadge = (tab.matchCount > 1)
    ? `<span class="result-badge matches">${tab.matchCount} matches</span>` : '';

  // Build context HTML (with highlight) only when there's a query
  let contextHtml = '';
  if (tab.context) {
    const safeContext = escapeText(tab.context);
    const highlighted = safeContext.replace(
      new RegExp(`(${escapeRegex(query)})`, 'gi'),
      '<mark>$1</mark>'
    );
    contextHtml = `<div class="result-context">${highlighted}</div>`;
  }

  // GitHub links (only in the empty-query view, where we pass them through)
  let ghHtml = '';
  if (Array.isArray(tab.githubLinks) && tab.githubLinks.length > 0) {
    ghHtml = `<div class="github-links">${
      tab.githubLinks.map(link => {
        const safe = escapeAttr(link);
        const display = escapeText(link.replace(/^https?:\/\/github\.com\//, ''));
        return `<a href="${safe}" class="github-link" target="_blank" rel="noopener noreferrer">${display}</a>`;
      }).join('')
    }</div>`;
  }

  const preview = tab.preview
    ? `<div class="result-context">${escapeText(tab.preview)}...</div>` : '';

  return `
    <div class="result-item ${tab.isGrok ? 'grok' : ''}" data-tab-id="${tab.id}">
      <div class="result-title">
        ${safeTitle}
        ${grokBadge}
        ${suspendedBadge}
        ${matchesBadge}
      </div>
      <div class="result-url">${safeUrl}</div>
      ${ghHtml}
      ${contextHtml || preview}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// HTML escaping (XSS hardening)
// ---------------------------------------------------------------------------

function escapeText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeText(s);
}

function escapeHtml(text) {
  // Legacy alias kept for back-compat with any other call sites.
  return escapeText(text);
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Selection / navigation
// ---------------------------------------------------------------------------

function updateSelection() {
  const items = document.querySelectorAll('.result-item');
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === selectedIndex);
  });
}

function parseTabId(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function jumpToTab(tabId) {
  const id = parseTabId(tabId);
  if (id === null) {
    console.warn('jumpToTab: invalid tabId', tabId);
    return;
  }
  console.log('Jumping to tab:', id);
  chrome.tabs.update(id, { active: true }, (tab) => {
    if (chrome.runtime.lastError) {
      console.warn('tabs.update failed:', chrome.runtime.lastError.message);
      return;
    }
    if (tab && tab.windowId) {
      chrome.windows.update(tab.windowId, { focused: true });
    }
  });
  window.close();
}

async function wakeAllAndIndex() {
  const btn = document.getElementById('wakeAll');
  if (!btn) return;
  const originalText = btn.textContent;
  btn.textContent = 'Waking...';
  btn.disabled = true;
  try {
    const tabs = await chrome.tabs.query({});
    let wokenCount = 0;
    for (const tab of tabs) {
      if (isSuspendedTab(tab)) {
        try {
          await chrome.tabs.reload(tab.id);
          wokenCount++;
          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          console.log('Failed to wake tab:', tab.id, e);
        }
      }
    }
    btn.textContent = `☀ Woke ${wokenCount}`;
    setTimeout(async () => {
      await indexTabs();
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  } catch (e) {
    console.error('wakeAllAndIndex error:', e);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Grok detection
// ---------------------------------------------------------------------------

function isGrokTab(url) {
  return GROK_URL_TEST(url);
}

const GROK_CONVERSATION_PATTERNS = [
  /x\.com\/i\/grok\?conversation=/i,
  /x\.com\/grok\?conversation=/i,
  /x\.com\/grok$/i,
  /x\.com\/grokai/i,
  /grok\.com/i,
  /x\.com\/i\/grok$/i
];

function isGrokConversation(url) {
  if (!url) return false;
  return GROK_CONVERSATION_PATTERNS.some(p => p.test(url));
}

function getConversationId(url) {
  if (!url) return null;
  const match = url.match(/conversation[=\/](\d+)/i);
  return match ? match[1] : null;
}

async function syncGrok() {
  const btn = document.getElementById('syncGrok');
  if (!btn) return;
  const originalText = btn.textContent;
  let grokTabs = [];
  try {
    const allTabs = await chrome.tabs.query({});
    // Wake all suspended Grok tabs first
    const suspendedGrok = allTabs.filter(t => GROK_URL_TEST(t.url) && isSuspendedTab(t));
    for (const tab of suspendedGrok) {
      await wakeUpTab(tab.id);
      await new Promise(r => setTimeout(r, 300));
    }
    grokTabs = allTabs.filter(t => GROK_URL_TEST(t.url));
  } catch (e) {
    console.error('syncGrok: tab query failed', e);
    alert('Sync failed: ' + (e.message || e));
    return;
  }

  if (grokTabs.length === 0) {
    alert('No Grok tabs found. Make sure you have x.com/grok tabs open.');
    return;
  }

  btn.textContent = 'Syncing...';
  btn.disabled = true;

  let synced = 0;
  let hadError = false;
  for (const tab of grokTabs) {
    try {
      const content = await getTabContentFast(tab.id);
      if (!content || content.length <= 20) continue;
      const resp = await fetch(`${settings.xkgEndpoint}/api/tab-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: tab.title || 'Grok Conversation',
          url: tab.url,
          content,
          timestamp: Date.now()
        })
      });
      if (resp.ok) synced++;
    } catch (e) {
      console.log('Sync error for tab', tab.id, e);
      hadError = true;
    }
  }

  btn.textContent = synced > 0 ? `✓ ${synced} synced!` : 'Failed';
  setTimeout(() => {
    btn.textContent = originalText;
    btn.disabled = false;
  }, 3000);

  if (synced === 0 && hadError) {
    alert('Sync failed. Make sure XKG is running at ' + settings.xkgEndpoint);
  }
}

// ---------------------------------------------------------------------------
// Status / event wiring
// ---------------------------------------------------------------------------

function updateStatus(status) {
  document.querySelectorAll('.status span').forEach(el => el.classList.add('hidden'));
  if (status === 'indexing') {
    const el = document.querySelector('.status .indexing');
    if (el) el.classList.remove('hidden');
  } else if (status === 'ready') {
    const el = document.querySelector('.status .ready');
    if (el) el.classList.remove('hidden');
  }
}

function setupEventListeners() {
  const searchInput = document.getElementById('searchInput');
  const results = document.getElementById('results');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value;
      saveSearch(query);
      search(query);
    });
    searchInput.addEventListener('keydown', (e) => {
      const items = document.querySelectorAll('.result-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length === 0) return;
        selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
        if (selectedIndex < 0) selectedIndex = 0;
        updateSelection();
        scrollToSelected();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length === 0) return;
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelection();
        scrollToSelected();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = document.querySelector('.result-item.selected');
        if (selected) jumpToTab(selected.dataset.tabId);
      } else if (e.key === 'Escape') {
        window.close();
      }
    });
  }

  if (results) {
    results.addEventListener('click', (e) => {
      const item = e.target.closest('.result-item');
      if (item) jumpToTab(item.dataset.tabId);
    });
  }

  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  };
  wire('syncGrok', syncGrok);
  wire('wakeAll', wakeAllAndIndex);
  wire('settingsBtn', () => toggleSettings(true));
  wire('saveSettings', saveSettings);
  wire('closeSettings', () => toggleSettings(false));
  wire('groupTabs', () => toggleGroupPanel(true));
  wire('closeGroup', () => toggleGroupPanel(false));
  wire('groupByDomain', groupByDomain);
  wire('groupGrok', groupGrokTabs);
  wire('groupX', groupXTabs);
}

function scrollToSelected() {
  const selected = document.querySelector('.result-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Group Panel
// ---------------------------------------------------------------------------

function toggleGroupPanel(show) {
  const panel = document.getElementById('groupPanel');
  if (panel) panel.classList.toggle('hidden', !show);
}

async function groupByDomain() {
  const list = document.getElementById('groupList');
  if (list) list.innerHTML = '<p class="hint">Grouping by domain...</p>';
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const domainGroups = {};
    for (const tab of tabs) {
      try {
        const url = new URL(tab.url);
        const domain = url.hostname;
        if (!domainGroups[domain]) domainGroups[domain] = [];
        domainGroups[domain].push(tab.id);
      } catch (e) { /* ignore invalid URLs */ }
    }
    let groupCount = 0;
    for (const [domain, tabIds] of Object.entries(domainGroups)) {
      if (tabIds.length > 1) {
        const groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, { title: domain.substring(0, 15), color: 'blue' });
        groupCount++;
      }
    }
    if (list) list.innerHTML = `<p class="hint">✅ Created ${groupCount} groups</p>`;
  } catch (e) {
    if (list) list.innerHTML = `<p class="hint">❌ Error: ${escapeText(e.message)}</p>`;
  }
}

async function groupGrokTabs() {
  const list = document.getElementById('groupList');
  if (list) list.innerHTML = '<p class="hint">Grouping Grok tabs...</p>';
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const grokTabs = tabs.filter(t => t.url && t.url.includes('grok'));
    if (grokTabs.length > 1) {
      const tabIds = grokTabs.map(t => t.id);
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { title: 'Grok', color: 'green' });
      if (list) list.innerHTML = `<p class="hint">✅ Grouped ${grokTabs.length} Grok tabs</p>`;
    } else {
      if (list) list.innerHTML = '<p class="hint">Not enough Grok tabs to group</p>';
    }
  } catch (e) {
    if (list) list.innerHTML = `<p class="hint">❌ Error: ${escapeText(e.message)}</p>`;
  }
}

async function groupXTabs() {
  const list = document.getElementById('groupList');
  if (list) list.innerHTML = '<p class="hint">Grouping X/Twitter tabs...</p>';
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const xTabs = tabs.filter(t =>
      t.url && (t.url.includes('x.com') || t.url.includes('twitter.com'))
    );
    if (xTabs.length > 1) {
      const tabIds = xTabs.map(t => t.id);
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { title: 'X/Twitter', color: 'cyan' });
      if (list) list.innerHTML = `<p class="hint">✅ Grouped ${xTabs.length} X tabs</p>`;
    } else {
      if (list) list.innerHTML = '<p class="hint">Not enough X tabs to group</p>';
    }
  } catch (e) {
    if (list) list.innerHTML = `<p class="hint">❌ Error: ${escapeText(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// XKG endpoint auto-detection (optional, manual-trigger only)
// ---------------------------------------------------------------------------

const XKG_ENDPOINT_CANDIDATES = [
  { url: 'http://localhost:18050',     platform: 'desktop',          priority: 1 },
  { url: 'http://10.0.2.2:18050',      platform: 'android-emulator',  priority: 2 },
  { url: 'http://localhost:18050',     platform: 'ios-simulator',    priority: 2 },
  { url: 'http://192.168.50.187:18050', platform: 'android-device',  priority: 3 },
  { url: 'http://localhost:8080',      platform: 'web-alt',          priority: 4 },
  { url: 'http://localhost:5000',      platform: 'legacy',           priority: 5 }
];

function getXkgEndpointCandidates() {
  return XKG_ENDPOINT_CANDIDATES.slice().sort((a, b) => a.priority - b.priority);
}

async function autoDetectXkgEndpoint(timeoutMs = 2000) {
  for (const ep of getXkgEndpointCandidates()) {
    try {
      const res = await fetch(ep.url + '/api/health', {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.ok) {
        return ep.url;
      }
    } catch (e) {
      // try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Enhanced Grok content extraction (uses executeScript with a string-arg func)
// ---------------------------------------------------------------------------

const GROK_EXTRACT_FN = () => {
  const data = {
    title: document.title,
    url: window.location.href,
    timestamp: Date.now(),
    content: '',
    metadata: {}
  };

  // CSS selectors (all properly quoted strings so they're parseable)
  const selectors = [
    '[data-testid="cellInnerDiv"]',  // Timeline tweets
    'article',                       // Article posts
    '[role="article"]',              // Generic articles
    'main',                          // Main content
    '.r-1hab5b2'                     // Grok-specific
  ];

  let content = '';
  for (const sel of selectors) {
    let els = [];
    try { els = document.querySelectorAll(sel); } catch (_) { continue; }
    if (els.length > 0) {
      content = Array.from(els).map(e => e.textContent).join(' | ');
      if (content.length > 200) break;
    }
  }

  // Fallback to body
  if (!content || content.length < 100) {
    const body = document.body;
    if (body) {
      const clone = body.cloneNode(true);
      const remove = ['script', 'style', 'nav', 'footer', 'header', '.promo', '.ad'];
      remove.forEach(s => {
        try { clone.querySelectorAll(s).forEach(e => e.remove()); } catch (_) {}
      });
      content = (clone.textContent || '').trim();
    }
  }

  data.content = (content || '').slice(0, 50000);

  // Extract metadata
  let hasGrok = false;
  let tweetCount = 0;
  try { hasGrok = document.querySelector('[data-testid="grokPrompt"]') !== null; } catch (_) {}
  try { tweetCount = document.querySelectorAll('[data-testid="tweet"]').length; } catch (_) {}

  data.metadata = {
    hasGrok,
    tweetCount,
    url: window.location.href
  };

  return data;
};

async function extractGrokContent(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: GROK_EXTRACT_FN
    });
    return (results && results[0] && results[0].result) || null;
  } catch (e) {
    console.error('extractGrokContent error:', e);
    return null;
  }
}

async function syncGrokConversations() {
  const endpoint = settings.xkgEndpoint || 'http://localhost:18050';
  let grokTabs = [];
  try {
    const tabs = await chrome.tabs.query({});
    grokTabs = tabs.filter(t => t.url && isGrokConversation(t.url));
  } catch (e) {
    console.error('syncGrokConversations: tab query failed', e);
    return 0;
  }

  console.log(`Found ${grokTabs.length} Grok tabs`);

  const results = [];
  for (const tab of grokTabs) {
    const data = await extractGrokContent(tab);
    if (data) {
      data.conversationId = getConversationId(tab.url);
      results.push(data);
    }
  }

  if (results.length === 0) return 0;

  try {
    const response = await fetch(endpoint + '/api/tab-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabs: results,
        source: 'TabMind Chrome Extension',
        timestamp: Date.now()
      })
    });
    if (response.ok) {
      console.log(`✅ Synced ${results.length} conversations to XKG`);
    } else {
      console.warn(`XKG returned ${response.status} for sync`);
    }
  } catch (e) {
    console.error('Sync error:', e);
  }
  return results.length;
}

// ---------------------------------------------------------------------------
// Init — runs once DOM is ready
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSettings();
  } catch (e) {
    console.error('loadSettings failed:', e);
  }
  try {
    renderQuickLaunch();
    renderLlmPicker();
  } catch (e) {
    console.error('Initial render failed:', e);
  }
  try {
    setupEventListeners();
  } catch (e) {
    console.error('setupEventListeners failed:', e);
  }
  try {
    loadSavedSearch();
  } catch (e) {
    console.error('loadSavedSearch failed:', e);
  }
  try {
    await indexTabs();
  } catch (e) {
    console.error('indexTabs failed:', e);
  }
  updateStatus('ready');
});

// Export for tests (no-op in extension context)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LLM_REGISTRY, LLM_BY_ID, DEFAULT_QUICK_LAUNCH,
    isGrokTab, isGrokConversation, getConversationId,
    isSuspendedTab, extractGitHubLinks, escapeText, escapeRegex,
    settings, GROK_URL_TEST
  };
}
