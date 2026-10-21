/*
 * Deck Card: any Home Assistant cards as a swipeable deck, with a looping strip of thumbnails and page dots.
 * Large slides on top (any cards), named thumbnails underneath; the active thumbnail is highlighted, tapping one
 * goes there, swiping the slides moves the highlight, and the ends wrap round (loop). Coverflow shows the
 * neighbouring cards peeking out behind the current one, so it is obvious there is more to swipe to.
 * Built on the browser's own scroll snapping: no library, nothing to download, works offline.
 * https://github.com/githubfreddieve/deck-card (MIT)
 *
 *   type: custom:deck-card
 *   effect: coverflow               # slide (default): one card fills the width
 *                                   # coverflow: the neighbours peek out behind the current card, smaller and
 *                                   #   dimmed; tapping one brings it forward
 *   loop: true                      # default true
 *   thumbs: true                    # default true: the strip of named thumbnails
 *   dots: true                      # default true: page dots under the thumbnails
 *   max_width: 480                  # default 480: the widest a slide gets, in px (0 = no limit)
 *   height: tallest                 # tallest (default): the deck keeps the height of its tallest slide, so the
 *                                   #   thumbnails never move; current: it follows the slide in the middle
 *   slides:
 *     - name: Living room           # thumbnail label
 *       icon: mdi:sofa              # thumbnail icon
 *       entity: climate.living      # optional: its state shows under the label
 *       card: { type: ..., ... }    # the slide: any card, e.g. a vertical-stack
 *       tap_action: { ... }         # optional: a normal HA action when the slide itself is tapped
 */
const VERSION = "0.1.0";
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

class DeckCard extends HTMLElement {
  setConfig(config) {
    if (!Array.isArray(config.slides) || config.slides.length < 2 || config.slides.some((s) => !s.card)) {
      throw new Error("deck-card: give at least two slides, each with a card");
    }
    if (config.effect && !["slide", "coverflow"].includes(config.effect)) {
      throw new Error("deck-card: effect is slide or coverflow");
    }
    this._config = { loop: true, dots: true, thumbs: true, effect: "slide", height: "tallest", max_width: 480, ...config };
    this._built = false;
    this._active = 0;
    if (this._hass) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    else {
      (this._cards || []).forEach((c) => (c.hass = hass));
      this._renderThumbs();
    }
  }

  getCardSize() { return 6; }
  getGridOptions() { return { columns: "full", rows: "auto" }; }

  // Visual editor: a tab per slide, the thumbnail's fields apart from the slide's card, and the
  // card in HA's own card editor, the way vertical-stack and layout-card work.
  static async getConfigElement() {
    await loadHaCardEditors();
    return document.createElement("deck-card-editor");
  }

  static getStubConfig() {
    return { effect: "coverflow", loop: true, slides: [
      { name: "First", icon: "mdi:numeric-1-circle", card: { type: "markdown", content: "First slide" } },
      { name: "Second", icon: "mdi:numeric-2-circle", card: { type: "markdown", content: "Second slide" } },
    ] };
  }

