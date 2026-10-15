# Installing and using Tinig Turo offline

## Install

The app must be served over **https** (or `localhost`) for the service worker,
microphone and installation to work.

- **Android (Chrome):** ⋮ menu → *Install app* / *Add to Home screen*.
- **iPhone/iPad (Safari):** Share → *Add to Home Screen*.
- **Windows / ChromeOS (Chrome or Edge):** the install icon in the address bar.

The in-app page `/install` shows the same steps and an install button when the
browser offers one.

## Before going offline

1. Open the app once while online. The app shell (≈ 940 KB) is saved by the service
   worker.
2. Optionally sign in, add readers, and (teachers) set up the class on a shared device.
3. Open **Offline downloads**:
   - Download any extra stories. Assigned stories download automatically when online.
   - If "Download language pack" appears for English, tap it to enable on-device word
     checking in that browser.
   - If the experimental engine is enabled, download the speech model (about 40 MB).
   - Tap **Ask the browser to keep this data**.
4. Check that **Sync** shows nothing waiting before leaving the network.

## What works offline

- Opening the installed app.
- Choosing a reader.
- Reading downloaded and bundled stories, in both modes. Listen mode needs a voice
  installed on the device.
- Recording.
- Word checking, only with an on-device engine.
- Word Coach and My Words with downloaded vocabulary.
- Progress and rewards (rewards show "waiting to be checked").
- Recovering an interrupted reading.

## What needs the internet

- Creating an account and the first sign-in.
- Password recovery.
- Joining a class.
- Downloading new stories, language packs or models.
- Syncing.
- Teacher screens, which work on live server data. Story drafts saved offline are
  queued and checked for conflicts when you reconnect.

## Storage

The Offline downloads screen shows space used against the browser's quota, the
number of recordings, and items waiting to sync. Removing a story download never
removes readings, recordings, saved words or unsynced work.

If the device runs out of space, the app shows a clear message:

- Starting a reading: the reading does not start.
- Saving a reading: the recording stays available to download, and the half-saved
  attempt is not committed.
- Downloading: the story is not downloaded.

Browser storage can still be removed when someone clears site data, uninstalls the
app, or (without persistent storage) the browser reclaims space. The app does not
promise permanent offline storage. Sync whenever you are online.

## Updates

A new version downloads in the background, and the app offers **Update now**.
- While a reading is being recorded, the update waits and is offered after the
  reading is saved.
- Drafts, attempts and the outbox are in IndexedDB, so updating never loses saved
  work.
