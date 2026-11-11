/* CV Builder — app logic. Data lives in Supabase (table "docs"); nothing personal is stored in this code. */
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const mkid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 20);
const words = s => (String(s || "").trim().match(/\S+/g) || []).length;
const E = window.CVEngine;

function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2800); }
function status(t) { const el = $("#status"); el.textContent = t || ""; el.hidden = !t; }
function arm(btn, run) {
  if (btn.dataset.armed) { run(); return; }
  btn.dataset.armed = "1"; const t = btn.textContent; btn.classList.add("armed"); btn.textContent = "Confirmer ?";
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = t; } }, 3000);
}
function ago(ts) {
  if (!ts) return ""; const d = (Date.now() - ts) / 1000;
  if (d < 90) return "à l'instant"; if (d < 3600) return `il y a ${Math.round(d / 60)} min`; if (d < 86400) return `il y a ${Math.round(d / 3600)} h`;
  if (d < 86400 * 30) return `il y a ${Math.round(d / 86400)} j`; return new Date(ts).toLocaleDateString("fr-CH");
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label || "Copié"); }
  catch (_) { toast("Copie bloquée par le navigateur : sélectionne le texte à la main."); }
}

/* ---------- Sync layer: Supabase table "docs" (collection, id, data) + local cache (same model as WA-Trip) ---------- */
const CFG = window.APP_CONFIG || {};
const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && !/YOUR_/.test(CFG.supabaseUrl + CFG.supabaseAnonKey));
const SB = CONFIGURED && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
const CACHE = "cvb-cache";
const Store = {
  docs: new Map(), user: null, synced: false, member: true,
  key: (c, i) => c + "/" + i,
  load() { try { const raw = localStorage.getItem(CACHE); if (raw) for (const r of JSON.parse(raw)) this.docs.set(this.key(r.c, r.i), r.d); } catch (_) {} },
  save() { clearTimeout(this.t); this.t = setTimeout(() => { try { localStorage.setItem(CACHE, JSON.stringify([...this.docs].map(([k, d]) => { const j = k.indexOf("/"); return { c: k.slice(0, j), i: k.slice(j + 1), d }; }))); } catch (_) {} }, 400); },
  clear() { this.docs.clear(); try { localStorage.removeItem(CACHE); } catch (_) {} },
  get(c, i) { return this.docs.get(this.key(c, i)); },
  list(c) { return [...this.docs].filter(([k]) => k.startsWith(c + "/")).map(([k, d]) => ({ id: k.slice(c.length + 1), ...d })); }
};
function denied(e) {
  if (e && (e.code === "42501" || /row-level security/i.test(e.message || ""))) { Store.member = false; return { message: "Cet e-mail n'est pas autorisé. Ajoute-le à la table members dans Supabase." }; }
  return e;
}
async function put(c, i, d) {
  if (!SB || !Store.user) throw { message: "Connecte-toi pour enregistrer." };
  Store.docs.set(Store.key(c, i), d); Store.save();
  const { error } = await SB.from("docs").upsert({ collection: c, id: i, data: d, updated_by: Store.user.email, updated_at: new Date().toISOString() });
  if (error) throw denied(error);
}
async function del(c, i) {
  if (!SB || !Store.user) throw { message: "Connecte-toi pour supprimer." };
  const k = Store.key(c, i), prev = Store.docs.get(k); Store.docs.delete(k); Store.save();
  const { error } = await SB.from("docs").delete().match({ collection: c, id: i });
  if (error) { if (prev) Store.docs.set(k, prev); throw denied(error); }
}
async function pull() {
  if (!SB || !Store.user) return;
  const { data, error } = await SB.from("docs").select("collection,id,data").limit(5000);
  if (error) { const e = denied(error); status(e.message || "Chargement impossible."); render(); return; }
  Store.docs.clear(); data.forEach(r => Store.docs.set(Store.key(r.collection, r.id), r.data));
  Store.synced = true; Store.save(); status(""); afterData();
}
let CHANNEL = null;
function listen() {
  if (!SB || CHANNEL) return;
  CHANNEL = SB.channel("docs-changes").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
    if (p.eventType === "DELETE") { if (p.old && p.old.collection) Store.docs.delete(Store.key(p.old.collection, p.old.id)); }
    else {
      const k = Store.key(p.new.collection, p.new.id), mine = Store.docs.get(k);
      if (mine && (mine.updatedAt || 0) >= (p.new.data.updatedAt || 0)) return; // our own echo, or older than what we hold
      Store.docs.set(k, p.new.data);
    }
    Store.save(); remoteChanged();
  }).subscribe();
}

/* ---------- state ---------- */
const STATUSES = [["draft", "Brouillon"], ["sent", "Envoyée"], ["interview", "Entretien"], ["offer", "Offre"], ["rejected", "Refus"], ["withdrawn", "Abandonnée"]];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const ACCENTS = [["#1a8cff", "Bleu (modèle)"], ["#1f8a8a", "Pétrole"], ["#b0452a", "Brique"], ["#3a3f47", "Graphite"]];
const S = {
  tab: "edit", curId: null, filter: "all", openSecs: new Set(["meta", "header"]), newForm: false, more: new Set(),
  claude: false, pdf: null, pdfText: "", pdfBusy: false, pdfDirty: true, pages: 0
};
try { const t = localStorage.getItem("cvb-tab"); if (["edit", "ats", "pdf", "apps"].includes(t)) S.tab = t; } catch (_) {}

const versions = () => Store.list("versions").sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const cur = () => S.curId ? Store.get("versions", S.curId) : null;
const photo = () => (Store.get("profile", "photo") || {}).data || null;
const BLANK = {
  name: "", title: "", contacts: [""], summary: "", experience: [], education: [], certifications: [], skills: [], languages: [], patents: [], interests: "",
  headings: { summary: "Summary", experience: "Experience", education: "Education", certifications: "Certifications and Training", skills: "Skills", languages: "Languages", patents: "Patents", interests: "Interests" },
  show: { photo: true, certifications: true, patents: true, interests: true }, accent: "#1a8cff"
};
function fix(cv) {
  const o = { ...clone(BLANK), ...(cv || {}) };
  o.headings = { ...BLANK.headings, ...(cv && cv.headings || {}) }; o.show = { ...BLANK.show, ...(cv && cv.show || {}) };
  for (const k of ["experience", "education", "certifications", "skills", "languages", "patents", "contacts"]) if (!Array.isArray(o[k])) o[k] = [];
  o.experience.forEach(e => { if (!Array.isArray(e.bullets)) e.bullets = []; });
  o.education.forEach(e => { if (!Array.isArray(e.bullets)) e.bullets = []; });
  return o;
}

/* ---------- saving ---------- */
let saveT = null;
function setSave(t) { $("#save").textContent = t; }
function touch(opts) {
  const v = cur(); if (!v) return;
  v.updatedAt = Date.now(); S.pdfDirty = true;
  setSave("Modifié…"); clearTimeout(saveT); saveT = setTimeout(() => flush(S.curId), 700);
  refreshLive();
  if (opts && opts.rerender) renderPane();
}
async function flush(id) {
  const v = Store.get("versions", id); if (!v) return;
  try { setSave("Enregistrement…"); v.score = E.score(fix(v.cv), v.keywords).pct; await put("versions", id, v); setSave("Enregistré"); }
  catch (e) { setSave("Non enregistré"); toast(e.message || "Enregistrement impossible. Vérifie ta connexion, puis modifie un champ pour réessayer."); }
}
async function saveVersion(v, msg) {
  v.updatedAt = Date.now();
  try { await put("versions", v.id, stripId(v)); if (msg) toast(msg); } catch (e) { toast(e.message || "Enregistrement impossible."); }
}
const stripId = v => { const { id, ...rest } = v; return rest; };

