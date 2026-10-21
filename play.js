/* GameHub live runtime: rooms, realtime chat, presence and crowd-vote judging
   for the three house games. The host's browser runs the timers and scoring;
   every other phone just reads the room state and posts moves. */
(() => {
  "use strict";
  const D = window.GH_DATA;
  const COLORS = ["#E4572E", "#1B998B", "#6C5CE7", "#C98F00", "#D7263D", "#2D7DD2", "#8F2D56", "#3E7C17", "#00838F", "#B5651D"];
  const ENGINES = {
    laws: { name: "Dumb Laws", min: 2, durations: [[120000, "2 min"], [180000, "3 min"], [300000, "5 min"]],
      how: "Two teams. Each round draws a real (reportedly) dumb law: one side defends it, the other tears it down. When the clock runs out, everyone votes for the side that argued best. Sides swap every round." },
    friends: { name: "True Friends", min: 3, durations: [[180000, "3 min"], [300000, "5 min"], [420000, "7 min"]],
      how: "Everyone chats under a random alias. One secret Saviour must get one unknowing Survivor to pick them as their true friend, without the rest of the room working it out. 12 messages each, one sealed accusation." },
    deal: { name: "Art of the Deal", min: 2, durations: [[240000, "4 min"], [360000, "6 min"], [480000, "8 min"]],
      how: "Two teams, each with a secret brief: what they want, their walk-away point and one hidden piece of leverage. Put formal offers on the record; the other side can accept one to close. The room votes on who got the better deal." }
  };

  const P = { code: null, room: null, st: {}, players: {}, msgs: new Map(), online: new Set(), me: null,
    chan: null, ticker: null, busy: false, err: "", accuseOpen: false, presenceReady: false };
  let db, esc, root;

  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const $ = id => document.getElementById(id);
  function enc(o, k) { const s = encodeURIComponent(JSON.stringify(o)); let r = ""; for (let i = 0; i < s.length; i++) r += String.fromCharCode(s.charCodeAt(i) ^ k.charCodeAt(i % k.length)); return btoa(r); }
  function dec(b, k) { try { const r = atob(b); let s = ""; for (let i = 0; i < r.length; i++) s += String.fromCharCode(r.charCodeAt(i) ^ k.charCodeAt(i % k.length)); return JSON.parse(decodeURIComponent(s)); } catch { return null; } }
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
      return `Guest play isn't switched on for this GameHub yet. The owner needs to enable <strong>Anonymous sign-ins</strong> in Supabase (Authentication → Sign In / Providers).`;
    return esc(e?.message || "Couldn't start a session.");
  }

  /* ------------------------------------------------------------ helpers over state */
  const engine = () => P.room?.engine;
  const isHost = () => P.room && P.room.host === P.me;
  const nameOf = uid => P.players[uid]?.name || P.st.names?.[uid] || "Someone";
  const colorOf = uid => P.players[uid]?.color || "#888";
  const activeUids = () => { const all = Object.keys(P.players); return P.presenceReady ? all.filter(u => P.online.has(u)) : all; };
  const myTeam = () => P.st.teams?.[P.me] || null;
  const tfSecret = () => P.st.tf?.secret ? dec(P.st.tf.secret, P.st.gid) : null;
  const myAlias = () => tfSecret()?.alias?.[P.me] || null;
  const roundMsgs = () => [...P.msgs.values()].filter(m => m.gid === P.st.gid && m.round === (P.st.round || 1)).sort((a, b) => a.id - b.id);
  function teamName(t) {
    if (engine() === "laws") return P.st.laws?.sides?.[t] === "for" ? "Keep it" : "Strike it";
    if (engine() === "deal") return P.st.deal?.scenario?.[t]?.name || "Team " + t;
    return t;
  }
  function votes() { const v = {}; for (const p of Object.values(P.players)) if (P.st.voteKey && p.vote_key === P.st.voteKey && p.vote) v[p.uid] = p.vote; return v; }
  function voters() {
    if (engine() === "friends") return (P.st.tf?.players || []).filter(u => activeUids().includes(u));
    return activeUids();
  }
  function balance(uids, existing = {}) {
    const t = { ...existing }; let a = Object.values(t).filter(x => x === "A").length, b = Object.values(t).filter(x => x === "B").length;
    for (const u of shuffle(uids)) { if (t[u]) continue; if (a <= b) { t[u] = "A"; a++; } else { t[u] = "B"; b++; } }
    return t;
  }

  /* ------------------------------------------------------------ writes */
  async function setState(patch) {
    const next = { ...P.st, ...patch };
    P.st = next;
    const { error } = await db.from("rooms").update({ state: next, updated_at: new Date().toISOString() }).eq("code", P.code);
    if (error) throw error;
    render();
  }
  async function post(kind, text, extra = {}) {
    const row = { room_code: P.code, gid: P.st.gid || "none", round: P.st.round || 1, kind, text: String(text).slice(0, 600),
      name: P.players[P.me]?.name || "", team: myTeam(), ...extra };
    if (engine() === "friends" && (kind === "msg" || kind === "accuse")) { row.alias = myAlias(); row.name = ""; }
    if (kind === "sys" || kind === "judge") { row.name = ""; row.team = null; }
    const { data, error } = await db.from("room_messages").insert(row).select().single();
    if (error) { P.err = error.message; render(); return; }
    addMsg(data);
  }
  function addMsg(m) { if (!m || P.msgs.has(m.id)) return; P.msgs.set(m.id, m); renderChat(); renderActions(); }
  async function vote(v) {
    const { error } = await db.from("room_players").update({ vote: v, vote_key: P.st.voteKey }).eq("room_code", P.code).eq("uid", P.me);
    if (error) { P.err = error.message; }
    if (P.players[P.me]) P.players[P.me] = { ...P.players[P.me], vote: v, vote_key: P.st.voteKey };
    render();
  }

  /* ------------------------------------------------------------ host: game starts */
  async function startGame() {
    const e = ENGINES[engine()], online = activeUids();
    if (online.length < e.min) { P.err = `${e.name} needs at least ${e.min} players in the room.`; render(); return; }
    P.err = "";
    const names = { ...(P.st.names || {}) }; for (const u of online) names[u] = nameOf(u);
    await setState({ names });
    if (engine() === "laws") return lawsRound(true);
    if (engine() === "friends") return tfStart();
    if (engine() === "deal") return dealStart();
  }

  async function lawsRound(first) {
    const st = P.st, used = st.usedLaws || [];
    let pool = D.LAWS.map((_, i) => i).filter(i => !used.includes(i)); if (!pool.length) pool = D.LAWS.map((_, i) => i);
    const idx = pick(pool); const [law, place] = D.LAWS[idx];
    const sides = first ? { A: "for", B: "against" } : { A: st.laws.sides.A === "for" ? "against" : "for", B: st.laws.sides.B === "for" ? "against" : "for" };
    const twist = Math.random() < 0.35 ? pick(D.TWISTS) : null;
    const now = Date.now();
    await setState({ phase: "argue", gid: first ? rid() : st.gid, round: first ? 1 : (st.round || 1) + 1,
      teams: first ? balance(activeUids()) : st.teams, usedLaws: [...used, idx].slice(-80),
      phaseAt: now, endsAt: now + (st.duration || 180000), laws: { law, place, sides, twist }, result: null, voteKey: null });
    await post("judge", `Order in the court. Team "${teamName("A")}" argues to keep this law; team "${teamName("B")}" argues to strike it. Best case wins the room.` + (twist ? "\n" + twist : ""));
  }

  async function tfStart() {
    const players = shuffle(activeUids());
    if (players.length < 3) { P.err = "True Friends needs at least 3 players in the room."; render(); return; }
    const gid = rid(), names = shuffle(D.ALIASES);
    const alias = Object.fromEntries(players.map((u, i) => [u, names[i % names.length] + (i >= names.length ? " " + (i + 1) : "")]));
    const now = Date.now();
    await setState({ phase: "chat", gid, round: 1, teams: {}, phaseAt: now, endsAt: now + (P.st.duration || 300000),
      tf: { secret: enc({ alias, sv: players[0], su: players[1] }, gid), players, cap: 12, hint: false }, result: null, voteKey: null });
    await post("judge", "Welcome, strangers. One of you is a secret Saviour. One of you is quietly being hunted as a friend. Trust carefully.\n\nFirst question: " + pick(D.TF_STARTERS));
  }

  async function dealStart() {
    const sc = pick(D.DEALS), now = Date.now();
    await setState({ phase: "negotiate", gid: rid(), round: 1, teams: balance(activeUids()), phaseAt: now, endsAt: now + (P.st.duration || 360000),
      deal: { scenario: sc, event: false, accepted: null }, result: null, voteKey: null });
    await post("judge", `${sc.title}\n\n${sc.setup}\n\nOn the table: ${sc.terms.join(" · ")}. Read your team's secret brief. Four formal offers each. Begin.`);
  }

  async function openVote(msg, ms, extra = {}) {
    const now = Date.now();
    await setState({ phase: "vote", voteKey: rid(), phaseAt: now, endsAt: now + ms, ...extra });
    await post("sys", msg);
  }

  /* ------------------------------------------------------------ host: tally */
  function bump(awards) {
    const board = { ...(P.st.board || {}) }, names = { ...(P.st.names || {}) };
    for (const [u, p] of Object.entries(awards)) { board[u] = (board[u] || 0) + p; names[u] = nameOf(u); }
    return { board, names };
  }
  async function finishVote() {
    const v = votes();
    if (engine() === "friends") return tfReveal(v);
    const counts = { A: 0, B: 0 }; for (const x of Object.values(v)) if (x === "A" || x === "B") counts[x]++;
    const winner = counts.A === counts.B ? "tie" : counts.A > counts.B ? "A" : "B";
    const awards = {}; for (const [u, t] of Object.entries(P.st.teams || {})) awards[u] = winner === "tie" ? 1 : t === winner ? 3 : 0;
    const margin = winner === "tie" ? "" : ` ${counts[winner]}–${counts[winner === "A" ? "B" : "A"]}`;
    const result = { counts, winner, awards,
      verdict: winner === "tie" ? "The room is split down the middle. Dead heat." : `The room sided with "${teamName(winner)}"${margin}.` };
    if (engine() === "deal") {
      result.briefs = { A: P.st.deal.scenario.A, B: P.st.deal.scenario.B };
      result.outcome = P.st.deal.accepted ? `Deal signed: "${P.st.deal.accepted}"` : "No deal. Both sides walked away.";
    }
    await setState({ phase: "result", result, ...bump(awards) });
  }
  async function tfReveal(v) {
    const sec = tfSecret(), players = P.st.tf.players || [];
    const byAlias = Object.fromEntries(Object.entries(sec.alias).map(([u, a]) => [a, u]));
    const picked = Object.fromEntries(players.map(u => [u, v[u] ? byAlias[v[u]] || null : null]));
    const awards = {}; players.forEach(u => awards[u] = 0);
    const survivorPicked = picked[sec.su] === sec.sv;
    if (survivorPicked) { awards[sec.sv] += 5; awards[sec.su] += 2; }
    for (const u of players) { if (u === sec.sv || u === sec.su) continue; if (picked[u] === sec.sv) awards[u] += 2; else awards[sec.sv] += 1; }
    const accused = {}; roundMsgs().filter(m => m.kind === "accuse").forEach(m => { if (!(m.uid in accused)) accused[m.uid] = m.target; });
    for (const [u, target] of Object.entries(accused)) { if (u === sec.sv || !(u in awards)) continue; awards[u] += byAlias[target] === sec.sv ? 2 : -1; }
    const verdict = survivorPicked ? `The Saviour pulled it off. ${sec.alias[sec.su]} picked ${sec.alias[sec.sv]}.` : `The Survivor didn't fall for it. ${sec.alias[sec.su]} did not pick the Saviour, ${sec.alias[sec.sv]}.`;
    await setState({ phase: "reveal", result: { awards, survivorPicked, picked, sv: sec.sv, su: sec.su, alias: sec.alias, verdict }, ...bump(awards) });
  }

  /* ------------------------------------------------------------ host: clock */
  function hostTick() {
    if (!isHost() || P.busy || !P.st.phase) return;
    const st = P.st, now = Date.now(), eng = engine();
    const run = async f => { P.busy = true; try { await f(); } catch (e) { P.err = e.message || String(e); console.warn(e); } P.busy = false; render(); };
    if ((eng === "laws" || eng === "deal") && !["lobby"].includes(st.phase) && st.teams) {
      const missing = activeUids().filter(u => !st.teams[u]);
      if (missing.length) return run(() => setState({ teams: balance(missing, st.teams), names: { ...(st.names || {}), ...Object.fromEntries(missing.map(u => [u, nameOf(u)])) } }));
    }
    if (st.phase === "vote") {
      const el = voters(), n = Object.keys(votes()).filter(u => el.includes(u)).length;
      if (now >= st.endsAt || (el.length && n >= el.length)) return run(finishVote);
      return;
    }
    if (eng === "laws" && st.phase === "argue" && now >= st.endsAt) return run(() => openVote("Time! Vote for the side that argued best.", 60000));
    if (eng === "friends" && st.phase === "chat") {
      if (now >= st.endsAt) return run(() => openVote("Chat closed. Pick your true friend.", 75000));
      if (!st.tf.hint && now - st.phaseAt > (st.endsAt - st.phaseAt) / 2) return run(async () => { await setState({ tf: { ...st.tf, hint: true } }); await post("judge", "Halfway hint: " + pick(D.TF_HINTS)); });
    }
    if (eng === "deal" && st.phase === "negotiate") {
      const acc = roundMsgs().find(m => m.kind === "accept");
      if (acc) return run(() => openVote("A deal was accepted! Vote for the side that got the better end.", 60000, { deal: { ...st.deal, accepted: acc.ref } }));
      if (now >= st.endsAt) return run(() => openVote("Time! No deal signed. Vote for the side that negotiated best.", 60000));
      if (!st.deal.event && now - st.phaseAt > (st.endsAt - st.phaseAt) / 2) return run(async () => { await setState({ deal: { ...st.deal, event: true } }); await post("judge", "Breaking news: " + pick(D.DEAL_EVENTS)); });
    }
  }

  /* ------------------------------------------------------------ joining */
  function namePrompt(code, next) {
    const c0 = lsGet("gh-color") || pick(COLORS);
    root.innerHTML = `<div class="form card"><h1>${code ? "Join room " + esc(code) : "Pick a name"}</h1><p class="muted small">Pick the name your friends will see. No account needed.</p>
      <label for="pv-name">Your name</label><input id="pv-name" maxlength="24" value="${esc(lsGet("gh-name") || "")}" autocomplete="nickname">
      <label>Colour</label><div class="swatches">${COLORS.map(c => `<button class="sw" type="button" data-c="${c}" style="background:${c}" aria-pressed="${c === c0}" aria-label="Colour ${c}"></button>`).join("")}</div>
      <div class="row" style="margin-top:14px"><button id="pv-go">Join</button><a class="btn ghost" href="#/">Cancel</a></div><div id="pv-msg"></div></div>`;
    let color = c0;
    root.querySelectorAll(".sw").forEach(b => b.onclick = () => { color = b.dataset.c; root.querySelectorAll(".sw").forEach(x => x.setAttribute("aria-pressed", x === b)); });
    const go = () => { const n = $("pv-name").value.trim().slice(0, 24); if (!n) { $("pv-msg").innerHTML = `<p class="err">Enter a name.</p>`; return; } lsSet("gh-name", n); lsSet("gh-color", color); next(); };
    $("pv-go").onclick = go; $("pv-name").onkeydown = e => { if (e.key === "Enter") go(); };
    $("pv-name").focus();
  }

  async function view(code) {
    teardown();
    ({ db, esc } = window.GH); root = document.getElementById("app");
    code = String(code || "").toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) { root.innerHTML = `<div class="card"><p class="err">That room code doesn't look right.</p><a href="#/">Back</a></div>`; return; }
    if (!lsGet("gh-name")) return namePrompt(code, () => view(code));
    root.innerHTML = `<p class="muted">Joining room ${esc(code)}…</p>`;
    let user;
    try { user = await ensureSession(); } catch (e) { root.innerHTML = `<div class="card"><p class="err">${sessionError(e)}</p></div>`; return; }
    P.me = user.id; P.code = code;
    const { data: room } = await db.from("rooms").select("*").eq("code", code).maybeSingle();
    if (!room) { root.innerHTML = `<div class="card"><p class="err">Room ${esc(code)} doesn't exist.</p><a href="#/">Back to games</a></div>`; return; }
    P.room = room; P.st = room.state || {};
    const me = { room_code: code, uid: P.me, name: lsGet("gh-name"), color: lsGet("gh-color") || pick(COLORS) };
    const { error } = await db.from("room_players").upsert(me, { onConflict: "room_code,uid" });
    if (error) { root.innerHTML = `<div class="card"><p class="err">${esc(error.message)}</p></div>`; return; }
    shell();
    await refetch();
    subscribe();
    P.ticker = setInterval(() => { hostTick(); tickClock(); }, 1000);
  }

  async function refetch() {
    const [r, pl] = await Promise.all([
      db.from("rooms").select("*").eq("code", P.code).single(),
      db.from("room_players").select("*").eq("room_code", P.code)
    ]);
    if (r.data) { P.room = r.data; P.st = r.data.state || {}; }
    if (pl.data) { P.players = {}; pl.data.forEach(p => P.players[p.uid] = p); }
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
        if (gidChanged) refetch(); else render();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "room_players", filter: "room_code=eq." + code }, p => {
        if (p.new && p.new.uid) { P.players[p.new.uid] = p.new; render(); }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_messages", filter: "room_code=eq." + code }, p => addMsg(p.new))
      .on("presence", { event: "sync" }, () => { P.online = new Set(Object.keys(P.chan.presenceState())); P.presenceReady = true; render(); })
      .subscribe(async status => {
        if (status === "SUBSCRIBED") { await P.chan.track({ name: lsGet("gh-name") }); refetch(); }
      });
  }

  function teardown() {
    if (P.ticker) clearInterval(P.ticker);
    if (P.chan) db.removeChannel(P.chan);
    Object.assign(P, { code: null, room: null, st: {}, players: {}, msgs: new Map(), online: new Set(), chan: null, ticker: null, busy: false, err: "", accuseOpen: false, presenceReady: false });
  }

  async function createRoom(game) {
    ({ db, esc } = window.GH);
    const eng = game.config?.engine;
    if (!ENGINES[eng]) throw new Error("This game has no live runtime yet.");
    if (!lsGet("gh-name")) {
      root = document.getElementById("app");
      return namePrompt("", () => createRoom(game).catch(e => { root.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><a href="#/game/${esc(game.slug)}">Back</a></div>`; }));
    }
    let user;
    try { user = await ensureSession(); } catch (e) { throw new Error(sessionError(e).replace(/<[^>]+>/g, "")); }
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
      const { error } = await db.from("rooms").insert({ code, game_slug: game.slug, engine: eng, host: user.id, state: { phase: "lobby", gid: rid(), round: 1, board: {}, names: {} } });
      if (!error) { location.hash = "#/play/" + code; return; }
      if (error.code !== "23505") throw error;
    }
    throw new Error("Couldn't find a free room code. Try again.");
  }

  /* ------------------------------------------------------------ render */
  function shell() {
    const e = ENGINES[engine()];
    root.innerHTML = `<div class="room">
      <div class="roomhead card">
        <div class="row between"><div><span class="label">${esc(e.name)}</span><h2 style="margin:0">Room <span class="mono">${esc(P.code)}</span></h2></div>
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
      const link = location.href;
      try { await navigator.clipboard.writeText(link); $("pv-copy").textContent = "Copied!"; } catch { prompt("Copy this link:", link); }
      setTimeout(() => { if ($("pv-copy")) $("pv-copy").textContent = "Copy invite link"; }, 1500);
    };
    $("pv-form").onsubmit = e => { e.preventDefault(); const t = $("pv-input").value.trim(); if (!t || !canChat()) return; $("pv-input").value = ""; post("msg", t); };
  }

  function canChat() {
    const st = P.st, eng = engine();
    if (eng === "laws") return st.phase === "argue" && !!myTeam();
    if (eng === "deal") return st.phase === "negotiate" && !!myTeam();
    if (eng === "friends") return st.phase === "chat" && (st.tf?.players || []).includes(P.me) && myCount() < (st.tf?.cap || 12);
    return false;
  }
  const myCount = () => roundMsgs().filter(m => m.uid === P.me && m.kind === "msg").length;

  function render() {
    if (!P.code || !$("pv-main")) return;
    const st = P.st;
    $("pv-people").innerHTML = Object.values(P.players).filter(p => !P.presenceReady || P.online.has(p.uid)).map(p =>
      `<span class="person"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${p.uid === P.room.host ? " ★" : ""}${p.uid === P.me ? " (you)" : ""}</span>`).join("");
    let h = "";
    if (P.err) h += `<p class="err">${esc(P.err)}</p>`;
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
    const hostOnline = !P.presenceReady || P.online.has(P.room.host);
    if (isHost()) return `<div class="row between small muted"><span>You're the host — your phone runs the clock. Keep this page open.</span>${P.st.phase && P.st.phase !== "lobby" ? `<button class="btn ghost sm" data-a="lobby">End game</button>` : ""}</div>`;
    return `<div class="row between small muted"><span>Host: ${esc(nameOf(P.room.host))}${hostOnline ? "" : " (offline)"}</span>${hostOnline ? "" : `<button class="btn ghost sm" data-a="takeover">Take over hosting</button>`}</div>`;
  }

  function boardView() {
    const rows = Object.entries(P.st.board || {}).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return "";
    return `<div class="card"><h3>Scoreboard</h3><div class="board">${rows.map(([u, p], i) => `<div class="r"><span>${i === 0 ? "👑 " : ""}${esc(P.st.names?.[u] || nameOf(u))}</span><span class="mono">${p}</span></div>`).join("")}</div></div>`;
  }

  function lobbyView() {
    const e = ENGINES[engine()], n = activeUids().length, st = P.st;
    let h = `<div class="card"><h3>How to play</h3><p>${esc(e.how)}</p>
      <p class="small muted">${n} in the room · needs ${e.min}+. Share the invite link — friends just pick a name.</p>`;
    if (isHost()) {
      const dur = st.duration || e.durations[1][0];
      h += `<span class="label">Round length</span><div class="row">${e.durations.map(([ms, l]) => `<button class="btn sm ${dur === ms ? "" : "ghost"}" data-a="dur" data-v="${ms}">${l}</button>`).join("")}</div>
        <div class="row" style="margin-top:12px"><button data-a="start" ${n < e.min || P.busy ? "disabled" : ""}>Start game</button></div>`;
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
    const mine = P.players[P.me]?.vote_key === P.st.voteKey ? P.players[P.me]?.vote : null;
    const el = voters(), n = Object.keys(votes()).filter(u => el.includes(u)).length;
    const canVote = el.includes(P.me);
    return `<div class="card"><h2>${esc(question)}</h2><p class="small muted">${n} of ${el.length} voted.</p>
      <div class="picks">${options.map(([v, label]) => `<button class="pickbtn" data-a="vote" data-v="${esc(v)}" aria-pressed="${mine === v}" ${canVote ? "" : "disabled"}>${esc(label)}</button>`).join("")}</div>
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
    const mine = r.awards?.[P.me];
    if (mine !== undefined) h += `<p class="mono small">You ${mine >= 0 ? "earned" : "lost"} ${Math.abs(mine)} point${Math.abs(mine) === 1 ? "" : "s"}.</p>`;
    if (isHost()) h += `<div class="row">${engine() === "laws" ? `<button data-a="next">Next round (sides swap)</button>` : `<button data-a="again">Play again</button>`}<button class="btn ghost" data-a="lobby">Back to lobby</button></div>`;
    else h += `<p class="small muted">Waiting for the host…</p>`;
    return h + `</div>` + boardView();
  }

  function lawsView() {
    const L = P.st.laws || {}, mine = myTeam();
    let h = `<div class="card case"><div class="row between"><span class="label">Round ${P.st.round || 1} · ${esc(L.place || "")}</span>
      ${mine ? `<span class="pill ${L.sides?.[mine] === "for" ? "live" : "draft"}">You: ${esc(teamName(mine))}</span>` : `<span class="pill">Watching</span>`}</div>
      <p class="law">“${esc(L.law)}”</p>${L.twist ? `<p class="twist">${esc(L.twist)}</p>` : ""}${teamsView()}</div>`;
    h += votePanel("Which side argued best?", [["A", teamName("A")], ["B", teamName("B")]]);
    if (P.st.phase === "result") { const w = P.st.result?.winner; h += resultView(w === "tie" ? "It's a tie" : `"${teamName(w)}" wins`); }
    return h;
  }

  function tfView() {
    const st = P.st, sec = tfSecret(), r = st.result;
    if (!sec) return `<div class="card"><p class="muted">Setting up…</p></div>`;
    const playing = (st.tf.players || []).includes(P.me), me = sec.alias[P.me];
    let h = `<div class="card case"><div class="row between"><span class="label">Anonymous lobby</span>${me ? `<span class="pill draft">You are ${esc(me)}</span>` : `<span class="pill">Watching</span>`}</div>`;
    if (playing && st.phase !== "reveal") h += sec.sv === P.me
      ? `<div class="brief secret"><span class="label">Your secret role</span><p><strong>You are the Saviour.</strong> Get <strong>${esc(sec.alias[sec.su])}</strong> to pick you as their true friend at the vote, without the rest of the room working out who you are.</p></div>`
      : `<div class="brief"><span class="label">Your role</span><p>You might be the Survivor, or you might not. Somewhere in this chat is the Saviour. Find your true friend and vote for them.</p></div>`;
    if (playing && st.phase === "chat") h += `<p class="small muted mono">${Math.max(0, st.tf.cap - myCount())} of ${st.tf.cap} messages left</p>`;
    h += `</div>`;
    if (st.phase === "vote") h += votePanel("Who is your true friend?", (st.tf.players || []).filter(u => u !== P.me).map(u => [sec.alias[u], sec.alias[u]]));
    if (st.phase === "reveal" && r) {
      h += `<div class="card"><span class="label">The reveal</span><h2>${r.survivorPicked ? "The Saviour got through" : "The Survivor wasn't fooled"}</h2><p>${esc(r.verdict)}</p>
        <div class="board">${(st.tf.players || []).map(u => `<div class="r"><span>${esc(r.alias[u])} = ${esc(nameOf(u))}${u === r.sv ? " (Saviour)" : u === r.su ? " (Survivor)" : ""}</span><span class="small muted">picked ${esc(r.picked[u] ? r.alias[r.picked[u]] : "nobody")} · <span class="mono">${r.awards[u] > 0 ? "+" : ""}${r.awards[u]}</span></span></div>`).join("")}</div>
        ${isHost() ? `<div class="row" style="margin-top:12px"><button data-a="again">Play again</button><button class="btn ghost" data-a="lobby">Back to lobby</button></div>` : `<p class="small muted">Waiting for the host…</p>`}</div>` + boardView();
    }
    return h;
  }

  function dealView() {
    const st = P.st, D2 = st.deal || {}, sc = D2.scenario, mine = myTeam();
    if (!sc) return `<div class="card"><p class="muted">Setting up…</p></div>`;
    const offersLeft = t => Math.max(0, 4 - roundMsgs().filter(m => m.kind === "offer" && m.team === t).length);
    let h = `<div class="card case"><span class="label">The case</span><h2>${esc(sc.title)}</h2><p>${esc(sc.setup)}</p>
      <div class="row">${sc.terms.map(t => `<span class="pill">${esc(t)}</span>`).join("")}</div>${teamsView(t => `<span class="small muted">${offersLeft(t)} offers left</span>`)}`;
    const b = mine ? sc[mine] : null;
    if (b && st.phase !== "result") h += `<div class="brief secret"><span class="label">Secret brief · ${esc(b.name)}</span><p>${esc(b.brief)}</p><p class="small"><strong>Ideal:</strong> ${esc(b.ideal)}</p><p class="small"><strong>Walk away at:</strong> ${esc(b.walkaway)}</p><p class="small"><strong>Your leverage:</strong> ${esc(b.leverage)}</p></div>`;
    h += `</div>`;
    h += votePanel("Who got the better deal?", [["A", teamName("A")], ["B", teamName("B")]]);
    if (st.phase === "result") { const w = st.result?.winner; h += resultView(w === "tie" ? "It's a tie" : `${teamName(w)} wins`); }
    return h;
  }

  function renderChat() {
    const box = $("pv-chat"); if (!box) return;
    const near = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 160;
    const eng = engine(), anon = eng === "friends" && P.st.phase !== "reveal";
    const msgs = roundMsgs();
    box.innerHTML = msgs.map(m => {
      if (m.kind === "sys") return `<div class="msg sys">${esc(m.text)}</div>`;
      if (m.kind === "judge") return `<div class="msg judge"><div class="who">Judge</div>${esc(m.text)}</div>`;
      if (m.kind === "accuse") return `<div class="msg sys">${esc(m.alias)} sealed an accusation.</div>`;
      if (m.kind === "accept") return `<div class="msg sys"><strong>${esc(m.name)} accepted the offer for ${esc(teamName(m.team))}. Deal!</strong></div>`;
      const me = m.uid === P.me;
      const who = eng === "friends" ? (anon ? m.alias : `${m.alias} (${nameOf(m.uid)})`) : `${m.name}${m.team ? " · " + teamName(m.team) : ""}`;
      return `<div class="msg ${me ? "me" : ""} ${m.team ? "t" + m.team : ""} ${m.kind === "offer" ? "offer" : ""}"><div class="who">${esc(me ? "You" : who)}${m.kind === "offer" ? " · formal offer" : ""}</div>${esc(m.text)}</div>`;
    }).join("") || `<div class="msg sys">No messages yet. Someone has to go first.</div>`;
    if (near) window.scrollTo(0, document.body.scrollHeight);
  }

  function renderActions() {
    const act = $("pv-actions"), note = $("pv-note"), inp = $("pv-input"); if (!act) return;
    const st = P.st, eng = engine(), ok = canChat();
    inp.disabled = !ok; $("pv-send").disabled = !ok;
    let h = "", n = "";
    if (eng === "laws") { inp.placeholder = "Make your case…"; if (st.phase === "argue") n = myTeam() ? "Argue your side. When time runs out, the whole room votes." : "You're watching — you'll get a team in a moment."; }
    if (eng === "friends") {
      inp.placeholder = myAlias() ? `Speak as ${myAlias()}…` : "Watching";
      const accused = roundMsgs().some(m => m.kind === "accuse" && m.uid === P.me);
      if (st.phase === "chat" && (st.tf?.players || []).includes(P.me)) {
        if (!accused) {
          h = `<button class="btn ghost sm" data-a="accuse">${P.accuseOpen ? "Cancel" : "Seal an accusation"}</button>`;
          if (P.accuseOpen) { const sec = tfSecret(); h += `<div class="picks" style="width:100%">${st.tf.players.filter(u => u !== P.me).map(u => `<button class="pickbtn" data-a="accuseWho" data-v="${esc(sec.alias[u])}">${esc(sec.alias[u])}</button>`).join("")}</div>`; }
        }
        n = myCount() >= st.tf.cap ? "You've used all your messages. Watch closely." : "One sealed accusation: name the Saviour right for +2, wrong for −1. Revealed at the end.";
      }
    }
    if (eng === "deal" && st.phase === "negotiate" && myTeam()) {
      inp.placeholder = "Negotiate…";
      const left = 4 - roundMsgs().filter(m => m.kind === "offer" && m.team === myTeam()).length;
      const theirs = roundMsgs().filter(m => m.kind === "offer" && m.team !== myTeam()).pop();
      h = `<button class="btn sm" data-a="offer" ${left <= 0 ? "disabled" : ""}>Formal offer (${Math.max(0, left)} left)</button>` + (theirs ? `<button class="btn sm gold" data-a="accept">Accept their last offer</button>` : "");
      n = "Type terms in the box, then tap Formal offer to put them on the record.";
    }
    act.innerHTML = h; act.hidden = !h; note.textContent = n;
  }

  /* ------------------------------------------------------------ clicks */
  async function onClick(e) {
    const b = e.target.closest("[data-a]"); if (!b || !P.code) return;
    const a = b.dataset.a, v = b.dataset.v;
    const hostRun = async f => { if (P.busy) return; P.busy = true; render(); try { await f(); } catch (err) { P.err = err.message || String(err); } P.busy = false; render(); };
    if (a === "dur") return hostRun(() => setState({ duration: +v }));
    if (a === "start") return hostRun(startGame);
    if (a === "next") return hostRun(() => lawsRound(false));
    if (a === "again") return hostRun(startGame);
    if (a === "lobby") return hostRun(() => setState({ phase: "lobby", voteKey: null }));
    if (a === "takeover") { const { error } = await db.from("rooms").update({ host: P.me }).eq("code", P.code); if (error) P.err = error.message; else P.room.host = P.me; render(); return; }
    if (a === "vote") return vote(v);
    if (a === "accuse") { P.accuseOpen = !P.accuseOpen; renderActions(); return; }
    if (a === "accuseWho") { P.accuseOpen = false; await post("accuse", "accused", { target: v }); return; }
    if (a === "offer") { const t = $("pv-input").value.trim(); if (!t) { $("pv-note").textContent = "Type your offer in the box first, then tap Formal offer."; return; } $("pv-input").value = ""; await post("offer", t); return; }
    if (a === "accept") { const o = roundMsgs().filter(m => m.kind === "offer" && m.team !== myTeam()).pop(); if (o) await post("accept", "Accepted", { ref: o.text }); }
  }

  document.addEventListener("click", onClick);
  window.GHPlay = { view, createRoom, teardown, ENGINES };
})();
