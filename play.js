/* GameHub live rooms. The database runs every rule (gh_private engines behind
   the room_* functions); this file only shows the room and sends moves.
   Each open page nudges the room clock with room_tick, which advances a
   phase only once its time has really passed. */
(() => {
  "use strict";
  const COLORS = ["#ff4a1c", "#2f6bff", "#12a37a", "#8b5cf6", "#e0398f", "#f5a524", "#0ea5b7", "#16130f", "#c2410c", "#65a30d"];
  const ALIAS_COLORS = ["#ff2e88", "#39f3c2", "#b6ff3b", "#ffb238", "#9d8cff", "#4fc3ff", "#ff6b4a", "#f9f871"];
  const FUNNY = ["Captain Gavel", "Lady Loophole", "Baron Von Bluff", "Sir Objection", "The Closer", "Judge Mental", "Count Offer", "Miss Demeanor",
    "Duke of Spin", "Agent Smalltalk", "Notary Public", "Professor Plot", "Admiral Alibi", "Madam Motion", "The Fine Print"];
  const ENGINES = {
    laws: { name: "Dumb Laws", min: 2, durations: [[120000, "2 min"], [180000, "3 min"], [300000, "5 min"]],
      steps: ["A real (reportedly) dumb law hits the table.", "Your team defends it or tears it down. Sides swap every round.", "Argue in the chat until the clock runs out.", "The room votes, or the AI judge rules."] },
    friends: { name: "True Friends", min: 3, durations: [[180000, "3 min"], [300000, "5 min"], [420000, "7 min"]],
      steps: ["Everyone gets a secret alias.", "One Saviour must get one unknowing Survivor to pick them, without being spotted.", "12 messages each, plus one sealed accusation.", "Everyone names their true friend. Then the masks come off."] },
    deal: { name: "Art of the Deal", min: 2, durations: [[240000, "4 min"], [360000, "6 min"], [480000, "8 min"]],
      steps: ["Two teams, one deal, and a confidential brief each.", "Talk freely. Put formal offers on the record (four each).", "Accept their offer to sign, or run out the clock.", "The judge rewards good deals. Being unreasonable loses."] }
  };
  const ICON = {
    menu: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
    crown: `<svg class="crown" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 4l4.5 8L21 8l-2 11H5z" fill="#ffcf33" stroke="#16130f" stroke-width="2" stroke-linejoin="round"/></svg>`,
    scales: `<svg class="scales" viewBox="0 0 130 110" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><line x1="65" y1="20" x2="65" y2="96"/><line x1="38" y1="98" x2="92" y2="98"/><circle cx="65" cy="13" r="5" fill="currentColor"/><g class="beam"><line x1="15" y1="30" x2="115" y2="30"/><path d="M15 30 L3 62 H27 Z"/><path d="M115 30 L103 62 H127 Z"/></g></g></svg>`
  };

  const P = {};
  const fresh = () => Object.assign(P, { code: null, room: null, st: {}, players: {}, msgs: new Map(), priv: null, online: new Set(), me: null,
    chan: null, ticker: null, lastTick: 0, ticking: false, busy: false, myVote: null, judgedKey: null,
    phaseKey: null, confettiKey: null, sheet: null, dealMode: "msg", cache: {}, seenMsgs: 0 });
  fresh();
  let db, esc, root;

  const pick = a => a[Math.floor(Math.random() * a.length)];
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const $ = id => document.getElementById(id);
  const fmt = ms => { const s = Math.ceil(Math.max(0, ms) / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const toast = (m, bad) => window.GH?.toast?.(m, bad);
  const buzz = p => { try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(p); } catch {} };
  const safeColor = c => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : "#6f6656");
  const initials = n => (String(n || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2) || "?");
  const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const aliasColor = a => ALIAS_COLORS[hash(a) % ALIAS_COLORS.length];
  const av = (name, color, cls = "", crown = false) => `<span class="av ${cls}" style="--c:${safeColor(color)}">${esc(initials(name))}${crown ? ICON.crown : ""}</span>`;
  // Only touch the DOM when the markup actually changed: keeps animations, focus and held secrets intact.
  const put = (el, key, html) => { if (!el || P.cache[key] === html) return false; P.cache[key] = html; el.innerHTML = html; return true; };

  /* ------------------------------------------------------------ session */
  async function ensureSession() {
    const { data } = await db.auth.getSession();
    if (data.session) return data.session.user;
    const { data: d, error } = await db.auth.signInAnonymously();
    if (error) throw error;
    return d.user;
  }
  function sessionError(e) {
    if (e && (e.code === "anonymous_provider_disabled" || /anonymous sign-ins are disabled/i.test(e.message || "")))
      return "Guest play isn't switched on for this GameHub yet. The owner needs to enable anonymous sign-ins in Supabase.";
    return e?.message || "Couldn't start a session.";
  }
  async function call(fn, args) {
    const { data, error } = await db.rpc(fn, { p_code: P.code, ...args });
    if (error) throw new Error(error.message);
    return data;
  }

  /* ------------------------------------------------------------ derived state */
  const engine = () => P.room?.engine;
  const isHost = () => P.room && P.room.host === P.me;
  const nameOf = uid => P.players[uid]?.name || P.st.names?.[uid] || "Someone";
  const colorOf = uid => P.players[uid]?.color;
  const myTeam = () => P.st.teams?.[P.me] || null;
  const mine = () => (P.priv && P.priv.gid === P.st.gid ? P.priv.payload : null);
  const roundMsgs = () => [...P.msgs.values()].filter(m => m.gid === P.st.gid && m.round === (P.st.round || 1)).sort((a, b) => a.id - b.id);
  const myCount = () => roundMsgs().filter(m => m.kind === "msg" && m.seat && m.seat === mine()?.seat).length;
  const present = () => Object.values(P.players).filter(p => !P.online.size || P.online.has(p.uid));
  const onlineCount = () => present().length || Object.keys(P.players).length;
  const hostAway = () => P.online.size > 0 && !P.online.has(P.room.host);
  const tfPlaying = () => (P.st.tf?.players || []).includes(P.me);
  const offersLeft = t => Math.max(0, 4 - roundMsgs().filter(m => m.kind === "offer" && m.team === t).length);
  function teamName(t) {
    if (engine() === "laws") return P.st.laws?.sides?.[t] === "for" ? "Keep it" : "Strike it";
    if (engine() === "deal") return P.st.deal?.names?.[t] || "Team " + t;
    return t;
  }
  function canChat() {
    const st = P.st, eng = engine();
    if (!mine()) return false;
    if (eng === "laws") return st.phase === "argue" && !!myTeam();
    if (eng === "deal") return st.phase === "negotiate" && !!myTeam();
    if (eng === "friends") return st.phase === "chat" && tfPlaying() && myCount() < (st.tf?.cap || 12);
    return false;
  }

  /* ------------------------------------------------------------ the room clock */
  function due() {
    const st = P.st, now = Date.now();
    if (!st.endsAt || !["argue", "chat", "negotiate", "vote", "judging"].includes(st.phase)) return false;
    if (now >= st.endsAt) return true;
    const half = st.phaseAt + (st.endsAt - st.phaseAt) / 2;
    if (st.phase === "chat" && !st.tf?.hint && now >= half) return true;
    if (st.phase === "negotiate" && !st.deal?.event && now >= half) return true;
    return false;
  }
  async function tick(force) {
    const now = Date.now();
    if (P.ticking || !P.code) return;
    if (!force && !(due() && now - P.lastTick > 1500) && now - P.lastTick < 8000) return;
    P.ticking = true; P.lastTick = now;
    try { await call("room_tick"); } catch (e) { console.warn(e); }
    P.ticking = false;
  }

  /* ------------------------------------------------------------ joining */
  function namePrompt(kicker, next) {
    document.body.classList.remove("in-room");
    let color = safeColor(lsGet("gh-color") || pick(COLORS));
    root.innerHTML = `<div class="namecard"><span class="label">${esc(kicker)}</span><h1>Who are you?</h1>
      <span class="av lg" id="pv-av" style="--c:${color}">?</span>
      <div class="namerow"><input id="pv-name" maxlength="24" value="${esc(lsGet("gh-name") || "")}" autocomplete="nickname" placeholder="Your name" aria-label="Your name">
        <button class="iconbtn ghost" type="button" id="pv-dice" aria-label="Suggest a name">🎲</button></div>
      <div class="swatches">${COLORS.map(c => `<button class="sw" type="button" data-c="${c}" style="background:${c}" aria-pressed="${c === color}" aria-label="Colour ${c}"></button>`).join("")}</div>
      <button class="big" id="pv-go">Let me in</button><p class="small muted">No account. This name is only for this game.</p></div>`;
    const inp = $("pv-name"), avEl = $("pv-av");
    const paint = () => { avEl.style.setProperty("--c", color); avEl.textContent = initials(inp.value.trim() || "?"); };
    root.querySelectorAll(".sw").forEach(b => b.onclick = () => { color = b.dataset.c; root.querySelectorAll(".sw").forEach(x => x.setAttribute("aria-pressed", x === b)); paint(); });
    $("pv-dice").onclick = () => { inp.value = pick(FUNNY.filter(n => n !== inp.value)); paint(); };
    inp.oninput = paint; paint();
    const go = () => { const n = inp.value.trim().slice(0, 24); if (!n) { toast("Pick a name first.", true); inp.focus(); return; } lsSet("gh-name", n); lsSet("gh-color", color); next(); };
    $("pv-go").onclick = go; inp.onkeydown = e => { if (e.key === "Enter") go(); };
    if (!inp.value) inp.focus();
  }
  const fail = (msg, back = "#/") => {
    document.body.classList.remove("in-room"); delete document.body.dataset.game;
    root.innerHTML = `<div class="form"><div class="card"><h2>Hmm.</h2><p style="margin:10px 0 18px">${esc(msg)}</p><a class="btn" href="${esc(back)}">Back</a></div></div>`;
  };

  async function view(code) {
    teardown();
    ({ db, esc } = window.GH); root = document.getElementById("app");
    code = String(code || "").toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return fail("That room code doesn't look right. Codes are 5 letters or numbers.");
    if (!lsGet("gh-name")) return namePrompt("Joining room " + code, () => view(code));
    root.innerHTML = `<div class="loading"><p><span>J</span><span>o</span><span>i</span>ning ${esc(code)}</p></div>`;
    let user;
    try { user = await ensureSession(); } catch (e) { return fail(sessionError(e)); }
    P.me = user.id; P.code = code;
    try { await call("join_room", { p_name: lsGet("gh-name"), p_color: safeColor(lsGet("gh-color") || pick(COLORS)) }); }
    catch (e) { P.code = null; return fail(e.message); }
    await refetch(true);
    subscribe();
    P.ticker = setInterval(() => { tick(false); tickClock(); }, 1000);
    tick(true);
  }

  async function refetch(first) {
    const [r, pl, pv] = await Promise.all([
      db.from("rooms").select("*").eq("code", P.code).single(),
      db.from("room_players").select("room_code,uid,name,color,joined_at").eq("room_code", P.code),
      db.from("room_private").select("*").eq("room_code", P.code).maybeSingle()
    ]);
    if (r.data) { P.room = r.data; P.st = r.data.state || {}; }
    if (pl.data) { P.players = {}; pl.data.forEach(p => P.players[p.uid] = p); }
    P.priv = pv.data || null;
    if (P.st.gid) {
      const { data } = await db.from("room_messages").select("*").eq("room_code", P.code).eq("gid", P.st.gid).order("id", { ascending: true }).limit(500);
      (data || []).forEach(m => P.msgs.set(m.id, m));
    }
    if (first) shell();
    render();
  }

  function subscribe() {
    const code = P.code;
    P.chan = db.channel("room:" + code, { config: { presence: { key: P.me } } })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: "code=eq." + code }, p => {
        const gidChanged = p.new.state?.gid !== P.st.gid;
        P.room = p.new; P.st = p.new.state || {};
        if (P.st.voteKey !== P.myVote?.key) P.myVote = null;
        if (gidChanged) refetch(); else render();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "room_players", filter: "room_code=eq." + code }, p => {
        if (p.new && p.new.uid) { P.players[p.new.uid] = p.new; render(); }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "room_private", filter: "room_code=eq." + code }, p => {
        if (p.new && p.new.uid === P.me) { P.priv = p.new; render(); }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_messages", filter: "room_code=eq." + code }, p => {
        if (p.new && !P.msgs.has(p.new.id)) {
          P.msgs.set(p.new.id, p.new);
          if (p.new.kind === "judge" || p.new.kind === "accept") buzz(25);
          render();
        }
      })
      .on("presence", { event: "sync" }, () => { P.online = new Set(Object.keys(P.chan.presenceState())); render(); })
      .subscribe(async status => { if (status === "SUBSCRIBED") { await P.chan.track({ at: Date.now() }); refetch(); } });
  }

  function teardown() {
    if (P.ticker) clearInterval(P.ticker);
    if (P.chan) db.removeChannel(P.chan);
    fresh();
    document.body.classList.remove("in-room");
    delete document.body.dataset.game;
    document.body.style.setProperty("--dock-h", "0px");
  }

  async function createRoom(game) {
    ({ db, esc } = window.GH); root = document.getElementById("app");
    if (!lsGet("gh-name")) return namePrompt("Hosting " + game.title, () => createRoom(game).catch(e => fail(e.message, "#/game/" + game.slug)));
    try { await ensureSession(); } catch (e) { throw new Error(sessionError(e)); }
    const { data: code, error } = await db.rpc("create_room", { p_slug: game.slug });
    if (error) throw new Error(error.message);
    location.hash = "#/play/" + code;
  }

  /* ------------------------------------------------------------ actions */
  async function act(f) {
    if (P.busy) return;
    P.busy = true; render();
    try { await f(); } catch (e) { toast(e.message, true); }
    P.busy = false; render();
  }
  async function send(kind, text, target) {
    try { await call("room_post", { p_kind: kind, p_text: text || "", p_target: target || null }); return true; }
    catch (e) { toast(e.message, true); return false; }
  }
  async function share() {
    const url = location.href.split("#")[0] + "#/play/" + P.code, name = ENGINES[engine()]?.name || "GameHub";
    if (navigator.share) { try { await navigator.share({ title: name, text: `Join my ${name} room. Code ${P.code}`, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(url); toast("Invite link copied"); } catch { toast(url); }
  }

  async function onClick(e) {
    const b = e.target.closest("[data-a]"); if (!b || !P.code) return;
    const a = b.dataset.a, v = b.dataset.v;
    if (a === "noop") return;
    if (a === "menu") { P.sheet = "menu"; return renderLayer(); }
    if (a === "closeSheet") { P.sheet = null; return renderLayer(); }
    if (a === "share") { P.sheet = null; renderLayer(); return share(); }
    if (a === "leave") { location.hash = "#/"; return; }
    if (a === "dur") return act(() => call("room_set_duration", { p_ms: +v }));
    if (a === "judge") return act(() => call("room_set_judge", { p_mode: v }));
    if (a === "start" || a === "again") return act(() => call("room_start"));
    if (a === "next") return act(() => call("room_next_round"));
    if (a === "lobby") { P.sheet = null; renderLayer(); return act(() => call("room_to_lobby")); }
    if (a === "takeover") { P.sheet = null; renderLayer(); return act(() => call("room_takeover")); }
    if (a === "vote") { buzz(15); P.myVote = { key: P.st.voteKey, value: v }; render(); return act(() => call("room_vote", { p_value: v })); }
    if (a === "accuse") { P.sheet = "accuse"; return renderLayer(); }
    if (a === "accuseWho") { P.sheet = null; renderLayer(); if (await send("accuse", "", v)) { buzz([20, 40, 20]); toast("Accusation sealed"); } return; }
    if (a === "mode") { P.dealMode = v; render(); $("pv-input")?.focus(); return; }
    if (a === "accept") { if (await send("accept")) buzz([30, 50, 60]); }
  }
  document.addEventListener("click", onClick);

  // Hold-to-reveal secrets: open only while a finger (or key) is down.
  const closePeeks = () => document.querySelectorAll(".peek.open").forEach(p => p.classList.remove("open"));
  document.addEventListener("pointerdown", e => { const p = e.target.closest?.("[data-peek]"); if (p) { p.classList.add("open"); buzz(10); } });
  ["pointerup", "pointercancel", "blur"].forEach(t => (t === "blur" ? window : document).addEventListener(t, closePeeks));
  document.addEventListener("keydown", e => { const p = e.target.closest?.("[data-peek]"); if (p && (e.key === " " || e.key === "Enter")) { e.preventDefault(); p.classList.add("open"); } });
  document.addEventListener("keyup", closePeeks);
  document.addEventListener("contextmenu", e => { if (e.target.closest?.("[data-peek]")) e.preventDefault(); });

  /* ------------------------------------------------------------ shell */
  function shell() {
    const eng = engine();
    document.body.classList.add("in-room");
    document.body.dataset.game = eng || "";
    window.scrollTo(0, 0);
    root.innerHTML = `<header class="rbar" id="pv-rbar">
        <a class="btn iconbtn ghost" href="#/" aria-label="Leave room">${ICON.close}</a>
        <div class="title"><b>${esc(ENGINES[eng]?.name || "Room")}</b><span id="pv-sub"></span></div>
        <span class="clock" id="pv-clock" hidden></span>
        <button class="iconbtn ghost" data-a="menu" aria-label="Room menu">${ICON.menu}</button>
      </header>
      <div class="tbar" id="pv-tbar"><i></i></div>
      <div class="stage" id="pv-main"></div>
      <section id="pv-chatwrap" hidden><div class="chathead" id="pv-chathead"></div><div class="chat" id="pv-chat" aria-live="polite"></div></section>
      <div class="dock" id="pv-dock" hidden><div class="inner">
        <div class="bar" id="pv-actions"></div>
        <form id="pv-form" autocomplete="off"><textarea id="pv-input" rows="1" maxlength="280" aria-label="Message"></textarea><button class="send" id="pv-send" type="submit" aria-label="Send">${ICON.send}</button></form>
        <p class="note" id="pv-note"></p></div></div>
      <div id="pv-layer"></div><div id="pv-overlay"></div>`;
    document.body.style.setProperty("--rbar-h", $("pv-rbar").offsetHeight + "px");
    const inp = $("pv-input");
    const grow = () => { inp.style.height = "50px"; inp.style.height = Math.min(128, inp.scrollHeight + 4) + "px"; syncDock(); };
    inp.oninput = grow;
    inp.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("pv-form").requestSubmit(); } };
    $("pv-form").onsubmit = async e => {
      e.preventDefault();
      const t = inp.value.trim(); if (!t || !canChat()) return;
      const kind = engine() === "deal" && P.dealMode === "offer" ? "offer" : "msg";
      if (kind === "offer" && offersLeft(myTeam()) <= 0) return toast("No formal offers left.", true);
      inp.value = ""; grow();
      if (await send(kind, t)) { buzz(8); if (kind === "offer") P.dealMode = "msg"; P.stick = true; render(); }
      else { inp.value = t; grow(); }
    };
  }
  function syncDock() {
    const d = $("pv-dock"); if (!d) return;
    document.body.style.setProperty("--dock-h", (d.hidden ? 0 : d.offsetHeight) + "px");
  }

  function summonJudge() {
    const key = P.st.judgeKey;
    if (P.st.phase !== "judging" || !key || P.judgedKey === key) return;
    P.judgedKey = key;
    const code = P.code;
    setTimeout(() => { if (P.code === code) db.functions.invoke("judge", { body: { code } }).catch(e => console.warn(e)); }, Math.random() * 1500);
  }

  /* ------------------------------------------------------------ render */
  function render() {
    if (!P.code || !$("pv-main") || !P.room) return;
    const st = P.st, eng = engine();
    summonJudge();
    let main = "";
    if (!isHost() && hostAway()) main += `<div class="banner row between"><span><b>${esc(nameOf(P.room.host))}</b> (host) dropped out.</span><button class="sm ink" data-a="takeover">Take over</button></div>`;
    if (!st.phase || st.phase === "lobby") main += lobbyView();
    else if (eng === "laws") main += lawsView();
    else if (eng === "friends") main += tfView();
    else if (eng === "deal") main += dealView();
    if (put($("pv-main"), "main", main)) afterMain();
    $("pv-sub").textContent = subtitle();
    const playing = st.phase && st.phase !== "lobby";
    $("pv-chatwrap").hidden = !playing;
    if (playing) renderChat();
    renderDock();
    renderLayer();
    tickClock();
    ceremony();
  }

  function afterMain() {
    const q = $("pv-qr");
    if (q) {
      const draw = () => {
        if (!window.qrcode) return setTimeout(() => $("pv-qr") && draw(), 400);
        const qr = window.qrcode(0, "M"); qr.addData(location.href.split("#")[0] + "#/play/" + P.code); qr.make();
        q.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      };
      draw();
    }
  }

  function subtitle() {
    const st = P.st, n = onlineCount();
    if (!st.phase || st.phase === "lobby") return `Room ${P.code} · ${n} here`;
    if (engine() === "laws") return `Round ${st.round || 1} · ${st.laws?.law || ""}`;
    if (engine() === "friends") return mine()?.alias ? `Room ${P.code} · you are ${mine().alias}` : `Room ${P.code} · watching`;
    return `Room ${P.code} · ${st.deal?.title || ""}`;
  }

  function tickClock() {
    const el = $("pv-clock"), bar = $("pv-tbar"); if (!el) return;
    const st = P.st, show = ["argue", "chat", "negotiate", "vote"].includes(st.phase) && st.endsAt;
    el.hidden = !show; bar.style.visibility = show ? "visible" : "hidden";
    if (!show) return;
    const left = st.endsAt - Date.now(), total = Math.max(1, st.endsAt - (st.phaseAt || st.endsAt - 60000));
    el.textContent = fmt(left);
    const low = left < 20000;
    el.classList.toggle("low", low); bar.classList.toggle("low", low);
    bar.firstElementChild.style.width = Math.max(0, Math.min(100, left / total * 100)) + "%";
  }

  /* ---- phase ceremony: a full-screen title card whenever the room moves on */
  function ceremony() {
    const st = P.st, key = `${st.gid || ""}:${st.round || 1}:${st.phase || "lobby"}`;
    if (P.phaseKey === null) { P.phaseKey = key; P.confettiKey = resultKey(); return; }
    if (key === P.phaseKey) return;
    P.phaseKey = key;
    window.scrollTo(0, 0);
    const o = overlayFor();
    if (!o) return;
    buzz([30, 40, 30]);
    const el = $("pv-overlay");
    el.innerHTML = `<div class="overlay" role="status"><span class="kicker">${esc(o.kicker)}</span><div class="headline">${esc(o.headline)}</div>${o.sub ? `<p class="sub">${esc(o.sub)}</p>` : ""}<span class="tap">Tap to continue</span></div>`;
    const ov = el.firstElementChild;
    const close = () => { if (!ov.isConnected || ov.classList.contains("out")) return; ov.classList.add("out"); setTimeout(() => { ov.remove(); celebrate(); }, 250); };
    ov.onclick = close; setTimeout(close, 2800);
  }
  const resultKey = () => (P.st.result ? `${P.st.gid}:${P.st.round || 1}` : null);
  function overlayFor() {
    const st = P.st, eng = engine(), ph = st.phase, t = myTeam(), r = st.result;
    const won = r && (r.awards?.[P.me] > 0);
    if (eng === "laws") {
      if (ph === "argue") return { kicker: `Round ${st.round || 1}`, headline: "All rise", sub: t ? `Your team argues to ${st.laws?.sides?.[t] === "for" ? "KEEP" : "STRIKE DOWN"} the law.` : "You're in the public gallery this round." };
      if (ph === "vote") return { kicker: "Time's up", headline: "Vote!", sub: "Which side argued best?" };
      if (ph === "judging") return { kicker: "Time's up", headline: "Hmm…", sub: "The judge retires to deliberate." };
      if (ph === "result") return { kicker: "The verdict", headline: r?.winner === "tie" ? "Hung jury" : teamName(r?.winner) + "!", sub: won ? "Your side takes it." : t ? "Not your day in court." : "" };
    }
    if (eng === "friends") {
      if (ph === "chat") return { kicker: "Masks on", headline: mine()?.alias || "Watch", sub: mine()?.alias ? "That's your name now. Hold your role card to read your secret." : "You joined mid-game. Enjoy the show." };
      if (ph === "vote") return { kicker: "Chat closed", headline: "Choose", sub: "Who is your true friend?" };
      if (ph === "reveal") return { kicker: "Masks off", headline: r?.survivorPicked ? "Rescued" : "Not fooled", sub: won ? "You played it right." : "" };
    }
    if (eng === "deal") {
      if (ph === "negotiate") return { kicker: "The doors close", headline: "Let's deal", sub: t ? `You represent ${teamName(t)}. Hold the confidential file to read your brief.` : "You're observing this one." };
      if (ph === "vote") return { kicker: "Pens down", headline: "Vote!", sub: "Who got the better deal?" };
      if (ph === "judging") return { kicker: "Pens down", headline: "Hmm…", sub: "The judge reviews the paperwork." };
      if (ph === "result") return { kicker: "Closing", headline: r?.winner === "tie" ? "Even" : teamName(r?.winner), sub: won ? "Pleasure doing business." : "" };
    }
    return null;
  }
  function celebrate() {
    const k = resultKey();
    if (!k || P.confettiKey === k) return;
    P.confettiKey = k;
    if (!(P.st.result?.awards?.[P.me] > 0) || !window.confetti) return;
    const css = getComputedStyle(document.body);
    const colors = ["--hot", "--sun", "--teamA", "--teamB"].map(v => css.getPropertyValue(v).trim()).filter(Boolean);
    window.confetti({ particleCount: 140, spread: 85, startVelocity: 48, origin: { y: .65 }, colors, disableForReducedMotion: true });
    setTimeout(() => window.confetti({ particleCount: 70, angle: 120, spread: 60, origin: { x: 1, y: .7 }, colors, disableForReducedMotion: true }), 300);
  }

  /* ---- shared pieces */
  const phaseChip = text => `<span class="phase"><i></i>${esc(text)}</span>`;

  function versus(extra) {
    return `<div class="versus">${["A", "B"].map((t, i) => {
      const members = Object.entries(P.st.teams || {}).filter(([, x]) => x === t).map(([u]) => u);
      const side = `<div class="side t${t} ${myTeam() === t ? "mine" : ""}"><b>${esc(teamName(t))}</b>
        <div class="avs">${members.map(u => av(nameOf(u), colorOf(u), "sm")).join("") || `<span class="small muted">nobody</span>`}</div>
        ${myTeam() === t ? `<span class="you">Your side</span>` : ""}${extra ? extra(t) : ""}</div>`;
      return i === 0 ? side + `<span class="vs">VS</span>` : side;
    }).join("")}</div>`;
  }

  function voteBlock(question, options, cols) {
    const st = P.st, voters = st.voters || [], canVote = voters.includes(P.me), count = st.voteCount || 0;
    const chosen = P.myVote?.key === st.voteKey ? P.myVote.value : null;
    return `<section class="votehead"><h2>${esc(question)}</h2></section>
      <div class="choices ${cols || ""}">${options.map(o => `<button class="choice ${o.cls || ""}" ${o.style ? `style="${o.style}"` : ""} data-a="vote" data-v="${esc(o.v)}" aria-pressed="${chosen === o.v}" ${canVote ? "" : "disabled"}>
        ${o.small ? `<small>${esc(o.small)}</small>` : ""}<b>${esc(o.label)}</b></button>`).join("")}</div>
      <div><div class="meter">${voters.map((_, i) => `<i class="${i < count ? "on" : ""}"></i>`).join("")}</div>
        <p class="meterlabel">${count} of ${voters.length} voted${canVote ? (chosen ? " · you can change your mind" : "") : " · you're watching this one"}</p></div>`;
  }

  const judging = text => `<section class="card deliberate">${ICON.scales}<h2>The judge is out</h2><p>${esc(text)}</p><p class="label" style="margin-top:14px">If no verdict in 45s, the room votes instead</p></section>`;

  function verdictBanner(title, cls, style) {
    const r = P.st.result, pts = r.awards?.[P.me];
    return `<section class="verdict ${cls || ""}" ${style ? `style="${style}"` : ""}><span class="label">${r.ai ? "The judge rules" : engine() === "friends" ? "The reveal" : "The room has spoken"}</span>
      <h2>${esc(title)}</h2>${r.verdict ? `<p>${esc(r.verdict)}</p>` : ""}
      ${pts !== undefined ? `<span class="delta ${pts < 0 ? "neg" : ""}">${pts < 0 ? "−" : "+"}${Math.abs(pts)} pt${Math.abs(pts) === 1 ? "" : "s"}</span>` : ""}</section>`;
  }

  function scoreCard() {
    const r = P.st.result; if (!r) return "";
    const tot = Math.max(1, (r.counts?.A || 0) + (r.counts?.B || 0));
    const bar = (t, v, max, suffix = "") => `<div class="bar"><span>${esc(teamName(t))}</span><span class="track"><span class="fill t${t}" style="width:${Math.max(0, Math.min(100, v / max * 100))}%"></span></span><span class="mono">${v}${suffix}</span></div>`;
    let h = "";
    if (r.counts) h += `<span class="label">Votes</span>` + bar("A", r.counts.A || 0, tot) + bar("B", r.counts.B || 0, tot);
    const sc = r.scores || {};
    if (sc.convincing) h += `<span class="label">Convincing</span>` + bar("A", sc.convincing.A, 10) + bar("B", sc.convincing.B, 10);
    if (sc.craft) h += `<span class="label">Did the most with it</span>` + bar("A", sc.craft.A, 10) + bar("B", sc.craft.B, 10);
    if (sc.closeness) h += `<span class="label">How close to their ideal</span>` + bar("A", sc.closeness.A, 100, "%") + bar("B", sc.closeness.B, 100, "%");
    if (r.outcome) h += `<p class="small" style="margin-top:6px">${esc(r.outcome)}</p>`;
    if (r.briefs) h += `<span class="label">The confidential briefs</span>` + ["A", "B"].map(t => `<div class="reveal-brief t${t}"><b>${esc(r.briefs[t].name)}</b>
      <p><strong>Wanted:</strong> ${esc(r.briefs[t].ideal)}</p><p><strong>Walk-away:</strong> ${esc(r.briefs[t].walkaway)}</p><p><strong>Leverage:</strong> ${esc(r.briefs[t].leverage)}</p></div>`).join("");
    return h ? `<section class="card bars">${h}</section>` : "";
  }

  function boardView() {
    const rows = Object.entries(P.st.board || {}).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return "";
    const aw = (P.st.phase === "result" || P.st.phase === "reveal") ? P.st.result?.awards || {} : {};
    return `<section class="card"><span class="label">Standings</span><div class="board" style="margin-top:14px">${rows.map(([u, p], i) =>
      `<div class="r ${i === 0 && p > 0 ? "first" : ""}"><span class="rank">${i + 1}</span>${av(P.st.names?.[u] || nameOf(u), colorOf(u), "sm")}
        <span class="nm">${esc(P.st.names?.[u] || nameOf(u))}${u === P.me ? " (you)" : ""}${aw[u] ? `<small>${aw[u] > 0 ? "+" : "−"}${Math.abs(aw[u])} this round</small>` : ""}</span><span class="pts">${p}</span></div>`).join("")}</div></section>`;
  }

  /* ---- lobby */
  function lobbyView() {
    const e = ENGINES[engine()], st = P.st, ppl = present(), n = onlineCount();
    const empties = Math.max(0, e.min - ppl.length);
    let h = phaseChip("Lobby · waiting for players");
    h += `<section class="card lobbyhead"><div><span class="label">Room code</span><div class="bigcode">${esc(P.code)}</div>
        <button class="sm" data-a="share" style="margin-top:12px">Invite friends</button></div><div class="qr" id="pv-qr" role="img" aria-label="QR code to join this room"></div></section>`;
    h += `<section class="card"><div class="row between"><span class="label">At the table · ${n}</span><span class="label">${n >= e.min ? "Ready" : `Needs ${e.min}+`}</span></div>
      <div class="people" style="margin-top:18px">${ppl.map(p => `<div class="person">${av(p.name, p.color, "", p.uid === P.room.host)}<span>${esc(p.name)}</span>${p.uid === P.me ? "<em>you</em>" : p.uid === P.room.host ? "<em>host</em>" : ""}</div>`).join("")}
      ${Array.from({ length: empties }, () => `<div class="person empty"><span class="av">?</span><span>open seat</span></div>`).join("")}</div></section>`;
    const dur = st.duration || e.durations[1][0];
    if (isHost()) {
      h += `<section class="card"><span class="label">House rules · you're the host</span>
        <div class="setting"><span class="small" style="font-weight:800">Round length</span><div class="seg">${e.durations.map(([ms, l]) => `<button data-a="dur" data-v="${ms}" aria-pressed="${dur === ms}">${l}</button>`).join("")}</div></div>
        ${engine() !== "friends" ? `<div class="setting"><span class="small" style="font-weight:800">Who decides the winner</span><div class="seg">
          <button data-a="judge" data-v="crowd" aria-pressed="${st.judgeMode !== "ai"}">Crowd vote</button><button data-a="judge" data-v="ai" aria-pressed="${st.judgeMode === "ai"}">AI judge</button></div>
          <p class="small muted">${st.judgeMode === "ai" ? "An AI judge reads every word and scores both sides. If it can't decide, the room votes." : "When time runs out, everyone votes."}</p></div>` : ""}</section>`;
    } else {
      h += `<section class="card"><span class="label">House rules</span><p style="margin-top:10px;font-weight:700">${esc(e.durations.find(([ms]) => ms === dur)?.[1] || "")} rounds${engine() !== "friends" ? ` · ${st.judgeMode === "ai" ? "AI judge" : "crowd vote"}` : ""}</p></section>`;
    }
    h += `<section class="card"><span class="label">How it plays</span><ol class="steps" style="margin-top:16px">${e.steps.map(s => `<li><div>${esc(s)}</div></li>`).join("")}</ol></section>`;
    return h + boardView();
  }

  /* ---- Dumb Laws */
  function lawsView() {
    const st = P.st, L = st.laws || {}, t = myTeam(), ph = st.phase, r = st.result;
    const label = { argue: "Court is in session", vote: "The room votes", judging: "Judge deliberating", result: "Verdict" }[ph] || ph;
    let top = "";
    if (ph === "vote") top = voteBlock("Who argued best?", ["A", "B"].map(x => ({ v: x, label: teamName(x), cls: "t" + x, small: x === t ? "Your side" : `Team ${x}` })), "two");
    if (ph === "judging") top = judging("Reading every argument. Wit counts.");
    if (ph === "result" && r) top = verdictBanner(r.winner === "tie" ? "Hung jury" : `${teamName(r.winner)} wins`, r.winner === "A" || r.winner === "B" ? "t" + r.winner : "") + scoreCard();
    const exhibit = `<section class="exhibit"><span class="label">Exhibit ${st.round || 1} · ${esc(L.place || "Somewhere, USA")}</span><p class="law">${esc(L.law)}</p>
      ${t ? `<span class="stamp" style="--c:var(--team${t})">${L.sides?.[t] === "for" ? "Keep it" : "Strike it"}</span>` : ""}
      ${L.twist ? `<div class="twist"><b>Twist rule</b>${esc(L.twist)}</div>` : ""}</section>`;
    return phaseChip(label) + top + exhibit + versus() + (ph === "result" ? boardView() : "");
  }

  /* ---- True Friends */
  function tfView() {
    const st = P.st, r = st.result, my = mine(), ph = st.phase, playing = tfPlaying();
    const label = { chat: "Masked chat", vote: "Choose your true friend", reveal: "Masks off" }[ph] || ph;
    let h = phaseChip(label);
    if (ph === "reveal" && r) {
      h += verdictBanner(r.survivorPicked ? "The Saviour got through" : "The Survivor wasn't fooled", "", "--tc:var(--hot)");
      const order = Object.keys(r.alias || {}).sort((a, b) => (r.awards?.[b] || 0) - (r.awards?.[a] || 0));
      h += `<section class="card"><span class="label">Unmasked</span><div class="board" style="margin-top:14px">${order.map(u => {
        const al = r.alias[u], pts = r.awards?.[u] || 0;
        return `<div class="r" style="--ac:${aliasColor(al)}">${av(al, aliasColor(al), "sm")}${av(nameOf(u), colorOf(u), "sm")}
          <span class="nm"><span style="color:var(--ac)">${esc(al)}</span> is ${esc(nameOf(u))}${u === r.sv ? `<span class="role">Saviour</span>` : u === r.su ? `<span class="role su">Survivor</span>` : ""}
          <small>picked ${esc(r.picked?.[u] ? r.alias[r.picked[u]] : "nobody")}</small></span><span class="pts">${pts > 0 ? "+" : ""}${pts}</span></div>`;
      }).join("")}</div></section>` + boardView();
      return h;
    }
    if (playing && my?.alias) {
      const cap = st.tf?.cap || 12, used = myCount();
      h += `<section class="maskhead" style="--ac:${aliasColor(my.alias)}"><span class="label">Tonight you are</span>
        <svg viewBox="0 0 100 50" fill="currentColor" aria-hidden="true">${window.GH.MASK}</svg><div class="alias">${esc(my.alias)}</div>
        ${ph === "chat" ? `<div class="pips" title="${cap - used} messages left">${Array.from({ length: cap }, (_, i) => `<i class="${i < used ? "used" : ""}"></i>`).join("")}</div><p class="label" style="margin-top:8px">${Math.max(0, cap - used)} messages left</p>` : ""}</section>`;
      h += `<div class="peek rolecard ${my.role === "saviour" ? "saviour" : ""}" data-peek tabindex="0" aria-label="Hold to reveal your secret role">
        <div class="secret">${my.role === "saviour"
          ? `<span class="label">Secret role</span><h3>You are the Saviour</h3><p>Get <span class="target">${esc(my.survivor)}</span> to pick you as their true friend at the vote. Don't let anyone else work out who you are.</p>`
          : `<span class="label">Secret role</span><h3>Survivor… maybe</h3><p>Somewhere in this chat is the Saviour, a true friend in disguise. If you're the Survivor, find them. If not, unmask them and seal an accusation.</p>`}</div>
        <div class="cover-s">${ICON.eye}<b>Hold to see your role</b><span>Cover your screen</span></div></div>`;
    } else if (!playing) {
      h += `<section class="card"><h3>You're watching this one</h3><p style="margin-top:6px">You joined mid-game. Everyone's in disguise. You'll get a mask next game.</p></section>`;
    }
    if (ph === "vote") h += voteBlock("Who's your true friend?", (st.tf?.aliases || []).filter(a => a !== my?.alias).map(a => ({ v: a, label: a, cls: "alias", style: `--ac:${aliasColor(a)}` })), "two");
    return h;
  }

  /* ---- Art of the Deal */
  function dealView() {
    const st = P.st, d = st.deal || {}, my = mine(), ph = st.phase, r = st.result;
    if (!d.title) return `<div class="loading"><p><span>S</span><span>e</span><span>t</span>ting up</p></div>`;
    const label = { negotiate: "Negotiation open", vote: "The room votes", judging: "Judge reviewing", result: "Closing" }[ph] || ph;
    let top = "";
    if (ph === "vote") top = voteBlock("Who got the better deal?", ["A", "B"].map(x => ({ v: x, label: teamName(x), cls: "t" + x, small: x === myTeam() ? "Your side" : `Team ${x}` })), "two");
    if (ph === "judging") top = judging("Checking the deal against both confidential briefs.");
    if (ph === "result" && r) top = verdictBanner(r.winner === "tie" ? "Even match" : `${teamName(r.winner)} wins`, r.winner === "A" || r.winner === "B" ? "t" + r.winner : "") + scoreCard();
    const file = `<section class="casefile"><span class="seal">Deal<br>or no<br>deal</span><span class="label">The case</span><h2>${esc(d.title)}</h2><p>${esc(d.setup)}</p>
      <div class="terms">${(d.terms || []).map(x => `<span>${esc(x)}</span>`).join("")}</div></section>`;
    const sides = versus(t => `<span class="you">${offersLeft(t)} of 4 offers left</span>`);
    const b = my?.brief;
    const brief = b && ph !== "result" ? `<div class="folder"><span class="tab">CONFIDENTIAL</span><div class="peek" data-peek tabindex="0" aria-label="Hold to read your confidential brief">
      <div class="secret"><span class="label">Eyes only · ${esc(b.name)}</span><h3>${esc(b.name)}</h3><p>${esc(b.brief)}</p>
        <dl><div><dt>Your ideal</dt><dd>${esc(b.ideal)}</dd></div><div><dt>Walk away at</dt><dd>${esc(b.walkaway)}</dd></div><div><dt>Your leverage</dt><dd>${esc(b.leverage)}</dd></div></dl></div>
      <div class="cover-s">${ICON.lock}<b>Hold to read your brief</b><span>Don't let them see</span></div></div></div>` : "";
    return phaseChip(label) + top + (ph === "negotiate" ? brief + file : file) + sides + (ph === "result" ? boardView() : "");
  }

  /* ---- chat */
  function renderChat() {
    const box = $("pv-chat"); if (!box) return;
    const eng = engine(), st = P.st, msgs = roundMsgs(), mySeat = mine()?.seat, t = myTeam();
    const revealed = eng === "friends" && st.phase === "reveal" && st.result?.alias;
    const done = ["result", "reveal"].includes(st.phase);
    $("pv-chathead").textContent = done ? "The transcript" : { laws: "The debate", friends: "The masked chat", deal: "The negotiation" }[eng] || "Chat";
    const host = { laws: "The Clerk", friends: "The Host", deal: "The Chair" }[eng] || "Host";
    const accept = msgs.find(m => m.kind === "accept");
    const offers = msgs.filter(m => m.kind === "offer");
    const signedId = accept ? (offers.filter(o => o.team !== accept.team && o.id < accept.id).pop() || {}).id : null;
    const onRight = m => (eng === "friends" ? !!mySeat && m.seat === mySeat : t ? m.team === t : m.team === "B");
    const html = msgs.map(m => {
      if (m.kind === "sys") return `<div class="msg sys">${esc(m.text)}</div>`;
      if (m.kind === "judge") {
        if (/^Breaking news: /.test(m.text)) return `<div class="news"><b>Breaking news</b><span>${esc(m.text.replace(/^Breaking news: /, ""))}</span></div>`;
        if (/^Halfway hint: /.test(m.text)) return `<div class="hint"><b>A hint from the Host</b>${esc(m.text.replace(/^Halfway hint: /, ""))}</div>`;
        return `<div class="clerk"><span class="who">${host}</span>${esc(m.text)}</div>`;
      }
      if (m.kind === "accuse") return `<div class="msg sys">🔒 ${esc(m.alias)} sealed an accusation</div>`;
      if (m.kind === "accept") return `<div class="msg sys"><strong>${esc(m.name)} signed for ${esc(teamName(m.team))}. We have a deal.</strong></div>`;
      if (m.kind === "offer") {
        const latest = offers.filter(o => o.team === m.team).pop()?.id === m.id;
        const signed = m.id === signedId, dead = !signed && (!latest || !!accept);
        const canSign = !accept && latest && st.phase === "negotiate" && t && m.team !== t && !!mine();
        const n = offers.filter(o => o.team === m.team && o.id <= m.id).length;
        return `<div class="contract t${m.team} ${onRight(m) ? "right" : ""} ${signed ? "signed" : dead ? "dead" : ""}"><div class="doc">
          <span class="who">${esc(teamName(m.team))} · formal offer ${n} of 4</span><div class="terms-t">${esc(m.text)}</div>
          <div class="sig"><span>${signed ? "Signed" : dead ? (accept ? "Not taken" : "Superseded") : `Proposed by ${esc(m.name)}`}</span>${canSign ? `<button class="sm" data-a="accept">Sign it</button>` : ""}</div></div></div>`;
      }
      const me = !!mySeat && m.seat === mySeat;
      let who = eng === "friends" ? m.alias : m.name;
      if (revealed) { const u = Object.keys(st.result.alias).find(k => st.result.alias[k] === m.alias); if (u) who += ` · ${nameOf(u)}`; }
      const style = eng === "friends" ? ` style="--ac:${aliasColor(m.alias)}"` : "";
      return `<div class="msg ${onRight(m) ? "right" : ""} ${me ? "me" : ""} ${m.team ? "t" + m.team : ""}"${style}><div class="bub"><span class="who">${esc(me ? "You" : who)}</span>${esc(m.text)}</div></div>`;
    }).join("") || `<div class="msg sys">The floor is open. Someone go first.</div>`;
    const near = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 220;
    const grew = msgs.length > P.seenMsgs; P.seenMsgs = msgs.length;
    if (put(box, "chat", html) && grew && (near || P.stick)) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
    P.stick = false;
  }

  /* ---- dock: only shows up when there's something to do */
  function renderDock() {
    const dock = $("pv-dock"); if (!dock) return;
    const st = P.st, eng = engine(), ph = st.phase || "lobby", my = mine(), t = myTeam();
    const chat = canChat();
    let actions = "", note = "", ph_ = "";
    const wait = text => `<div class="waitnote">${esc(text)} <span class="dots"><i></i><i></i><i></i></span></div>`;
    if (ph === "lobby") {
      const e = ENGINES[eng], n = onlineCount();
      actions = isHost()
        ? `<button class="big" data-a="start" ${P.busy || n < e.min ? "disabled" : ""}>${P.busy ? "Starting…" : n < e.min ? `Need ${e.min - n} more player${e.min - n === 1 ? "" : "s"}` : "Start the game"}</button>`
        : wait(`Waiting for ${nameOf(P.room.host)} to start`);
    } else if (ph === "result" || ph === "reveal") {
      actions = isHost()
        ? `<div class="row" style="width:100%;flex-wrap:nowrap"><button class="big" data-a="${eng === "laws" ? "next" : "again"}" ${P.busy ? "disabled" : ""}>${eng === "laws" ? "Next round" : "Play again"}</button><button class="ghost" data-a="lobby" style="flex:none">Lobby</button></div>`
        : wait(`Waiting for ${nameOf(P.room.host)}`);
    } else if (eng === "laws" && ph === "argue") {
      ph_ = t ? `Argue to ${st.laws?.sides?.[t] === "for" ? "keep" : "strike"} it…` : "";
      note = t ? "Persuade the room. Funny counts." : "You're watching. You'll be on a team next round.";
    } else if (eng === "friends" && ph === "chat") {
      ph_ = my?.alias ? `Speak as ${my.alias}…` : "";
      if (tfPlaying()) {
        const accused = roundMsgs().some(m => m.kind === "accuse" && m.seat && m.seat === my?.seat);
        actions = accused ? `<span class="note">🔒 Accusation sealed</span>` : `<button class="sm ghost" data-a="accuse">Seal an accusation</button>`;
        note = myCount() >= (st.tf?.cap || 12) ? "Out of messages. Watch closely." : "Right accusation +2 · wrong −1 · revealed at the end";
      } else note = "You're watching this game.";
    } else if (eng === "deal" && ph === "negotiate") {
      if (t) {
        const left = offersLeft(t);
        if (left <= 0 && P.dealMode === "offer") P.dealMode = "msg";
        actions = `<div class="seg"><button data-a="mode" data-v="msg" aria-pressed="${P.dealMode === "msg"}">Talk</button><button data-a="mode" data-v="offer" aria-pressed="${P.dealMode === "offer"}" ${left <= 0 ? "disabled" : ""}>Formal offer · ${left} left</button></div>`;
        ph_ = P.dealMode === "offer" ? "Write the terms: price, perks, conditions…" : "Talk it out…";
        note = P.dealMode === "offer" ? "Goes on the record. They can sign it." : "Read your brief, then make them an offer.";
      } else note = "You're observing this negotiation.";
    }
    put($("pv-actions"), "actions", actions);
    $("pv-actions").hidden = !actions;
    $("pv-form").hidden = !chat;
    dock.classList.toggle("offer", eng === "deal" && P.dealMode === "offer" && chat);
    const inp = $("pv-input");
    if (ph_ && inp.placeholder !== ph_) inp.placeholder = ph_;
    $("pv-note").textContent = note; $("pv-note").hidden = !note;
    dock.hidden = !(actions || chat || note);
    syncDock();
  }

  /* ---- sheets */
  function renderLayer() {
    const el = $("pv-layer"); if (!el) return;
    let h = "";
    if (P.sheet === "accuse" && P.st.phase === "chat") {
      const my = mine();
      h = `<div class="scrim" data-a="closeSheet"><div class="sheet" data-a="noop" role="dialog" aria-label="Seal an accusation"><div class="grab"></div>
        <h2>Who's the Saviour?</h2><p>Right: <b>+2</b>. Wrong: <b>−1</b>. Nobody sees it until the reveal, and you only get one.</p>
        <div class="list">${(P.st.tf?.aliases || []).filter(a => a !== my?.alias).map(a => `<button data-a="accuseWho" data-v="${esc(a)}">${av(a, aliasColor(a), "sm")}${esc(a)}</button>`).join("")}</div>
        <button class="ghost" data-a="closeSheet" style="width:100%;margin-top:14px">Not yet</button></div></div>`;
    } else if (P.sheet === "menu") {
      const playing = P.st.phase && P.st.phase !== "lobby";
      h = `<div class="scrim" data-a="closeSheet"><div class="sheet" data-a="noop" role="dialog" aria-label="Room menu"><div class="grab"></div>
        <span class="label">${esc(ENGINES[engine()]?.name || "")}</span><h2>Room ${esc(P.code)}</h2>
        <div class="list"><button data-a="share">Invite friends</button>
          ${isHost() && playing ? `<button data-a="lobby">End game · back to lobby</button>` : ""}
          ${!isHost() && hostAway() ? `<button data-a="takeover">Take over hosting</button>` : ""}
          <button class="danger" data-a="leave">Leave room</button></div>
        <button class="ghost" data-a="closeSheet" style="width:100%;margin-top:14px">Close</button></div></div>`;
    } else P.sheet = null;
    put(el, "layer", h);
  }

  window.GHPlay = { view, createRoom, teardown, ENGINES };
})();
