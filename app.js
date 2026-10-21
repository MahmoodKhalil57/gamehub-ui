/* GameHub — a tiny party-game platform on pure HTML/JS/CSS + Supabase.
   No build step, no backend server: Row-Level Security in Postgres is the backend. */
(() => {
  "use strict";
  const cfg = window.GAMEHUB_CONFIG || {};
  const app = document.getElementById("app");
  const nav = document.getElementById("navlinks");
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT") && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");
  const db = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  let user = null;
  const isDev = () => !!user && !user.is_anonymous;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "game";
  const go = hash => { location.hash = hash; };
  const setHTML = html => { app.innerHTML = html; window.scrollTo(0, 0); };
  const $ = id => document.getElementById(id);

  let toastTimer;
  function toast(msg, bad) {
    const t = $("toast"); if (!t) return;
    t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------------------------------------------------------------- art */
  // Poster covers, one per engine. Drawn in SVG so they stay sharp and weigh nothing.
  const rays = (cx, cy, n, fill) => {
    let d = "";
    for (let i = 0; i < n; i += 2) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2, R = 600;
      d += `M${cx},${cy}L${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)}L${(cx + R * Math.cos(b)).toFixed(1)},${(cy + R * Math.sin(b)).toFixed(1)}Z`;
    }
    return `<path d="${d}" fill="${fill}"/>`;
  };
  const MASK = `<path d="M8,22 C14,6 40,4 50,16 C60,4 86,6 92,22 C96,36 84,46 70,44 C60,43 55,36 50,32 C45,36 40,43 30,44 C16,46 4,36 8,22 Z M24,22 C20,26 24,32 32,31 C38,30 40,25 38,22 C34,18 28,18 24,22 Z M76,22 C72,18 66,18 62,22 C60,25 62,30 68,31 C76,32 80,26 76,22 Z" fill-rule="evenodd"/>`;
  const ART = {
    laws: `<svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="400" height="200" fill="#8e1b1b"/>${rays(290, 120, 36, "#a3302a")}
      <g transform="translate(282 108) rotate(-32)"><rect x="-8" y="0" width="16" height="118" rx="6" fill="#e0ad45" stroke="#16130f" stroke-width="4"/>
        <rect x="-52" y="-34" width="104" height="44" rx="10" fill="#fbf6ea" stroke="#16130f" stroke-width="4"/><rect x="-60" y="-38" width="14" height="52" rx="5" fill="#e0ad45" stroke="#16130f" stroke-width="4"/><rect x="46" y="-38" width="14" height="52" rx="5" fill="#e0ad45" stroke="#16130f" stroke-width="4"/></g>
      <rect x="196" y="160" width="130" height="24" rx="6" fill="#fbf6ea" stroke="#16130f" stroke-width="4"/>
      <g transform="translate(22 106) rotate(-7)"><text font-family="Anton, Impact, sans-serif" font-size="52" fill="#fbf6ea" stroke="#16130f" stroke-width="3" paint-order="stroke">OBJECTION!</text></g>
      <g transform="translate(28 140) rotate(-7)"><text font-family="Space Mono, monospace" font-weight="700" font-size="13" letter-spacing="3" fill="#e0ad45">KEEP IT · STRIKE IT</text></g></svg>`,
    friends: `<svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="#ff2e88" opacity=".35"/></pattern>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <rect width="400" height="200" fill="#0d0a12"/><rect width="400" height="200" fill="url(#dots)"/>
      <g transform="translate(150 46) scale(2.3)" fill="#ff2e88" filter="url(#glow)">${MASK}</g>
      <g transform="translate(36 120) rotate(-14) scale(1)" fill="#39f3c2" filter="url(#glow)" opacity=".9">${MASK}</g>
      <g transform="translate(300 18) rotate(12) scale(.8)" fill="#b6ff3b" filter="url(#glow)" opacity=".8">${MASK}</g>
      <text x="200" y="186" text-anchor="middle" font-family="Anton, Impact, sans-serif" font-size="30" letter-spacing="2" fill="#b6ff3b" filter="url(#glow)">WHO'S WHO?</text></svg>`,
    deal: `<svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="400" height="200" fill="#0f3b2e"/>
      <g stroke="#ffffff" stroke-opacity=".05">${Array.from({ length: 20 }, (_, i) => `<line x1="0" x2="400" y1="${i * 10}" y2="${i * 10}"/>`).join("")}</g>
      <g transform="translate(190 30) rotate(8)"><rect width="150" height="190" fill="#fbf7ec" stroke="#000" stroke-width="4"/><rect x="0" y="0" width="10" height="190" fill="#c26a12"/>
        <g stroke="#10241c" stroke-width="4" stroke-linecap="round"><line x1="26" y1="30" x2="124" y2="30"/><line x1="26" y1="50" x2="110" y2="50"/><line x1="26" y1="70" x2="120" y2="70"/><line x1="26" y1="90" x2="96" y2="90"/></g>
        <path d="M28 132 c12 -18 20 10 30 -6 s14 -14 22 4 s18 -6 26 -2" fill="none" stroke="#1f5fbf" stroke-width="4" stroke-linecap="round"/><line x1="24" y1="146" x2="128" y2="146" stroke="#10241c" stroke-width="2" stroke-dasharray="5 4"/></g>
      <g transform="translate(330 54) rotate(14)"><circle r="34" fill="#e7b53b" stroke="#000" stroke-width="4"/><circle r="24" fill="none" stroke="#7a5810" stroke-width="3" stroke-dasharray="4 4"/><text y="9" text-anchor="middle" font-family="Anton, Impact, sans-serif" font-size="24" fill="#3d2a00">$</text></g>
      <g transform="translate(26 104) rotate(-5)"><text font-family="Anton, Impact, sans-serif" font-size="46" fill="#e7b53b" stroke="#000" stroke-width="3" paint-order="stroke">SIGN HERE</text></g>
      <g transform="translate(30 140) rotate(-5)"><text font-family="Space Mono, monospace" font-weight="700" font-size="13" letter-spacing="3" fill="#f4efe1">OR WALK AWAY</text></g></svg>`,
    generic: `<svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="400" height="200" fill="#ffcf33"/>${rays(200, 100, 40, "#ffbe1a")}
      <g transform="translate(200 100) rotate(-12)"><rect x="-48" y="-48" width="96" height="96" rx="20" fill="#ff4a1c" stroke="#16130f" stroke-width="5"/><circle cx="-22" cy="-22" r="9" fill="#16130f"/><circle r="9" fill="#16130f"/><circle cx="22" cy="22" r="9" fill="#16130f"/></g></svg>`
  };
  // Facts the game page shows for each built-in engine.
  const META = {
    laws: { players: "2–16", mins: "10–20 min", judge: "Crowd or AI judge", steps: [
      ["Draw a law", "A real (reportedly) dumb law lands on the table, plus a twist rule for the round."],
      ["Pick a side", "Your team is told to defend it or tear it down. You don't get to choose."],
      ["Argue", "Make your case in the chat before the clock runs out. Wit counts as much as logic."],
      ["Verdict", "The room votes, or the AI judge scores both sides. Sides swap every round."]] },
    friends: { players: "3–16", mins: "5–10 min", judge: "Sealed votes", steps: [
      ["Masks on", "Everyone gets a random alias. Nobody knows who is who."],
      ["Secret roles", "One player is the Saviour. Their job: make one unknowing Survivor pick them."],
      ["Chat carefully", "You get 12 messages. You can seal one accusation of who the Saviour is."],
      ["Masks off", "Everyone names their true friend. Then every alias is revealed."]] },
    deal: { players: "2–16", mins: "8–15 min", judge: "Crowd or AI judge", steps: [
      ["Open the file", "Two teams, one deal. Each team gets a confidential brief nobody else sees."],
      ["Know your limits", "Your brief has an ideal outcome, a walk-away point and hidden leverage."],
      ["Negotiate", "Chat freely, then put formal offers on the record. Breaking news may change everything."],
      ["Sign or walk", "Accept their offer to close. The judge rewards good deals and punishes unreasonable ones."]] }
  };
  const engineOf = g => (g.config?.engine && ART[g.config.engine]) ? g.config.engine : "generic";
  const metaChips = (eng) => { const m = META[eng]; return m ? `<div class="meta"><span>${m.players} players</span><span>${m.mins}</span><span>${m.judge}</span></div>` : ""; };

  function renderNav() {
    if (!configured) { nav.innerHTML = ""; return; }
    nav.innerHTML = isDev()
      ? `<a href="#/">Games</a><a href="#/dev">My games</a><a href="#" id="logout">Log out</a>`
      : `<a href="#/">Games</a><a href="#/login">Make games</a>`;
    const lo = $("logout");
    if (lo) lo.onclick = async e => { e.preventDefault(); await db.auth.signOut(); user = null; renderNav(); go("#/"); };
  }

  /* ---------------------------------------------------------------- views */
  function notConfigured() {
    setHTML(`<div class="banner"><strong>Almost there.</strong> Edit <code>config.js</code> with your Supabase
      <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> (Dashboard → Project Settings → API), and run
      <code>supabase/schema.sql</code> once in the SQL editor. Reload and the platform comes alive.</div>`);
  }

  // Wires any join-code box on the page.
  function wireJoin(inputId, btnId) {
    const inp = $(inputId), btn = $(btnId);
    if (!inp) return;
    inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5); };
    const join = () => { const c = inp.value.trim(); if (/^[A-Z0-9]{5}$/.test(c)) go("#/play/" + c); else { toast("Room codes are 5 letters or numbers.", true); inp.focus(); } };
    btn.onclick = join;
    inp.onkeydown = e => { if (e.key === "Enter") join(); };
  }
  async function host(g, btn) {
    if (btn) btn.disabled = true;
    try { await window.GHPlay.createRoom(g); }
    catch (e) { toast(e.message, true); if (btn) btn.disabled = false; }
  }

  async function viewMarketplace() {
    const tape = ["It is illegal to <b>whistle underwater</b>", "One of you is <b>lying</b>", "Sign here or <b>walk away</b>", "Order in the court", "Trust <b>nobody</b>",
      "Best argument wins", "Four offers. <b>No refunds.</b>", "The judge has <b>no chill</b>"];
    const tapeHTML = tape.concat(tape).map(t => `<span>${t}</span><span>✶</span>`).join("");
    setHTML(`<section class="hero">
        <div><h1>Argue.<br>Lie.<br><span class="hl">Deal.</span></h1>
          <p class="lead">Party games for the phones already in your pocket. One person hosts, everyone else types a <b>five-letter code</b>. No app, no account.</p></div>
        <div class="joinbox"><h3>Got a code?</h3><input id="code" class="codein" maxlength="5" placeholder="ABCDE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Room code">
          <button class="big ink" id="join">Join the room</button></div>
      </section>
      <div class="ticker" aria-hidden="true"><div>${tapeHTML}</div></div>
      <div class="sechead"><h2>Tonight's lineup</h2>${isDev() ? `<a class="btn sm ghost" href="#/new">+ New game</a>` : `<span class="label" id="count"></span>`}</div>
      <div id="list" class="shelf"><div class="loading"><p><span>D</span><span>e</span><span>a</span>ling</p></div></div>`);
    wireJoin("code", "join");
    const { data, error } = await db.from("games").select("slug,title,tagline,plays,config").eq("status", "published").order("created_at", { ascending: true });
    const list = $("list"); if (!list) return;
    if (error) { list.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
    if (!data.length) { list.innerHTML = `<div class="card"><p>No published games yet. ${isDev() ? `<a href="#/new">Create the first one.</a>` : `Log in as a developer to add one.`}</p></div>`; return; }
    if ($("count")) $("count").textContent = `${data.length} game${data.length === 1 ? "" : "s"}`;
    list.innerHTML = data.map((g, i) => { const eng = engineOf(g); return `<article class="gcard">
      <a class="cover" href="#/game/${esc(g.slug)}" aria-label="${esc(g.title)}">${ART[eng]}<span class="num">No. ${String(i + 1).padStart(2, "0")}</span></a>
      <div class="body"><h2>${esc(g.title)}</h2><p class="tag">${esc(g.tagline || "")}</p>${metaChips(eng)}
        <div class="actions">${g.config?.engine ? `<button data-host="${esc(g.slug)}">Host a room</button>` : ""}<a class="btn ghost" href="#/game/${esc(g.slug)}">How to play</a></div></div></article>`; }).join("");
    list.querySelectorAll("[data-host]").forEach(b => b.onclick = () => host(data.find(g => g.slug === b.dataset.host), b));
  }

  async function viewGame(slug) {
    setHTML(`<div class="loading"><p><span>L</span><span>o</span><span>a</span>ding</p></div>`);
    const { data: g, error } = await db.from("games").select("*").eq("slug", slug).single();
    if (error || !g) { setHTML(`<a class="backlink" href="#/">← All games</a><div class="card"><h2>Not found</h2><p style="margin-top:8px">This game doesn't exist or isn't published.</p></div>`); return; }
    const eng = engineOf(g), m = META[eng], live = !!g.config?.engine;
    setHTML(`<a class="backlink" href="#/">← All games</a>
      <section class="gamehero"><div class="cover">${ART[eng]}</div>
        <div class="body"><h1>${esc(g.title)}</h1><p class="lead" style="font-size:19px;font-weight:500">${esc(g.tagline)}</p>${metaChips(eng)}
          ${live ? `<button class="big" id="mkroom">Host a room</button>` : `<p class="muted">This game doesn't have a live runtime yet.</p>`}</div></section>
      <div class="gamegrid">
        <section class="card"><span class="label">How it plays</span><ol class="steps" style="margin-top:16px">${(m?.steps || []).map(([t, d]) => `<li><div><b>${esc(t)}</b>${esc(d)}</div></li>`).join("") || `<li><div>${esc(g.description)}</div></li>`}</ol>
          ${m && g.description ? `<details style="margin-top:18px"><summary class="label" style="cursor:pointer">The fine print</summary><p style="white-space:pre-wrap;margin-top:10px">${esc(g.description)}</p></details>` : ""}</section>
        ${live ? `<aside class="joinbox"><h3>Joining a friend?</h3><input id="joincode" class="codein" maxlength="5" placeholder="ABCDE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Room code">
          <button class="big ink" id="joinroom">Join</button><p class="small" style="font-weight:600">${g.plays} game${g.plays === 1 ? "" : "s"} played so far.</p></aside>` : ""}
      </div>`);
    if ($("mkroom")) $("mkroom").onclick = () => host(g, $("mkroom"));
    wireJoin("joincode", "joinroom");
  }

  function authView(mode) {
    const login = mode === "login";
    setHTML(`<div class="form"><a class="backlink" href="#/">← All games</a><h1>${login ? "Studio login" : "Open a studio"}</h1>
      <p style="margin-top:12px;font-size:18px">${login ? "For people who make games on GameHub. Players never need an account." : "Publish your own party games on GameHub. Free to start."}</p>
      <div class="card" style="margin-top:22px"><div id="msg"></div>
        <label class="field">Email<input id="email" type="email" autocomplete="email"></label>
        <label class="field">Password<input id="pw" type="password" autocomplete="${login ? "current-password" : "new-password"}"></label>
        <button id="submit" class="big" style="margin-top:20px">${login ? "Log in" : "Sign up"}</button>
        <p class="small center" style="margin-top:14px"><a href="#/${login ? "signup" : "login"}">${login ? "No studio yet? Sign up" : "Already have one? Log in"}</a></p></div></div>`);
    const msg = $("msg");
    const submit = async () => {
      const email = $("email").value.trim(), password = $("pw").value;
      if (!email || !password) { msg.innerHTML = `<p class="err">Email and password required.</p>`; return; }
      msg.innerHTML = `<p class="muted">Working…</p>`;
      if (user?.is_anonymous) await db.auth.signOut();
      const { data, error } = await (login ? db.auth.signInWithPassword({ email, password }) : db.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
      if (error) { msg.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
      if (!login && !data.session) { msg.innerHTML = `<p class="ok">Account created. Check your email to confirm, then log in.</p>`; return; }
      user = data.user; renderNav(); go("#/dev");
    };
    $("submit").onclick = submit;
    $("pw").onkeydown = e => { if (e.key === "Enter") submit(); };
  }

  async function viewDev() {
    if (!isDev()) return go("#/login");
    setHTML(`<div class="sechead" style="margin-top:6px"><h2>My games</h2><a class="btn" href="#/new">+ New game</a></div>
      <div id="mine" class="stack"><div class="loading"><p><span>L</span><span>o</span><span>a</span>ding</p></div></div>`);
    const { data, error } = await db.from("games").select("*").eq("owner", user.id).order("created_at", { ascending: false });
    const box = $("mine");
    if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
    if (!data.length) { box.innerHTML = `<div class="card"><p>No games yet. <a href="#/new">Create your first game.</a></p></div>`; return; }
    box.innerHTML = data.map(g => `<div class="card devrow">
      <div><h3 style="font:400 26px/1 var(--display);text-transform:uppercase">${esc(g.title)}</h3><p class="label" style="margin-top:6px">/${esc(g.slug)} · ${g.plays} plays</p></div>
      <div class="row"><span class="pill ${g.status === "published" ? "live" : "draft"}">${g.status}</span>
        <a class="btn ghost sm" href="#/edit/${g.id}">Edit</a>
        ${g.status === "published" ? `<a class="btn ghost sm" href="#/game/${esc(g.slug)}">View</a>` : ""}</div></div>`).join("");
  }

  function gameForm(existing) {
    const g = existing || { title: "", tagline: "", description: "" };
    return `<label class="field">Title<input id="title" value="${esc(g.title)}" maxlength="60"></label>
      <label class="field">Tagline (one line)<input id="tagline" value="${esc(g.tagline)}" maxlength="120"></label>
      <label class="field">Description<textarea id="description" rows="6" maxlength="2000">${esc(g.description)}</textarea></label>`;
  }

  function viewNew() {
    if (!isDev()) return go("#/login");
    setHTML(`<div class="form"><a class="backlink" href="#/dev">← My games</a><h1>New game</h1><div class="card" style="margin-top:20px"><div id="msg"></div>${gameForm()}
      <div class="row" style="margin-top:20px"><button id="save">Create</button><a class="btn ghost" href="#/dev">Cancel</a></div></div></div>`);
    $("save").onclick = async () => {
      const title = $("title").value.trim();
      if (!title) { $("msg").innerHTML = `<p class="err">Title required.</p>`; return; }
      const slug = slugify(title) + "-" + Math.random().toString(36).slice(2, 6);
      const row = { slug, title, tagline: $("tagline").value.trim(), description: $("description").value.trim() };
      const { data, error } = await db.from("games").insert(row).select("id").single();
      if (error) { $("msg").innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
      go("#/edit/" + data.id);
    };
  }

  async function viewEdit(id) {
    if (!isDev()) return go("#/login");
    const { data: g, error } = await db.from("games").select("*").eq("id", id).single();
    if (error || !g) { setHTML(`<p class="err">${esc(error?.message || "Game not found.")}</p>`); return; }
    setHTML(`<div class="form"><a class="backlink" href="#/dev">← My games</a><div class="row between"><h1>Edit</h1><span class="pill ${g.status === "published" ? "live" : "draft"}">${g.status}</span></div>
      <div class="card" style="margin-top:20px"><div id="msg"></div>${gameForm(g)}
      <div class="row" style="margin-top:20px">
        <button id="save">Save</button>
        <button id="pub" class="ghost">${g.status === "published" ? "Unpublish" : "Publish"}</button>
        <button id="del" class="ghost sm" style="margin-left:auto;color:var(--danger)">Delete</button>
      </div>
      <p class="label" style="margin-top:16px">Public link: #/game/${esc(g.slug)}</p></div></div>`);
    const msg = $("msg");
    const patch = async fields => {
      const { error } = await db.from("games").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) { msg.innerHTML = `<p class="err">${esc(error.message)}</p>`; return false; }
      return true;
    };
    $("save").onclick = async () => {
      if (await patch({ title: $("title").value.trim(), tagline: $("tagline").value.trim(), description: $("description").value.trim() })) toast("Saved.");
    };
    $("pub").onclick = async () => { if (await patch({ status: g.status === "published" ? "draft" : "published" })) viewEdit(id); };
    $("del").onclick = async () => {
      if (!confirmInline()) return;
      const { error } = await db.from("games").delete().eq("id", id);
      if (error) { msg.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
      go("#/dev");
    };
  }
  let armedDelete = false;
  function confirmInline() {
    const b = $("del");
    if (!armedDelete) { armedDelete = true; b.textContent = "Tap again to delete"; setTimeout(() => { armedDelete = false; if (b) b.textContent = "Delete"; }, 3000); return false; }
    return true;
  }

  /* ---------------------------------------------------------------- router */
  function route() {
    if (!configured) return notConfigured();
    window.GHPlay?.teardown();
    const h = location.hash || "#/";
    const [, path, arg] = h.match(/^#\/([^/]*)\/?(.*)$/) || [, "", ""];
    if (path === "") return viewMarketplace();
    if (path === "login") return authView("login");
    if (path === "signup") return authView("signup");
    if (path === "dev") return viewDev();
    if (path === "new") return viewNew();
    if (path === "edit") return viewEdit(arg);
    if (path === "game") return viewGame(arg);
    if (path === "play") return window.GHPlay.view(arg);
    setHTML(`<div class="card"><h2>Nothing here</h2><p style="margin-top:8px"><a href="#/">Back to the games</a></p></div>`);
  }

  /* ---------------------------------------------------------------- boot */
  window.GH = { db, esc, go, toast, MASK };

  async function boot() {
    if (!configured) { renderNav(); route(); return; }
    const { data } = await db.auth.getSession();
    user = data.session?.user || null;
    db.auth.onAuthStateChange((_e, session) => { user = session?.user || null; renderNav(); });
    renderNav();
    window.addEventListener("hashchange", route);
    route();
  }
  boot();
})();
