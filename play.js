/* GameHub live rooms. The database runs every rule (gh_private engines behind
   the room_* functions); this file only shows the room and sends moves.
   Each open page nudges the room clock with room_tick, which advances a
   phase only once its time has really passed. */
(() => {
  "use strict";
  const COLORS = ["#E4572E", "#1B998B", "#6C5CE7", "#C98F00", "#D7263D", "#2D7DD2", "#8F2D56", "#3E7C17", "#00838F", "#B5651D"];
  const ENGINES = {
    laws: { name: "Dumb Laws", min: 2, durations: [[120000, "2 min"], [180000, "3 min"], [300000, "5 min"]],
      how: "Two teams. Each round draws a real (reportedly) dumb law: one side defends it, the other tears it down. When the clock runs out, everyone votes for the side that argued best. Sides swap every round." },
    friends: { name: "True Friends", min: 3, durations: [[180000, "3 min"], [300000, "5 min"], [420000, "7 min"]],
      how: "Everyone chats under a random alias. One secret Saviour must get one unknowing Survivor to pick them as their true friend, without the rest of the room working it out. 12 messages each, one sealed accusation." },
    deal: { name: "Art of the Deal", min: 2, durations: [[240000, "4 min"], [360000, "6 min"], [480000, "8 min"]],
      how: "Two teams, each with a secret brief: what they want, their walk-away point and one hidden piece of leverage. Put formal offers on the record; the other side can accept one to close. The room votes on who got the better deal." }
  };

  const P = { code: null, room: null, st: {}, players: {}, msgs: new Map(), priv: null, online: new Set(), me: null,
    chan: null, ticker: null, lastTick: 0, ticking: false, busy: false, err: "", accuseOpen: false, myVote: null };
  let db, esc, root;

  const pick = a => a[Math.floor(Math.random() * a.length)];
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const $ = id => document.getElementById(id);
  const fmt = ms => { const s = Math.ceil(Math.max(0, ms) / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

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
  const myTeam = () => P.st.teams?.[P.me] || null;
  const mine = () => (P.priv && P.priv.gid === P.st.gid ? P.priv.payload : null);
  const roundMsgs = () => [...P.msgs.values()].filter(m => m.gid === P.st.gid && m.round === (P.st.round || 1)).sort((a, b) => a.id - b.id);
  const myCount = () => roundMsgs().filter(m => m.kind === "msg" && m.seat && m.seat === mine()?.seat).length;
  const onlineCount = () => Object.keys(P.players).filter(u => P.online.has(u)).length || Object.keys(P.players).length;
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
    if (eng === "friends") return st.phase === "chat" && (st.tf?.players || []).includes(P.me) && myCount() < (st.tf?.cap || 12);
    return false;
  }

  /* ------------------------------------------------------------ the room clock */
  function due() {
    const st = P.st, now = Date.now();
    if (!st.endsAt || !["argue", "chat", "negotiate", "vote"].includes(st.phase)) return false;
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
  function namePrompt(title, next) {
    const c0 = lsGet("gh-color") || pick(COLORS);
    root.innerHTML = `<div class="form card"><h1>${esc(title)}</h1><p class="muted small">Pick the name your friends will see. No account needed.</p>
      <label for="pv-name">Your name</label><input id="pv-name" maxlength="24" value="${esc(lsGet("gh-name") || "")}" autocomplete="nickname">
      <label>Colour</label><div class="swatches">${COLORS.map(c => `<button class="sw" type="button" data-c="${c}" style="background:${c}" aria-pressed="${c === c0}" aria-label="Colour ${c}"></button>`).join("")}</div>
      <div class="row" style="margin-top:14px"><button id="pv-go">Continue</button><a class="btn ghost" href="#/">Cancel</a></div><div id="pv-msg"></div></div>`;
    let color = c0;
    root.querySelectorAll(".sw").forEach(b => b.onclick = () => { color = b.dataset.c; root.querySelectorAll(".sw").forEach(x => x.setAttribute("aria-pressed", x === b)); });
    const go = () => { const n = $("pv-name").value.trim().slice(0, 24); if (!n) { $("pv-msg").innerHTML = `<p class="err">Enter a name.</p>`; return; } lsSet("gh-name", n); lsSet("gh-color", color); next(); };
    $("pv-go").onclick = go; $("pv-name").onkeydown = e => { if (e.key === "Enter") go(); };
    $("pv-name").focus();
  }
  const fail = (msg, back = "#/") => { root.innerHTML = `<div class="card"><p class="err">${esc(msg)}</p><a href="${esc(back)}">Back</a></div>`; };

  async function view(code) {
    teardown();
    ({ db, esc } = window.GH); root = document.getElementById("app");
    code = String(code || "").toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return fail("That room code doesn't look right.");
    if (!lsGet("gh-name")) return namePrompt("Join room " + code, () => view(code));
    root.innerHTML = `<p class="muted">Joining room ${esc(code)}…</p>`;
    let user;
    try { user = await ensureSession(); } catch (e) { return fail(sessionError(e)); }
    P.me = user.id; P.code = code;
    try { await call("join_room", { p_name: lsGet("gh-name"), p_color: lsGet("gh-color") || pick(COLORS) }); }
    catch (e) { P.code = null; return fail(e.message); }
    shell();
    await refetch();
    subscribe();
    P.ticker = setInterval(() => { tick(false); tickClock(); }, 1000);
    tick(true);
  }

  async function refetch() {
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
        if (p.new && !P.msgs.has(p.new.id)) { P.msgs.set(p.new.id, p.new); renderChat(); renderActions(); }
      })
      .on("presence", { event: "sync" }, () => { P.online = new Set(Object.keys(P.chan.presenceState())); render(); })
      .subscribe(async status => { if (status === "SUBSCRIBED") { await P.chan.track({ at: Date.now() }); refetch(); } });
  }

  function teardown() {
    if (P.ticker) clearInterval(P.ticker);
    if (P.chan) db.removeChannel(P.chan);
    Object.assign(P, { code: null, room: null, st: {}, players: {}, msgs: new Map(), priv: null, online: new Set(), chan: null, ticker: null,
      lastTick: 0, ticking: false, busy: false, err: "", accuseOpen: false, myVote: null });
  }

  async function createRoom(game) {
    ({ db, esc } = window.GH); root = document.getElementById("app");
    if (!lsGet("gh-name")) return namePrompt("Pick a name", () => createRoom(game).catch(e => fail(e.message, "#/game/" + game.slug)));
    try { await ensureSession(); } catch (e) { throw new Error(sessionError(e)); }
    const { data: code, error } = await db.rpc("create_room", { p_slug: game.slug });
    if (error) throw new Error(error.message);
    location.hash = "#/play/" + code;
  }

  /* ------------------------------------------------------------ actions */
  async function act(f) {
    if (P.busy) return;
    P.busy = true; P.err = ""; render();
    try { await f(); } catch (e) { P.err = e.message; }
    P.busy = false; render();
  }
  async function send(kind, text, target) {
    try { await call("room_post", { p_kind: kind, p_text: text || "", p_target: target || null }); P.err = ""; }
    catch (e) { P.err = e.message; render(); return false; }
    return true;
  }

  async function onClick(e) {
    const b = e.target.closest("[data-a]"); if (!b || !P.code) return;
    const a = b.dataset.a, v = b.dataset.v;
    if (a === "dur") return act(() => call("room_set_duration", { p_ms: +v }));
    if (a === "start" || a === "again") return act(() => call("room_start"));
    if (a === "next") return act(() => call("room_next_round"));
    if (a === "lobby") return act(() => call("room_to_lobby"));
    if (a === "takeover") return act(() => call("room_takeover"));
    if (a === "vote") { P.myVote = { key: P.st.voteKey, value: v }; render(); return act(() => call("room_vote", { p_value: v })); }
    if (a === "accuse") { P.accuseOpen = !P.accuseOpen; renderActions(); return; }
    if (a === "accuseWho") { P.accuseOpen = false; await send("accuse", "", v); renderActions(); return; }
    if (a === "offer") {
      const t = $("pv-input").value.trim();
      if (!t) { $("pv-note").textContent = "Type your offer in the box first, then tap Formal offer."; return; }
      if (await send("offer", t)) $("pv-input").value = "";
      return;
    }
    if (a === "accept") await send("accept");
  }
  document.addEventListener("click", onClick);

  /* ------------------------------------------------------------ render */
  function shell() {
    const e = ENGINES[engine()] || { name: "Room" };
    root.innerHTML = `<div class="room">
      <div class="roomhead card">
        <div class="row between"><div><span class="label" id="pv-game">${esc(e.name)}</span><h2 style="margin:0">Room <span class="mono">${esc(P.code)}</span></h2></div>
          <div class="row"><span id="pv-clock" class="timer" hidden></span><button class="btn ghost sm" id="pv-copy">Copy invite link</button></div></div>
        <div id="pv-people" class="people"></div>
      </div>
      <div id="pv-main" class="stack"></div>
      <section id="pv-chatwrap" class="stack" hidden>
        <div id="pv-chat" class="chat" aria-live="polite"></div>
        <div class="composer">
          <div class="row" id="pv-actions"></div>
          <form id="pv-form" autocomplete="off" class="row"><input id="pv-input" maxlength="280" placeholder="Say something…" aria-label="Message"><button id="pv-send" type="submit">Send</button></form>
          <p class="small muted" id="pv-note"></p>
        </div>
      </section></div>`;
    $("pv-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); $("pv-copy").textContent = "Copied!"; }
      catch { $("pv-copy").textContent = location.href; }
      setTimeout(() => { if ($("pv-copy")) $("pv-copy").textContent = "Copy invite link"; }, 2500);
    };
    $("pv-form").onsubmit = async e => {
      e.preventDefault();
      const t = $("pv-input").value.trim(); if (!t || !canChat()) return;
      if (await send("msg", t)) $("pv-input").value = "";
    };
  }

  function render() {
    if (!P.code || !$("pv-main") || !P.room) return;
    const st = P.st;
    $("pv-game").textContent = ENGINES[engine()]?.name || "Room";
    $("pv-people").innerHTML = Object.values(P.players).filter(p => !P.online.size || P.online.has(p.uid)).map(p =>
      `<span class="person"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${p.uid === P.room.host ? " ★" : ""}${p.uid === P.me ? " (you)" : ""}</span>`).join("");
    let h = P.err ? `<p class="err">${esc(P.err)}</p>` : "";
    if (!st.phase || st.phase === "lobby") h += lobbyView();
    else if (engine() === "laws") h += lawsView();
    else if (engine() === "friends") h += tfView();
    else if (engine() === "deal") h += dealView();
    h += hostBar();
    $("pv-main").innerHTML = h;
    const playing = st.phase && st.phase !== "lobby";
    $("pv-chatwrap").hidden = !playing;
    if (playing) { renderChat(); renderActions(); }
    tickClock();
  }

  function tickClock() {
    const el = $("pv-clock"); if (!el) return;
    const show = ["argue", "chat", "negotiate", "vote"].includes(P.st.phase) && P.st.endsAt;
    el.hidden = !show; if (!show) return;
    const left = P.st.endsAt - Date.now(); el.textContent = fmt(left); el.classList.toggle("low", left < 20000);
  }

  function hostBar() {
    const hostOnline = !P.online.size || P.online.has(P.room.host);
    if (isHost()) return `<div class="row between small muted"><span>You're the host.</span>${P.st.phase && P.st.phase !== "lobby" ? `<button class="btn ghost sm" data-a="lobby">End game</button>` : ""}</div>`;
    return `<div class="row between small muted"><span>Host: ${esc(nameOf(P.room.host))}${hostOnline ? "" : " (away)"}</span>${hostOnline ? "" : `<button class="btn ghost sm" data-a="takeover">Take over hosting</button>`}</div>`;
  }

  function boardView() {
    const rows = Object.entries(P.st.board || {}).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return "";
    return `<div class="card"><h3>Scoreboard</h3><div class="board">${rows.map(([u, p], i) => `<div class="r"><span>${i === 0 ? "👑 " : ""}${esc(P.st.names?.[u] || nameOf(u))}</span><span class="mono">${p}</span></div>`).join("")}</div></div>`;
  }

  function lobbyView() {
    const e = ENGINES[engine()], n = onlineCount(), st = P.st;
    let h = `<div class="card"><h3>How to play</h3><p>${esc(e.how)}</p>
      <p class="small muted">${n} in the room · needs ${e.min}+. Share the invite link — friends just pick a name.</p>`;
    if (isHost()) {
      const dur = st.duration || e.durations[1][0];
      h += `<span class="label">Round length</span><div class="row">${e.durations.map(([ms, l]) => `<button class="btn sm ${dur === ms ? "" : "ghost"}" data-a="dur" data-v="${ms}">${l}</button>`).join("")}</div>
        <div class="row" style="margin-top:12px"><button data-a="start" ${P.busy ? "disabled" : ""}>Start game</button></div>`;
    } else h += `<p class="muted">Waiting for the host to start…</p>`;
    return h + `</div>` + boardView();
  }

  function teamsView(inner) {
    return `<div class="teams">${["A", "B"].map(t => {
      const members = Object.entries(P.st.teams || {}).filter(([, x]) => x === t).map(([u]) => nameOf(u));
      return `<div class="team t${t}"><strong>${esc(teamName(t))}${myTeam() === t ? " · you" : ""}</strong><span class="small">${members.map(esc).join(", ") || "—"}</span>${inner ? inner(t) : ""}</div>`;
    }).join("")}</div>`;
  }

  function votePanel(question, options) {
    if (P.st.phase !== "vote") return "";
    const voters = P.st.voters || [], canVote = voters.includes(P.me);
    const chosen = P.myVote?.key === P.st.voteKey ? P.myVote.value : null;
    return `<div class="card"><h2>${esc(question)}</h2><p class="small muted">${P.st.voteCount || 0} of ${voters.length} voted.</p>
      <div class="picks">${options.map(([v, label]) => `<button class="pickbtn" data-a="vote" data-v="${esc(v)}" aria-pressed="${chosen === v}" ${canVote ? "" : "disabled"}>${esc(label)}</button>`).join("")}</div>
      ${canVote ? "" : `<p class="small muted">You're watching this round.</p>`}</div>`;
  }

  function resultView(title) {
    const r = P.st.result; if (!r) return "";
    const tot = Math.max(1, (r.counts?.A || 0) + (r.counts?.B || 0));
    const bar = t => `<div class="bar"><span>${esc(teamName(t))}</span><span class="track"><span class="fill t${t}" style="width:${(r.counts?.[t] || 0) / tot * 100}%"></span></span><span class="mono">${r.counts?.[t] || 0}</span></div>`;
    let h = `<div class="card"><span class="label">The verdict</span><h2>${esc(title)}</h2>`;
    if (r.counts) h += bar("A") + bar("B");
    if (r.outcome) h += `<p class="small muted">${esc(r.outcome)}</p>`;
    h += `<p>${esc(r.verdict)}</p>`;
    if (r.briefs) h += `<span class="label">Secret briefs revealed</span>` + ["A", "B"].map(t => `<div class="brief"><strong>${esc(r.briefs[t].name)}</strong><p class="small">Wanted: ${esc(r.briefs[t].ideal)}</p><p class="small">Walk-away: ${esc(r.briefs[t].walkaway)} · Leverage: ${esc(r.briefs[t].leverage)}</p></div>`).join("");
    const pts = r.awards?.[P.me];
    if (pts !== undefined) h += `<p class="mono small">You ${pts >= 0 ? "earned" : "lost"} ${Math.abs(pts)} point${Math.abs(pts) === 1 ? "" : "s"}.</p>`;
    if (isHost()) h += `<div class="row">${engine() === "laws" ? `<button data-a="next">Next round (sides swap)</button>` : `<button data-a="again">Play again</button>`}<button class="btn ghost" data-a="lobby">Back to lobby</button></div>`;
    else h += `<p class="small muted">Waiting for the host…</p>`;
    return h + `</div>` + boardView();
  }

  function lawsView() {
    const L = P.st.laws || {}, t = myTeam();
    let h = `<div class="card case"><div class="row between"><span class="label">Round ${P.st.round || 1} · ${esc(L.place || "")}</span>
      ${t ? `<span class="pill ${L.sides?.[t] === "for" ? "live" : "draft"}">You: ${esc(teamName(t))}</span>` : `<span class="pill">Watching</span>`}</div>
      <p class="law">“${esc(L.law)}”</p>${L.twist ? `<p class="twist">${esc(L.twist)}</p>` : ""}${teamsView()}</div>`;
    h += votePanel("Which side argued best?", [["A", teamName("A")], ["B", teamName("B")]]);
    if (P.st.phase === "result") { const w = P.st.result?.winner; h += resultView(w === "tie" ? "It's a tie" : `"${teamName(w)}" wins`); }
    return h;
  }

  function tfView() {
    const st = P.st, r = st.result, my = mine(), playing = (st.tf?.players || []).includes(P.me);
    let h = `<div class="card case"><div class="row between"><span class="label">Anonymous lobby</span>${my?.alias ? `<span class="pill draft">You are ${esc(my.alias)}</span>` : `<span class="pill">Watching</span>`}</div>`;
    if (playing && my && st.phase !== "reveal") h += my.role === "saviour"
      ? `<div class="brief secret"><span class="label">Your secret role</span><p><strong>You are the Saviour.</strong> Get <strong>${esc(my.survivor)}</strong> to pick you as their true friend at the vote, without the rest of the room working out who you are.</p></div>`
      : `<div class="brief"><span class="label">Your role</span><p>You might be the Survivor, or you might not. Somewhere in this chat is the Saviour. Find your true friend and vote for them.</p></div>`;
    if (playing && st.phase === "chat") h += `<p class="small muted mono">${Math.max(0, (st.tf?.cap || 12) - myCount())} of ${st.tf?.cap || 12} messages left</p>`;
    h += `</div>`;
    if (st.phase === "vote") h += votePanel("Who is your true friend?", (st.tf?.aliases || []).filter(a => a !== my?.alias).map(a => [a, a]));
    if (st.phase === "reveal" && r) {
      h += `<div class="card"><span class="label">The reveal</span><h2>${r.survivorPicked ? "The Saviour got through" : "The Survivor wasn't fooled"}</h2><p>${esc(r.verdict)}</p>
        <div class="board">${Object.keys(r.alias || {}).map(u => `<div class="r"><span>${esc(r.alias[u])} = ${esc(nameOf(u))}${u === r.sv ? " (Saviour)" : u === r.su ? " (Survivor)" : ""}</span><span class="small muted">picked ${esc(r.picked?.[u] ? r.alias[r.picked[u]] : "nobody")} · <span class="mono">${r.awards[u] > 0 ? "+" : ""}${r.awards[u]}</span></span></div>`).join("")}</div>
        ${isHost() ? `<div class="row" style="margin-top:12px"><button data-a="again">Play again</button><button class="btn ghost" data-a="lobby">Back to lobby</button></div>` : `<p class="small muted">Waiting for the host…</p>`}</div>` + boardView();
    }
    return h;
  }

  function dealView() {
    const st = P.st, d = st.deal || {}, my = mine();
    if (!d.title) return `<div class="card"><p class="muted">Setting up…</p></div>`;
    const offersLeft = x => Math.max(0, 4 - roundMsgs().filter(m => m.kind === "offer" && m.team === x).length);
    let h = `<div class="card case"><span class="label">The case</span><h2>${esc(d.title)}</h2><p>${esc(d.setup)}</p>
      <div class="row">${(d.terms || []).map(x => `<span class="pill">${esc(x)}</span>`).join("")}</div>${teamsView(x => `<span class="small muted">${offersLeft(x)} offers left</span>`)}`;
    const b = my?.brief;
    if (b && st.phase !== "result") h += `<div class="brief secret"><span class="label">Secret brief · ${esc(b.name)}</span><p>${esc(b.brief)}</p><p class="small"><strong>Ideal:</strong> ${esc(b.ideal)}</p><p class="small"><strong>Walk away at:</strong> ${esc(b.walkaway)}</p><p class="small"><strong>Your leverage:</strong> ${esc(b.leverage)}</p></div>`;
    h += `</div>`;
    h += votePanel("Who got the better deal?", [["A", teamName("A")], ["B", teamName("B")]]);
    if (st.phase === "result") { const w = st.result?.winner; h += resultView(w === "tie" ? "It's a tie" : `${teamName(w)} wins`); }
    return h;
  }

  function renderChat() {
    const box = $("pv-chat"); if (!box) return;
    const near = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 160;
    const eng = engine(), revealed = eng === "friends" && P.st.phase === "reveal" && P.st.result?.alias, mySeat = mine()?.seat;
    box.innerHTML = roundMsgs().map(m => {
      if (m.kind === "sys") return `<div class="msg sys">${esc(m.text)}</div>`;
      if (m.kind === "judge") return `<div class="msg judge"><div class="who">Judge</div>${esc(m.text)}</div>`;
      if (m.kind === "accuse") return `<div class="msg sys">${esc(m.alias)} sealed an accusation.</div>`;
      if (m.kind === "accept") return `<div class="msg sys"><strong>${esc(m.name)} accepted the offer for ${esc(teamName(m.team))}. Deal!</strong></div>`;
      const me = !!mySeat && m.seat === mySeat;
      let who = eng === "friends" ? m.alias : `${m.name}${m.team ? " · " + teamName(m.team) : ""}`;
      if (revealed) { const u = Object.keys(P.st.result.alias).find(k => P.st.result.alias[k] === m.alias); if (u) who += ` (${nameOf(u)})`; }
      return `<div class="msg ${me ? "me" : ""} ${m.team ? "t" + m.team : ""} ${m.kind === "offer" ? "offer" : ""}"><div class="who">${esc(me ? "You" : who)}${m.kind === "offer" ? " · formal offer" : ""}</div>${esc(m.text)}</div>`;
    }).join("") || `<div class="msg sys">No messages yet. Someone has to go first.</div>`;
    if (near) window.scrollTo(0, document.body.scrollHeight);
  }

  function renderActions() {
    const actEl = $("pv-actions"), note = $("pv-note"), inp = $("pv-input"); if (!actEl) return;
    const st = P.st, eng = engine(), ok = canChat(), my = mine();
    inp.disabled = !ok; $("pv-send").disabled = !ok;
    let h = "", n = "";
    if (eng === "laws") { inp.placeholder = "Make your case…"; if (st.phase === "argue") n = myTeam() ? "Argue your side. When time runs out, the whole room votes." : "You're watching — you'll get a team in a moment."; }
    if (eng === "friends") {
      inp.placeholder = my?.alias ? `Speak as ${my.alias}…` : "Watching";
      const accused = roundMsgs().some(m => m.kind === "accuse" && m.seat && m.seat === my?.seat);
      if (st.phase === "chat" && (st.tf?.players || []).includes(P.me)) {
        if (!accused) {
          h = `<button class="btn ghost sm" data-a="accuse">${P.accuseOpen ? "Cancel" : "Seal an accusation"}</button>`;
          if (P.accuseOpen) h += `<div class="picks" style="width:100%">${(st.tf.aliases || []).filter(a => a !== my?.alias).map(a => `<button class="pickbtn" data-a="accuseWho" data-v="${esc(a)}">${esc(a)}</button>`).join("")}</div>`;
        }
        n = myCount() >= (st.tf?.cap || 12) ? "You've used all your messages. Watch closely." : "One sealed accusation: name the Saviour right for +2, wrong for −1. Revealed at the end.";
      }
    }
    if (eng === "deal" && st.phase === "negotiate" && myTeam()) {
      inp.placeholder = "Negotiate…";
      const left = 4 - roundMsgs().filter(m => m.kind === "offer" && m.team === myTeam()).length;
      const theirs = roundMsgs().filter(m => m.kind === "offer" && m.team !== myTeam()).pop();
      h = `<button class="btn sm" data-a="offer" ${left <= 0 ? "disabled" : ""}>Formal offer (${Math.max(0, left)} left)</button>` + (theirs ? `<button class="btn sm gold" data-a="accept">Accept their last offer</button>` : "");
      n = "Type terms in the box, then tap Formal offer to put them on the record.";
    }
    actEl.innerHTML = h; actEl.hidden = !h; note.textContent = n;
  }

  window.GHPlay = { view, createRoom, teardown, ENGINES };
})();
