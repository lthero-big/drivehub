// Drag "lift" for internal file drags (DEPTAI-485 r6, ref design.lthero.com motion-dropit-drag-trash):
// the whole card / row is cloned and follows the pointer (HTML5 DnD keeps the folder-drop semantics,
// the native drag image is a transparent pixel); it tilts 2–5° with horizontal velocity and levels out
// when the pointer pauses. On release: deleted -> vanishes in place (250 ms fade + scale .92);
// dropped on a folder -> quick fade; cancelled (Esc / outside) -> flies back to its slot (280 ms).
const BLANK = typeof Image !== "undefined" ? new Image() : null;
if (BLANK) BLANK.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const TILT_MAX = 5, TILT_MIN = 2, MAX_W = 720;
type G = { el: HTMLElement; src: HTMLElement; offX: number; offY: number; x: number; y: number; lastX: number; lastT: number; vel: number; tilt: number; raf: number; outcome: "" | "delete" | "drop"; home: DOMRect };
let g: G | null = null;
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function paint() {
  if (!g) return;
  g.raf = 0;
  const t = Math.max(-TILT_MAX, Math.min(TILT_MAX, g.vel * 3.2));
  const m = Math.abs(t);
  g.tilt = reduced() ? 0 : m > 0.05 ? Math.sign(t) * Math.max(TILT_MIN, m) : t;
  g.el.style.transform = `translate(${g.x - g.offX - g.home.left}px, ${g.y - g.offY - g.home.top}px) rotate(${g.tilt.toFixed(2)}deg)`;
  g.vel *= 0.86;
  if (Math.abs(g.vel) > 0.02) g.raf = requestAnimationFrame(paint); // decay to level while the pointer rests
}
function onMove(e: DragEvent) {
  if (!g || (e.clientX === 0 && e.clientY === 0)) return; // Firefox "drag" events carry 0,0
  const now = performance.now();
  const dt = Math.max(1, now - g.lastT);
  g.vel = 0.7 * g.vel + 0.3 * ((e.clientX - g.lastX) / dt) * 16.7;
  g.lastX = e.clientX;
  g.lastT = now;
  g.x = e.clientX;
  g.y = e.clientY;
  if (!g.raf) g.raf = requestAnimationFrame(paint);
}

/** Call from onDragStart. Returns the lifted card's home rect (the bin anchors to it). */
export function liftStart(e: { currentTarget: EventTarget | null; clientX: number; clientY: number; dataTransfer: DataTransfer | null }, count: number): DOMRect {
  liftAbort();
  const src = e.currentTarget as HTMLElement;
  const r = src.getBoundingClientRect();
  const w = Math.min(r.width, MAX_W);
  const home = new DOMRect(r.left, r.top, w, r.height);
  if (BLANK && e.dataTransfer) e.dataTransfer.setDragImage(BLANK, 0, 0);
  const el = src.cloneNode(true) as HTMLElement;
  el.removeAttribute("data-sel-path");
  el.removeAttribute("id");
  el.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("data-drag-lift", "");
  el.classList.remove("drag-ghost-src", "drag-slot", "drop-folder");
  el.classList.add("drag-lift");
  if (count > 1) {
    el.dataset.many = "";
    const b = document.createElement("span");
    b.className = "drag-count";
    b.textContent = String(count);
    el.appendChild(b);
  }
  Object.assign(el.style, { position: "fixed", left: `${home.left}px`, top: `${home.top}px`, width: `${w}px`, height: `${r.height}px`, margin: "0", zIndex: "65", pointerEvents: "none", boxSizing: "border-box" });
  document.body.appendChild(el);
  const offX = Math.min(e.clientX - r.left, w - 24);
  g = { el, src, offX, offY: e.clientY - r.top, x: e.clientX, y: e.clientY, lastX: e.clientX, lastT: performance.now(), vel: 0, tilt: 0, raf: 0, outcome: "", home };
  paint();
  document.addEventListener("dragover", onMove, true);
  document.addEventListener("drag", onMove, true);
  return home;
}

/** The drop handled it (bin / folder): fade the ghost out in place right away — the source row may be
 *  removed from the DOM by the delete / move, and then its dragend never reaches React. */
export function liftOutcome(o: "delete" | "drop") {
  if (!g) return;
  g.outcome = o;
  liftEnd("move");
}

function detach() {
  document.removeEventListener("dragover", onMove, true);
  document.removeEventListener("drag", onMove, true);
  if (g?.raf) cancelAnimationFrame(g.raf);
}
export function liftAbort() {
  if (!g) return;
  detach();
  g.el.remove();
  g = null;
}

/** Call from onDragEnd. */
export function liftEnd(dropEffect: string) {
  if (!g) return;
  const s = g;
  g = null;
  detach();
  const el = s.el;
  const cur = `translate(${s.x - s.offX - s.home.left}px, ${s.y - s.offY - s.home.top}px)`;
  const done = (ms: number) => setTimeout(() => el.remove(), ms);
  if (reduced()) return void el.remove();
  if (s.outcome === "delete" || s.outcome === "drop" || dropEffect !== "none") {
    el.style.transition = `opacity ${s.outcome === "delete" ? 250 : 180}ms ease, transform ${s.outcome === "delete" ? 250 : 180}ms ease`;
    requestAnimationFrame(() => ((el.style.opacity = "0"), (el.style.transform = `${cur} scale(.92)`)));
    el.dataset.out = s.outcome || "drop";
    return done(270);
  }
  // cancelled: fly back to the slot and level out
  const to = s.src.isConnected ? s.src.getBoundingClientRect() : s.home;
  el.dataset.out = "back";
  el.style.transition = "transform .28s cubic-bezier(.3,.9,.3,1), box-shadow .28s";
  requestAnimationFrame(() => (el.style.transform = `translate(${to.left - s.home.left}px, ${to.top - s.home.top}px) rotate(0deg)`, el.classList.add("landing")));
  done(300);
}
