# Autostart Reliability Across Platforms

Status: design reference for `tauri-plugin-autostart` integration in TabMind.

## Goal

Make "Start at login" reliable on Windows, macOS, and Linux by writing the right
autostart entry on first launch and confirming the write actually succeeded, with
explicit handling for the documented edge cases.

## Platform Matrix

| OS      | Method                                      | Persistence location                                    | Privileges      |
| ------- | ------------------------------------------- | ------------------------------------------------------- | --------------- |
| Windows | `HKCU\...\Run` registry value               | `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run\TabMind` | User-level only |
| macOS   | `LaunchAgent` plist                         | `~/Library/LaunchAgents/com.seele.tabmind.plist`         | User-level only |
| Linux   | XDG `.desktop` file                         | `~/.config/autostart/tabmind.desktop`                    | User-level only |

All three run as the *current user*. None requires elevation. That choice avoids the
SCCM / UAC pain of `HKLM\...\Run` and `LaunchDaemon` (which need admin and break
per-user sessions).

## Tauri Configuration

In `tauri.conf.json`:

```json
{
  "plugins": {
    "autostart": {
      "all": true
    }
  }
}
```

`all: true` covers every platform; on Linux it activates XDG autostart, on macOS the
LaunchAgent, on Windows the HKCU Run key. For platform-specific overrides, see the
plugin docs.

## UI Behavior

* Settings pane: single toggle "Start at login". Default OFF.
* Toggle ON -> call `tauri-plugin-autostart` `enable()`.
* Toggle OFF -> call `tauri-plugin-autostart` `disable()`.
* After each call, **re-read the registration** (`is_enabled()` + a filesystem /
  registry read) and surface a toast if the read disagrees with the user's intent.
* First-run confirmation: when the user enables autostart, show a one-line dialog:

  > "TabMind will start automatically the next time you sign in. You can change
  > this in Settings."

  This is enough to make the behavior discoverable without nagging.

## Edge Cases We Must Handle

### 1. Headless Linux (no display manager)

* XDG autostart runs only after a graphical session logs in. If the box is
  headless, there's no session, so the `.desktop` file is harmless but inert.
* **What we do**: if `/usr/bin/xdg-desktop-portal` or `loginctl show-session` shows
  no graphical session at startup, log a debug line and skip the autostart write.
  Don't fail the app.

### 2. macOS Fast User Switching

* LaunchAgents run once per user session. When the user fast-switches, the agent
  fires again. That's fine.
* **Do NOT** write a LaunchDaemon — those run as root, live in
  `/Library/LaunchDaemons/`, and don't know which user is logged in. That breaks
  per-user app data.
* Confirm the plist's `LimitLoadToSessionType` is `Aqua` (default) and not
  `Background` — `Background` is for system services and won't get a GUI session.

### 3. Windows S Mode

* S mode locks the registry to a virtualized subset; writes to `HKCU\...\Run` go
  to a per-app virtual store and **do not survive a reboot**.
* Detect: `Get-AppxPackage Microsoft.Windows.SecureAssessmentBrowser` or simply
  `reg query` returning a virtualization indicator under
  `HKCU\Software\Classes\VirtualStore`.
* **What we do**: if S mode is detected at first launch, surface a non-blocking
  banner: "Start at login is unavailable on Windows S Mode. Use Settings > Apps
  > Advanced options > Startup instead." Do not silently fail.

### 4. Windows UAC and elevated installs

* If TabMind is installed per-machine and the user is a non-admin, our HKCU write
  still succeeds (HKCU is per-user, not per-machine). Confirm we are NOT trying to
  write to `HKLM\...\Run`.

## Verification Checklist (per release)

For each OS in the matrix:

* [ ] Fresh install + reboot -> app icon visible in tray within 5s of login.
* [ ] Toggle ON -> registration file/value present and points to the installed binary.
* [ ] Toggle OFF -> registration removed.
* [ ] Reboot -> app starts only if toggle was ON.
* [ ] Toggle ON during install, then uninstall -> no orphan registration.

On Linux, also verify:

* [ ] `~/.config/autostart/tabmind.desktop` exists with `Type=Application`,
      `Exec=/opt/TabMind/tabmind`, `X-GNOME-Autostart-enabled=true`.
* [ ] On Wayland, the file is honored by GNOME's autostart path the same as X11.

## Known Limitations

* macOS LaunchAgent runs after login, but **not before the dock appears**. There
  is no supported Apple API to launch earlier without becoming a daemon. We
  accept this 1-2 second lag.
* Some kiosk Linux distros (Ubuntu Core, ChromeOS Flex) disable XDG autostart.
  In that environment we degrade silently — the toggle stays in the UI but the
  underlying write no-ops and is reflected by `is_enabled()` returning false
  with a "Not supported in this environment" reason.