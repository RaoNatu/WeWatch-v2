# WeWatch

WeWatch is a Windows/Linux desktop MVP for watching the same local movie together. It uses Firebase anonymous authentication and Cloud Firestore for six digit rooms and playback state. VLC runs locally on each device; movie files are never uploaded.

## Run it

1. Install Node.js 20 or newer and VLC media player.
2. In Firebase Console for `wewatch-v2`, enable **Authentication → Anonymous** and create a **Cloud Firestore** database.
3. Publish the included `firestore.rules` to the Firestore database.
4. Run `npm install`, then `npm run dev`.
5. Create a room, share its six digit code, and have both people choose the same movie file in WeWatch.

To package a desktop installer, run `npm run dist`. The build configuration produces an AppImage and `.deb` for Linux, and an NSIS installer for Windows. Build each operating system's installer on that operating system.

## Playback behavior

The app starts VLC with its HTTP control interface bound to `127.0.0.1` on a random port, protected by a random password held by Electron's main process. It reads playback position and sends play, pause, and seek updates through Firestore. Everyone in a room must have the same movie file available locally. Playback is best-effort synchronization; network delay and VLC seek behavior can cause a small offset.

Room members publish their current movie and timeline to their member record. Member playback controls are enabled by default for new rooms; the host can turn them off. Guests can manually seek to the host's reported position. The host's ping indicator measures a Firebase relay round trip (host → room → guest → room → host), so it includes cloud and network delay rather than measuring a direct device-to-device connection. Drift is estimated from the latest reported VLC positions.

Profile name, text/interface scale, layout spacing, and accent color are saved locally on each device.

## Firebase notes

The Firebase web configuration is included in `src/firebase.js`. These values identify the Firebase project and are not server credentials. Anonymous Authentication must be enabled. The supplied rules block collection listing and writes from non-members. Joining requires a signed-in user to look up a known room code, so exact room document reads are allowed for signed-in users; production deployments should add Firebase App Check and a server-side rate limit for room lookups.

## Current MVP limits

- Rooms support up to six members. The host can close the room for everyone; guests who leave or close WeWatch are removed while the room stays open.
- The app does not transfer movie files, subtitles, voice chat, or VLC installations.
- VLC detection can find the player executable and running process. Playback control is available after starting VLC through WeWatch, which enables the local control interface.
- Firebase must be configured in the supplied project and have the rules above deployed before room creation works.
