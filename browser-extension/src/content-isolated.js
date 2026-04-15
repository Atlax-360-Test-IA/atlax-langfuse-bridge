/**
 * content-isolated.js — ISOLATED world
 *
 * Bridge between MAIN world CustomEvents and the background service worker.
 * The MAIN world cannot call chrome.runtime directly; this script can.
 */
(function () {
  "use strict";

  // Cache email in case the turn event fires before the user event
  let cachedEmail = "unknown";

  window.addEventListener("__atlax_user__", (e) => {
    cachedEmail = e.detail.email;
    chrome.runtime.sendMessage({ type: "USER_INFO", email: cachedEmail });
  });

  window.addEventListener("__atlax_turn__", (e) => {
    chrome.runtime.sendMessage({
      type: "CONVERSATION_TURN",
      userEmail: cachedEmail,
      ...e.detail,
    });
  });
})();