/* ---------- rendering ---------- */
function render() {
  const authed = !!(SB && Store.user);
  $("#auth").hidden = authed && Store.member;
  $("#who").hidden = !authed; if (authed) $("#whoMail").textContent = Store.user.email;
  if (!authed || !Store.member) { renderAuth(); hideApp(); return; }
  const list = versions();
  if (!list.length) { hideApp(); $("#first").hidden = !Store.synced; if (Store.synced) renderFirst(); return; }
  $("#first").hidden = true;
  if (!S.curId || !cur()) { let k = null; try { k = localStorage.getItem("cvb-cur"); } catch (_) {} S.curId = list.find(v => v.id === k) ? k : list[0].id; }
  $("#vpick").hidden = false; $("#tabs").hidden = false;
  renderBar(); renderTabs(); renderPane();
}
function hideApp() { $("#first").hidden = true; $("#vpick").hidden = true; $("#tabs").hidden = true; ["edit", "ats", "pdf", "apps"].forEach(p => $("#pane-" + p).hidden = true); }
function renderBar() {
  const list = versions(), tpl = list.filter(v => v.isTemplate), apps = list.filter(v => !v.isTemplate);
  const opt = v => `<option value="${v.id}" ${v.id === S.curId ? "selected" : ""}>${esc(v.label || "Sans nom")}${v.company ? " · " + esc(v.company) : ""}</option>`;
  $("#vsel").innerHTML = (tpl.length ? `<optgroup label="Modèles">${tpl.map(opt).join("")}</optgroup>` : "") + (apps.length ? `<optgroup label="Candidatures">${apps.map(opt).join("")}</optgroup>` : "");
}
function renderTabs() {
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === S.tab));
  ["edit", "ats", "pdf", "apps"].forEach(p => $("#pane-" + p).hidden = p !== S.tab);
  refreshLive();
}
function renderPane() {
  ({ edit: renderEdit, ats: renderAts, pdf: renderPdf, apps: renderApps })[S.tab]();
}
/* small live counters that change on every keystroke */
function refreshLive() {
  const v = cur(); if (!v) return;
  const cv = fix(v.cv), sc = E.score(cv, v.keywords);
  $("#tabScore").textContent = sc.pct == null ? "–" : sc.pct + " %";
  clearTimeout(refreshLive.t); refreshLive.t = setTimeout(() => { try { S.pages = E.layoutCV(fix(cur().cv), { photo: photo() }).length; } catch (_) {} $("#tabPages").textContent = S.pages + " p."; }, 150);
  $("#tabApps").textContent = versions().filter(x => !x.isTemplate).length;
  if (S.tab === "ats") refreshScore();
  if (S.tab === "pdf") schedulePdf();
}

/* ---------- auth ---------- */
function renderAuth() {
  const el = $("#auth");
  if (!CONFIGURED) { el.innerHTML = `<div class="panel"><h2>Configuration requise</h2><p class="hint">Renseigne l'URL Supabase et la clé publique dans <span class="mono">config.js</span>, comme décrit dans le README.</p></div>`; return; }
  if (Store.user && !Store.member) {
    el.innerHTML = `<div class="panel"><h2>Accès refusé</h2><p class="hint">Le compte <b>${esc(Store.user.email)}</b> n'est pas dans la table <span class="mono">members</span> de Supabase. Ajoute-le, puis recharge la page.</p><div class="row"><button class="btn" data-act="logout">Se déconnecter</button></div></div>`; return;
  }
  el.innerHTML = `<form class="panel" id="login" autocomplete="on">
    <h2>Connexion</h2>
    <label>E-mail<input type="email" id="lg-mail" autocomplete="username" required></label>
    <label>Mot de passe<input type="password" id="lg-pw" autocomplete="current-password" minlength="6" required></label>
    <div class="row"><button class="btn pri" type="submit">Se connecter</button><button class="btn" type="button" data-act="signup">Créer le compte</button></div>
    <p class="hint" id="lg-msg">Première fois : saisis ton e-mail et un mot de passe (6 caractères min.), puis « Créer le compte ».</p></form>`;
}
async function signIn(e) {
  e.preventDefault();
  const mail = $("#lg-mail").value.trim(), pw = $("#lg-pw").value;
  $("#lg-msg").textContent = "Connexion…";
  const { error } = await SB.auth.signInWithPassword({ email: mail, password: pw });
  if (error) $("#lg-msg").textContent = /invalid/i.test(error.message) ? "E-mail ou mot de passe incorrect." : error.message;
}
async function signUp() {
  const mail = $("#lg-mail").value.trim(), pw = $("#lg-pw").value;
  if (!mail || pw.length < 6) { $("#lg-msg").textContent = "Saisis ton e-mail et un mot de passe d'au moins 6 caractères."; return; }
  const { data, error } = await SB.auth.signUp({ email: mail, password: pw });
  if (error) { $("#lg-msg").textContent = error.message; return; }
  if (!data.session) $("#lg-msg").textContent = "Compte créé. Si Supabase demande une confirmation, désactive « Confirm email » (voir README), puis connecte-toi.";
}

