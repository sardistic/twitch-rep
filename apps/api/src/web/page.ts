/**
 * ChatterScope pilot dashboard — a single self-contained page served by the
 * API. Milestone 5 scope delivered as an API-served SPA instead of a separate
 * Next.js app (see docs/architecture-decisions.md ADR-0004).
 */
export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatterScope</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0e0e10; color: #efeff1;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1.25rem;
           border-bottom: 1px solid #2f2f35; background: #18181b; flex-wrap: wrap; }
  header h1 { font-size: 1.2rem; margin: 0; }
  header h1 span { color: #a970ff; }
  header .spacer { flex: 1; }
  main { max-width: 62rem; margin: 0 auto; padding: 1.25rem; }
  .btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 0.4rem; border: 0;
         background: #9147ff; color: #fff; text-decoration: none; font-weight: 600;
         cursor: pointer; font-size: 0.9rem; }
  .btn:hover { background: #a970ff; }
  .btn.ghost { background: #2f2f35; }
  .btn.small { padding: 0.25rem 0.6rem; font-size: 0.8rem; }
  input, select, textarea { padding: 0.5rem 0.7rem; border-radius: 0.4rem; border: 1px solid #2f2f35;
    background: #18181b; color: #efeff1; font-size: 0.9rem; font-family: inherit; }
  .tabs { display: flex; gap: 0.5rem; margin: 1rem 0; }
  .tabs button { background: none; border: 0; color: #adadb8; padding: 0.4rem 0.8rem;
                 cursor: pointer; border-bottom: 2px solid transparent; font-size: 0.95rem; }
  .tabs button.active { color: #efeff1; border-bottom-color: #a970ff; }
  .card { border: 1px solid #2f2f35; border-radius: 0.5rem; background: #18181b;
          padding: 1rem; margin-bottom: 1rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
           gap: 0.75rem; margin: 1rem 0; }
  .stat { border: 1px solid #2f2f35; border-radius: 0.5rem; background: #18181b;
          padding: 0.6rem 0.9rem; }
  .stat b { display: block; font-size: 1.3rem; }
  .stat span { color: #adadb8; font-size: 0.78rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th { text-align: left; color: #adadb8; font-weight: 500; }
  th, td { padding: 0.35rem 0.6rem; border-bottom: 1px solid #232327; }
  .pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 1rem; font-size: 0.75rem;
          border: 1px solid; }
  .st-verified_current { color: #00f593; border-color: #00f593; }
  .st-observed_recent { color: #a970ff; border-color: #a970ff; }
  .st-observed_historical { color: #adadb8; border-color: #adadb8; }
  .st-external_unverified { color: #ffca5f; border-color: #ffca5f; }
  .st-expired { color: #66666e; border-color: #66666e; }
  .st-conflicting { color: #f55353; border-color: #f55353; }
  .muted { color: #adadb8; }
  .tiny { font-size: 0.78rem; color: #66666e; }
  .msg { font-size: 0.85rem; padding: 0.3rem 0; border-bottom: 1px solid #232327; }
  .note { border: 1px solid #2f2f35; border-radius: 0.4rem; padding: 0.6rem; margin: 0.5rem 0; }
  .hero { text-align: center; padding: 4rem 1rem; }
  .avatar { border-radius: 50%; }
  #toast { position: fixed; bottom: 1rem; right: 1rem; background: #2f2f35; color: #efeff1;
           padding: 0.6rem 1rem; border-radius: 0.4rem; display: none; }
</style>
</head>
<body>
<header>
  <h1>Chatter<span>Scope</span></h1>
  <span id="health" class="tiny">checking&hellip;</span>
  <div class="spacer"></div>
  <span id="whoami" class="muted"></span>
  <button id="logoutBtn" class="btn ghost small" style="display:none">Sign out</button>
</header>
<main>
  <div id="signedOut" class="hero" style="display:none">
    <h2>Evidence-based chat context for Twitch moderators</h2>
    <p class="muted">See verified roles, observed badges, message history, and moderation notes &mdash; with the source and freshness of every assertion.</p>
    <a class="btn" href="/v1/auth/twitch/login">Sign in with Twitch</a>
  </div>
  <div id="signedIn" style="display:none">
    <div class="tabs">
      <button data-tab="search" class="active">Research</button>
      <button data-tab="channels">Channels</button>
      <button data-tab="providers">Providers</button>
      <button data-tab="audit">Audit</button>
    </div>

    <section id="tab-search">
      <form id="searchForm" style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <input id="searchInput" style="flex:1;min-width:14rem" placeholder="Twitch login, profile URL, or numeric ID">
        <button class="btn" type="submit">Look up</button>
      </form>
      <div id="profileArea"></div>
    </section>

    <section id="tab-channels" style="display:none">
      <div class="card">
        <p class="muted">Connected channels feed chat ingestion. Only owners/admins can connect. Connecting subscribes to your own channel's chat via EventSub.</p>
        <button id="connectBtn" class="btn">Connect my channel</button>
        <span id="connectMsg" class="tiny"></span>
      </div>
      <div id="channelList"></div>
    </section>

    <section id="tab-providers" style="display:none">
      <div class="card">
        <p class="muted">External log providers enrich profiles with historical, cross-channel evidence. Results are always labeled <span class="pill st-external_unverified">external_unverified</span> and never override verified data.</p>
        <form id="providerForm" style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <input id="providerName" placeholder="Name (e.g. my rustlog)" required>
          <input id="providerUrl" style="flex:1;min-width:14rem" placeholder="Base URL (https://logs.example.org)" required>
          <button class="btn" type="submit">Add provider</button>
        </form>
        <span id="providerMsg" class="tiny"></span>
      </div>
      <div id="providerList"></div>
    </section>

    <section id="tab-audit" style="display:none">
      <div id="auditList" class="card">Loading&hellip;</div>
    </section>
  </div>
</main>
<div id="toast"></div>
<script>
"use strict";
var me = null, currentProfile = null, currentMessages = [], nextCursor = null, currentUserId = null;

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function $(id) { return document.getElementById(id); }
function toast(msg) { var t = $("toast"); t.textContent = msg; t.style.display = "block"; setTimeout(function () { t.style.display = "none"; }, 3000); }
function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (body) {
      if (!r.ok) throw new Error(body.error ? body.error.message : ("HTTP " + r.status));
      return body;
    });
  });
}

fetch("/healthz").then(function (r) { return r.json(); }).then(function (h) {
  var ok = h.status === "ok";
  $("health").innerHTML = (ok ? "<span style='color:#00f593'>\\u25cf</span>" : "<span style='color:#f55353'>\\u25cf</span>") + " v" + esc(h.version);
});

api("/v1/me").then(function (data) {
  me = data;
  $("whoami").textContent = data.user.displayName + " \\u00b7 " + (data.organizations[0] ? data.organizations[0].name : "");
  $("logoutBtn").style.display = "inline-block";
  $("signedIn").style.display = "block";
}).catch(function () { $("signedOut").style.display = "block"; });

$("logoutBtn").addEventListener("click", function () {
  api("/v1/auth/logout", { method: "POST" }).then(function () { location.reload(); });
});

document.querySelectorAll(".tabs button").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    ["search", "channels", "providers", "audit"].forEach(function (t) { $("tab-" + t).style.display = t === btn.dataset.tab ? "block" : "none"; });
    if (btn.dataset.tab === "channels") loadChannels();
    if (btn.dataset.tab === "providers") loadProviders();
    if (btn.dataset.tab === "audit") loadAudit();
  });
});

$("searchForm").addEventListener("submit", function (e) {
  e.preventDefault();
  var q = $("searchInput").value.trim();
  if (!q) return;
  $("profileArea").innerHTML = "<p class='muted'>Resolving\\u2026</p>";
  api("/v1/twitch/users/resolve?input=" + encodeURIComponent(q))
    .then(function (data) { loadProfile(data.user.twitchUserId); })
    .catch(function (err) { $("profileArea").innerHTML = "<p class='muted'>" + esc(err.message) + "</p>"; });
});

function loadProfile(id) {
  currentUserId = id;
  $("profileArea").innerHTML = "<p class='muted'>Loading profile\\u2026</p>";
  Promise.all([
    api("/v1/chatters/" + id + "/profile"),
    api("/v1/chatters/" + id + "/messages?limit=25"),
    api("/v1/chatters/" + id + "/notes")
  ]).then(function (results) {
    currentProfile = results[0];
    currentMessages = results[1].messages;
    nextCursor = results[1].nextCursor;
    renderProfile(results[2].notes);
  }).catch(function (err) { $("profileArea").innerHTML = "<p class='muted'>" + esc(err.message) + "</p>"; });
}

function renderProfile(notes) {
  var p = currentProfile, u = p.user;
  var html = "<div class='card' style='display:flex;gap:1rem;align-items:center;margin-top:1rem'>";
  if (u) {
    if (u.profileImageUrl) html += "<img class='avatar' width='64' src='" + esc(u.profileImageUrl) + "'>";
    html += "<div><b style='font-size:1.15rem'>" + esc(u.displayName) + "</b> <span class='muted'>(" + esc(u.login) + ")</span><br>" +
      "<span class='tiny'>ID " + esc(u.twitchUserId) + " \\u00b7 account created " + esc((u.accountCreatedAt || "unknown").slice(0, 10)) +
      " \\u00b7 fetched " + esc(u.fetchedAt.slice(0, 16).replace("T", " ")) + "</span></div>";
  } else {
    html += "<div class='muted'>Identity not cached; showing observation data only.</div>";
  }
  html += "</div>";

  html += "<div class='cards'>" +
    stat(p.summary.messagesObserved, "messages observed") +
    stat(p.summary.channelsObserved, "channels observed") +
    stat(p.roles.filter(function (r) { return r.status === "verified_current"; }).length, "verified current roles") +
    stat(p.roles.filter(function (r) { return r.status !== "verified_current"; }).length, "historical/observed roles") +
    stat(p.summary.firstObservedAt ? p.summary.firstObservedAt.slice(0, 10) : "\\u2014", "first observed") +
    stat(p.summary.lastObservedAt ? p.summary.lastObservedAt.slice(0, 10) : "\\u2014", "last observed") +
    "</div>";

  var channels = {};
  p.roles.forEach(function (r) { channels[r.channel.twitchChannelId] = r.channel.login || r.channel.twitchChannelId; });
  html += "<div class='card'><div style='display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap'><b>Roles</b>" +
    "<select id='statusFilter'><option value=''>all statuses</option>" +
    ["verified_current","observed_recent","observed_historical","external_unverified","expired","conflicting"].map(function (s) {
      return "<option>" + s + "</option>"; }).join("") + "</select>" +
    "<select id='channelFilter'><option value=''>all channels</option>" +
    Object.keys(channels).map(function (id) { return "<option value='" + esc(id) + "'>" + esc(channels[id]) + "</option>"; }).join("") +
    "</select></div><div id='rolesTable'></div></div>";

  html += "<div class='card'><b>Messages</b> <span class='tiny'>(authorized channels only)</span>" +
    "<div id='messagesList'></div>" +
    (nextCursor ? "<button id='moreBtn' class='btn ghost small' style='margin-top:0.5rem'>Load more</button>" : "") +
    "</div>";

  html += "<div class='card'><b>Notes</b> <span class='tiny'>(private to your organization)</span><div id='notesList'></div>" +
    "<form id='noteForm' style='display:flex;gap:0.5rem;margin-top:0.6rem'>" +
    "<textarea id='noteBody' rows='2' style='flex:1' placeholder='Add a moderation note\\u2026'></textarea>" +
    "<button class='btn' type='submit'>Add</button></form></div>";

  p.warnings.forEach(function (w) { html += "<p class='tiny'>\\u26a0 " + esc(w.message) + "</p>"; });
  $("profileArea").innerHTML = html;

  renderRoles(); renderMessages(); renderNotes(notes);
  $("statusFilter").addEventListener("change", renderRoles);
  $("channelFilter").addEventListener("change", renderRoles);
  var more = $("moreBtn");
  if (more) more.addEventListener("click", loadMoreMessages);
  $("noteForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = $("noteBody").value.trim();
    if (!body) return;
    api("/v1/chatters/" + currentUserId + "/notes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: body })
    }).then(function () { return api("/v1/chatters/" + currentUserId + "/notes"); })
      .then(function (data) { $("noteBody").value = ""; renderNotes(data.notes); toast("Note added"); })
      .catch(function (err) { toast(err.message); });
  });
}

function stat(value, label) { return "<div class='stat'><b>" + esc(value) + "</b><span>" + esc(label) + "</span></div>"; }

function renderRoles() {
  var status = $("statusFilter").value, channel = $("channelFilter").value;
  var rows = currentProfile.roles.filter(function (r) {
    return (!status || r.status === status) && (!channel || r.channel.twitchChannelId === channel);
  });
  if (!rows.length) { $("rolesTable").innerHTML = "<p class='muted'>No role evidence" + (status || channel ? " matching filters" : " yet") + ".</p>"; return; }
  $("rolesTable").innerHTML = "<table><tr><th>Channel</th><th>Role</th><th>Status</th><th>Source</th><th>First</th><th>Last</th><th>Verified</th><th>Evidence</th></tr>" +
    rows.map(function (r) {
      return "<tr><td>" + esc(r.channel.login || r.channel.twitchChannelId) + "</td>" +
        "<td>" + esc(r.role) + "</td>" +
        "<td><span class='pill st-" + esc(r.status) + "'>" + esc(r.status) + "</span></td>" +
        "<td>" + esc(r.source) + (r.provider ? " / " + esc(r.provider) : "") + "</td>" +
        "<td>" + esc(r.firstObservedAt ? r.firstObservedAt.slice(0, 10) : "\\u2014") + "</td>" +
        "<td>" + esc(r.lastObservedAt ? r.lastObservedAt.slice(0, 10) : "\\u2014") + "</td>" +
        "<td>" + esc(r.verifiedAt ? r.verifiedAt.slice(0, 10) : "\\u2014") + "</td>" +
        "<td>" + r.evidenceCount + "</td></tr>";
    }).join("") + "</table>";
}

function renderMessages() {
  if (!currentMessages.length) { $("messagesList").innerHTML = "<p class='muted'>No messages visible.</p>"; return; }
  $("messagesList").innerHTML = currentMessages.map(function (m) {
    var badges = Object.keys(m.badges || {}).map(function (k) { return k + "/" + m.badges[k]; }).join(" ");
    return "<div class='msg'><span class='tiny'>" + esc(m.sentAt.slice(0, 16).replace("T", " ")) +
      " \\u00b7 " + esc(m.channelLogin || m.twitchChannelId) + (badges ? " \\u00b7 " + esc(badges) : "") +
      " \\u00b7 " + esc(m.source) + "</span><br>" + esc(m.messageText) + "</div>";
  }).join("");
}

function loadMoreMessages() {
  api("/v1/chatters/" + currentUserId + "/messages?limit=25&cursor=" + encodeURIComponent(nextCursor))
    .then(function (data) {
      currentMessages = currentMessages.concat(data.messages);
      nextCursor = data.nextCursor;
      renderMessages();
      if (!nextCursor) $("moreBtn").style.display = "none";
    }).catch(function (err) { toast(err.message); });
}

function renderNotes(notes) {
  if (!notes.length) { $("notesList").innerHTML = "<p class='muted'>No notes yet.</p>"; return; }
  $("notesList").innerHTML = notes.map(function (n) {
    var mine = me && n.authorUserId === me.user.id;
    return "<div class='note' data-id='" + esc(n.id) + "'><span class='tiny'>" + esc(n.authorLogin) +
      " \\u00b7 " + esc(n.createdAt.slice(0, 16).replace("T", " ")) + "</span>" +
      (mine ? " <button class='btn ghost small note-edit'>edit</button> <button class='btn ghost small note-del'>delete</button>" : "") +
      "<div class='note-body'>" + esc(n.body) + "</div></div>";
  }).join("");
  document.querySelectorAll(".note-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.closest(".note").dataset.id;
      api("/v1/chatters/" + currentUserId + "/notes/" + id, { method: "DELETE" })
        .then(function () { return api("/v1/chatters/" + currentUserId + "/notes"); })
        .then(function (data) { renderNotes(data.notes); toast("Note deleted"); })
        .catch(function (err) { toast(err.message); });
    });
  });
  document.querySelectorAll(".note-edit").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var noteEl = btn.closest(".note");
      var bodyEl = noteEl.querySelector(".note-body");
      var updated = prompt("Edit note:", bodyEl.textContent);
      if (updated == null || !updated.trim()) return;
      api("/v1/chatters/" + currentUserId + "/notes/" + noteEl.dataset.id, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: updated.trim() })
      }).then(function () { return api("/v1/chatters/" + currentUserId + "/notes"); })
        .then(function (data) { renderNotes(data.notes); toast("Note updated"); })
        .catch(function (err) { toast(err.message); });
    });
  });
}

