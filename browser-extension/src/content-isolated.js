/**
 * content-isolated.js — ISOLATED world
 *
 * Bridge between MAIN world CustomEvents and the background service worker.
 * The MAIN world cannot call chrome.runtime directly; this script can.
 */
import { validateUser, validateTurn } from "./validators.js";

(function () {
  "use strict";

  // Cache email in case the turn event fires before the user event
  let cachedEmail = "unknown";

  window.addEventListener("__atlax_user__", (e) => {
    const validated = validateUser(e.detail);
    if (!validated) return;
    cachedEmail = validated.email;
    chrome.runtime.sendMessage({ type: "USER_INFO", email: cachedEmail });
  });

  window.addEventListener("__atlax_turn__", (e) => {
    const validated = validateTurn(e.detail);
    if (!validated) return;
    chrome.runtime.sendMessage({
      type: "CONVERSATION_TURN",
      userEmail: cachedEmail,
      ...validated,
    });
  });
})();
