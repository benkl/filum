// Filum website: small progressive enhancements. Everything works without it.

// Header border once the page scrolls
const nav = document.querySelector(".nav");
const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Reveal blocks as they come into view
const revealables = document.querySelectorAll(".section-head, .views-figure, .feature, .format-grid > div, .roots, .dl-card");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  revealables.forEach((el) => {
    el.classList.add("reveal");
    io.observe(el);
  });
}

// Digitizer output: Shapes / Cross stitch
const tabs = [...document.querySelectorAll('.toggle [role="tab"]')];
const select = (tab) => {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
};
tabs.forEach((tab, i) => {
  tab.tabIndex = i === 0 ? 0 : -1;
  tab.addEventListener("click", () => select(tab));
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    select(next);
    next.focus();
  });
});
// preload the other picture so the switch is instant
addEventListener("load", () => {
  const img = new Image();
  img.src = "img/digitize-cross.webp";
});

// Copy the build commands
for (const btn of document.querySelectorAll(".copy")) {
  btn.addEventListener("click", async () => {
    const text = btn.parentElement.querySelector("code").textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select and copy";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1800);
  });
}

// Point the download buttons at the newest release (the HTML links v0.1.0 as a fallback)
(async () => {
  const KEY = "filum-latest-release";
  let rel;
  try {
    rel = JSON.parse(sessionStorage.getItem(KEY) || "null");
  } catch {}
  if (!rel) {
    try {
      const r = await fetch("https://api.github.com/repos/benkl/filum/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
      if (!r.ok) return;
      const j = await r.json();
      const asset = (re) => j.assets.find((a) => re.test(a.name))?.browser_download_url;
      rel = { tag: j.tag_name, page: j.html_url, exe: asset(/-setup\.exe$/i), msi: asset(/\.msi$/i) };
      sessionStorage.setItem(KEY, JSON.stringify(rel));
    } catch {
      return;
    }
  }
  const version = rel.tag.replace(/^v/, "");
  for (const el of document.querySelectorAll("[data-version]")) {
    el.textContent = el.textContent.startsWith("v") ? `v${version}` : version;
  }
  for (const a of document.querySelectorAll("[data-dl]")) {
    const href = rel[a.dataset.dl];
    if (href) a.href = href;
  }
})();