function loadChannels() {
  api("/v1/channels").then(function (data) {
    $("channelList").innerHTML = data.organizations.map(function (org) {
      var rows = org.channels.length
        ? "<table><tr><th>Channel</th><th>Enabled</th><th>Connected</th></tr>" + org.channels.map(function (c) {
            return "<tr><td>" + esc(c.login) + "</td><td>" + (c.enabled ? "yes" : "no") + "</td><td>" + esc(c.connectedAt.slice(0, 10)) + "</td></tr>";
          }).join("") + "</table>"
        : "<p class='muted'>No channels connected.</p>";
      return "<div class='card'><b>" + esc(org.organizationName) + "</b>" + rows + "</div>";
    }).join("");
  }).catch(function (err) { $("channelList").innerHTML = "<p class='muted'>" + esc(err.message) + "</p>"; });
}

$("connectBtn").addEventListener("click", function () {
  $("connectMsg").textContent = "Connecting\\u2026";
  api("/v1/channels/connect", { method: "POST" })
    .then(function (data) { $("connectMsg").textContent = "Connected " + data.channel.login + " \\u00b7 " + data.subscription.status; loadChannels(); })
    .catch(function (err) { $("connectMsg").textContent = err.message; });
});

function loadProviders() {
  api("/v1/providers").then(function (data) {
    if (!data.providers.length) { $("providerList").innerHTML = "<p class='muted'>No providers configured. Profiles only include natively ingested channels.</p>"; return; }
    $("providerList").innerHTML = data.providers.map(function (p) {
      return "<div class='card' data-id='" + esc(p.id) + "'><b>" + esc(p.name) + "</b> <span class='tiny'>" + esc(p.providerType) + " \\u00b7 " + esc(p.baseUrl || "") + "</span><br>" +
        "<div style='display:flex;gap:0.4rem;margin-top:0.5rem;flex-wrap:wrap;align-items:center'>" +
        "<button class='btn ghost small p-test'>Test</button>" +
        "<input class='p-user' placeholder='user login/id' style='width:9rem'>" +
        "<input class='p-chan' placeholder='channel login/id' style='width:9rem'>" +
        "<button class='btn ghost small p-sync'>Import logs</button>" +
        "<button class='btn ghost small p-del'>Delete</button>" +
        "<span class='tiny p-msg'></span></div></div>";
    }).join("");
    document.querySelectorAll(".p-test").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var card = btn.closest(".card"), msg = card.querySelector(".p-msg");
        msg.textContent = "Testing\\u2026";
        api("/v1/providers/" + card.dataset.id + "/test", { method: "POST" })
          .then(function () { msg.textContent = "Connection OK"; })
          .catch(function (err) { msg.textContent = err.message; });
      });
    });
    document.querySelectorAll(".p-sync").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var card = btn.closest(".card"), msg = card.querySelector(".p-msg");
        var user = card.querySelector(".p-user").value.trim();
        var chan = card.querySelector(".p-chan").value.trim();
        if (!user || !chan) { msg.textContent = "Enter user and channel."; return; }
        msg.textContent = "Importing\\u2026";
        api("/v1/providers/" + card.dataset.id + "/sync", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: user, channel: chan })
        }).then(function (data) { msg.textContent = "Read " + data.read + ", imported " + data.written + " new."; })
          .catch(function (err) { msg.textContent = err.message; });
      });
    });
    document.querySelectorAll(".p-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var card = btn.closest(".card");
        if (!confirm("Delete this provider? Already-imported observations are kept.")) return;
        api("/v1/providers/" + card.dataset.id, { method: "DELETE" })
          .then(function () { loadProviders(); toast("Provider deleted"); })
          .catch(function (err) { toast(err.message); });
      });
    });
  }).catch(function (err) { $("providerList").innerHTML = "<p class='muted'>" + esc(err.message) + "</p>"; });
}

