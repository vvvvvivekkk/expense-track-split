/**
 * Split Four Ways — Google Apps Script backend
 * -------------------------------------------------
 * Turns your Google Sheet into a tiny API the static frontend reads/writes.
 *
 * Tabs (People, Expenses, Settings, Settlements) and columns are created
 * automatically. Adding this version over an older one is safe — any new
 * columns are appended to existing tabs without disturbing old rows.
 *
 * Redeploy after editing: Deploy -> Manage deployments -> edit -> Deploy.
 */

var SHEET_ID = "1C3GSm17VsmJVpU0X87fIGs8nyk2Veqy5yUaZiUVAlHs";
var SHARED_TOKEN = ""; // leave "" for open access

var PEOPLE_TAB   = "People";
var EXPENSE_TAB  = "Expenses";
var SETTINGS_TAB = "Settings";
var SETTLE_TAB   = "Settlements";

var PEOPLE_HEADERS  = ["id", "name", "order"];
var EXPENSE_HEADERS = ["id", "desc", "amount", "paidBy", "splitAmong", "category", "date", "items", "createdAt"];
var SETTLE_HEADERS  = ["id", "from", "to", "amount", "date", "note", "createdAt"];
var REQUEST_TAB     = "Requests";
// kind: "settle" (record a payment) or "deleteSettlement" (remove one).
// approvers = people who must say yes; approved = those who have. When approved
// covers approvers, the action happens. targetId = the settlement id (for deletes).
var REQUEST_HEADERS = ["id", "kind", "from", "to", "amount", "date", "note", "targetId", "approvers", "approved", "status", "createdAt"];

// =========================================================================
// AUTH — PINs and roles live HERE on the server, never in the webpage.
//
// How it works, plainly:
//  - Each of the 4 accounts has a PIN (stored only as a one-way hash) and a
//    role. Nothing here is visible from "View Source" on the website.
//  - To log in, the browser sends {action:"login", id, pin}. We check the
//    PIN and hand back a signed "token" (a pass stamped with a secret only
//    this script knows). The browser keeps that token.
//  - Every change the browser asks for must carry a valid token, and the
//    token's role must be high enough for that action. A "viewer" token is
//    refused for any write — so view-only really is view-only.
//
// Change a PIN later: the owner can do it in the app, or run resetPinManual_
// below once from the Apps Script editor. To rotate the signing secret (makes
// everyone log in again), delete the AUTH_SECRET script property.
// =========================================================================

// id -> starting PIN + role. Seeded into Script Properties on first use;
// after that these defaults are ignored and the stored copy is the source of
// truth (so PIN changes in the app stick). Roles: admin > editor > viewer.
var DEFAULT_ACCOUNTS = {
  p1: { name: "Akshay", role: "editor", pin: "2005" },
  p2: { name: "Praney", role: "editor", pin: "3699" },
  p3: { name: "Vivek",  role: "admin",  pin: "7733" },
  p4: { name: "Logesh", role: "viewer", pin: "1234" }
};

var TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // a login lasts 30 days
var ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };

// Which actions need which minimum role. "login"/"changePin" handled separately.
var ACTION_MIN = {
  addExpense: "editor", updateExpense: "editor", deleteExpense: "editor",
  addSettlement: "editor", deleteSettlement: "editor", setCurrency: "editor",
  addSettleRequest: "editor", respondSettleRequest: "editor", addDeleteRequest: "editor",
  addPerson: "admin", renamePerson: "admin", removePerson: "admin", resetPin: "admin"
};

function props_() { return PropertiesService.getScriptProperties(); }

function authSecret_() {
  var p = props_(), s = p.getProperty("AUTH_SECRET");
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty("AUTH_SECRET", s); }
  return s;
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b); return ("0" + v.toString(16)).slice(-2); }).join("");
}

// One-way hash of a PIN, salted with the server secret + the account id.
function pinHash_(id, pin) {
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, authSecret_() + ":" + id + ":" + String(pin)));
}

