const page = document.querySelector(".home-page");

function initHomePage() {
  if (!page) {
    return;
  }

  page.classList.add("is-ready");
}

initHomePage();
