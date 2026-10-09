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
    checkToken_(body);

    switch (body.action) {
      case "addExpense":      addExpense_(body); break;
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
      date: String(r.date || ""),
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
      date: String(r.date || ""),
      note: String(r.note || ""),
      createdAt: Number(r.createdAt) || 0
    };
  });

  return {
    people: people,
    expenses: expenses,
    settlements: settlements,
    currency: getSetting_("currency", "₹")
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
    date: String(b.date || "").slice(0, 10),
    items: items.length ? JSON.stringify(items) : "",
    createdAt: Date.now()
  });
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
