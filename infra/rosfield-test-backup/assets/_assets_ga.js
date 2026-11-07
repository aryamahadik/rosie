/* rosfield.com: Google Analytics 4. Every page but the 404 loads this file from its <head>.
   CSP is script-src 'self' plus www.googletagmanager.com (public/_headers), so the usual inline gtag snippet lives here.
   Our own URLs (the page, and a referrer from our pages) reach Google without their query strings, bar the campaign
   (utm_*) and listing (slug) parameters: a chat message sent before chat.js has loaded ends up in the URL as ?message=,
   and the privacy page promises Google never sees what people write to Rosie. */
(() => {
  "use strict";

  const id = "G-MC47ZC6DKB";
  const clean = (href) => {
    const url = new URL(href);
    const kept = [...url.searchParams].filter(([key]) => key === "slug" || key.startsWith("utm_"));
    const query = new URLSearchParams(kept).toString();
    return url.origin + url.pathname + (query ? "?" + query : "");
  };
  const page = { page_location: clean(location.href) };
  if (document.referrer.startsWith(location.origin + "/")) page.page_referrer = clean(document.referrer);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", id, page);

  const tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.googletagmanager.com/gtag/js?id=" + id;
  document.head.append(tag);
})();
