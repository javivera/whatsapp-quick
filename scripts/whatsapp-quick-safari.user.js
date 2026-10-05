// ==UserScript==
// @name         WhatsApp links → WhatsApp Quick
// @namespace    com.javivera.whatsappquick
// @version      1.0
// @description  Open supported wa.me and api.whatsapp.com links in WhatsApp Quick.
// @match        https://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  function quickURL(value) {
    let url;
    try { url = new URL(value, location.href); } catch (_) { return null; }
    if (url.protocol !== "https:") return null;
    let phone = null;
    if (url.hostname === "wa.me" && /^\/[1-9][0-9]{5,14}\/?$/.test(url.pathname)) {
      phone = url.pathname.replace(/\//g, "");
    } else if (url.hostname === "api.whatsapp.com" && url.pathname === "/send") {
      phone = url.searchParams.get("phone");
    }
    if (!phone || !/^[1-9][0-9]{5,14}$/.test(phone)) return null;
    const destination = new URL("whatsapp-quick://send");
    destination.searchParams.set("phone", phone);
    const text = url.searchParams.get("text");
    if (text && text.length <= 10000) destination.searchParams.set("text", text);
    return destination.href;
  }

  // Capture real clicks before the site navigates to WhatsApp. Ignore modified
  // clicks, downloads, and other gestures so Safari's normal behavior remains.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;
    const anchor = event.target.closest && event.target.closest("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    const destination = quickURL(anchor.href);
    if (!destination) return;
    event.preventDefault();
    location.assign(destination);
  }, true);

  // Direct navigation (address bar / bookmarks) has no anchor to intercept.
  // Leave an explicit button if Safari blocks automatic custom-scheme opens.
  const destination = quickURL(location.href);
  if (destination) {
    const addFallback = () => {
      const link = document.createElement("a");
      link.href = destination;
      link.textContent = "Open in WhatsApp Quick";
      link.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;padding:12px 18px;background:#176b52;color:white;border-radius:8px;font:16px system-ui;text-decoration:none";
      document.body.append(link);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addFallback, { once: true });
    else addFallback();
    location.assign(destination);
  }
})();
