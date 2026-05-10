// DOM-side ecosystem banner. Sits above the Pixi canvas and links back to
// https://icfred.co.uk/projects so users have an obvious way home. Matches the
// SiteBanner on icfred.co.uk so the chrome reads as the same site wrapping the
// project. Click navigation only — Durak owns arrow keys / Enter / Esc.
//
// This is the only DOM component in @durak/ui (everything else is Pixi). Kept
// in dom/ to make the boundary obvious.

const STYLE_ID = "icfred-banner-style";
const FONT_ID = "icfred-banner-font";
const FONT_HREF = "https://fonts.googleapis.com/css2?family=VT323&display=swap";

const CSS = `
.icfred-banner {
  all: initial;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  box-sizing: border-box;
  width: 100%;
  height: 2.25rem;
  padding: 0 0.85rem;
  background: #0c0700;
  color: #ffb641;
  border-bottom: 1px solid #c8862b;
  font-family: 'VT323', 'Share Tech Mono', ui-monospace, monospace;
  font-size: 1.1rem;
  letter-spacing: 0.08em;
  position: relative;
  z-index: 2147483000;
  flex-shrink: 0;
}
.icfred-banner :where(a) {
  color: inherit;
  text-decoration: none;
  text-shadow: 0 0 4px rgba(255, 182, 65, 0.55);
}
.icfred-banner :where(a):hover {
  background: #ffb641;
  color: #0c0700;
  text-shadow: none;
}
.icfred-banner .brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.15rem 0.5rem;
  border-radius: 2px;
}
.icfred-banner .crumb {
  color: #c8862b;
  display: inline-flex;
  gap: 0.5rem;
}
.icfred-banner .crumb-text {
  color: #ffb641;
  text-shadow: 0 0 4px rgba(255, 182, 65, 0.55);
}
.icfred-banner .back-text {
  padding: 0.15rem 0.5rem;
  color: #c8862b;
  font-size: 1rem;
}
.icfred-banner .spacer {
  flex: 1;
}
@media (max-width: 540px) {
  .icfred-banner .back-text { display: none; }
  .icfred-banner { font-size: 1rem; letter-spacing: 0.06em; }
}
`;

const HOME_URL = "https://icfred.co.uk/projects";

export interface SiteBannerOptions {
  crumb: string;
  parent?: HTMLElement;
}

export interface SiteBannerHandle {
  element: HTMLElement;
  destroy: () => void;
}

function ensureFont(): void {
  if (document.getElementById(FONT_ID)) return;
  const preconnect1 = document.createElement("link");
  preconnect1.rel = "preconnect";
  preconnect1.href = "https://fonts.googleapis.com";
  document.head.appendChild(preconnect1);
  const preconnect2 = document.createElement("link");
  preconnect2.rel = "preconnect";
  preconnect2.href = "https://fonts.gstatic.com";
  preconnect2.crossOrigin = "anonymous";
  document.head.appendChild(preconnect2);
  const link = document.createElement("link");
  link.id = FONT_ID;
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function mountSiteBanner(options: SiteBannerOptions): SiteBannerHandle {
  ensureFont();
  ensureStyle();

  const header = document.createElement("header");
  header.className = "icfred-banner";
  header.setAttribute("role", "banner");

  const brand = document.createElement("a");
  brand.href = HOME_URL;
  brand.className = "brand";
  brand.setAttribute("aria-label", "Back to icfred.co.uk");
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "←";
  const brandText = document.createElement("span");
  brandText.textContent = "ICFRED.CO.UK";
  brand.append(arrow, brandText);

  const crumb = document.createElement("span");
  crumb.className = "crumb";
  const slash = document.createElement("span");
  slash.setAttribute("aria-hidden", "true");
  slash.style.opacity = "0.7";
  slash.textContent = "/";
  const crumbText = document.createElement("span");
  crumbText.className = "crumb-text";
  crumbText.textContent = options.crumb;
  crumb.append(slash, crumbText);

  const spacer = document.createElement("span");
  spacer.className = "spacer";

  const back = document.createElement("a");
  back.href = HOME_URL;
  back.className = "back-text";
  back.textContent = "[ ← BACK ]";

  header.append(brand, crumb, spacer, back);

  const parent = options.parent ?? document.body;
  parent.insertBefore(header, parent.firstChild);

  return {
    element: header,
    destroy: () => header.remove(),
  };
}
