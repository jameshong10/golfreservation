(() => {
  const addLink = (rel, href, extra = {}) => {
    if (document.querySelector(`link[rel="${rel}"]`)) return;
    const link = document.createElement("link");
    link.rel = rel;
    link.href = href;
    Object.assign(link, extra);
    document.head.appendChild(link);
  };

  addLink("manifest", "/manifest.json");
  addLink("icon", "/icon-512.png");
  addLink("apple-touch-icon", "/icon-512.png");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("PWA service worker registration failed:", err);
      });
    });
  }
})();
