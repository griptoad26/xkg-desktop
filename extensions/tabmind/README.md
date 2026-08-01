# TabMind — Search Every Tab Instantly

<p align="center">
  <img src="https://img.shields.io/badge/Version-0.1.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License">
  <img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Brave-orange.svg" alt="Platform">
</p>

> **Stop clicking through tabs. Start searching.**

TabMind is a Chrome/Brave extension that searches the **content** of all your open tabs — not just titles. Find that one tab with the answer you need, instantly.

## Why TabMind?

- **40 tabs open?** No problem. Search across all of them in milliseconds.
- **Can't remember which tab?** Just search what you're looking for.
- **Grok conversations?** Auto-sync to XKG for permanent knowledge storage.
- **100% local** — your data never leaves your browser.

## Features

### 🔍 Deep Content Search
Search not just tab titles, but the actual content on each page. Finds what you need even if you forgot the page name.

### ⌨️ Keyboard Navigation
- `↑` `↓` — Navigate results
- `Enter` — Jump to tab
- `Esc` — Close popup

### 🤖 Grok Integration (XKG)
Connect to [XKG (X Knowledge Graph)](https://github.com/griptoad26/x-knowledge-graph) to:
- Auto-sync Grok conversations
- Build permanent searchable knowledge base
- Never lose important insights

### 🎯 Smart Ranking
Results ranked by relevance with Grok tabs boosted for quick access.

## Installation

### Option 1: Download ZIP (Recommended)

**Step 1: Download the extension**
> 👆 Look for the green **Code** button on this page (top right of the file list) and **CLICK IT**

A dropdown will appear. Click **Download ZIP**.

**Step 2: Extract the ZIP**
- Find `tabmind-main.zip` in your Downloads folder
- Right-click → **Extract All**
- **IMPORTANT:** You should now have a folder called `tabmind-main/`
- **NOTE:** Some ZIP programs create a nested folder, so you may see `tabmind-main/tabmind-main/` — use the INNER folder!

**Step 3: Verify folder contents**
Before loading, check that the folder contains:
- ✅ `manifest.json`
- ✅ `popup/` folder
- ✅ `background/` folder
- ✅ `content/` folder

**If you see double folders like this:**
```
Downloads/
└── tabmind-main/
    └── tabmind-main/   ← USE THIS ONE
        ├── manifest.json
        ├── popup/
        ├── background/
        └── content/
```

**Step 4: Load in Chrome/Brave**
1. Open **Chrome** or **Brave** browser
2. Go to `chrome://extensions/` (or `brave://extensions/`)
3. Enable **Developer Mode** (toggle in top right corner)
4. Click **Load unpacked**
5. Navigate to the folder with `manifest.json` inside
6. Click **Open**

---

## Setting Up XKG (Required for Sync)

TabMind can sync your Grok conversations to XKG (X Knowledge Graph). Here's how to set it up:

### Prerequisites

1. **Python installed** (for running XKG)
   - Download from: https://python.org/downloads
   - During install, check "Add Python to PATH"

2. **XKG source code** - If you don't have it:
   - Go to: https://github.com/griptoad26/x-knowledge-graph
   - Click **Code** → **Download ZIP**
   - Extract the folder

### Running XKG

**Option A: Using run.bat (Windows - Easiest)**
```
1. Open File Explorer
2. Navigate to x-knowledge-graph folder
3. Double-click run.bat
4. A window will open and XKG will start
```

**Option B: Using Python directly**
```
1. Open Command Prompt (cmd.exe)
2. Navigate to x-knowledge-graph folder:
   cd path/to/x-knowledge-graph
3. Run:
   python main.py
   # OR
   py main.py
```

**Option C: Using build and run (Windows)**
```
1. Navigate to x-knowledge-graph folder
2. Double-click build.bat (this builds the .exe)
3. Double-click start.bat
```

### Verifying XKG is Running

1. Open a new browser tab
2. Go to: http://localhost:5000
3. You should see the XKG interface

**Alternative: Check with curl**
```
1. Open Command Prompt
2. Run:
   curl http://localhost:5000/api/health
3. Should return JSON with status info
```

### Configuring TabMind to Sync with XKG

Once XKG is running:

1. Click the TabMind icon in your browser toolbar
2. Click the ⚙️ **Settings** button (bottom right)
3. In the **XKG Endpoint** field, enter:
   - `http://localhost:5000` (if XKG is on same computer)
   - `http://192.168.1.X:5000` (if XKG is on another computer in your network)
4. Click **Save**
5. Click **Test** to verify the connection

### Syncing Grok Conversations

1. Open Grok (x.com/grok) in a tab
2. Have a conversation or find an existing one
3. Click the TabMind icon
4. Click the **🤖 Sync Grok** button
5. The conversation content will be sent to XKG

### Checking Imported Content in XKG

1. Go to http://localhost:5000
2. Look for imported tabs in the interface
3. Or search: http://localhost:5000/api/tabs

3. **Load in Chrome/Brave:**
   - Open **Chrome** or **Brave** browser
   - Go to `chrome://extensions/` (or `brave://extensions/`)
   - Enable **Developer Mode** (toggle in top right corner)
   - Click **Load unpacked**
   - Navigate to the `tabmind-main` folder you extracted
   - Select the folder (make sure you're selecting the folder containing `manifest.json`)
   - Click **Open**

4. **Pin the extension:**
   - Look for the puzzle piece icon 🧩 in your browser toolbar
   - Click it → Find **TabMind** → Click the pin 📌

5. **Start searching!**
   - Click the TabMind icon in your toolbar
   - Type to search all your open tabs
   - Use ↑↓ to navigate, Enter to jump

### Option 2: Clone with Git

```bash
# If you have Git installed
git clone https://github.com/griptoad26/tabmind.git
cd tabmind

# Then load the folder in your browser:
# chrome://extensions/ → Developer Mode → Load unpacked → select tabmind folder
```

### Configuration (Optional - for Grok Sync)

**Prerequisite: XKG must be running first!**

Before using the Sync feature, you need to:

1. **Start XKG on your computer:**
   ```bash
   # Navigate to XKG folder
   cd /path/to/x-knowledge-graph
   
   # Run XKG (it runs on port 5000 by default)
   python main.py
   # OR on Windows
   run.bat
   ```

2. **Verify XKG is running:**
   - Open your browser
   - Go to: http://localhost:5000
   - You should see the XKG interface

3. **Configure TabMind:**
   - Click the ⚙️ **Settings** button in TabMind
   - In **XKG Endpoint**, enter: `http://localhost:5000`
   - Click **Save**

**Note:** If XKG is on a different computer (like a VPS), use that computer's IP address instead:
- Example: `http://192.168.1.100:5000` (local network)
- Example: `http://66.179.191.93:5000` (remote/VPS)

### Troubleshooting Sync

| Status | Meaning |
|--------|---------|
| "X tabs (Y indexed, Z Grok)" | Working! Y tabs have searchable content |
| "X failed" | Some tabs blocked by browser (normal for some sites) |
| "No Grok tabs found" | No x.com/grok tabs open |
| "Sync failed" | XKG not running or wrong endpoint |

### Checking Your XKG Version

To verify you have the latest XKG:

1. **Check the GitHub repo:**
   - Go to: https://github.com/griptoad26/x-knowledge-graph
   - Look at the latest commit date
   - Compare to your local version

2. **Check within XKG:**
   - Go to http://localhost:5000/api/health
   - Or check http://localhost:5000 (footer should show version)

3. **Update XKG:**
   - Download the latest ZIP from GitHub
   - Replace your x-knowledge-graph folder
   - Re-run run.bat

**Current XKG location:** `/home/molty/.openclaw/workspace/projects/x-knowledge-graph` (on this machine)

## Usage

1. Click the TabMind icon (or use keyboard shortcut)
2. Type your search query
3. Use arrow keys to navigate
4. Press Enter to jump to the matching tab

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate results |
| `Enter` | Jump to tab |
| `Esc` | Close popup |

## XKG Integration

TabMind pairs with [XKG (X Knowledge Graph)](https://github.com/griptoad26/x-knowledge-graph) for power users:

```
┌─────────────┐     ┌─────────────┐
│  TabMind   │────▶│     XKG     │
│  Extension  │     │ Knowledge   │
└─────────────┘     │   Base     │
                    └─────────────┘
```

- **Free:** Search all your tabs locally
- **Pro:** Sync Grok conversations → XKG for permanent, searchable knowledge

[Learn more about XKG →](https://github.com/griptoad26/x-knowledge-graph)

## Troubleshooting

### Extension won't load
- Make sure you're loading the **folder**, not a file inside it
- The folder should contain `manifest.json` at the root

### No tabs appear in search
- Click the extension icon to trigger initial indexing
- Refresh your tabs and try again

### Search is slow
- Close unused tabs for faster indexing
- TabMind works best with under 50 open tabs

## Development

```bash
# Clone
git clone https://github.com/griptoad26/tabmind.git
cd tabmind

# Load in browser
# chrome://extensions/ → Load unpacked → select folder
```

## Tech Stack

- **Manifest V3** Chrome Extension
- **Vanilla JS** — No heavy frameworks
- **Local Storage** — All indexing stays in browser

## License

MIT — Free to use, modify, and monetize.

---

<p align="center">
  <strong>TabMind</strong> — Find what you need, when you need it.
</p>
