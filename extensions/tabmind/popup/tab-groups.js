// TabMind - Tab Groups Feature
// Create and manage tab groups

// Match the same predicate used in popup.js / background.js so the three
// places stay in sync.
function isGrokUrl(url) {
  if (!url) return false;
  return (
    url.includes('x.com/grok') ||
    url.includes('x.com/i/grok') ||
    url.includes('grok.com') ||
    url.includes('x.com/grokai')
  );
}

async function createGroup(name, color = 'grey') {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  
  // Get selected tabs or all tabs if none selected
  const selectedTabs = tabs.filter(t => t.highlighted);
  
  if (selectedTabs.length === 0) {
    // Group all visible tabs
    const tabIds = tabs.map(t => t.id);
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title: name, color });
    return groupId;
  } else {
    // Group selected tabs
    const tabIds = selectedTabs.map(t => t.id);
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title: name, color });
    return groupId;
  }
}

async function addTabsToGroup(groupId, tabIds) {
  await chrome.tabs.group({ groupId, tabIds });
}

async function moveTabToGroup(tabId, groupId) {
  await chrome.tabs.group({ groupId: groupId, tabIds: [tabId] });
}

async function ungroupTabs(tabIds) {
  for (const tabId of tabIds) {
    await chrome.tabs.ungroup(tabId);
  }
}

async function getAllGroups() {
  const groups = await chrome.tabGroups.query({});
  return groups;
}

async function getTabsInGroup(groupId) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(t => t.groupId === groupId);
}

// Available colors for groups
const GROUP_COLORS = [
  { id: 'grey', name: 'Grey', hex: '#6b7280' },
  { id: 'blue', name: 'Blue', hex: '#3b82f6' },
  { id: 'red', name: 'Red', hex: '#ef4444' },
  { id: 'yellow', name: 'Yellow', hex: '#eab308' },
  { id: 'green', name: 'Green', hex: '#22c55e' },
  { id: 'pink', name: 'Pink', hex: '#ec4899' },
  { id: 'purple', name: 'Purple', hex: '#a855f7' },
  { id: 'cyan', name: 'Cyan', hex: '#06b6d4' },
];

// Quick group by domain
async function groupByDomain() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  
  // Group tabs by domain
  const domainGroups = {};
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url);
      const domain = url.hostname;
      if (!domainGroups[domain]) {
        domainGroups[domain] = [];
      }
      domainGroups[domain].push(tab.id);
    } catch (e) {
      // Skip invalid URLs
    }
  }
  
  // Create groups for each domain
  for (const [domain, tabIds] of Object.entries(domainGroups)) {
    if (tabIds.length > 1) {
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { 
        title: domain.substring(0, 20),
        color: 'blue'
      });
    }
  }
}

// Quick group by time (tabs opened recently vs older)
async function groupByTime() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const now = Date.now();
  const hourAgo = now - (60 * 60 * 1000);
  
  const recentTabs = tabs.filter(t => t.lastAccessed > hourAgo).map(t => t.id);
  const olderTabs = tabs.filter(t => t.lastAccessed <= hourAgo).map(t => t.id);
  
  if (recentTabs.length > 0) {
    const recentGroup = await chrome.tabs.group({ tabIds: recentTabs });
    await chrome.tabGroups.update(recentGroup, { title: 'Recent', color: 'green' });
  }
  
  if (olderTabs.length > 0) {
    const olderGroup = await chrome.tabs.group({ tabIds: olderTabs });
    await chrome.tabGroups.update(olderGroup, { title: 'Older', color: 'grey' });
  }
}

// Auto-group suggestions based on content
async function suggestGroups() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const suggestions = [];
  
  // Group by domain
  const domainGroups = {};
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url);
      const domain = url.hostname.split('.')[0];
      if (!domainGroups[domain]) domainGroups[domain] = [];
      domainGroups[domain].push({ id: tab.id, title: tab.title, url: tab.url });
    } catch (e) {}
  }
  
  for (const [domain, tabList] of Object.entries(domainGroups)) {
    if (tabList.length >= 2) {
      suggestions.push({
        name: domain,
        count: tabList.length,
        tabs: tabList,
        type: 'domain'
      });
    }
  }
  
  // Group Grok tabs
  const grokTabs = tabs.filter(t => isGrokUrl(t.url));
  if (grokTabs.length >= 2) {
    suggestions.push({
      name: 'Grok',
      count: grokTabs.length,
      tabs: grokTabs.map(t => ({ id: t.id, title: t.title, url: t.url })),
      type: 'grok'
    });
  }
  
  // Group X tabs
  const xTabs = tabs.filter(t => t.url?.includes('x.com') || t.url?.includes('twitter.com'));
  if (xTabs.length >= 2) {
    suggestions.push({
      name: 'X / Twitter',
      count: xTabs.length,
      tabs: xTabs.map(t => ({ id: t.id, title: t.title, url: t.url })),
      type: 'x'
    });
  }
  
  return suggestions;
}