/* ---------- first run ---------- */
function renderFirst() {
  $("#first").innerHTML = `<div class="panel"><h2>Aucun CV pour l'instant</h2>
    <p class="hint">Importe ton CV de base (le fichier <span class="mono">cv-base.json</span> que tu gardes hors du dépôt). Il devient ton premier modèle ; chaque candidature en sera une copie.</p>
    <div class="row"><button class="btn pri" data-act="seed">Importer le CV de base</button><button class="btn" data-act="blank">Commencer avec un CV vide</button></div></div>`;
}
async function importSeed(file) {
  let seed;
  try { seed = JSON.parse(await file.text()); } catch (_) { toast("Ce fichier n'est pas un JSON lisible."); return; }
  if (!seed || !seed.cv || !seed.cv.name) { toast("Ce fichier ne contient pas de CV au bon format."); return; }
  try {
    if (seed.photo && /^data:image\//.test(seed.photo)) await put("profile", "photo", { data: seed.photo, updatedAt: Date.now() });
    const id = mkid(), now = Date.now();
    await put("versions", id, { label: seed.label || "CV de base", company: "", role: "", isTemplate: true, status: "draft", createdAt: now, updatedAt: now, cv: fix(seed.cv), jobAd: "", offerUrl: "", keywords: null, kwSource: null, suggestions: [], uncovered: [], notes: "" });
    S.curId = id; toast("CV de base importé"); render();
  } catch (e) { toast(e.message || "Import impossible."); }
}

/* ---------- EDIT ---------- */
const getP = (o, p) => p.split(".").reduce((x, k) => x == null ? x : x[k], o);
function setP(o, p, val) { const ks = p.split("."); let x = o; ks.slice(0, -1).forEach(k => x = x[k]); x[ks.at(-1)] = val; }
function renderEdit() {
  const v = cur(); if (!v) return; v.cv = fix(v.cv); const cv = v.cv;
  const inp = (p, label, ph = "") => `<label>${label}<input type="text" id="f-${p}" data-k="${p}" value="${esc(getP(cv, p))}" placeholder="${esc(ph)}"></label>`;
  const ta = (p, label, rows = 3, lines = false) => { const x = getP(cv, p); return `<label>${label}<textarea id="f-${p}" data-k="${p}" ${lines ? 'data-lines="1"' : ""} rows="${rows}">${esc(lines ? (x || []).join("\n") : x)}</textarea></label>`; };
  const cb = (p, label, inv = false) => `<label class="chk"><input type="checkbox" id="f-${p}" data-k="${p}" ${inv ? 'data-inv="1"' : ""} ${(inv ? !getP(cv, p) : getP(cv, p)) ? "checked" : ""}> ${label}</label>`;
  const ctrl = (list, i) => `<button class="btn sm" data-act="up" data-list="${list}" data-i="${i}" aria-label="Monter">↑</button><button class="btn sm" data-act="down" data-list="${list}" data-i="${i}" aria-label="Descendre">↓</button><button class="btn sm" data-act="rm" data-list="${list}" data-i="${i}" aria-label="Supprimer">✕</button>`;
  const sec = (id, title, small, body) => `<details class="sec" data-sec="${id}" ${S.openSecs.has(id) ? "open" : ""}><summary>${title}<small>${small ?? ""}</small></summary><div class="sbody">${body}</div></details>`;
  const add = (list, label) => `<div><button class="btn" data-act="add" data-list="${list}">+ ${label}</button></div>`;
  const bul = (p, label) => { const arr = getP(cv, p) || [];
    return `<div class="bul" data-bl="${p}"><label>${label}</label>${arr.map((b, j) => `<div class="bi"><span aria-hidden="true">•</span><textarea rows="1" id="f-${p}.${j}" data-k="${p}.${j}" data-bullet="1" aria-label="Puce ${j + 1}">${esc(b)}</textarea><button class="btn sm" data-act="brm" data-p="${p}" data-j="${j}" aria-label="Supprimer la puce ${j + 1}">✕</button></div>`).join("")}<div><button class="btn sm" data-act="badd" data-p="${p}">+ Puce</button></div></div>`; };

  const exp = cv.experience.map((e, i) => `<div class="card ${e.hidden ? "off" : ""}"><div class="chead"><b>${esc(e.title || "Nouveau poste")}</b>${ctrl("experience", i)}</div>
    ${cb(`experience.${i}.hidden`, "Inclure dans cette version", true)}
    <div class="grid2">${inp(`experience.${i}.title`, "Poste")}${inp(`experience.${i}.dates`, "Dates", "01/2024 - Present")}</div>
    <div class="grid2">${inp(`experience.${i}.company`, "Entreprise")}${inp(`experience.${i}.location`, "Lieu")}</div>
    ${bul(`experience.${i}.bullets`, "Réalisations · Entrée crée une nouvelle puce")}</div>`).join("");
  const edu = cv.education.map((e, i) => `<div class="card"><div class="chead"><b>${esc(e.degree || "Nouvelle formation")}</b>${ctrl("education", i)}</div>
    <div class="grid2">${inp(`education.${i}.degree`, "Diplôme")}${inp(`education.${i}.dates`, "Dates")}</div>
    <div class="grid2">${inp(`education.${i}.school`, "École")}${inp(`education.${i}.grade`, "Note")}</div>
    ${bul(`education.${i}.bullets`, "Détails (facultatif)")}</div>`).join("");
  const cer = cv.certifications.map((c, i) => `<div class="card"><div class="chead"><b>${esc(c.title || "Nouvelle certification")}</b>${ctrl("certifications", i)}</div>
    ${inp(`certifications.${i}.title`, "Intitulé")}<div class="grid2">${inp(`certifications.${i}.issuer`, "Organisme")}${inp(`certifications.${i}.date`, "Année")}</div></div>`).join("");
  const skl = cv.skills.map((s, i) => `<div class="card"><div class="chead"><b>${esc(s.name || "Nouveau groupe")}</b>${ctrl("skills", i)}</div>
    ${inp(`skills.${i}.name`, "Groupe")}${ta(`skills.${i}.text`, "Compétences, séparées par des virgules", 3)}</div>`).join("");
  const lng = cv.languages.map((l, i) => `<div class="card"><div class="chead"><b>${esc(l.name || "Nouvelle langue")}</b>${ctrl("languages", i)}</div>
    <div class="grid3">${inp(`languages.${i}.name`, "Langue")}${inp(`languages.${i}.level`, "Niveau")}
    <label>Points sur 5<select id="f-languages.${i}.dots" data-k="languages.${i}.dots" data-num="1">${[0, 1, 2, 3, 4, 5].map(n => `<option ${+l.dots === n ? "selected" : ""}>${n}</option>`).join("")}</select></label></div></div>`).join("");
  const pat = cv.patents.map((p, i) => `<div class="card"><div class="chead"><b>${esc(p.num || "Nouveau brevet")}</b>${ctrl("patents", i)}</div>
    ${inp(`patents.${i}.num`, "Numéro")}${inp(`patents.${i}.title`, "Titre")}${inp(`patents.${i}.detail`, "Statut / déposant", "ex. granted; first inventor")}</div>`).join("");
  const nExp = cv.experience.filter(e => !e.hidden).length;
  const srcs = versions(), tplFirst = [...srcs.filter(x => x.isTemplate), ...srcs.filter(x => !x.isTemplate)];

  $("#pane-edit").innerHTML = [
    `<div class="panel">
      <h2>Version ouverte <small>modifiée ${esc(ago(v.updatedAt))}</small></h2>
      <div class="grid3"><label>Nom de la version<input type="text" id="v-label" data-v="label" value="${esc(v.label)}"></label>
      <label>Entreprise<input type="text" id="v-company" data-v="company" value="${esc(v.company)}" placeholder="ex. Acme Medical"></label>
      <label>Poste visé<input type="text" id="v-role" data-v="role" value="${esc(v.role)}" placeholder="ex. R&D Mechanical Engineer"></label></div>
      <div class="row"><label class="chk"><input type="checkbox" id="v-tpl" data-v="isTemplate" ${v.isTemplate ? "checked" : ""}> Utiliser comme modèle de départ</label>
      <span style="flex:1"></span><button class="btn acc" data-act="newform">+ Nouvelle candidature</button></div>
      ${S.newForm ? `<form class="card newv" id="newv">
        <h3>Nouvelle candidature</h3>
        <label>Partir de<select id="nv-src">${tplFirst.map(x => `<option value="${x.id}" ${x.id === S.curId ? "selected" : ""}>${x.isTemplate ? "★ " : ""}${esc(x.label || "Sans nom")}${x.company ? " · " + esc(x.company) : ""}</option>`).join("")}</select></label>
        <div class="grid3"><label>Entreprise<input type="text" id="nv-company" required></label><label>Poste<input type="text" id="nv-role"></label><label>Nom de la version<input type="text" id="nv-label" placeholder="auto : Entreprise – Poste"></label></div>
        <div class="row"><button class="btn pri" type="submit">Créer et ouvrir</button><button class="btn" type="button" data-act="newcancel">Annuler</button></div></form>` : ""}
    </div>`,
    sec("header", "En-tête", "", inp("name", "Nom") + inp("title", "Titre sous le nom", "ex. R&D Engineer | Technical Lead") +
      ta("contacts", "Coordonnées · une ligne par rangée, éléments séparés par |", 3, true) +
      `<p class="hint">Le titre sous ton nom est lu en premier par les ATS : reprends l'intitulé de l'offre quand il te correspond. L'icône de chaque coordonnée est choisie automatiquement.</p>`),
    sec("summary", "Résumé", `${words(cv.summary)} mots`, ta("summary", "Résumé professionnel", 7) + `<p class="hint">Visé : 50 à 90 mots, avec les 4 ou 5 mots-clés majeurs de l'offre.</p>`),
    sec("experience", "Expérience", `${nExp}/${cv.experience.length} incluses`, exp + add("experience", "Ajouter un poste")),
    sec("education", "Formation", cv.education.length, edu + add("education", "Ajouter une formation")),
    sec("certifications", "Certifications et formations", cv.show.certifications ? cv.certifications.length : "masqué", cb("show.certifications", "Afficher la section") + cer + add("certifications", "Ajouter une certification")),
    sec("skills", "Compétences", cv.skills.length, skl + add("skills", "Ajouter un groupe")),
    sec("languages", "Langues", cv.languages.length, lng + add("languages", "Ajouter une langue")),
    sec("patents", "Brevets", cv.show.patents ? cv.patents.length : "masqué", cb("show.patents", "Afficher la section") + pat + add("patents", "Ajouter un brevet")),
    sec("interests", "Centres d'intérêt", cv.show.interests ? "" : "masqué", cb("show.interests", "Afficher la section") + ta("interests", "Centres d'intérêt", 3)),
    sec("style", "Photo et couleur", "", `<div class="photo">${photo() ? `<img src="${photo()}" alt="Photo du CV">` : `<img alt="">`}
        <div class="row"><button class="btn" data-act="photo">Changer la photo</button></div></div>
      ${cb("show.photo", "Afficher la photo dans cette version")}
      <p class="hint">Les ATS ignorent la photo. Elle reste d'usage en Suisse et en Allemagne ; masque-la pour une candidature anglo-saxonne. La photo est commune à toutes les versions.</p>
      <label>Couleur d'accent<select id="f-accent" data-k="accent">${ACCENTS.map(([c, n]) => `<option value="${c}" ${cv.accent === c ? "selected" : ""}>${n}</option>`).join("")}</select></label>`),
    sec("headings", "Titres des sections", "", `<p class="hint">Garde des intitulés standard (Summary, Experience, Education, Skills) : les parsers découpent le CV grâce à eux. Traduis-les seulement si tout le CV est traduit.</p>
      <div class="grid2">${Object.keys(BLANK.headings).map(k => inp(`headings.${k}`, k)).join("")}</div>`)
  ].join("");
  autosizeAll();
}
function autosize(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; }
function autosizeAll(root) { (root || document).querySelectorAll("textarea[data-bullet]").forEach(autosize); }
function bulletOp(p, fn, focusJ, caret) {
  const v = cur(); if (!v) return; v.cv = fix(v.cv);
  const arr = getP(v.cv, p); if (!Array.isArray(arr)) return;
  fn(arr); S.openSecs.add(p.split(".")[0]); touch({ rerender: true });
  if (focusJ != null) { const el = document.getElementById(`f-${p}.${focusJ}`); if (el) { el.focus(); const c = caret == null ? el.value.length : caret; el.setSelectionRange(c, c); } }
}

/* ---------- ATS ---------- */
function renderAts() {
  const v = cur(); if (!v) return;
  $("#pane-ats").innerHTML = `<div class="cols ats">
    <div class="pane">
      <div class="panel"><h2>Offre d'emploi <small>${v.jobAd ? words(v.jobAd) + " mots" : ""}</small></h2>
        <label>Texte complet de l'offre<textarea id="ad" rows="10" placeholder="Colle ici l'annonce complète (FR, DE ou EN), depuis Workable, LinkedIn ou le site de l'entreprise">${esc(v.jobAd)}</textarea></label>
        <label>Lien de l'offre<input type="url" id="adurl" value="${esc(v.offerUrl)}" placeholder="https://…"></label>
        <div class="row"><button class="btn" data-act="quick">Analyse rapide</button><button class="btn acc" data-act="claude">Analyse avec Claude</button></div>
        <p class="hint">L'analyse rapide repère les termes fréquents de l'offre, hors ligne. L'analyse avec Claude extrait les vrais critères de tri, leurs synonymes FR/DE/EN, et propose des reformulations.</p>
      </div>
      <div class="panel" id="claudebox" ${S.claude ? "" : "hidden"}><h2>Analyse avec Claude</h2>
        <ol class="steps">
          <li><b>Copie le prompt</b><span class="hint">Il contient l'offre, tes champs de CV et les règles : rien d'inventé, ton style, anglais britannique.</span><div class="row"><button class="btn pri" data-act="prompt">Copier le prompt</button></div></li>
          <li><b>Colle-le dans une nouvelle conversation Claude</b><span class="hint"><a href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">claude.ai/new</a> · de préférence hors de tes projets, pour garder l'analyse isolée.</span></li>
          <li><b>Colle sa réponse ici</b><textarea id="answer" rows="5" placeholder='La réponse commence par { "keywords": …'></textarea><div class="row"><button class="btn pri" data-act="import">Importer la réponse</button><span class="hint" id="anserr"></span></div></li>
        </ol></div>
      <div class="panel"><h2>Contrôles de lecture</h2><ul class="checks" id="checks"></ul></div>
    </div>
    <div class="pane">
      <div class="panel" id="scorebox"></div>
      <div class="panel" id="sugbox"></div>
    </div></div>`;
  refreshScore(); renderSuggestions(); renderChecks();
}
function refreshScore() {
  const v = cur(), box = $("#scorebox"); if (!v || !box) return;
  const kws = v.keywords;
  if (!kws || !kws.length) {
    box.innerHTML = `<h2>Score ATS</h2><p class="hint">Colle une offre, puis lance une analyse. Les mots-clés restent attachés à cette version et le score suit chacune de tes modifications.</p>`; return;
  }
  const sc = E.score(fix(v.cv), kws);
  const cls = sc.pct >= 75 ? "" : sc.pct >= 50 ? "mid" : "low";
  const chip = k => `<button class="chip ${k.ok ? "ok" : "no"} ${k.importance === "high" ? "hi" : ""}" data-copy="${esc(k.term)}" title="${esc((k.variants || []).join(", ") || "Copier")}">${esc(k.term)}</button>`;
  const miss = sc.res.filter(k => !k.ok).sort((a, b) => (b.importance === "high") - (a.importance === "high")), hit = sc.res.filter(k => k.ok);
  const unc = (v.uncovered || []).filter(u => u && u.term);
  box.innerHTML = `<h2>Score ATS <span class="src">${v.kwSource === "claude" ? "mots-clés Claude" : "analyse rapide"}</span></h2>
    <div class="score"><span class="pct">${sc.pct}%</span><div class="meter ${cls}"><span style="width:${sc.pct}%"></span></div></div>
    <p class="hint">${sc.hit} mots-clés présents sur ${sc.total} · ● exigence forte, compte double · synonymes et variantes FR/DE/EN reconnus.</p>
    <h3>Manquants (${miss.length})</h3><div class="chips">${miss.map(chip).join("") || '<span class="hint">Aucun.</span>'}</div>
    <h3>Présents (${hit.length})</h3><div class="chips">${hit.map(chip).join("")}</div>
    ${unc.length ? `<h3>Non couverts par ton parcours</h3><ul class="checks">${unc.map(u => `<li><span class="wa-t">!</span><div><b>${esc(u.term)}</b> <span class="why">${esc(u.note || "")}</span></div></li>`).join("")}</ul>
      <p class="hint">À traiter dans la lettre ou en entretien plutôt que dans le CV.</p>` : ""}
    <p class="hint">Ce score mesure la couverture des mots-clés, pas la note d'un ATS précis : chaque logiciel pondère différemment.</p>`;
}
const FIELD_NAME = (cv, path) => {
  const m = path.split(".");
  if (path === "title") return "Titre"; if (path === "summary") return "Résumé";
  if (m[0] === "experience") { const e = cv.experience[+m[1]]; return `${e ? (e.company || e.title) : "Poste"} · puce ${+m[3] + 1}`; }
  if (m[0] === "education") { const e = cv.education[+m[1]]; return `${e ? e.degree : "Formation"} · puce ${+m[3] + 1}`; }
  if (m[0] === "skills") { const s = cv.skills[+m[1]]; return `Compétences · ${s ? s.name : ""}`; }
  return path;
};
function wordDiff(a, b) {
  const A = String(a || "").split(/(\s+)/), B = String(b || "").split(/(\s+)/), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, out = "";
  while (i < n && j < m) { if (A[i] === B[j]) { out += esc(A[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { out += /\S/.test(A[i]) ? `<del>${esc(A[i])}</del>` : esc(A[i]); i++; } else { out += /\S/.test(B[j]) ? `<ins>${esc(B[j])}</ins>` : esc(B[j]); j++; } }
  while (i < n) { out += /\S/.test(A[i]) ? `<del>${esc(A[i])}</del>` : esc(A[i]); i++; }
  while (j < m) { out += /\S/.test(B[j]) ? `<ins>${esc(B[j])}</ins>` : esc(B[j]); j++; }
  return out;
}
const sameText = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();
function renderSuggestions() {
  const v = cur(), box = $("#sugbox"); if (!v || !box) return;
  const list = v.suggestions || [], cv = fix(v.cv);
  if (!list.length) { box.innerHTML = `<h2>Reformulations proposées</h2><p class="hint">Après l'analyse avec Claude, ses propositions s'affichent ici. Rien n'est appliqué sans ton accord : tu peux modifier chaque texte avant de l'appliquer.</p>`; return; }
  const open = list.filter(s => !s.state).length;
  box.innerHTML = `<h2>Reformulations proposées <small>${open} à traiter</small></h2>` + list.map((s, i) => {
    const now = getP(cv, s.path), stale = !s.state && now != null && !sameText(now, s.before), gone = now == null;
    return `<div class="sug ${s.state === "applied" ? "done" : s.state === "skipped" ? "skip" : ""}" data-si="${i}">
      <div class="row"><span class="where">${esc(FIELD_NAME(cv, s.path))}</span><span style="flex:1"></span>${(s.keywords || []).map(k => `<span class="chip ok">${esc(k)}</span>`).join("")}</div>
      <p class="diff">${wordDiff(s.before, s.after)}</p>
      ${s.why ? `<p class="why">${esc(s.why)}</p>` : ""}
      ${s.state ? `<div class="row"><span class="hint">${s.state === "applied" ? "Appliquée" : "Ignorée"}</span><button class="btn sm" data-act="sreset">Annuler ce choix</button></div>` :
        gone ? `<p class="hint">Ce champ n'existe plus dans le CV.</p><div class="row"><button class="btn sm" data-act="sskip">Ignorer</button></div>` :
        `<label>Texte appliqué (modifiable)<textarea rows="3" data-sedit="${i}">${esc(s.after)}</textarea></label>
        ${stale ? `<p class="hint" style="color:var(--warn)">Ce champ a changé depuis l'analyse : appliquer remplacera ton texte actuel.</p>` : ""}
        <div class="row"><button class="btn pri sm" data-act="sapply">Appliquer</button><button class="btn sm" data-act="sskip">Ignorer</button></div>`}
    </div>`;
  }).join("");
}
function renderChecks() {
  const v = cur(), el = $("#checks"); if (!v || !el) return;
  const cv = fix(v.cv), contacts = (cv.contacts || []).join(" "), sw = words(cv.summary);
  const recent = cv.experience.filter(e => !e.hidden).slice(0, 3), thin = recent.filter(e => e.bullets.filter(b => b.trim()).length < 2);
  const std = ["summary", "experience", "education", "skills"].filter(k => !/^(summary|experience|education|skills|profile|work experience|professional experience|zusammenfassung|berufserfahrung|ausbildung|kenntnisse|résumé|expérience|formation|compétences)$/i.test((cv.headings[k] || "").trim()));
  const dates = cv.experience.filter(e => !e.hidden).map(e => e.dates).filter(Boolean), badDates = dates.filter(d => !/^\d{2}\/\d{4}\s*-\s*(\d{2}\/\d{4}|present|current|aujourd'hui|heute)$/i.test(d.trim()));
  const C = [
    [S.pages <= 2 ? "ok" : "no", `${S.pages} page${S.pages > 1 ? "s" : ""}${S.pages > 2 ? " : vise 2 pages maximum" : ""}`],
    [/@/.test(contacts) ? "ok" : "no", /@/.test(contacts) ? "E-mail en texte dans l'en-tête" : "Aucun e-mail dans les coordonnées"],
    [/\d{6,}/.test(contacts.replace(/[\s()+.-]/g, "")) ? "ok" : "no", "Téléphone en texte dans l'en-tête"],
    [cv.title ? "ok" : "wa", cv.title ? "Titre sous le nom renseigné" : "Ajoute un titre sous ton nom"],
    [sw >= 40 && sw <= 100 ? "ok" : "wa", `Résumé de ${sw} mots${sw < 40 ? " : un peu court" : sw > 100 ? " : un peu long" : ""}`],
    [!thin.length ? "ok" : "wa", thin.length ? `Peu de puces pour : ${thin.map(e => e.title).join(", ")}` : "Les 3 postes récents ont au moins 2 puces"],
    [!badDates.length ? "ok" : "wa", badDates.length ? `Format de dates inhabituel : ${badDates.join(" ; ")}` : "Dates au format MM/AAAA - MM/AAAA"],
    [!std.length ? "ok" : "wa", std.length ? `Intitulés non standard : ${std.map(k => cv.headings[k]).join(", ")}` : "Intitulés de sections standard"],
    ["ok", "Texte réel et police intégrée : le PDF est lisible par les parsers (vérifie l'onglet Aperçu & PDF)"]
  ];
  el.innerHTML = C.map(([k, t]) => `<li><span class="${k}-t">${k === "ok" ? "OK" : k === "no" ? "✕" : "!"}</span>${esc(t)}</li>`).join("");
}
function quickAnalyse() {
  const v = cur(); const ad = (v.jobAd || "").trim();
  if (ad.length < 80) { toast("Colle d'abord le texte complet de l'offre."); return; }
  v.keywords = E.quickKeywords(ad); v.kwSource = "quick"; touch(); refreshScore(); toast(`${v.keywords.length} termes repérés`);
}
function buildPrompt(v) {
  const cv = fix(v.cv), F = [];
  F.push(["title", cv.title], ["summary", cv.summary]);
  cv.experience.forEach((e, i) => { if (!e.hidden) e.bullets.forEach((b, j) => b.trim() && F.push([`experience.${i}.bullets.${j}`, b])); });
  cv.education.forEach((e, i) => e.bullets.forEach((b, j) => b.trim() && F.push([`education.${i}.bullets.${j}`, b])));
  cv.skills.forEach((s, i) => F.push([`skills.${i}.text`, `${s.text}`]));
  const ctx = [
    ...cv.experience.filter(e => !e.hidden).map(e => `- ${e.title} | ${e.company} | ${e.location} | ${e.dates}`),
    ...cv.education.map(e => `- ${e.degree} | ${e.school} | ${e.dates} | ${e.grade}`),
    ...cv.certifications.map(c => `- Certification: ${c.title} (${c.issuer}, ${c.date})`),
    ...cv.skills.map((s, i) => `- Skill group skills.${i}: ${s.name}`),
    ...cv.languages.map(l => `- Language: ${l.name} ${l.level}`),
    ...cv.patents.map(p => `- Patent: ${p.num} ${p.title} (${p.detail || ""})`)
  ].join("\n");
  return `You are helping me tailor my CV to a job ad so that applicant tracking systems (ATS) and recruiters find the right keywords. Work only from the facts in my CV.

TASK 1 - keywords: extract the 15 to 25 terms an ATS would most likely screen for: hard skills, tools and software, methods, standards and regulations, domain terms, degree, spoken languages, and the job title. "term" uses the ad's own wording. "variants" lists synonyms, abbreviations and English/French/German equivalents a CV might use instead (e.g. "FMEA" / "AMDEC" / "FMEA-Analyse"). importance is "high" when the ad requires it explicitly, repeats it, or puts it in the title; otherwise "medium".

TASK 2 - suggestions: propose at most 8 edits that improve keyword coverage and relevance for this ad. Each edit rewrites ONE existing field, identified by its path from the list below. Strict rules:
- Never invent experience, tools, figures, results, employers, certifications or responsibilities. Only rephrase what the field, or another part of my CV, already states.
- Add a keyword only where my CV already evidences it (the same thing under another name, or clearly described). If it is not evidenced, do not add it: list it in "uncovered".
- Keep my voice: minimal edits, British English, no buzzwords or superlatives, factual and concise, bullets under about 200 characters.
- Do not change dates, employers or past job titles. The headline ("title") and the "summary" may be adapted to the role.
- "before" must be copied exactly from the field; "after" is the full new text of that field.
- Prioritise "high" keywords and the most recent roles.

TASK 3 - uncovered: requirements of the ad that my CV does not support, each with a one-sentence note in French saying whether it is a real gap or just unstated.

Answer with JSON only, in a single code block, in exactly this shape:
{"keywords":[{"term":"","importance":"high","variants":[""]}],"suggestions":[{"path":"","before":"","after":"","keywords":[""],"why":"one sentence in French"}],"uncovered":[{"term":"","note":"in French"}]}

JOB AD:
<<<
${(v.jobAd || "").trim().slice(0, 14000)}
>>>

MY CV - EDITABLE FIELDS (path => text):
${F.map(([p, t]) => `${p} => ${String(t || "").replace(/\s+/g, " ").trim()}`).join("\n")}

MY CV - CONTEXT (read only):
${ctx}`;
}
function importAnswer() {
  const v = cur(), raw = ($("#answer").value || "").trim(), err = $("#anserr");
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  let j = null; try { j = JSON.parse(raw.slice(a, b + 1)); } catch (_) {}
  if (!j || !Array.isArray(j.keywords)) { err.textContent = "Réponse illisible : colle le bloc JSON complet renvoyé par Claude."; return; }
  const cv = fix(v.cv);
  v.keywords = j.keywords.filter(k => k && k.term).slice(0, 30).map(k => ({ term: String(k.term), importance: k.importance === "high" ? "high" : "medium", variants: (k.variants || []).map(String).filter(Boolean).slice(0, 10) }));
  v.suggestions = (Array.isArray(j.suggestions) ? j.suggestions : []).filter(s => s && typeof s.path === "string" && typeof s.after === "string" && getP(cv, s.path) != null && typeof getP(cv, s.path) === "string")
    .slice(0, 12).map(s => ({ path: s.path, before: String(s.before || getP(cv, s.path)), after: s.after.trim(), keywords: (s.keywords || []).map(String).slice(0, 6), why: String(s.why || ""), state: null }));
  v.uncovered = (Array.isArray(j.uncovered) ? j.uncovered : []).filter(u => u && u.term).slice(0, 12).map(u => ({ term: String(u.term), note: String(u.note || "") }));
  v.kwSource = "claude"; S.claude = false; err.textContent = "";
  touch(); renderAts();
  toast(`${v.keywords.length} mots-clés, ${v.suggestions.length} reformulations importées`);
}
function applySuggestion(i) {
  const v = cur(), s = v.suggestions[i]; if (!s) return;
  const ta = document.querySelector(`[data-sedit="${i}"]`), text = (ta ? ta.value : s.after).trim();
  if (!text) { toast("Le texte appliqué est vide."); return; }
  v.cv = fix(v.cv); setP(v.cv, s.path, text);
  s.after = text; s.state = "applied"; touch(); renderSuggestions(); refreshScore(); toast("Reformulation appliquée");
}

/* ---------- PDF ---------- */
let pdfT = null, pdfRun = 0;
function fileName(v) {
  const last = (fix(v.cv).name || "CV").trim().split(/\s+/).pop().toUpperCase();
  const slug = String(v.company || (v.isTemplate ? "" : v.label) || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase().slice(0, 40);
  return `CV_${last}${slug ? "_" + slug : ""}.pdf`;
}
function renderPdf() {
  const v = cur(); if (!v) return;
  $("#pane-pdf").innerHTML = `<div class="cols pv">
    <div class="desk"><div class="ruler"><span id="pvinfo">A4 · 210 × 297 mm</span><span>Rendu du PDF exporté</span></div><div class="sheets" id="sheets"><p class="hint">Génération…</p></div></div>
    <div class="pane stick">
      <div class="panel"><h2>Exporter</h2>
        <label>Nom du fichier<input type="text" id="fname" value="${esc(v.fileName || fileName(v))}"></label>
        <div class="row"><button class="btn acc" data-act="export">Télécharger le PDF</button><span class="hint" id="pdfmeta"></span></div>
      </div>
      <div class="panel"><h2>Ce que lit un parser</h2>
        <p class="hint">Texte extrait du PDF généré, dans l'ordre où il est écrit. C'est ce que reçoit un ATS.</p>
        <ul class="checks" id="pchecks"></ul>
        <details><summary class="hint" style="cursor:pointer">Voir le texte extrait</summary><div class="row" style="margin:8px 0"><button class="btn sm" data-act="copytxt">Copier</button></div><pre class="txt" id="ptxt"></pre></details>
      </div>
    </div></div>`;
  S.pdfDirty = true; schedulePdf(0);
}
function schedulePdf(ms) { if (S.tab !== "pdf") return; clearTimeout(pdfT); pdfT = setTimeout(genPdf, ms == null ? 450 : ms); }
async function genPdf() {
  const v = cur(), host = $("#sheets"); if (!v || !host) return;
  const run = ++pdfRun;
  let out;
  try { out = E.pdfBytes(fix(v.cv), { photo: photo() }); } catch (e) { host.innerHTML = `<p class="hint">Génération impossible : ${esc(e.message || e)}</p>`; return; }
  S.pdf = out; S.pdfDirty = false;
  $("#pvinfo").textContent = `A4 · ${out.pages} page${out.pages > 1 ? "s" : ""} · ${Math.round(out.bytes.length / 1024)} Ko`;
  if (!window.pdfjsLib) { host.innerHTML = `<p class="hint">Aperçu indisponible (pdf.js non chargé). L'export fonctionne quand même.</p>`; return; }
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: out.bytes.slice() }).promise;
    if (run !== pdfRun) return;
    const w = Math.min(host.clientWidth || 800, 820), dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvases = [];
    let text = "";
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), vp0 = page.getViewport({ scale: 1 }), scale = w / vp0.width, vp = page.getViewport({ scale: scale * dpr });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; c.style.width = w + "px"; c.style.height = (vp0.height * scale) + "px";
      c.setAttribute("role", "img"); c.setAttribute("aria-label", `Page ${n} du CV`);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      canvases.push(c);
      const tc = await page.getTextContent(); let lastY = null;
      for (const it of tc.items) { if (!("str" in it)) continue; const y = Math.round(it.transform[5]); if (lastY !== null) text += Math.abs(y - lastY) > 2 ? "\n" : (it.str && !/\s$/.test(text) ? " " : ""); text += it.str; lastY = y; }
      text += "\n\n";
      if (run !== pdfRun) return;
    }
    host.replaceChildren(...canvases);
    S.pdfText = text.trim(); renderParse();
  } catch (e) { host.innerHTML = `<p class="hint">Aperçu impossible : ${esc(e.message || e)}. L'export fonctionne quand même.</p>`; }
}
function renderParse() {
  const v = cur(), t = S.pdfText || "", el = $("#pchecks"); if (!el) return;
  const cv = fix(v.cv), first = t.split("\n").find(l => l.trim()) || "";
  const mail = (cv.contacts.join(" ").match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0], phone = (cv.contacts.join(" ").match(/\+?[\d][\d\s]{7,}\d/) || [])[0];
  const heads = ["summary", "experience", "education", "skills"].map(k => (cv.headings[k] || "").toUpperCase()).filter(Boolean);
  const found = heads.filter(h => new RegExp("(^|\\n)" + h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\n|$)").test(t)), allFound = found.length === heads.length;
  const sData = E.score(cv, v.keywords), sPdf = E.score(cv, v.keywords, t);
  const C = [
    [first.trim().toUpperCase() === String(cv.name || "").toUpperCase() ? "ok" : "no", `Première ligne : « ${first.trim().slice(0, 40)} »`],
    [mail && t.includes(mail) ? "ok" : "no", mail ? `E-mail extrait intact (${mail})` : "Aucun e-mail trouvé"],
    [phone && t.replace(/\s/g, "").includes(phone.replace(/\s/g, "")) ? "ok" : "no", phone ? "Téléphone extrait intact" : "Aucun téléphone trouvé"],
    [allFound ? "ok" : "wa", allFound ? "Intitulés Summary, Experience, Education et Skills trouvés, chacun sur sa ligne" : `Intitulés introuvables : ${heads.filter(h => !found.includes(h)).join(", ")}`],
    [!/[�]/.test(t) ? "ok" : "no", /[�]/.test(t) ? "Caractères illisibles dans le texte extrait" : "Aucun caractère illisible"],
    [v.keywords && v.keywords.length ? (sPdf.pct === sData.pct ? "ok" : "wa") : "wa", v.keywords && v.keywords.length ? `Score sur le texte extrait : ${sPdf.pct} % (éditeur : ${sData.pct} %)` : "Lance une analyse ATS pour vérifier les mots-clés dans le PDF"]
  ];
  el.innerHTML = C.map(([k, x]) => `<li><span class="${k}-t">${k === "ok" ? "OK" : k === "no" ? "✕" : "!"}</span>${esc(x)}</li>`).join("");
  const pre = $("#ptxt"); if (pre) pre.textContent = t;
}
function exportPdf() {
  const v = cur(); if (!v) return;
  let name = ($("#fname").value || fileName(v)).trim(); if (!/\.pdf$/i.test(name)) name += ".pdf";
  let out; try { out = E.pdfBytes(fix(v.cv), { photo: photo() }); } catch (e) { toast("Export impossible : " + (e.message || e)); return; }
  const url = URL.createObjectURL(new Blob([out.bytes], { type: "application/pdf" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  if (v.fileName !== name) { v.fileName = name; touch(); }
  $("#pdfmeta").textContent = `${name} téléchargé`;
}

/* ---------- APPLICATIONS ---------- */
function renderApps() {
  const list = versions(), tpl = list.filter(v => v.isTemplate), apps = list.filter(v => !v.isTemplate);
  const count = k => apps.filter(v => (v.status || "draft") === k).length;
  const shown = apps.filter(v => S.filter === "all" || (v.status || "draft") === S.filter);
  const card = v => {
    const sc = v.keywords && v.keywords.length ? E.score(fix(v.cv), v.keywords).pct : null;
    const scc = sc == null ? "na" : sc >= 75 ? "hi" : sc >= 50 ? "mid" : "lo", st = v.status || "draft", more = S.more.has(v.id);
    return `<div class="app ${v.id === S.curId ? "cur" : ""}" data-id="${v.id}">
      <div class="t">${esc(v.company || v.label || "Sans nom")}${v.isTemplate ? '<span class="star" title="Modèle">★</span>' : ""}</div>
      <span class="sc ${scc}" title="Score ATS">${sc == null ? "pas d'offre" : sc + " %"}</span>
      <div class="s">${esc([v.role, v.company ? v.label : ""].filter(Boolean).join(" · ") || v.label || "")} · modifiée ${esc(ago(v.updatedAt))}</div>
      ${v.isTemplate ? "" : `<div class="meta">
        <select class="st st-${st}" data-f="status" aria-label="Statut">${STATUSES.map(([k, l]) => `<option value="${k}" ${k === st ? "selected" : ""}>${l}</option>`).join("")}</select>
        <label class="chk" style="font-size:13px;color:var(--muted)">Envoyée le <input type="date" data-f="appliedAt" value="${esc(v.appliedAt || "")}"></label>
        ${v.offerUrl ? `<a class="hint" href="${esc(v.offerUrl)}" target="_blank" rel="noopener noreferrer">Voir l'offre ↗</a>` : ""}</div>`}
      <div class="acts"><button class="btn sm pri" data-act="open">Ouvrir</button><button class="btn sm" data-act="dup">Dupliquer</button>
        <button class="btn sm" data-act="tpl">${v.isTemplate ? "Retirer des modèles" : "En faire un modèle"}</button>
        ${v.isTemplate ? "" : `<button class="btn sm" data-act="more">${more ? "Masquer les notes" : "Notes"}</button>`}
        <button class="btn sm" data-act="vdel">Supprimer</button></div>
      ${more ? `<div class="more"><label>Lien de l'offre<input type="url" data-f="offerUrl" value="${esc(v.offerUrl || "")}"></label><label>Notes (contacts, échéances, retours)<textarea rows="3" data-f="notes">${esc(v.notes || "")}</textarea></label></div>` : ""}
    </div>`;
  };
  $("#pane-apps").innerHTML = `
    <div class="filters">${[["all", "Toutes", apps.length], ...STATUSES.map(([k, l]) => [k, l, count(k)])].map(([k, l, n]) => `<button class="fchip ${S.filter === k ? "on" : ""}" data-filter="${k}">${l}<span>${n}</span></button>`).join("")}</div>
    <div class="apps">${shown.map(card).join("") || `<div class="empty">${apps.length ? "Aucune candidature avec ce statut." : "Aucune candidature encore. Ouvre un modèle et crée une nouvelle candidature depuis l'onglet Éditer."}</div>`}</div>
    <h3>Modèles (${tpl.length})</h3><div class="apps">${tpl.map(card).join("") || `<div class="empty">Aucun modèle. Coche « Utiliser comme modèle » sur une version pour la proposer comme point de départ.</div>`}</div>`;
}
async function newVersion(src, meta) {
  const id = mkid(), now = Date.now();
  const d = { label: meta.label, company: meta.company || "", role: meta.role || "", isTemplate: false, status: "draft", createdAt: now, updatedAt: now,
    cv: clone(fix(src.cv)), jobAd: "", offerUrl: "", keywords: null, kwSource: null, suggestions: [], uncovered: [], notes: "", fromId: src.id };
  try { await put("versions", id, d); S.curId = id; try { localStorage.setItem("cvb-cur", id); } catch (_) {} S.newForm = false; render(); toast(`« ${d.label} » créée`); }
  catch (e) { toast(e.message || "Création impossible."); }
}
async function removeVersion(id) {
  const v = Store.get("versions", id); if (!v) return;
  if (versions().length < 2) { toast("Garde au moins une version."); return; }
  try { await del("versions", id); if (S.curId === id) S.curId = null; render(); toast(`« ${v.label || v.company} » supprimée`); } catch (e) { toast(e.message || "Suppression impossible."); }
}

/* ---------- photo ---------- */
function setPhoto(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const im = new Image();
    im.onload = async () => {
      const N = 360, c = document.createElement("canvas"); c.width = c.height = N; const g = c.getContext("2d");
      g.fillStyle = "#24405c"; g.fillRect(0, 0, N, N);
      const m = Math.min(im.width, im.height); g.save(); g.beginPath(); g.arc(N / 2, N / 2, N / 2 - 1, 0, Math.PI * 2); g.clip();
      g.fillStyle = "#fff"; g.fillRect(0, 0, N, N); g.drawImage(im, (im.width - m) / 2, (im.height - m) / 2, m, m, 0, 0, N, N); g.restore();
      try { await put("profile", "photo", { data: c.toDataURL("image/jpeg", 0.88), updatedAt: Date.now() }); S.pdfDirty = true; renderPane(); refreshLive(); toast("Photo mise à jour"); }
      catch (e) { toast(e.message || "Enregistrement de la photo impossible."); }
    };
    im.onerror = () => toast("Image illisible. Essaie un JPEG ou un PNG.");
    im.src = fr.result;
  };
  fr.readAsDataURL(file);
}

/* ---------- events ---------- */
const editing = () => { const a = document.activeElement; return a && $("#main").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== "checkbox"; };
let pendingRemote = false;
function remoteChanged() { if (editing()) { pendingRemote = true; return; } render(); }
document.addEventListener("focusout", () => setTimeout(() => { if (pendingRemote && !editing()) { pendingRemote = false; render(); } }, 0));
function afterData() { render(); }

$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  S.tab = b.dataset.tab; try { localStorage.setItem("cvb-tab", S.tab); } catch (_) {}
  renderTabs(); renderPane(); window.scrollTo({ top: 0 });
});
$("#vsel").addEventListener("change", e => { S.curId = e.target.value; try { localStorage.setItem("cvb-cur", S.curId); } catch (_) {} S.newForm = false; render(); });
$("#logout").addEventListener("click", async () => { await SB.auth.signOut(); Store.clear(); S.curId = null; render(); });

$("#main").addEventListener("input", e => {
  const el = e.target, v = cur(); if (!v) return;
  if (el.dataset.k) {
    v.cv = fix(v.cv); let val;
    if (el.type === "checkbox") val = el.dataset.inv ? !el.checked : el.checked;
    else if (el.dataset.lines) val = el.value.split("\n");
    else if (el.dataset.num) val = +el.value;
    else val = el.value;
    setP(v.cv, el.dataset.k, val);
    const k = el.dataset.k;
    if (/^(experience|education|certifications|skills|languages|patents)\.\d+\.(title|degree|name|num)$/.test(k)) { const b = el.closest(".card")?.querySelector(".chead b"); if (b) b.textContent = el.value || "…"; }
    if (el.dataset.bullet) autosize(el);
    if (k === "summary") { const sm = el.closest("details")?.querySelector("summary small"); if (sm) sm.textContent = `${words(el.value)} mots`; }
    touch({ rerender: el.type === "checkbox" });
  } else if (el.dataset.v) {
    v[el.dataset.v] = el.type === "checkbox" ? el.checked : el.value; touch(); renderBar();
  } else if (el.id === "ad") { v.jobAd = el.value; touch(); }
  else if (el.id === "adurl") { v.offerUrl = el.value.trim(); touch(); }
  else if (el.dataset.sedit != null) { /* edited suggestion text is read on apply */ }
  else if (el.dataset.f) {
    const id = el.closest("[data-id]").dataset.id, x = Store.get("versions", id); if (!x) return;
    x[el.dataset.f] = el.value;
    if (el.dataset.f === "status") { el.className = "st st-" + el.value; if (el.value === "sent" && !x.appliedAt) x.appliedAt = new Date().toISOString().slice(0, 10); }
    clearTimeout(x._t); x._t = setTimeout(() => { delete x._t; saveVersion({ id, ...x }); if (el.dataset.f === "status") renderApps(); }, el.tagName === "SELECT" ? 0 : 700);
  }
});
$("#main").addEventListener("toggle", e => { const d = e.target; if (d.dataset && d.dataset.sec) { d.open ? S.openSecs.add(d.dataset.sec) : S.openSecs.delete(d.dataset.sec); if (d.open) autosizeAll(d); } }, true);
$("#main").addEventListener("keydown", e => {
  const el = e.target; if (!el.dataset || !el.dataset.bullet || e.isComposing) return;
  const m = el.dataset.k.match(/^(.*)\.(\d+)$/); if (!m) return;
  const p = m[1], j = +m[2];
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const a = el.selectionStart, before = el.value.slice(0, a).trimEnd(), after = el.value.slice(el.selectionEnd).trimStart();
    bulletOp(p, arr => { arr[j] = before; arr.splice(j + 1, 0, after); }, j + 1, 0);
  } else if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0 && j > 0) {
    e.preventDefault();
    const prevLen = (getP(cur().cv, p)[j - 1] || "").length;
    bulletOp(p, arr => { arr[j - 1] = (arr[j - 1] || "") + (el.value ? (arr[j - 1] ? " " : "") + el.value : ""); arr.splice(j, 1); }, j - 1, prevLen);
  }
});
$("#main").addEventListener("submit", e => {
  e.preventDefault();
  if (e.target.id === "login") return signIn(e);
  if (e.target.id === "newv") {
    const src = Store.get("versions", $("#nv-src").value); if (!src) return;
    const company = $("#nv-company").value.trim(), role = $("#nv-role").value.trim();
    if (!company) { $("#nv-company").focus(); return; }
    newVersion({ ...src, id: $("#nv-src").value }, { company, role, label: $("#nv-label").value.trim() || [company, role].filter(Boolean).join(" – ") });
  }
});
$("#main").addEventListener("click", async e => {
  const chip = e.target.closest("[data-copy]"); if (chip) { copy(chip.dataset.copy, `« ${chip.dataset.copy} » copié`); return; }
  const fb = e.target.closest("[data-filter]"); if (fb) { S.filter = fb.dataset.filter; renderApps(); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, v = cur();
  if (act === "signup") return signUp();
  if (act === "logout") { await SB.auth.signOut(); Store.clear(); render(); return; }
  if (act === "seed") { $("#seedIn").click(); return; }
  if (act === "blank") { const id = mkid(), now = Date.now(); try { await put("versions", id, { label: "CV vierge", company: "", role: "", isTemplate: true, status: "draft", createdAt: now, updatedAt: now, cv: clone(BLANK), jobAd: "", offerUrl: "", keywords: null, suggestions: [], uncovered: [], notes: "" }); S.curId = id; render(); } catch (err) { toast(err.message || "Création impossible."); } return; }
  if (act === "photo") { $("#photoIn").click(); return; }
  if (act === "newform") { S.newForm = true; renderEdit(); setTimeout(() => $("#nv-company")?.focus(), 0); return; }
  if (act === "newcancel") { S.newForm = false; renderEdit(); return; }
  if (["add", "up", "down", "rm"].includes(act) && v) {
    v.cv = fix(v.cv); const list = b.dataset.list, i = +b.dataset.i, arr = v.cv[list];
    const T = { experience: () => ({ title: "", company: "", location: "", dates: "", hidden: false, bullets: [""] }), education: () => ({ degree: "", school: "", dates: "", grade: "", bullets: [] }),
      certifications: () => ({ title: "", issuer: "", date: "" }), skills: () => ({ name: "", text: "" }), languages: () => ({ name: "", level: "", dots: 3 }), patents: () => ({ num: "", title: "", detail: "" }) };
    if (act === "add") { arr.push(T[list]()); S.openSecs.add(list); touch({ rerender: true }); }
    else if (act === "up" && i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; touch({ rerender: true }); }
    else if (act === "down" && i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; touch({ rerender: true }); }
    else if (act === "rm") arm(b, () => { arr.splice(i, 1); touch({ rerender: true }); });
    return;
  }
  if (act === "badd") { const p = b.dataset.p, n = (getP(fix(v.cv), p) || []).length; bulletOp(p, arr => arr.push(""), n); return; }
  if (act === "brm") { const p = b.dataset.p, j = +b.dataset.j; arm(b, () => bulletOp(p, arr => arr.splice(j, 1))); return; }
  if (act === "quick") return quickAnalyse();
  if (act === "claude") { if ((v.jobAd || "").trim().length < 80) { toast("Colle d'abord le texte complet de l'offre."); return; } S.claude = true; $("#claudebox").hidden = false; $("#claudebox").scrollIntoView({ block: "nearest" }); return; }
  if (act === "prompt") return copy(buildPrompt(v), "Prompt copié : colle-le dans Claude");
  if (act === "import") return importAnswer();
  const si = b.closest("[data-si]")?.dataset.si;
  if (si != null && v) {
    const s = v.suggestions[+si];
    if (act === "sapply") return applySuggestion(+si);
    if (act === "sskip") { s.state = "skipped"; touch(); renderSuggestions(); return; }
    if (act === "sreset") { s.state = null; touch(); renderSuggestions(); return; }
  }
  if (act === "export") return exportPdf();
  if (act === "copytxt") return copy(S.pdfText, "Texte extrait copié");
  const id = b.closest("[data-id]")?.dataset.id;
  if (id) {
    const x = Store.get("versions", id); if (!x) return;
    if (act === "open") { S.curId = id; try { localStorage.setItem("cvb-cur", id); } catch (_) {} S.tab = "edit"; render(); window.scrollTo({ top: 0 }); return; }
    if (act === "dup") { newVersion({ ...x, id }, { company: x.company, role: x.role, label: (x.label || "Version") + " (copie)" }); return; }
    if (act === "tpl") { x.isTemplate = !x.isTemplate; await saveVersion({ id, ...x }, x.isTemplate ? "Ajoutée aux modèles" : "Retirée des modèles"); render(); return; }
    if (act === "more") { S.more.has(id) ? S.more.delete(id) : S.more.add(id); renderApps(); return; }
    if (act === "vdel") { arm(b, () => removeVersion(id)); return; }
  }
});
$("#seedIn").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) importSeed(f); });
$("#photoIn").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) setPhoto(f); });
addEventListener("resize", () => { if (S.tab === "pdf") schedulePdf(); });
addEventListener("beforeunload", e => { if (saveT && $("#save").textContent === "Modifié…") { flush(S.curId); e.preventDefault(); } });

/* ---------- boot ---------- */
(async () => {
  Store.load();
  if (!SB) { render(); return; }
  const { data: { session } } = await SB.auth.getSession();
  Store.user = session ? session.user : null;
  if (!Store.user) Store.clear();
  render();
  if (Store.user) { pull(); listen(); }
  SB.auth.onAuthStateChange((_e, sess) => {
    const was = Store.user && Store.user.id; Store.user = sess ? sess.user : null; Store.member = true;
    if (Store.user && Store.user.id !== was) { pull(); listen(); }
    if (!Store.user) Store.clear();
    render();
  });
  if (document.fonts) document.fonts.ready.then(() => { if (S.tab === "pdf") schedulePdf(0); });
})();
