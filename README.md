# WeWatch

WeWatch is a desktop app for watching the same locally stored movie together. It uses Firebase anonymous authentication and Cloud Firestore for six digit rooms and playback state. Movie files stay on each viewer's device.

## Requirements

- Windows 10/11 or a recent Linux desktop distribution
- Node.js 20 or newer for development and packaging
- VLC media player installed separately on every computer
- A configured Firebase project (see [Firebase setup](#firebase-setup))

## Run from source

1. Install dependencies with `npm install`.
2. Configure Firebase and publish `firestore.rules` (see below).
3. Start the app with `npm run dev`.
4. Use **Start VLC** in WeWatch or **Choose movie & launch** to start a managed VLC session. Choose the same movie file on each computer.
5. Create a room and share its six digit code.

## Build installers

The production web bundle is built with `npm run build`. Electron Builder writes desktop packages into `release/`.

On Linux, build the AppImage with:

```sh
npx electron-builder --linux AppImage
```

On Windows, build the NSIS installer (`.exe`) with:

```powershell
npx electron-builder --win nsis
```

The Linux AppImage can be built on Linux. For the Windows installer, use a Windows build machine. Run the resulting installer and AppImage on their target systems before distributing them. VLC and Firebase configuration are prerequisites at runtime; neither VLC nor movie files are bundled.

## Firebase setup

In Firebase Console for the configured project, enable **Authentication → Anonymous** and create a **Cloud Firestore** database. Publish the included `firestore.rules`. The Firebase web configuration in `src/firebase.js` identifies the project; it is not a server credential. The supplied rules block collection listing and writes from non-members. Joining requires an authenticated exact room-code lookup. Production deployments should add Firebase App Check and a server-side rate limit for room lookups.

## Playback and rooms

WeWatch starts VLC with its HTTP control interface bound to `127.0.0.1` on a random port and a random password held by Electron's main process. It sends play, pause, and seek updates through Firestore. Rooms support up to six people. The host can close a room; guests can leave without closing it. Member playback controls are enabled by default for new rooms and can be turned off by the host.

Everyone needs the same movie file locally. WeWatch does not transfer movie files, subtitles, or VLC installations. Playback is best-effort synchronization; network delay and VLC seek behavior can cause small offsets. The room ping measures a Firebase relay round trip rather than a direct device-to-device connection.

The optional VLC overlay shows playback and room events. Its position, duration, and enabled state are configurable in Settings. The app's event log is local to the device and retains the latest 80 entries. Profile name and appearance settings are also saved locally.