  async _build() {
    if (this._building || !this._config) return;
    this._building = true;
    const helpers = await window.loadCardHelpers();
    const slides = this._config.slides;
    const n = slides.length;
    const cover = this._config.effect === "coverflow";
    // Loop: copies of the last slides before the first and of the first after the last; landing on a copy jumps
    // silently to the real one. Coverflow shows a neighbour on each side, so it needs two copies per end.
    const pad = this._config.loop ? Math.min(cover ? 2 : 1, n) : 0;
    const order = [...Array(pad).keys()].map((k) => n - pad + k).concat([...slides.keys()], [...Array(pad).keys()]);
    this._pad = pad;

    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; }
        .track { position: relative; /* slides measure their offsetLeft from the track, not the page */ display: flex; align-items: flex-start; overflow-x: auto; overflow-y: hidden; transition: height .25s ease; scroll-snap-type: x mandatory; scrollbar-width: none;
                 overscroll-behavior-x: contain; border-radius: var(--ha-card-border-radius, 12px); }
        .track::-webkit-scrollbar { display: none; }
        .slide { flex: 0 0 100%; scroll-snap-align: center; scroll-snap-stop: always; box-sizing: border-box; }
        /* --w is the slide width: the whole width (slide) or 78% (coverflow), never more than max_width.
           Slide mode: the whole carousel is --w wide, centred. Coverflow: the track keeps the full width so the
           neighbours show, each card is --w and overlaps its neighbours by a tenth of --w; a wide screen simply
           shows more of them. Scale, dimming and stacking follow the scroll position (see _paint). */
        .wrap:not(.cover) { max-width: var(--w); margin: 0 auto; }
        .cover .thumbs, .cover .dots { max-width: calc(var(--w) / 0.78); margin-left: auto; margin-right: auto; }  /* full width on a phone, capped on a wide screen */
        .cover .track { border-radius: 0; padding: 6px 0 10px;
                        mask-image: linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent);
                        -webkit-mask-image: linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent); }
        .cover .slide { flex-basis: var(--w); margin: 0 calc(var(--w) * -0.05); position: relative; transform-origin: center center;
                        will-change: transform, opacity; }
        .cover .slide:first-child { margin-left: calc((100% - var(--w)) / 2); }
        .cover .slide:last-child { margin-right: calc((100% - var(--w)) / 2); }
        .cover .slide.current { box-shadow: 0 6px 20px rgba(0, 0, 0, .35); border-radius: var(--ha-card-border-radius, 12px); }
        .cover .slide:not(.current) > * { pointer-events: none; }
        .cover .slide:not(.current), .slide.tappable { cursor: pointer; }
        .thumbs { display: flex; gap: 8px; margin-top: 8px; overflow-x: auto; scrollbar-width: none; padding: 2px; }
        .thumbs[hidden] { display: none; }
        .thumbs::-webkit-scrollbar { display: none; }
        .thumbs button { flex: 1 1 0; min-width: 76px; min-height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 8px 6px;
                 border: 1px solid var(--divider-color); border-radius: 12px; cursor: pointer; text-align: center;
                 background: var(--card-background-color); color: var(--secondary-text-color); font: inherit;
                 transition: background-color .2s, color .2s, border-color .2s; }
        .thumbs button[aria-pressed="true"] { border-color: var(--primary-color); color: var(--primary-text-color);
                 background: color-mix(in srgb, var(--primary-color) 14%, var(--card-background-color)); }
        button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        ha-icon { --mdc-icon-size: 20px; flex: none; }
        .thumbs button[aria-pressed="true"] ha-icon { color: var(--primary-color); }
        .label { display: flex; flex-direction: column; align-items: center; min-width: 0; max-width: 100%; line-height: 1.2; }
        .name { font-size: 13px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
        .state { font-size: 11px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .dots { display: flex; justify-content: center; gap: 2px; margin-top: 4px; }
        .dots[hidden] { display: none; }
        .dot { flex: none; width: 24px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer;
               display: grid; place-items: center; border-radius: 12px; }
        .dot::after { content: ""; width: 7px; height: 7px; border-radius: 4px; background: var(--secondary-text-color);
                      opacity: .45; transition: width .2s, opacity .2s, background-color .2s; }
        .dot[aria-current="true"]::after { width: 18px; opacity: 1; background: var(--primary-color); }
        @media (prefers-reduced-motion: reduce) { .track, .thumbs button, .dot::after { transition: none; } }
      </style>
      <div class="wrap ${cover ? "cover" : ""}" style="--w: ${this._width(cover)}">
        <div class="track" role="region" aria-roledescription="carousel"></div>
        <div class="thumbs" role="group" aria-label="Choose a slide"></div>
        <div class="dots" role="group" aria-label="Slide position"></div>
      </div>`;
    const track = root.querySelector(".track");
    this._cards = [];
    this._slides = [];
    order.forEach((i, pos) => {
      const slide = document.createElement("div");
      slide.className = "slide";
      slide.setAttribute("aria-label", slides[i].name || `Slide ${i + 1}`);
      const card = helpers.createCardElement(slides[i].card);
      card.hass = this._hass;
      this._cards.push(card);
      slide.appendChild(card);
      // Coverflow: a tap on a card that isn't the current one brings it forward instead of acting on it.
      const tap = slides[i].tap_action;
      if (tap) slide.classList.add("tappable");
      slide.addEventListener("click", (e) => {
        if (cover && !slide.classList.contains("current")) {
          e.stopPropagation();
          e.preventDefault();
          this._goPos(pos, true);
        } else if (tap) {
          // Through HA's own action handling, so every action type works (more-info, navigate, fire-dom-event…).
          e.stopPropagation();
          this.dispatchEvent(new CustomEvent("hass-action", { bubbles: true, composed: true,
                                                               detail: { config: { tap_action: tap }, action: "tap" } }));
        }
      }, true);
      track.appendChild(slide);
      this._slides.push(slide);
    });
    this._track = track;
    this._cover = cover;

    this._thumbs = root.querySelector(".thumbs");
    this._thumbs.hidden = !this._config.thumbs;
    this._thumbs.innerHTML = slides.map((s, i) => `
      <button type="button" data-i="${i}" aria-pressed="false">
        ${s.icon ? `<ha-icon icon="${s.icon}"></ha-icon>` : ""}
        <span class="label"><span class="name"></span><span class="state"></span></span>
      </button>`).join("");
    this._thumbs.querySelectorAll("button").forEach((b, i) => {
      b.querySelector(".name").textContent = slides[i].name || `Slide ${i + 1}`;
      b.addEventListener("click", () => this._go(i, true));
    });
    this._dots = root.querySelector(".dots");
    this._dots.hidden = !this._config.dots;
    slides.forEach((s, i) => {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "dot";
      d.setAttribute("aria-label", s.name || `Slide ${i + 1}`);
      d.addEventListener("click", () => this._go(i, true));
      this._dots.appendChild(d);
    });

    let timer;
    let frame;
    track.addEventListener("scroll", () => {
      if (cover && !frame) frame = requestAnimationFrame(() => { frame = null; this._paint(); });
      clearTimeout(timer);
      timer = setTimeout(() => this._settle(), 120);
    }, { passive: true });
    new ResizeObserver(() => this._go(this._active, false)).observe(track);
    // Track height: the tallest slide (default, nothing moves) or the slide in the middle (height: current).
    // Cards render after they're created, so their sizes are watched too.
    const fit = new ResizeObserver(() => this._fit());
    this._slides.forEach((sl) => fit.observe(sl));
    this._built = true;
    this._building = false;
    requestAnimationFrame(() => this._go(0, false));
    this._renderThumbs();
  }

  _width(cover) {
    const share = cover ? "78%" : "100%";
    const max = Number(this._config.max_width);
    return max > 0 ? `min(${share}, ${max}px)` : share;
  }

  // Scroll so that track position `pos` (counting the loop copies) is centred.
  _goPos(pos, smooth) {
    const s = this._slides[pos];
    if (!s) return;
    const left = s.offsetLeft - (this._track.clientWidth - s.offsetWidth) / 2;
    this._track.scrollTo({ left, behavior: smooth && !reduceMotion() ? "smooth" : "auto" });
    if (this._cover) this._paint();
    if (!smooth) { this._setActive(this._real(pos)); this._fit(); }
  }

  _go(i, smooth) {
    if (!this._track) return;
    this._goPos(i + this._pad, smooth);
    this._setActive(i);
  }

  _real(pos) {
    const n = this._config.slides.length;
    return (((pos - this._pad) % n) + n) % n;
  }

  // The track position nearest the middle of the view.
  _nearest() {
    const mid = this._track.scrollLeft + this._track.clientWidth / 2;
    let best = 0;
    let dist = Infinity;
    this._slides.forEach((s, pos) => {
      const d = Math.abs(s.offsetLeft + s.offsetWidth / 2 - mid);
      if (d < dist) { dist = d; best = pos; }
    });
    return best;
  }

  _fit() {
    if (!this._slides?.length) return;
    const h = this._config.height === "current"
      ? this._slides[this._nearest()].offsetHeight
      : Math.max(...this._slides.map((s) => s.offsetHeight));
    this._track.style.height = `${h}px`;   // content height; the track's own padding comes on top
  }

  _settle() {
    if (!this._track.clientWidth) return;
    this._fit();
    const n = this._config.slides.length;
    const pos = this._nearest();
    if (pos < this._pad || pos >= this._pad + n) return this._go(this._real(pos), false);   // on a loop copy
    this._setActive(pos - this._pad);
  }

  // Coverflow look, from the scroll position: the card in the middle full size and on top, the others smaller,
  // dimmer and further back the further they are from it.
  _paint() {
    const mid = this._track.scrollLeft + this._track.clientWidth / 2;
    let current = null;
    let closest = Infinity;
    this._slides.forEach((s) => {
      const d = (s.offsetLeft + s.offsetWidth / 2 - mid) / s.offsetWidth;
      const a = Math.min(Math.abs(d), 1.5);
      s.style.transform = `scale(${1 - a * 0.14})`;
      s.style.opacity = String(1 - Math.min(a, 1) * 0.3);
      s.style.zIndex = String(100 - Math.round(a * 20));
      if (Math.abs(d) < closest) { closest = Math.abs(d); current = s; }
    });
    this._slides.forEach((s) => s.classList.toggle("current", s === current));
  }

  _setActive(i) {
    this._active = i;
    this._thumbs.querySelectorAll("button").forEach((b, j) => b.setAttribute("aria-pressed", String(j === i)));
    this._dots?.querySelectorAll(".dot").forEach((d, j) => d.setAttribute("aria-current", String(j === i)));
    const b = this._thumbs.children[i];
    if (b && !this._thumbs.hidden) this._thumbs.scrollTo({ left: b.offsetLeft - (this._thumbs.clientWidth - b.clientWidth) / 2,
                                                          behavior: reduceMotion() ? "auto" : "smooth" });
  }

  _renderThumbs() {
    if (!this._thumbs || !this._hass) return;
    this._config.slides.forEach((s, i) => {
      const el = this._thumbs.children[i]?.querySelector(".state");
      const st = s.entity && this._hass.states[s.entity];
      if (el) el.textContent = st ? this._hass.formatEntityState?.(st) ?? st.state : "";
    });
  }
}

if (!customElements.get("deck-card")) customElements.define("deck-card", DeckCard);

// ── Visual editor ────────────────────────────────────────────────────────────────────────────────────────────
// HA's card editor (hui-card-element-editor) and card picker are loaded on demand by its stack-card editor;
// asking a vertical-stack for its editor is the usual way for a custom card to get them.
async function loadHaCardEditors() {
  if (customElements.get("hui-card-element-editor") && customElements.get("hui-card-picker")) return;
  const helpers = await window.loadCardHelpers();
  const stack = await helpers.createCardElement({ type: "vertical-stack", cards: [] });
  await stack.constructor.getConfigElement();
}

const GENERAL_SCHEMA = [
  { name: "effect", selector: { select: { mode: "dropdown", options: [
    { value: "coverflow", label: "Coverflow (neighbours visible behind)" }, { value: "slide", label: "Slide (one card fills the width)" }] } } },
  { name: "max_width", selector: { number: { min: 0, max: 1600, step: 10, mode: "box", unit_of_measurement: "px" } } },
  { name: "height", selector: { select: { mode: "dropdown", options: [
    { value: "tallest", label: "Fixed: tallest slide (thumbnails never move)" }, { value: "current", label: "Follow the current slide" }] } } },
  { type: "grid", name: "", schema: [
    { name: "loop", selector: { boolean: {} } }, { name: "thumbs", selector: { boolean: {} } }, { name: "dots", selector: { boolean: {} } }] },
];
const THUMB_SCHEMA = [
  { type: "grid", name: "", schema: [{ name: "name", selector: { text: {} } }, { name: "icon", selector: { icon: {} } }] },
  { name: "entity", selector: { entity: {} } },
  { name: "tap_action", selector: { ui_action: {} } },
];
const LABELS = { effect: "Effect", max_width: "Largest slide width (0 = no limit)", height: "Height", loop: "Loop round", thumbs: "Thumbnails", dots: "Dots",
                 name: "Thumbnail name", icon: "Thumbnail icon", entity: "Thumbnail shows this entity's state",
                 tap_action: "Tap on the slide (optional; for cards without buttons of their own)" };
const DEFAULTS = { effect: "slide", max_width: 480, height: "tallest", loop: true, thumbs: true, dots: true };

class DeckCardEditor extends HTMLElement {
  constructor() {
    super();
    this._selected = 0;
    this._picking = false;
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot?.querySelectorAll("ha-form, hui-card-element-editor, hui-card-picker").forEach((el) => (el.hass = hass));
    if (!this._rendered) this._render();
  }

  set lovelace(lovelace) {
    this._lovelace = lovelace;
    this.shadowRoot?.querySelectorAll("hui-card-element-editor, hui-card-picker").forEach((el) => (el.lovelace = lovelace));
  }

  setConfig(config) {
    // Our own edits come back through setConfig; re-rendering then would steal the focus from a field being typed in.
    if (this._emitted && JSON.stringify(config) === this._emitted) return;
    this._config = JSON.parse(JSON.stringify(config));
    this._config.slides = this._config.slides || [];
    this._selected = Math.min(this._selected, Math.max(this._config.slides.length - 1, 0));
    this._render();
  }

  _emit() {
    this._emitted = JSON.stringify(this._config);
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  _render() {
    if (!this._config || !this._hass) return;
    this._rendered = true;
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    const slides = this._config.slides;
    const i = this._selected;
    root.innerHTML = `
      <style>
        :host { display: block; }
        h3 { font-size: 15px; font-weight: 500; margin: 20px 0 8px; }
        .tabs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
        .tabs button, .tools button { font: inherit; font-size: 13px; border-radius: 16px; padding: 6px 12px; cursor: pointer;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .tabs button[aria-selected="true"] { border-color: var(--primary-color); color: var(--primary-color);
          background: color-mix(in srgb, var(--primary-color) 12%, transparent); }
        .tools { display: flex; gap: 6px; justify-content: flex-end; margin: 10px 0; }
        .tools button[disabled] { opacity: .4; cursor: default; }
        .box { border: 1px solid var(--divider-color); border-radius: 12px; padding: 12px; }
        .hint { color: var(--secondary-text-color); font-size: 13px; margin: 4px 0 8px; }
      </style>
      <h3>Carousel</h3>
      <ha-form class="general"></ha-form>
      <h3>Slides</h3>
      <div class="tabs" role="tablist">
        ${slides.map((s, n) => `<button role="tab" data-n="${n}" aria-selected="${n === i && !this._picking}"></button>`).join("")}
        <button class="add" title="Add a slide" aria-selected="${this._picking}">＋ Add slide</button>
      </div>
      ${this._picking || !slides.length ? `
        <p class="hint">Pick the card for the new slide.</p>
        <hui-card-picker></hui-card-picker>` : `
        <div class="tools">
          <button data-do="left" ${i === 0 ? "disabled" : ""}>◀ Move</button>
          <button data-do="right" ${i === slides.length - 1 ? "disabled" : ""}>Move ▶</button>
          <button data-do="delete" ${slides.length <= 2 ? "disabled title='A carousel needs two slides'" : ""}>Delete</button>
        </div>
        <div class="box">
          <h3 style="margin-top:0">Thumbnail</h3>
          <ha-form class="thumb"></ha-form>
          <h3>Card</h3>
          <hui-card-element-editor></hui-card-element-editor>
        </div>`}`;
    root.querySelectorAll(".tabs button[data-n]").forEach((b) => {
      const n = Number(b.dataset.n);
      b.textContent = `${n + 1}. ${slides[n].name || slides[n].card?.type?.replace("custom:", "") || "Slide"}`;
      b.addEventListener("click", () => { this._selected = n; this._picking = false; this._render(); });
    });
    root.querySelector(".add").addEventListener("click", () => { this._picking = true; this._render(); });

    const general = root.querySelector("ha-form.general");
    Object.assign(general, { hass: this._hass, schema: GENERAL_SCHEMA, computeLabel: (s) => LABELS[s.name] ?? s.name,
      data: { ...DEFAULTS, ...this._config } });
    general.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const { slides: _s, ...rest } = ev.detail.value;
      this._config = { ...this._config, ...rest };
      this._emit();
    });

    const picker = root.querySelector("hui-card-picker");
    if (picker) {
      Object.assign(picker, { hass: this._hass, lovelace: this._lovelace });
      picker.addEventListener("config-changed", (ev) => {
        ev.stopPropagation();
        const card = ev.detail.config;
        const now = this._config.slides;
        this._config.slides = [...now, { name: `Slide ${now.length + 1}`, card }];
        this._selected = this._config.slides.length - 1;
        this._picking = false;
        this._emit();
        this._render();
      });
      return;
    }

    root.querySelectorAll(".tools button").forEach((b) => b.addEventListener("click", () => {
      const list = [...this._config.slides];          // the config as it is now, card edits included
      if (b.dataset.do === "delete") { list.splice(i, 1); this._selected = Math.max(i - 1, 0); }
      else {
        const j = b.dataset.do === "left" ? i - 1 : i + 1;
        [list[i], list[j]] = [list[j], list[i]];
        this._selected = j;
      }
      this._config.slides = list;
      this._emit();
      this._render();
    }));

    const thumb = root.querySelector("ha-form.thumb");
    const { card: _c, ...thumbData } = slides[i];
    Object.assign(thumb, { hass: this._hass, schema: THUMB_SCHEMA, computeLabel: (s) => LABELS[s.name] ?? s.name, data: thumbData });
    thumb.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const v = { ...ev.detail.value };
      Object.keys(v).forEach((k) => (v[k] === "" || v[k] === undefined) && delete v[k]);
      this._config.slides = this._config.slides.map((s, n) => (n === i ? { ...v, card: s.card } : s));
      this._emit();
      const tab = root.querySelector(`.tabs button[data-n="${i}"]`);
      if (tab) tab.textContent = `${i + 1}. ${v.name || this._config.slides[i].card?.type?.replace("custom:", "") || "Slide"}`;
    });

    const cardEditor = root.querySelector("hui-card-element-editor");
    Object.assign(cardEditor, { hass: this._hass, lovelace: this._lovelace, value: slides[i].card });
    cardEditor.addEventListener("config-changed", (ev) => {
      ev.stopPropagation();
      if (!ev.detail.config) return;
      this._config.slides = this._config.slides.map((s, n) => (n === i ? { ...s, card: ev.detail.config } : s));
      this._emit();
    });
  }
}

if (!customElements.get("deck-card-editor")) customElements.define("deck-card-editor", DeckCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({ type: "deck-card", name: "Deck Card",
                          description: "Any cards as a swipeable deck: coverflow or slide, with thumbnails and dots.",
                          preview: false, documentationURL: "https://github.com/githubfreddieve/deck-card" });

console.info(`%c DECK-CARD %c ${VERSION} `, "color:#fff;background:#03a9f4;font-weight:700", "color:#03a9f4;background:#1c1f24");
