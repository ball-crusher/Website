# Extra Box Feature Setup Guide

This document explains the overall concept of the new **Extra Box** panel and
guides you through the Firebase + Google Ads configuration that you need to
complete before going live.

## Concept overview

1. Visitors can scroll to the **Extra Box** panel at the bottom of the page.
2. They enter their player name (with suggestions taken from the daily stats
   JSON) and press **“Get an extra box”**.
3. The site reads the player's current totals from a Firebase Firestore
   collection named `extraBoxes`.
4. The interface displays both the cumulative number of boxes and the number of
   boxes earned for the latest competition day (determined from
   `data/day_stats.json`).
5. The **Request box** button becomes available. When pressed, the site asks the
   visitor to watch a rewarded Google Ad.
6. After the ad finishes, Firestore increments the player's counters and the
   page reloads so that fresh banner ads are fetched automatically.

## Firebase configuration

### 1. Create a Firestore database

* Create a Firebase project (or reuse an existing project).
* Enable **Firestore** in production mode.
* Under **Firestore Database → Data**, create a collection named
  `extraBoxes` (you can change the collection name by editing
  `window.EXTRA_BOX_CONFIG.firestoreCollection`).

### 2. Document structure

Each document inside the collection should use the player's slugified name as
its ID (the app automatically lowercases the name and removes special
characters). The document schema looks like this:

```json
{
  "name": "vermixo",
  "totalBoxes": 12,
  "daily": {
    "13": 1,
    "12": 2
  },
  "createdAt": <server timestamp>,
  "updatedAt": <server timestamp>
}
```

* `totalBoxes` — running total for that player.
* `daily` — object keyed by day number. Each value tracks how many extra boxes
  were granted on that day.
* `createdAt`/`updatedAt` — maintained automatically by the code via
  `serverTimestamp()`.

The application will create or update documents for you; you do **not** need to
pre-populate data manually.

### 3. Firestore security rules

Allow only authenticated updates in production. For local testing you can use a
relaxed rule, but remember to lock it down before launch. A minimum viable rule
set for authenticated users could look like:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /extraBoxes/{playerId} {
      allow read: if true; // Everyone may read counts.
      allow write: if request.auth != null; // Require authentication for writes.
    }
  }
}
```

Adjust the `allow write` clause to fit your app's authentication story.

### 4. Add the Firebase web SDK keys

In `index.html` you will find the configuration blueprint:

```html
<script>
  window.EXTRA_BOX_CONFIG = {
    firebaseConfig: {
      apiKey: 'YOUR_FIREBASE_API_KEY',
      authDomain: 'YOUR_FIREBASE_AUTH_DOMAIN',
      projectId: 'YOUR_FIREBASE_PROJECT_ID',
      storageBucket: 'YOUR_FIREBASE_STORAGE_BUCKET',
      messagingSenderId: 'YOUR_FIREBASE_MESSAGING_SENDER_ID',
      appId: 'YOUR_FIREBASE_APP_ID',
    },
    // …
  };
</script>
```

Replace each placeholder with your real Firebase project values. The JavaScript
verifies that the placeholders were updated before enabling the feature.

## Google Ads integration

### 1. Banner ads

* Create two banner units (for example in Google AdSense or Google Ad Manager).
* Insert their unit IDs into `window.EXTRA_BOX_CONFIG.googleAds.bannerUnitIds`:

```js
bannerUnitIds: [
  'ca-pub-1234567890123456/EXTRA_BOX_TOP',
  'ca-pub-1234567890123456/EXTRA_BOX_BOTTOM'
],
```

* Replace the placeholder `<div class="extra-box__banner-placeholder">…</div>`
  inside each banner container with the `<ins class="adsbygoogle">` snippet
  supplied by Google. The layout wrapper already exists, so you only need to
  drop in the snippet and ensure `adsbygoogle.push({});` runs.
* Provide your publisher ID via `googleAds.publisherId`. The script loads the
  official Google Ads library automatically when a publisher ID is present.

### 2. Rewarded ad

* Create a **rewarded** ad unit and set its ID in
  `googleAds.rewardedUnitId`.
* Implement a custom loader by defining `window.extraBoxShowRewardedAd`. The
  helper receives the ad unit ID and a container element where you can render
  Google's rewarded ad UI. Return `false` if the ad was closed before
  completion, otherwise return `true` (or an object with `{ completed: true }`).

Example skeleton:

```html
<script>
  window.extraBoxShowRewardedAd = async ({ unitId, container }) => {
    // TODO: Initialize Google Publisher Tag or another rewarded ads SDK here.
    // Mount the ad inside `container` and wait for it to finish.
    await loadRewardedAd(unitId, container);
    return { completed: true };
  };
</script>
```

Until you provide this function, the site simulates a rewarded ad with a short
3.5 second delay so you can test the Firebase flow without third-party
dependencies.

### 3. Auto-reloading after rewards

After a rewarded ad completes and Firestore updates successfully, the page
reloads. This ensures both banner slots fetch a fresh ad, as requested.

## Troubleshooting checklist

* **No Firebase data appears** — double-check that all Firebase keys are filled
  in and that the Firestore rules allow reads.
* **Writes fail** — inspect the browser console for detailed errors. Most
  issues stem from missing authentication in the security rules or from not
  enabling Firestore in the Firebase console.
* **Ads do not show** — confirm that the `publisherId` and ad unit IDs do not
  contain placeholder fragments such as `XXXXXXXXXXXXXXXX`. Replace the
  placeholder `<div>` with the official `<ins>` block from Google.
* **Rewarded ad does nothing** — make sure you implemented
  `window.extraBoxShowRewardedAd`. Without it, the simulation runs but no real
  monetisation occurs.

With these steps completed the Extra Box panel will be fully operational and
ready for production traffic.