// The live accounts table (hashes + roles), seeded from DEFAULT_ACCOUNTS once.
function accounts_() {
  var p = props_(), raw = p.getProperty("ACCOUNTS_V1");
  if (raw) { try { return JSON.parse(raw); } catch (_) {} }
  var acc = {};
  Object.keys(DEFAULT_ACCOUNTS).forEach(function (id) {
    var a = DEFAULT_ACCOUNTS[id];
    acc[id] = { name: a.name, role: a.role, pinHash: pinHash_(id, a.pin) };
  });
  p.setProperty("ACCOUNTS_V1", JSON.stringify(acc));
  return acc;
}
function saveAccounts_(acc) { props_().setProperty("ACCOUNTS_V1", JSON.stringify(acc)); }

// Public account list for the login screen — names + roles only, no secrets.
function publicAccounts_() {
  var acc = accounts_();
  return Object.keys(acc).map(function (id) {
    return { id: id, name: acc[id].name, role: acc[id].role };
  });
}

// ---- signed tokens (stateless; nothing stored server-side) ----
function sign_(payloadB64) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payloadB64, authSecret_()));
}
function makeToken_(id, role) {
  var payload = Utilities.base64EncodeWebSafe(
    JSON.stringify({ id: id, role: role, exp: Date.now() + TOKEN_TTL_MS }));
  return payload + "." + sign_(payload);
}
function verifyToken_(tok) {
  if (!tok) throw new Error("unauthorized");
  var parts = String(tok).split(".");
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) throw new Error("unauthorized");
  var data;
  try { data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); }
  catch (_) { throw new Error("unauthorized"); }
  if (!data || !data.exp || Date.now() > data.exp) throw new Error("session expired");
  return data; // { id, role, exp }
}

function login_(b) {
  var id = String(b.id || ""), pin = String(b.pin || "");
  var acc = accounts_(), a = acc[id];
  if (!a || a.pinHash !== pinHash_(id, pin)) throw new Error("bad pin");
  return { token: makeToken_(id, a.role), id: id, name: a.name, role: a.role };
}

function changePin_(session, b) {
  var newPin = String(b.newPin || "");
  if (!/^\d{4}$/.test(newPin)) throw new Error("PIN must be exactly 4 digits");
  var acc = accounts_(), a = acc[session.id];
  if (!a) throw new Error("no such account");
  a.pinHash = pinHash_(session.id, newPin);
  saveAccounts_(acc);
}

// Admin resets someone else's PIN.
function resetPin_(session, b) {
  var targetId = String(b.targetId || ""), newPin = String(b.newPin || "");
  if (!/^\d{4}$/.test(newPin)) throw new Error("PIN must be exactly 4 digits");
  var acc = accounts_(), a = acc[targetId];
  if (!a) throw new Error("no such account");
  a.pinHash = pinHash_(targetId, newPin);
  saveAccounts_(acc);
}

// Run this once from the Apps Script editor to force a PIN (e.g. if forgotten).
// Edit the id and pin, press Run.
function resetPinManual_() {
  var id = "p3", pin = "7733";       // <-- change these, then Run
  var acc = accounts_(); if (!acc[id]) throw new Error("no account " + id);
  acc[id].pinHash = pinHash_(id, pin); saveAccounts_(acc);
  Logger.log("PIN updated for " + id + " (" + acc[id].name + ")");
}

// =========================================================================
// HTTP entry points
// =========================================================================

