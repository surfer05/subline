// What the page should say after checkout, from the address alone. Pure: no
// DOM, no network, so the build inlines it into the page and a node test runs
// the very same text.
//
// Dodo sends the buyer back to the return URL and appends
// payment_id or subscription_id, status, and license_key when the product
// issues keys (comma separated when there are several), plus email.
// https://docs.dodopayments.com/developer-resources/checkout-session (Handle the return)
// https://docs.dodopayments.com/developer-resources/integration-guide#static-payment-links
// "#thanks" alone also shows the view, with no key.
//
// A checkout started from Discord returns to "?from=discord". Discord has
// already saved the code by itself, so that view says to go back there, with
// no downloads. The key Dodo appended is offered only as a collapsed fallback
// (fallbackKeys), in case the purchase has not switched on after a few
// minutes: a buyer must never be left with a payment and nothing to type.
//
// A checkout started from the Subline installer returns to "?from=installer".
// The installer is still open and carries on by itself once the purchase
// lands, so that view says to go back to it, again with no code and no
// downloads.
//
// Once read, the page cleans the address with cleanedReturnSearch: the key and
// Dodo's parameters go, the from= and the outcome stay ("?from=discord&result=failed#thanks",
// "?result=ok#thanks"). A refresh, back/forward or a restored tab then shows
// the same outcome, never "You're all set" after a declined card. An address
// with no result= (hand typed, or cleaned by v0.2.0) never claims success: it
// shows the pending view, which is true either way.
//
// Returns null when this is not a return from checkout. Otherwise
// { state: "ok" | "pending" | "failed", keys: [...], fromDiscord: bool, fromInstaller: bool },
// plus fallbackKeys: [...] on a Discord or installer return that carried a key.
// The email is never read.
function parseCheckoutReturn(search, hash) {
  var params;
  try { params = new URLSearchParams(search || ""); } catch (e) { params = null; }
  var status = params ? (params.get("status") || "").toLowerCase() : "";
  var from = params ? params.get("from") : null;
  var fromDiscord = from === "discord";
  var fromInstaller = from === "installer";
  var isReturn = !!params && status !== "" && !!(params.get("payment_id") || params.get("subscription_id"));
  if (!isReturn) {
    // A cleaned address: the outcome is in result=, never a key.
    var result = params ? params.get("result") : null;
    var kept = result === "ok" || result === "pending" || result === "failed" ? result : null;
    if (!kept && !fromDiscord && !fromInstaller && hash !== "#thanks") return null;
    return { state: kept || "pending", keys: [], fromDiscord: fromDiscord, fromInstaller: fromInstaller };
  }

  var OK = ["succeeded", "active"];
  var FAILED = ["failed", "cancelled", "canceled", "expired", "requires_payment_method"];
  var state = OK.indexOf(status) >= 0 ? "ok" : FAILED.indexOf(status) >= 0 ? "failed" : "pending";

  // Only key-shaped values: this text lands on the page, and a crafted link
  // should not be able to put a sentence there.
  var keys = [];
  var raw = params.get("license_key") || "";
  raw.split(",").forEach(function (k) {
    k = k.trim();
    if (/^[A-Za-z0-9_-]{4,128}$/.test(k) && keys.indexOf(k) < 0) keys.push(k);
  });
  if (state === "failed") keys = [];
  if (fromDiscord || fromInstaller) {
    var out = { state: state, keys: [], fromDiscord: fromDiscord, fromInstaller: fromInstaller };
    if (keys.length > 0) out.fallbackKeys = keys;
    return out;
  }
  return { state: state, keys: keys, fromDiscord: false, fromInstaller: false };
}

// The address the page keeps after reading a return (before "#thanks"): the
// from= and the outcome, never a key or Dodo's ids. parseCheckoutReturn reads
// it back to the same state and view.
function cleanedReturnSearch(ret) {
  var parts = [];
  if (ret.fromDiscord) parts.push("from=discord");
  else if (ret.fromInstaller) parts.push("from=installer");
  parts.push("result=" + ret.state);
  return "?" + parts.join("&");
}
