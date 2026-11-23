# We Watch

We Watch is a desktop app for watching the same locally stored movie together. It uses Firebase anonymous authentication and Cloud Firestore for six digit rooms and playback state. Movie files stay on each viewer's device.

## Requirements

- Windows 10/11 or a recent Linux desktop distribution
- Node.js 20 or newer for development and packaging
- VLC media player installed separately on every computer
- A configured Firebase project (see [Firebase setup](#firebase-setup))

## Run from source

1. Install dependencies with `npm install`.
2. Configure Firebase and publish `firestore.rules` (see below).
3. Start the app with `npm run dev`.
4. Use **Start VLC** in We Watch or **Choose movie & launch** to start a managed VLC session. Choose the same movie file on each computer.
5. Create a room and share its six digit code.

## Build releases

Build the production web bundle and desktop packages with Node.js 20 or newer. Electron Builder writes packages into `release/`; generated builds are ignored by Git.

On Linux, build the AppImage with:

```sh
npm run build
npx electron-builder --linux AppImage
```

On Windows, build the NSIS installer (`.exe`) with:

```powershell
npm run build
npx electron-builder --win nsis
```

The current local release outputs are `We Watch-0.1.0.AppImage` and `We Watch Setup 0.1.0.exe`. Build each package on its target platform (or configure the required cross-build tools). Run the AppImage and installer on their target systems before distributing them. VLC and Firebase configuration are prerequisites at runtime; neither VLC nor movie files are bundled.

## Firebase setup

In Firebase Console for the configured project, enable **Authentication → Anonymous** and create a **Cloud Firestore** database. Publish the included `firestore.rules`. The Firebase web configuration in `src/firebase.js` identifies the project; it is not a server credential. The supplied rules block collection listing and writes from non-members. Joining requires an authenticated exact room-code lookup. Production deployments should add Firebase App Check and a server-side rate limit for room lookups.

## Playback and rooms

We Watch starts VLC with its HTTP control interface bound to `127.0.0.1` on a random port and a random password held by Electron's main process. It sends playback updates through Firestore. Rooms support up to six people. The host can transfer host duties, remove a member, lock the room to prevent new joins, sync all members to the host, and turn member playback controls on or off. Guests can leave without closing the room. Closing We Watch shuts down VLC processes it started.

If VLC is installed in a custom location, select its executable under **Settings → VLC player → Browse**. We Watch remembers that path on the device.

The host can enable automatic drift correction and choose a threshold from 2.5 to 15 seconds. Members can also sync with the host on demand. Everyone needs the same movie file locally; We Watch does not transfer movie files, subtitles, or VLC installations. Playback is best-effort synchronization, so network delay and VLC seek behavior can cause small offsets. The room ping measures a Firebase relay round trip rather than a direct device-to-device connection.

Room chat and quick reactions let members communicate while watching. The optional VLC overlay can show playback updates, room activity, chat messages, and reactions. In Settings, each overlay type can be enabled separately, along with the master toggle, position, and display duration. The app's event log is local to the device and retains the latest 80 entries. Recently Played keeps the latest video title and its last playback position (`HH:MM:SS`) on that device. Profile name and appearance settings are also saved locally.

Use `Ctrl` + `+` (or `Ctrl` + `=`) to zoom in and `Ctrl` + `-` to zoom out.
