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
// already saved the code by itself, so that view only says to go back there:
// no code and no downloads, even when Dodo appended a key. The page cleans the
// address back to "?from=discord#thanks" once it has read it (the key and
// Dodo's parameters go, the from= stays), so "?from=discord" alone, as after a
// refresh, shows that same view in its ok state.
//
// A checkout started from the Subline installer returns to "?from=installer".
// The installer is still open and carries on by itself once the purchase
// lands, so that view says to go back to it, again with no code and no
// downloads. "?from=installer" alone shows it too, like "?from=discord".
//
// Returns null when this is not a return from checkout. Otherwise
// { state: "ok" | "pending" | "failed", keys: [...], fromDiscord: bool, fromInstaller: bool }.
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
    if (fromDiscord || fromInstaller) return { state: "ok", keys: [], fromDiscord: fromDiscord, fromInstaller: fromInstaller };
    return hash === "#thanks" ? { state: "ok", keys: [], fromDiscord: false, fromInstaller: false } : null;
  }

  var OK = ["succeeded", "active"];
  var FAILED = ["failed", "cancelled", "canceled", "expired", "requires_payment_method"];
  var state = OK.indexOf(status) >= 0 ? "ok" : FAILED.indexOf(status) >= 0 ? "failed" : "pending";
  if (fromDiscord || fromInstaller) return { state: state, keys: [], fromDiscord: fromDiscord, fromInstaller: fromInstaller };

  // Only key-shaped values: this text lands on the page, and a crafted link
  // should not be able to put a sentence there.
  var keys = [];
  var raw = params.get("license_key") || "";
  raw.split(",").forEach(function (k) {
    k = k.trim();
    if (/^[A-Za-z0-9_-]{4,128}$/.test(k) && keys.indexOf(k) < 0) keys.push(k);
  });
  return { state: state, keys: state === "failed" ? [] : keys, fromDiscord: false, fromInstaller: false };
}