$("providerForm").addEventListener("submit", function (e) {
  e.preventDefault();
  $("providerMsg").textContent = "Adding\\u2026";
  api("/v1/providers", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: $("providerName").value.trim(), providerType: "rustlog", baseUrl: $("providerUrl").value.trim() })
  }).then(function () { $("providerMsg").textContent = ""; $("providerName").value = ""; $("providerUrl").value = ""; loadProviders(); toast("Provider added"); })
    .catch(function (err) { $("providerMsg").textContent = err.message; });
});

function loadAudit() {
  api("/v1/audit?limit=100").then(function (data) {
    if (!data.events.length) { $("auditList").innerHTML = "<p class='muted'>No audit events.</p>"; return; }
    $("auditList").innerHTML = "<table><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr>" +
      data.events.map(function (e) {
        return "<tr><td>" + esc(e.createdAt.slice(0, 19).replace("T", " ")) + "</td><td>" + esc(e.actorLogin || "\\u2014") +
          "</td><td>" + esc(e.action) + "</td><td>" + esc(e.targetType) + (e.targetId ? " " + esc(e.targetId).slice(0, 12) : "") + "</td></tr>";
      }).join("") + "</table>";
  }).catch(function (err) { $("auditList").innerHTML = "<p class='muted'>" + esc(err.message) + "</p>"; });
}
</script>
</body>
</html>`;
