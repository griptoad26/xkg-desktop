# Installation Guide

## Desktop

### Linux

**Debian/Ubuntu (apt):**
```bash
sudo dpkg -i XKG-Desktop_0.1.0_amd64.deb
sudo apt-get install -f   # resolve dependencies if needed
xkg-desktop               # launch
```

**Fedora/RHEL/CentOS (rpm):**
```bash
sudo dnf install ./XKG-Desktop-0.1.0-1.x86_64.rpm
xkg-desktop
```

**Universal AppImage (no install):**
```bash
chmod +x XKG-Desktop_0.1.0_amd64.AppImage
./XKG-Desktop_0.1.0_amd64.AppImage
```

### Windows

**Interactive installer (recommended):**
- Download `XKG-Desktop_0.1.0_x64-setup.exe`
- Double-click → follow wizard
- Adds Start Menu entry, registers as autostart app

**Silent install (enterprise):**
```powershell
XKG-Desktop_0.1.0_x64-setup.exe /S
```

**MSI (for GPO / Intune):**
```powershell
msiexec /i XKG-Desktop_0.1.0_x64_en-US.msi /qn
```

### macOS

- Download `XKG-Desktop_0.1.0_x64.dmg` (Intel) or `XKG-Desktop_0.1.0_aarch64.dmg` (Apple Silicon)
- Open the DMG → drag `XKG Desktop.app` to `/Applications`
- Launch from Applications or Spotlight

**Gatekeeper warning?** Right-click → Open → confirm.

## Mobile

### Android
- Download `app-release.apk` (or `xkg-mobile.apk`)
- Enable "Install from unknown sources" for your browser
- Open the APK → Install
- Open "XKG Mobile" from app drawer

### Linux/Windows (Flutter bundles)
- Linux: `tar xzf xkg-linux-bundle.tar.gz && ./xkg_mobile`
- Windows: Extract ZIP and run `xkg_mobile.exe`

## Setting up Sync

1. **Run cluster-hub** on a server that's always reachable (your desktop, a NAS, a VPS)
2. **Configure XKG Desktop** settings → set Hub URL
3. **Configure XKG Mobile** settings → set `xkgEndpoint` and `openclawEndpoint`
4. **Capture!** Press `Ctrl+Shift+X` on desktop, check mobile to see it appear

## Verifying Install

After install, run:
```bash
xkg-desktop --version      # shows 0.1.0
```