function doGet(e) {
  try {
    checkToken_(e);
    return json_({ ok: true, data: loadAll_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (_) { return json_({ ok: false, error: "busy, try again" }); }
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);

    // Logging in needs no token — that's the point.
    if (body.action === "login") return json_({ ok: true, data: login_(body) });

    // Everything else must carry a valid, unexpired token.
    var session = verifyToken_(body.token);

    // Changing your OWN pin only needs to be logged in (any role).
    if (body.action === "changePin") { changePin_(session, body); return json_({ ok: true, data: loadAll_() }); }

    // Role gate: refuse actions above the token's role.
    var need = ACTION_MIN[body.action];
    if (!need) throw new Error("unknown action: " + body.action);
    if (ROLE_RANK[session.role] < ROLE_RANK[need]) throw new Error("not allowed for your role");

    if (body.action === "resetPin") { resetPin_(session, body); return json_({ ok: true, data: loadAll_() }); }
    if (body.action === "addSettleRequest") { addSettleRequest_(session, body); return json_({ ok: true, data: loadAll_() }); }
    if (body.action === "addDeleteRequest") { addDeleteRequest_(session, body); return json_({ ok: true, data: loadAll_() }); }
    if (body.action === "respondSettleRequest") { respondSettleRequest_(session, body); return json_({ ok: true, data: loadAll_() }); }

    switch (body.action) {
      case "addExpense":      addExpense_(body); break;
      case "updateExpense":   updateExpense_(body); break;
      case "deleteExpense":   deleteRowById_(EXPENSE_TAB, EXPENSE_HEADERS, body.id); break;
      case "addPerson":       addPerson_(body.name); break;
      case "renamePerson":    renamePerson_(body.id, body.name); break;
      case "removePerson":    deleteRowById_(PEOPLE_TAB, PEOPLE_HEADERS, body.id); break;
      case "setCurrency":     setSetting_("currency", body.currency); break;
      case "addSettlement":   addSettlement_(body); break;
      case "deleteSettlement":deleteRowById_(SETTLE_TAB, SETTLE_HEADERS, body.id); break;
      default: throw new Error("unknown action: " + body.action);
    }
    return json_({ ok: true, data: loadAll_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// Read
// =========================================================================

function loadAll_() {
  var people = readRows_(PEOPLE_TAB, PEOPLE_HEADERS);
  if (people.length === 0) { seedPeople_(); people = readRows_(PEOPLE_TAB, PEOPLE_HEADERS); }
  people = people.map(function (p) {
    return { id: String(p.id), name: String(p.name), order: Number(p.order) || 0 };
  }).sort(function (a, b) { return a.order - b.order; });

  var expenses = readRows_(EXPENSE_TAB, EXPENSE_HEADERS).map(function (r) {
    return {
      id: String(r.id),
      desc: String(r.desc || ""),
      amount: Number(r.amount) || 0,
      paidBy: String(r.paidBy || ""),
      splitAmong: String(r.splitAmong || "").split(",").map(trim_).filter(Boolean),
      category: String(r.category || ""),
      date: toYmd_(r.date),
      items: parseItems_(r.items),
      createdAt: Number(r.createdAt) || 0
    };
  });

  var settlements = readRows_(SETTLE_TAB, SETTLE_HEADERS).map(function (r) {
    return {
      id: String(r.id),
      from: String(r.from || ""),
      to: String(r.to || ""),
      amount: Number(r.amount) || 0,
      date: toYmd_(r.date),
      note: String(r.note || ""),
      createdAt: Number(r.createdAt) || 0
    };
  });

  var requests = readRequests_().filter(function (r) { return r.status === "pending"; });

  return {
    people: people,
    expenses: expenses,
    settlements: settlements,
    requests: requests,          // pending two-step settle requests
    currency: getSetting_("currency", "₹"),
    accounts: publicAccounts_()   // login tiles: {id,name,role} — no PINs
  };
}

function parseItems_(raw) {
  if (!raw) return [];
  try {
    var a = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    return a.map(function (it) { return { name: String(it.name || ""), amount: Number(it.amount) || 0 }; });
  } catch (_) { return []; }
}

// =========================================================================
// Write — expenses
// =========================================================================

function addExpense_(b) {
  var amount = Number(b.amount);
  if (!(amount > 0)) throw new Error("amount must be greater than zero");
  var among = (b.splitAmong || []).map(String).filter(Boolean);
  if (among.length === 0) throw new Error("splitAmong is empty");

  var items = Array.isArray(b.items)
    ? b.items.map(function (it) { return { name: String(it.name || "").slice(0, 100), amount: Number(it.amount) || 0 }; })
             .filter(function (it) { return it.amount > 0 || it.name; })
    : [];

  appendObj_(EXPENSE_TAB, EXPENSE_HEADERS, {
    id: newId_(),
    desc: String(b.desc || "").slice(0, 200),
    amount: amount,
    paidBy: String(b.paidBy || ""),
    splitAmong: among.join(","),
    category: String(b.category || "").slice(0, 40),
    date: dateText_(b.date),
    items: items.length ? JSON.stringify(items) : "",
    createdAt: Date.now()
  });
}

// Edit an existing expense in place (id required); only provided fields change.
function updateExpense_(b) {
  if (!b.id) throw new Error("id required");
  var sh = getOrCreate_(EXPENSE_TAB, EXPENSE_HEADERS);
  var r = findRow_(sh, b.id);
  if (r < 0) throw new Error("expense not found");
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var cur = sh.getRange(r, 1, 1, head.length).getValues()[0];
  var obj = {};
  for (var i = 0; i < head.length; i++) obj[head[i]] = cur[i];

  if (b.desc !== undefined) obj.desc = String(b.desc || "").slice(0, 200);
  if (b.amount !== undefined) {
    var amt = Number(b.amount);
    if (!(amt > 0)) throw new Error("amount must be greater than zero");
    obj.amount = amt;
  }
  if (b.paidBy !== undefined) obj.paidBy = String(b.paidBy || "");
  if (b.splitAmong !== undefined) {
    var among = (b.splitAmong || []).map(String).filter(Boolean);
    if (among.length === 0) throw new Error("splitAmong is empty");
    obj.splitAmong = among.join(",");
  }
  if (b.category !== undefined) obj.category = String(b.category || "").slice(0, 40);
  if (b.date !== undefined) obj.date = dateText_(b.date);
  if (b.items !== undefined) {
    var items = Array.isArray(b.items)
      ? b.items.map(function (it) { return { name: String(it.name || "").slice(0, 100), amount: Number(it.amount) || 0 }; })
               .filter(function (it) { return it.amount > 0 || it.name; })
      : [];
    obj.items = items.length ? JSON.stringify(items) : "";
  }
  var row = head.map(function (h) { return obj[h] !== undefined ? obj[h] : ""; });
  sh.getRange(r, 1, 1, head.length).setValues([row]);
}

// =========================================================================
// Write — settlements (someone paid someone back)
// =========================================================================

function addSettlement_(b) {
  var amount = Number(b.amount);
  if (!(amount > 0)) throw new Error("amount must be greater than zero");
  if (!b.from || !b.to) throw new Error("from and to required");
  if (String(b.from) === String(b.to)) throw new Error("from and to must differ");
  appendObj_(SETTLE_TAB, SETTLE_HEADERS, {
    id: newId_(),
    from: String(b.from),
    to: String(b.to),
    amount: amount,
    date: String(b.date || "").slice(0, 10),
    note: String(b.note || "").slice(0, 120),
    createdAt: Date.now()
  });
}

// =========================================================================
// Two-step settle requests: one person asks to settle, the other confirms.
// =========================================================================

function csvList_(s) { return String(s || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean); }

function readRequests_() {
  return readRows_(REQUEST_TAB, REQUEST_HEADERS).map(function (r) {
    return {
      id: String(r.id), kind: String(r.kind || "settle"),
      from: String(r.from || ""), to: String(r.to || ""),
      amount: Number(r.amount) || 0, date: toYmd_(r.date),
      note: String(r.note || ""), targetId: String(r.targetId || ""),
      approvers: csvList_(r.approvers), approved: csvList_(r.approved),
      status: String(r.status || "pending"), createdAt: Number(r.createdAt) || 0
    };
  });
}

// person-by-person: settle a debt YOU owe. The payee must accept.
function addSettleRequest_(session, b) {
  var from = String(b.from || ""), to = String(b.to || "");
  if (from !== session.id && session.role !== "admin") throw new Error("you can only settle your own debt");
  var amount = Number(b.amount);
  if (!(amount > 0)) throw new Error("amount must be greater than zero");
  if (!from || !to) throw new Error("from and to required");
  if (from === to) throw new Error("from and to must differ");
  var pending = readRequests_().filter(function (r) { return r.status === "pending" && r.kind === "settle" && r.from === from; });
  if (pending.length) throw new Error("you already have a settle request waiting to be accepted");
  appendObj_(REQUEST_TAB, REQUEST_HEADERS, {
    id: newId_(), kind: "settle", from: from, to: to, amount: amount,
    date: dateText_(b.date || ""), note: String(b.note || "").slice(0, 120),
    targetId: "", approvers: to, approved: "", status: "pending", createdAt: Date.now()
  });
}

// Ask to DELETE a settlement. Everyone involved (both parties) except the
// requester must approve before it's removed.
function addDeleteRequest_(session, b) {
  var targetId = String(b.targetId || ""); if (!targetId) throw new Error("targetId required");
  // find the settlement
  var s = null, all = readRows_(SETTLE_TAB, SETTLE_HEADERS);
  for (var i = 0; i < all.length; i++) if (String(all[i].id) === targetId) s = all[i];
  if (!s) throw new Error("settlement not found");
  var parties = [String(s.from), String(s.to)];
  var approvers = parties.filter(function (p) { return p && p !== session.id; });
  // de-dup
  var seen = {}, appr = []; approvers.forEach(function (p) { if (!seen[p]) { seen[p] = 1; appr.push(p); } });
  if (!appr.length) throw new Error("nothing to approve");   // shouldn't happen
  // one pending delete request per settlement
  var dup = readRequests_().filter(function (r) { return r.status === "pending" && r.kind === "deleteSettlement" && r.targetId === targetId; });
  if (dup.length) throw new Error("there is already a pending request to delete this settlement");
  appendObj_(REQUEST_TAB, REQUEST_HEADERS, {
    id: newId_(), kind: "deleteSettlement", from: session.id, to: "",
    amount: Number(s.amount) || 0, date: dateText_(""), note: String(b.note || "").slice(0, 120),
    targetId: targetId, approvers: appr.join(","), approved: "", status: "pending", createdAt: Date.now()
  });
}

// Accept or reject a pending request. Works for both kinds.
function respondSettleRequest_(session, b) {
  var id = String(b.id || ""); if (!id) throw new Error("id required");
  var accept = !!b.accept;
  var sh = getOrCreate_(REQUEST_TAB, REQUEST_HEADERS);
  var r = findRow_(sh, id);
  if (r < 0) throw new Error("request not found");
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var cur = sh.getRange(r, 1, 1, head.length).getValues()[0];
  var obj = {}; for (var i = 0; i < head.length; i++) obj[head[i]] = cur[i];
  if (String(obj.status) !== "pending") throw new Error("this request was already answered");

  var approvers = csvList_(obj.approvers), approved = csvList_(obj.approved);
  var isApprover = approvers.indexOf(session.id) >= 0;
  if (!isApprover && session.role !== "admin") throw new Error("you're not asked to approve this");
  if (approved.indexOf(session.id) >= 0) throw new Error("you already approved this");

  if (!accept) {
    obj.status = "rejected";
  } else {
    if (isApprover) approved.push(session.id);
    obj.approved = approved.join(",");
    // all required approvers in? then finalize.
    var allIn = approvers.every(function (p) { return approved.indexOf(p) >= 0; });
    if (allIn || (session.role === "admin")) {
      obj.status = "accepted";
      if (String(obj.kind) === "settle") {
        appendObj_(SETTLE_TAB, SETTLE_HEADERS, {
          id: newId_(), from: String(obj.from), to: String(obj.to),
          amount: Number(obj.amount) || 0, date: toYmd_(obj.date),
          note: String(obj.note || "") || (nameFor_(obj.from) + " paid " + nameFor_(obj.to)),
          createdAt: Date.now()
        });
      } else if (String(obj.kind) === "deleteSettlement") {
        deleteRowById_(SETTLE_TAB, SETTLE_HEADERS, String(obj.targetId));
      }
    }
    // else: stays pending, just records this approval
  }
  var row = head.map(function (h) { return obj[h] !== undefined ? obj[h] : ""; });
  sh.getRange(r, 1, 1, head.length).setValues([row]);
}

function nameFor_(id) {
  var ppl = readRows_(PEOPLE_TAB, PEOPLE_HEADERS);
  for (var i = 0; i < ppl.length; i++) if (String(ppl[i].id) === String(id)) return String(ppl[i].name);
  return "Someone";
}

// =========================================================================
// Write — people
// =========================================================================

function addPerson_(name) {
  name = String(name || "").trim();
  if (!name) throw new Error("name required");
  var people = readRows_(PEOPLE_TAB, PEOPLE_HEADERS);
  var maxOrder = people.reduce(function (m, p) { return Math.max(m, Number(p.order) || 0); }, 0);
  appendObj_(PEOPLE_TAB, PEOPLE_HEADERS, { id: newId_(), name: name, order: maxOrder + 1 });
}

function renamePerson_(id, name) {
  name = String(name || "").trim();
  if (!name) throw new Error("name required");
  var sh = getOrCreate_(PEOPLE_TAB, PEOPLE_HEADERS);
  var r = findRow_(sh, id);
  if (r > 0) {
    var col = headerIndex_(sh, "name"); // 1-based
    if (col > 0) sh.getRange(r, col).setValue(name);
  }
}

function deleteRowById_(tab, headers, id) {
  var sh = getOrCreate_(tab, headers);
  var r = findRow_(sh, id);
  if (r > 0) sh.deleteRow(r);
}

function seedPeople_() {
  [["p1", "Akshay", 1], ["p2", "Praney", 2], ["p3", "Vivek", 3], ["p4", "Logesh", 4]]
    .forEach(function (row) {
      appendObj_(PEOPLE_TAB, PEOPLE_HEADERS, { id: row[0], name: row[1], order: row[2] });
    });
}

// =========================================================================
// Settings (key/value)
// =========================================================================

function getSetting_(key, fallback) {
  var sh = getOrCreate_(SETTINGS_TAB, ["key", "value"]);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (String(rows[i][0]) === key) return String(rows[i][1]);
  return fallback;
}

function setSetting_(key, value) {
  var sh = getOrCreate_(SETTINGS_TAB, ["key", "value"]);
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === key) { sh.getRange(i + 1, 2).setValue(String(value)); return; }
  }
  sh.appendRow([key, String(value)]);
}

// =========================================================================
// Sheet helpers (header-aware, backward compatible)
// =========================================================================

function ss_() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreate_(tabName, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else {
    ensureHeaders_(sh, headers); // add any new columns to an existing tab
  }
  return sh;
}

// Ensure every header in `needed` exists in row 1; append missing ones at the end.
function ensureHeaders_(sh, needed) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var missing = needed.filter(function (h) { return head.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
    sh.setFrozenRows(1);
  }
}

// 1-based column index of a header, or -1.
function headerIndex_(sh, name) {
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  for (var i = 0; i < head.length; i++) if (String(head[i]).trim() === name) return i + 1;
  return -1;
}

// Append a row matching the sheet's CURRENT header order (not a fixed order).
function appendObj_(tabName, headers, obj) {
  var sh = getOrCreate_(tabName, headers);
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(function (h) { return String(h).trim(); });
  var row = head.map(function (h) { return obj[h] !== undefined ? obj[h] : ""; });
  sh.appendRow(row);
}

function readRows_(tabName, headers) {
  var sh = getOrCreate_(tabName, headers);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join("") === "") continue;
    var obj = {};
    for (var c = 0; c < head.length; c++) obj[head[c]] = row[c];
    out.push(obj);
  }
  return out;
}

function findRow_(sh, id) {
  id = String(id);
  var ids = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (var i = 1; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 1;
  return -1;
}

// =========================================================================
// Misc
// =========================================================================

function checkToken_(src) {
  if (!SHARED_TOKEN) return;
  var t = src && (src.token || (src.parameter && src.parameter.token));
  if (String(t) !== SHARED_TOKEN) throw new Error("unauthorized");
}

function newId_() {
  return "x" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function trim_(s) { return String(s).trim(); }

// Normalize a date CELL to "YYYY-MM-DD" on READ. Google Sheets often coerces
// a "2026-10-08" string into a real Date value, so getValues returns a Date;
// convert it back in the spreadsheet's own timezone so the chosen day sticks.
function toYmd_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), "yyyy-MM-dd");
  }
  return String(v || "").slice(0, 10);
}

// What we write for a date: a plain YYYY-MM-DD string (Sheets may store it as a
// Date; toYmd_ normalizes it back on read either way).
function dateText_(v) { return String(v || "").slice(0, 10); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
