(() => {
  "use strict";

  function shouldIgnoreClick(event, link) {
    return (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      link.target === "_blank"
    );
  }

  function initHomePage() {
    const page = document.querySelector(".home-page");

    if (!page) {
      return;
    }

    page.classList.add("is-ready");

    const loadingLinks = page.querySelectorAll("[data-loading-link]");

    loadingLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        if (shouldIgnoreClick(event, link)) {
          return;
        }

        link.classList.add("is-loading");
        link.setAttribute("aria-busy", "true");
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHomePage, { once: true });
    return;
  }

  initHomePage();
})();
