/**
 * Extra Box configuration example
 * --------------------------------
 * 1. Duplicate this file, rename the copy to `assets/js/extra-box-config.js`,
 *    and load it from `index.html` before `assets/js/app.js`.
 * 2. Replace all placeholder values with your Firebase + Google Ads details.
 * 3. Never commit real credentials. Keep secrets in deployment environments.
 */

window.EXTRA_BOX_CONFIG = {
  /**
   * Firebase Realtime Database URL
   * -------------------------------
   * Use the "Database" tab inside the Firebase console and copy the REST
   * endpoint that ends with `.firebasedatabase.app`. Example:
   * https://your-project-id-default-rtdb.europe-west1.firebasedatabase.app
   */
  realtimeDatabaseUrl: 'https://your-project-id-default-rtdb.europe-west1.firebasedatabase.app',

  /**
   * extraBoxesPath
   * ---------------
   * The JSON path that stores the per-player box counters. Keeping it short
   * helps with security rules: e.g. `/extraBoxes` or `/prod/extraBoxes`.
   */
  extraBoxesPath: 'extraBoxes',

  /**
   * authToken (optional but recommended)
   * ------------------------------------
   * Provide either a Firebase Database Secret (legacy) or an Auth token created
   * through a Cloud Function. Example: use a Cloud Function to mint a custom
   * token that only allows writes to `/extraBoxes/{playerId}`.
   */
  authToken: 'REPLACE_WITH_DATABASE_SECRET_OR_CUSTOM_TOKEN',

  /**
   * buildKey(playerName)
   * --------------------
   * Firebase paths may not contain `.`, `#`, `$`, `[`, or `]`. The helper below
   * converts the typed name into a safe key. Adjust if you keep spaces, etc.
   */
  buildKey(playerName) {
    return playerName.trim().toLowerCase().replace(/[.#$/\[\]]/g, '_');
  },

  /**
   * loadRewardedAd({ container, playerName })
   * -----------------------------------------
   * Implement the Google Ads rewarded ad flow here. The function must return a
   * Promise that resolves only after the user watched the ad to completion.
   *
   * Example with Google Publisher Tag (GPT) rewarded ads:
   *
   *   loadRewardedAd: ({ container, playerName }) => {
   *     return new Promise((resolve, reject) => {
   *       const slot = window.googletag.defineOutOfPageSlot(
   *         '/123456789/extra_box_rewarded',
   *         window.googletag.enums.OutOfPageFormat.REWARDED,
   *       );
   *       if (!slot) {
   *         reject(new Error('Rewarded slot could not be created.'));
   *         return;
   *       }
   *       slot.addService(window.googletag.pubads());
   *
   *       window.googletag.pubads().addEventListener('rewardedSlotReady', () => {
   *         slot.show();
   *       });
   *       window.googletag.pubads().addEventListener('rewardedSlotClosed', resolve);
   *       window.googletag.enableServices();
   *       window.googletag.display(slot);
   *     });
   *   }
   *
   * For Google AdSense Auto ads, use a full-screen overlay with a manual
   * close handler and call `resolve()` once the ad fires the reward event.
   */
  async loadRewardedAd({ container, playerName }) {
    console.info('Simulating rewarded ad for', playerName);
    container.setAttribute('data-ad-state', 'loading');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    container.removeAttribute('data-ad-state');
  },
};
