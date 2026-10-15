# Android app

Tinig Turo ships as an Android app built as a **Trusted Web Activity (TWA)**.

- Download: <https://tinigturo-green.vercel.app/download/tinigturo.apk>, or the
  in-app page **Get the app** (`/install`).
- Package `com.tinigturo.app`, version 1.0.0. Requires Android 7.0 (API 24) or newer.
- The APK is about 1 MB.

## How it works and why

The app opens the Tinig Turo site full-screen using Google Chrome's engine. It is not
a WebView wrapper, because Android's WebView has no speech recognition, which voice
following needs. Inside the TWA everything behaves exactly as in Chrome:
- offline use through the service worker;
- the microphone;
- on-device or (opt-in) online word checking;
- the update gate.

`public/.well-known/assetlinks.json` proves the app and the site belong together, so
Android opens the app without a browser address bar. It was verified with Google's
Digital Asset Links API (`"linked": true`).

**Consequences:**
- **Web changes need no new APK.** The app loads the live site, so deploying to Vercel
  updates every installed app. Rebuild only to change the app name, icon, version, or
  domain.
- **First launch needs the internet,** just like the website. After that it works
  offline.
- **Chrome must be installed** (it is on nearly all Android phones). Without a browser
  that supports TWAs, the app falls back to a Custom Tab with an address bar.
- **A different domain needs a new build** (`android/twa-manifest.json` → `host`).

## Installing (sideloading)

1. Open the download link on the phone and open `tinigturo.apk`.
2. When asked, allow the browser to *install unknown apps*, then tap **Install**.
3. Open Tinig Turo once while online.

## Building

Requirements: JDK 17 (`JAVA_HOME`) and the Android SDK with build-tools (Android
Studio's default location is detected automatically, or set `ANDROID_HOME`).

```bash
npm run android:build   # signed APK + Play bundle + assetlinks.json
npm run build           # include them in the website
npx vercel deploy --prod
```

Outputs:
- `public/download/tinigturo.apk`: signed APK, served by the site (committed).
- `android/app-release-bundle.aab`: signed bundle for Google Play (git-ignored).
- `public/.well-known/assetlinks.json`: regenerated from the signing key.

### Signing key: keep it safe

The key is **outside the repository**, in `%USERPROFILE%\.tinigturo-signing\`:
- `tinigturo-upload.jks`: PKCS12 keystore, alias `tinigturo`.
- `signing-info.txt`: the passwords.
- `tinigturo-upload.jks.bak`: the same key in the older JKS format. It can be deleted
  once you have a backup.

Back this folder up somewhere private (a password manager or private cloud drive).
**If the key is lost, the installed app can't be updated with a new APK.** Never commit
it or upload it to Vercel. On another machine, set `TINIGTURO_KEYSTORE` and
`TINIGTURO_KEYSTORE_PASSWORD` instead.

### New app version

Raise the version in both places, then rebuild:
- `android/twa-manifest.json`: `appVersionCode` and `appVersionName`;
- `android/app/build.gradle`: `versionCode` and `versionName`.

The version code must increase with every release.

The project was generated with Google's Bubblewrap (`@bubblewrap/core` 1.27), so
`npx @bubblewrap/cli update` can also regenerate it from `twa-manifest.json`.

## Publishing on Google Play (optional)

1. Create the app in the Play Console and upload `android/app-release-bundle.aab`.
2. With **Play App Signing**, Google re-signs the app with its own key. Copy Play's
   *App signing key certificate* SHA-256 from **Test and release → App integrity**.
3. Run `PLAY_APP_SIGNING_SHA256=<that fingerprint> npm run android:build`, then build
   and deploy. Asset links then list both keys, so both the sideloaded APK and the Play
   version open full-screen.
4. Choose the package name carefully before the first upload: `com.tinigturo.app`
   can't be changed later on Play.

## Not yet verified

The APK was built, signed, verified with `apksigner`, and checked with `aapt2`. Its
download and Digital Asset Links were confirmed on the live site. It has **not** been
installed on a physical phone in this environment. Check the install, first launch,
microphone permission and voice following on the target devices (`docs/TESTING.md`).
