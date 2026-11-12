/* Layout and PDF engine. One layout feeds both the on-screen preview and the exported PDF.
   Geometry and type sizes are measured from the reference two-column template (A4, mm). */
(function (root) {
  "use strict";
  const PT = 25.4 / 72;            // mm per point
  const ASC = 0.935, BOX = 1.185;  // Rubik ascender and line-box height, in em
  const G = {
    W: 210, H: 297, SBX: 137.5,
    MX: 11.8, MR: 129.8, BX: 12.3, BT: 15.0,
    SX: 145.8, SR: 201.5, TOP: 9.5, BOT: 287
  };
  const C = {
    ink: "#303030", name: "#262626", rule: "#cfcfcf", side: "#24405c",
    sideInk: "#f4f6f9", sideMuted: "#889db4", white: "#ffffff", dotOff: "#c3ccd6", icon: "#4a4a4a"
  };
  const FONT = { L: "Rubik300", M: "Rubik500", B: "Rubik700" };

  /* ---------- fonts ---------- */
  function jspdfNS() { return root.jspdf || (typeof require === "function" ? require("jspdf") : null); }
  let fontsHooked = false;
  function hookFonts() {
    if (fontsHooked) return;
    const ns = jspdfNS(), F = root.CV_FONTS;
    if (!ns || !F) throw new Error("jsPDF or fonts missing");
    ns.jsPDF.API.events.push(["addFonts", function () {
      for (const [w, name] of [["300", FONT.L], ["500", FONT.M], ["700", FONT.B]]) {
        this.addFileToVFS(name + ".ttf", F[w]);
        this.addFont(name + ".ttf", name, "normal");
      }
    }]);
    fontsHooked = true;
  }
  function newDoc() { hookFonts(); const { jsPDF } = jspdfNS(); return new jsPDF({ unit: "mm", format: "a4", compress: true }); }
  let measurer = null;
  function measureDoc() { return measurer || (measurer = newDoc()); }

  /* Keep only characters the embedded font can draw; map common look-alikes. */
  function clean(s) {
    return String(s == null ? "" : s)
      .replace(/[‐‑‒]/g, "-").replace(/ /g, " ").replace(/[′]/g, "'")
      .replace(/[\t\r]+/g, " ").replace(/ {2,}/g, " ")
      .replace(/[^\x20-\x7e -ÿŒœ–—‘’‚“”„•…€™−]/g, "")
      .trim();
  }

  /* ---------- layout ---------- */
  /* Two passes: the first measures the room left on page 1 after the last role kept there,
     the second spreads that room over the gaps between sections, roles and bullets. */
  function layoutCV(cv, opt) {
    const Z = { b: 0, r: 0, s: 0 };
    /* measuring pass: the sidebar may run past the page so its true length is known */
    const m = layoutPass(cv, opt, Z, { measure: true, sq: 0, D: 31 }).fill;
    /* sidebar: keep everything up to the patents on page 1 by tightening gaps, then the photo */
    let sq = 0, D = 31;
    const over = m.sideEnd - (G.BOT - 0.5);
    if (over > 0 && m.sideW > 0) { sq = Math.min(1.6, over / m.sideW); const rest = over - sq * m.sideW; if (rest > 0) D = Math.max(25, 31 - rest); }
    /* main column: stretch page 1 when the forced page break leaves room */
    let X = Z;
    if (m.broke) {
      const slack = G.BOT - 1 - m.endY, denom = m.nB * 1 + m.nR * 4 + m.nS * 2.5;
      if (slack >= 1 && denom > 0) { const k = Math.min(1.6, slack / denom); X = { b: k, r: 4 * k, s: 2.5 * k }; }
    }
    return layoutPass(cv, opt, X, { measure: false, sq, D }).pages;
  }
  function layoutPass(cv, opt, X, M) {
    M = M || { measure: false, sq: 0, D: 31 };
    opt = opt || {};
    const doc = measureDoc();
    const P1 = Math.max(0, Math.round(+cv.page1Roles || 0)); // roles kept on page 1; 0 = no forced break
    const fill = { broke: false, endY: null, nB: 0, nR: 0, nS: 0, sideEnd: 0, sideW: 0 };
    const stretch = f => f.key === "main" && f.p === 0 && P1 > 0 && !fill.broke;
    const H = cv.headings || {}, show = cv.show || {};
    const acc = cv.accent || "#1a8cff";
    const pages = [];
    const newPage = () => {
      pages.push({ bg: [{ t: "rect", x: G.SBX, y: 0, w: G.W - G.SBX, h: G.H, c: C.side }], main: [], side: [] });
    };
    newPage();

    const fm = { p: 0, y: G.TOP, key: "main", sec: null, X: G.MX, R: G.MR, color: C.ink, rule: C.rule };
    const fs = { p: 0, y: G.TOP, key: "side", sec: null, X: G.SX, R: G.SR, color: C.white, rule: C.white };
    /* sidebar gap tightening (page 1, up to the patents); also counts the weights during the measuring pass */
    let sideCount = true;
    const q = w => { if (!sideCount || fs.p !== 0) return 0; fill.sideW += w; return M.sq * w; };

    const font = (w, size) => { doc.setFont(FONT[w]); doc.setFontSize(size); };
    const width = (s, w, size) => { font(w, size); return doc.getTextWidth(s); };
    const wrap = (s, maxW, w, size) => { font(w, size); return doc.splitTextToSize(clean(s), maxW + 0.4); };
    const push = (f, op) => pages[f.p][f.key].push(op);
    const text = (f, s, x, top, w, size, c) => { s = clean(s); if (s) push(f, { t: "text", s, x, y: top + size * PT * ASC, w, size, c }); };
    const boxH = size => size * PT * BOX;

    function heading(f, label) {
      const atTop = f.y <= G.TOP + 0.01;
      if (!atTop) { f.y += f.key === "main" ? 5.2 : 9.9; if (f.key === "side") f.y -= q(2); if (stretch(f)) { f.y += X.s; fill.nS++; } }
      if (f.y + 6.4 + 9.5 > G.BOT && !(f.key === "side" && M.measure)) breakPage(f, false);
      drawHeading(f, label);
      f.sec = label;
    }
    function drawHeading(f, label) {
      text(f, String(label || "").toUpperCase(), f.X, f.y, "L", 10.5, f.color);
      const ry = f.y + (f.key === "main" ? 6.2 : 6.4);
      push(f, { t: "line", x1: f.X, y1: ry, x2: f.R, y2: ry, c: f.rule, w: 0.26 });
      f.y += f.key === "main" ? 8.9 : 9.8;
    }
    function breakPage(f, repeat) {
      f.p++; if (!pages[f.p]) newPage();
      f.y = G.TOP;
      if (repeat && f.sec) drawHeading(f, f.sec);
    }
    const room = (f, need) => { if (f.key === "side" && M.measure) return false; if (f.y + need > G.BOT) { breakPage(f, true); return true; } return false; };

    /* paragraph lines with a fixed pitch */
    function para(f, s, x, maxW, w, size, c, pitch) {
      for (const ln of wrap(s, maxW, w, size)) { room(f, boxH(size)); text(f, ln, x, f.y, w, size, c); f.y += pitch; }
    }
    function bullets(f, list) {
      list.filter(b => clean(b)).forEach((b, i) => {
        const lines = wrap(b, G.MR - G.BT, "L", 7.7);
        if (i) { f.y += 0.2; if (stretch(f)) { f.y += X.b; fill.nB++; } }
        lines.forEach((ln, k) => {
          room(f, boxH(7.7));
          if (k === 0) text(f, "•", G.BX, f.y, "L", 7.7, C.ink);
          text(f, ln, G.BT, f.y, "L", 7.7, C.ink); f.y += 3.45;
        });
      });
    }
    /* left text (may wrap) with a right-aligned value on the first line, same baseline */
    function row(f, left, right, w, size, c, rsize, pitch) {
      right = clean(right);
      const rw = right ? width(right, "L", rsize) : 0;
      const lines = wrap(left, G.MR - G.MX - (rw ? rw + 4 : 0), w, size);
      lines.forEach((ln, i) => {
        text(f, ln, G.MX, f.y, w, size, c);
        if (i === 0 && right) {
          const base = f.y + size * PT * ASC;
          push(f, { t: "text", s: right, x: G.MR - rw, y: base, w: "L", size: rsize, c: C.ink });
        }
        f.y += i < lines.length - 1 ? pitch : 0;
      });
    }

    /* ===== MAIN COLUMN (written first: parsers read the header and experience before the sidebar) ===== */
    text(fm, String(cv.name || "").toUpperCase(), G.MX, 9.9, "B", 19, C.name);
    let y = 19.6;
    if (clean(cv.title)) { const tl = wrap(cv.title, G.MR - G.MX, "L", 10.5); tl.forEach((ln, i) => text(fm, ln, G.MX, y + i * 4.6, "L", 10.5, acc)); y += 8 + (tl.length - 1) * 4.6; }
    const rows = (cv.contacts || []).map(r => String(r).split("|").map(clean).filter(Boolean)).filter(r => r.length);
    rows.forEach(r => {
      let x = G.MX;
      r.forEach(item => {
        const tw = width(item, "L", 7.8);
        if (x > G.MX && x + 4.1 + tw > G.MR) { x = G.MX; y += 5.3; }
        const kind = iconKind(item), url = contactUrl(item, kind);
        push(fm, { t: "icon", kind, x, y: y + 1.65, c: C.icon });
        text(fm, item, x + 4.1, y, "L", 7.8, C.ink);
        if (url) push(fm, { t: "link", x, y: y - 0.4, w: 4.1 + tw, h: 4, url });
        x += 4.1 + tw + 4.9;
      });
      y += 5.3;
    });
    fm.y = y - 5.3 + 8.9;
    fm.y = Math.max(fm.y, 30);

    if (clean(cv.summary)) {
      if (stretch(fm)) { fm.y += X.s; fill.nS++; }
      drawHeading(fm, H.summary || "Summary"); fm.sec = H.summary;
      para(fm, cv.summary, G.MX, G.MR - G.MX, "L", 7.85, C.ink, 3.72);
    }

    const exps = (cv.experience || []).filter(e => !e.hidden && (clean(e.title) || clean(e.company)));
    if (exps.length) {
      heading(fm, H.experience || "Experience");
      exps.forEach((e, i) => {
        if (P1 && i === P1 && fm.p === 0) { fill.endY = fm.y; fill.broke = true; breakPage(fm, true); }
        else if (i) { fm.y += 2.65; if (stretch(fm)) { fm.y += X.r; fill.nR++; } }
        room(fm, 17.5);
        row(fm, e.title, e.dates, "L", 9.3, C.ink, 7.6, 4.1); fm.y += 4.5;
        row(fm, e.company, e.location, "L", 8.5, acc, 7.6, 3.9); fm.y += 4.4;
        bullets(fm, e.bullets || []);
      });
    }

    const edus = (cv.education || []).filter(e => clean(e.degree) || clean(e.school));
    if (edus.length) {
      heading(fm, H.education || "Education");
      edus.forEach((e, i) => {
        if (i) fm.y += 2.65;
        room(fm, 12);
        row(fm, e.degree, e.dates, "L", 9.3, C.ink, 7.6, 4.1); fm.y += 4.5;
        row(fm, e.school, e.grade, "L", 8.5, acc, 7.6, 3.9); fm.y += 4.4;
        bullets(fm, e.bullets || []);
      });
    }

    const certs = (cv.certifications || []).filter(c => clean(c.title));
    if (show.certifications !== false && certs.length) {
      heading(fm, H.certifications || "Certifications and Training");
      certs.forEach((c, i) => {
        if (i) fm.y += 1.9;
        room(fm, 10);
        const date = clean(c.date), dw = date ? width(date, "L", 7.6) : 0;
        const lines = wrap(c.title, G.MR - G.MX - (dw ? dw + 8 : 0), "L", 9.3);
        lines.forEach((ln, k) => {
          text(fm, ln, G.MX, fm.y, "L", 9.3, C.ink);
          if (k === 0 && date) push(fm, { t: "text", s: date, x: G.MR - dw, y: fm.y + 9.3 * PT * ASC, w: "L", size: 7.6, c: C.ink });
          fm.y += 3.7;
        });
        if (clean(c.issuer)) { fm.y += 1.1; text(fm, c.issuer, G.MX, fm.y, "L", 8.5, acc); fm.y += 4.4; }
      });
    }

    /* ===== SIDEBAR ===== */
    const D = M.D;
    if (show.photo !== false && opt.photo) { push(fs, { t: "img", src: opt.photo, x: (G.SBX + G.W) / 2 - D / 2, y: G.TOP, w: D, h: D }); fs.y = G.TOP + D + 13.2 - q(2); fs.sec = "photo"; }

    const sideHead = label => { if (fs.sec === "photo") { fs.sec = null; drawHeading(fs, label); fs.sec = label; } else heading(fs, label); };

    const skills = (cv.skills || []).filter(s => clean(s.name) || clean(s.text));
    if (skills.length) {
      sideHead(H.skills || "Skills");
      skills.forEach((s, i) => {
        if (i) fs.y += 2.73 - q(1);
        room(fs, 10);
        if (clean(s.name)) { text(fs, s.name, G.SX, fs.y, "M", 8.75, C.white); fs.y += 5.5 - q(0.5); }
        para(fs, s.text, G.SX, G.SR - G.SX, "L", 8.2, C.sideInk, 3.97);
      });
    }
    const langs = (cv.languages || []).filter(l => clean(l.name));
    if (langs.length) {
      sideHead(H.languages || "Languages");
      const dotsLeft = G.SR - 0.55 - 4 * 2.1 - 1.4;
      const oneLine = langs.every(l => !clean(l.level) || G.SX + width(clean(l.name), "L", 9) + 2 + width(clean(l.level), "L", 7.7) <= dotsLeft - 1.5);
      langs.forEach((l, i) => {
        if (i) fs.y += (oneLine ? 2.3 : 3.6) - q(0.6);
        room(fs, oneLine ? 5 : 8);
        const nm = clean(l.name), lv = clean(l.level), nw = width(nm, "L", 9);
        text(fs, nm, G.SX, fs.y, "L", 9, C.white);
        const cy = fs.y + 2.05, n = Math.max(0, Math.min(5, +l.dots || 0));
        for (let k = 0; k < 5; k++) push(fs, { t: "circle", x: G.SR - 0.55 - (4 - k) * 2.1, y: cy, r: 0.52, c: k < n ? acc : C.dotOff });
        if (oneLine) {
          if (lv) text(fs, lv, G.SX + nw + 2, fs.y + (9 - 7.7) * PT * ASC, "L", 7.7, C.sideMuted); fs.y += 4.6;   // one line: name, level, dots
        } else {
          fs.y += 4.1; if (lv) text(fs, lv, G.SX, fs.y, "L", 7.7, C.sideMuted); fs.y += 4.0;          // level too long: second line
        }
      });
    }
    const pats = (cv.patents || []).filter(p => clean(p.num) || clean(p.title));
    if (show.patents !== false && pats.length) {
      sideHead(H.patents || "Patents");
      pats.forEach((p, i) => {
        if (i) fs.y += 3.1 - q(1);
        room(fs, 12);
        if (clean(p.num)) { text(fs, p.num, G.SX, fs.y, "M", 8.6, C.white); fs.y += 3.9; }
        para(fs, p.title, G.SX, G.SR - G.SX, "L", 8.25, C.sideInk, 4.2);
        if (clean(p.detail)) para(fs, p.detail, G.SX, G.SR - G.SX, "L", 8.25, C.sideMuted, 4.2);
      });
    }
    sideCount = false; fill.sideEnd = fs.p === 0 ? fs.y : G.BOT + 100;
    if (show.interests !== false && clean(cv.interests)) {
      sideHead(H.interests || "Interests");
      fs.y += 0.6;
      para(fs, cv.interests, G.SX, G.SR - G.SX, "L", 7.8, C.sideInk, 4.6);
    }
    return { pages, fill };
  }

  /* Real link targets, so PDF viewers don't have to guess them from the text */
  function contactUrl(item, kind) {
    const t = String(item || "").trim();
    if (kind === "mail") { const m = t.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/); return m ? "mailto:" + m[0] : null; }
    if (kind === "phone") { const d = t.replace(/[^\d+]/g, ""); return d.length >= 7 ? "tel:" + d : null; }
    if (kind === "link") {
      if (/^https?:\/\//i.test(t)) return t;
      return "https://" + t.replace(/^(linkedin\.com|github\.com)/i, "www.$1");
    }
    return null;
  }
  function iconKind(s) {
    if (/@/.test(s)) return "mail";
    if (/linkedin|https?:|www\.|github|\.com\//i.test(s)) return "link";
    if (/^[+\d][\d\s()./-]{6,}$/.test(s)) return "phone";
    if (/citizen|nationalit|staatsb|permis|permit|bürger/i.test(s)) return "globe";
    return "pin";
  }

  /* ---------- PDF ---------- */
  function hex(c) { return c; }
  function drawIcon(doc, op) {
    const { x, y, kind } = op; // y = vertical centre
    doc.setDrawColor(op.c); doc.setLineWidth(0.22); doc.setFillColor(op.c);
    if (kind === "mail") { doc.circle(x + 1.45, y, 1.25, "S"); doc.circle(x + 1.45, y, 0.5, "S"); doc.line(x + 1.95, y - 0.5, x + 1.95, y + 0.35); doc.line(x + 1.95, y + 0.35, x + 2.55, y + 0.45); }
    else if (kind === "phone") { doc.roundedRect(x + 0.55, y - 1.35, 1.6, 2.7, 0.35, 0.35, "S"); doc.line(x + 1.1, y + 1.0, x + 1.6, y + 1.0); }
    else if (kind === "link") { doc.roundedRect(x + 0.1, y - 0.55, 1.75, 1.1, 0.55, 0.55, "S"); doc.roundedRect(x + 1.15, y - 0.55, 1.75, 1.1, 0.55, 0.55, "S"); }
    else if (kind === "globe") { doc.circle(x + 1.45, y, 1.2, "S"); doc.ellipse(x + 1.45, y, 0.5, 1.2, "S"); doc.line(x + 0.25, y, x + 2.65, y); }
    else { doc.circle(x + 1.45, y - 0.35, 0.95, "S"); doc.circle(x + 1.45, y - 0.35, 0.28, "F"); doc.line(x + 0.68, y + 0.2, x + 1.45, y + 1.4); doc.line(x + 2.22, y + 0.2, x + 1.45, y + 1.4); }
  }
  function drawOp(doc, op) {
    if (op.t === "rect") { doc.setFillColor(op.c); doc.rect(op.x, op.y, op.w, op.h, "F"); }
    else if (op.t === "line") { doc.setDrawColor(op.c); doc.setLineWidth(op.w); doc.line(op.x1, op.y1, op.x2, op.y2); }
    else if (op.t === "circle") { doc.setFillColor(op.c); doc.circle(op.x, op.y, op.r, "F"); }
    else if (op.t === "img") { try { doc.addImage(op.src, "JPEG", op.x, op.y, op.w, op.h, "photo", "FAST"); } catch (e) { /* unreadable photo: skip */ } }
    else if (op.t === "icon") drawIcon(doc, op);
    else if (op.t === "link") doc.link(op.x, op.y, op.w, op.h, { url: op.url });
    else if (op.t === "text") { doc.setFont(FONT[op.w]); doc.setFontSize(op.size); doc.setTextColor(op.c); doc.text(op.s, op.x, op.y); }
  }
  function buildPdf(cv, opt) {
    const doc = newDoc();
    const pages = layoutCV(cv, opt);
    doc.setProperties({
      title: (cv.name || "CV") + " - CV" + (cv.title ? " - " + clean(cv.title) : ""),
      subject: clean(cv.title) || "Curriculum Vitae",
      author: clean(cv.name), creator: clean(cv.name), keywords: (cv.skills || []).map(s => clean(s.text)).join(", ")
    });
    pages.forEach((pg, i) => {
      if (i) doc.addPage();
      for (const op of pg.bg) drawOp(doc, op);
      for (const op of pg.main) drawOp(doc, op);
      for (const op of pg.side) drawOp(doc, op);
    });
    return { doc, pages: pages.length };
  }
  /* jsPDF writes "/Ordering (Identity-H)", which strict parsers reject; the correct value is "Identity".
     Same byte length, so the cross-reference table stays valid. */
  function pdfBytes(cv, opt) {
    const { doc, pages } = buildPdf(cv, opt);
    const u8 = new Uint8Array(doc.output("arraybuffer"));
    const from = "/Ordering (Identity-H)", to = "/Ordering (Identity)  ";
    const f = Array.from(from, ch => ch.charCodeAt(0));
    outer: for (let i = 0; i <= u8.length - f.length; i++) {
      for (let k = 0; k < f.length; k++) if (u8[i + k] !== f[k]) continue outer;
      for (let k = 0; k < f.length; k++) u8[i + k] = to.charCodeAt(k);
    }
    return { bytes: u8, pages };
  }

  /* ---------- text and keywords ---------- */
  function cvPlainText(cv) {
    const s = cv.show || {}, out = [cv.name, cv.title, ...(cv.contacts || []), cv.summary];
    (cv.experience || []).filter(e => !e.hidden).forEach(e => out.push(e.title, e.dates, e.company, e.location, ...(e.bullets || [])));
    (cv.education || []).forEach(e => out.push(e.degree, e.dates, e.school, e.grade, ...(e.bullets || [])));
    if (s.certifications !== false) (cv.certifications || []).forEach(c => out.push(c.title, c.date, c.issuer));
    (cv.skills || []).forEach(k => out.push(k.name, k.text));
    (cv.languages || []).forEach(l => out.push(l.name, l.level));
    if (s.patents !== false) (cv.patents || []).forEach(p => out.push(p.num, p.title, p.detail));
    if (s.interests !== false) out.push(cv.interests);
    return out.map(clean).filter(Boolean).join("\n");
  }
  const norm = s => " " + String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[‐-―-]/g, " ").replace(/[^a-z0-9+#/&]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  function forms(t) {
    const n = norm(t).trim(); if (!n) return [];
    const out = new Set([n]);
    if (n.length > 4) { if (/ies$/.test(n)) out.add(n.slice(0, -3) + "y"); else if (/s$/.test(n)) out.add(n.slice(0, -1)); else out.add(n + "s"); }
    if (/ise/.test(n)) out.add(n.replace(/ise/g, "ize")); if (/ize/.test(n)) out.add(n.replace(/ize/g, "ise"));
    if (/our/.test(n)) out.add(n.replace(/our/g, "or"));
    return [...out];
  }
  function kwPresent(textNorm, kw) {
    return [kw.term, ...(kw.variants || [])].filter(Boolean).some(t => forms(t).some(f => textNorm.includes(" " + f + " ")));
  }
  function score(cv, keywords, textOverride) {
    const tn = norm(textOverride != null ? textOverride : cvPlainText(cv));
    const res = (keywords || []).map(k => ({ ...k, ok: kwPresent(tn, k) }));
    const wt = k => k.importance === "high" ? 2 : 1;
    const tot = res.reduce((a, k) => a + wt(k), 0), got = res.filter(k => k.ok).reduce((a, k) => a + wt(k), 0);
    return { res, pct: tot ? Math.round(100 * got / tot) : null, hit: res.filter(k => k.ok).length, total: res.length };
  }

  const STOP = new Set(("le la les un une des de du et en au aux pour par sur dans avec sans vous nous votre vos notre nos est sont sera etre avoir ou qui que quoi dont ce cette ces son sa ses leur leurs plus tres afin ainsi mais comme tout tous toute toutes aussi chez entre sous lors nos vos " +
    "the a an and or of to in for on with by at as is are be will you your our we this that these those from into who what which have has can may must should within across about their they them its it more other such than also all any each per via etc using use well new " +
    "der die das und oder ein eine einer eines mit fur für von zu im in auf den dem des sie wir ihr ihre unser unsere ist sind werden als bei aus nach sowie oder wie zur zum durch uber über sich " +
    "poste profil mission missions entreprise equipe travail candidat candidature experience annees ans job role team company position years year work working looking join ideal candidate offer benefits salary apply").split(/\s+/));
  /* Offline estimate: frequent content words and acronyms of the ad. Claude's analysis replaces it. */
  function quickKeywords(ad) {
    const freq = {}, orig = {};
    (String(ad).match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9+#.\-]{2,}/g) || []).forEach(w0 => {
      const w = w0.replace(/[.\-]+$/, ""), k = norm(w).trim();
      if (!k || k.length < 4 && !/[A-Z]{2,}/.test(w) || STOP.has(k) || /^\d/.test(k)) return;
      freq[k] = (freq[k] || 0) + (/^[A-Z0-9+#]{2,}$/.test(w) ? 3 : 1);
      if (!orig[k] || /[A-Z]{2,}/.test(w)) orig[k] = w;
    });
    return Object.entries(freq).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 22)
      .map(([k, n]) => ({ term: orig[k] || k, importance: n >= 4 ? "high" : "medium", variants: [] }));
  }

  const API = { G, layoutCV, buildPdf, pdfBytes, cvPlainText, score, quickKeywords, norm, kwPresent, clean, iconKind };
  root.CVEngine = API;
  if (typeof module !== "undefined") module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
