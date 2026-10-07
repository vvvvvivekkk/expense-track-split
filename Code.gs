/**
 * Split Four Ways — Google Apps Script backend
 * -------------------------------------------------
 * This script turns your Google Sheet into a tiny API that your
 * static frontend (hosted on Vercel/Render) reads and writes.
 *
 * SETUP (full steps are in README.md):
 *   1. Open your Sheet → Extensions → Apps Script.
 *   2. Delete any sample code, paste ALL of this file, Save.
 *   3. Deploy → New deployment → type "Web app".
 *        Execute as:  Me
 *        Who has access:  Anyone
 *      Copy the /exec URL it gives you and paste it into index.html.
 *
 * The three tabs (People, Expenses, Settings) are created
 * automatically on first use, and People is seeded with Person 1–4.
 */

// --- Which Google Sheet this writes to -----------------------------------
// Pre-filled with your sheet. If you paste this script INTO the sheet
// (Extensions -> Apps Script), you can leave it as-is or set it to "" —
// either way it targets this sheet.
var SHEET_ID = "1C3GSm17VsmJVpU0X87fIGs8nyk2Veqy5yUaZiUVAlHs";

// --- Optional security ---------------------------------------------------
// Leave "" to allow anyone with the URL (fine for a small group).
// To harden: set the same non-empty string here AND in index.html (API_TOKEN).
var SHARED_TOKEN = "";

// --- Sheet/tab config ----------------------------------------------------
var PEOPLE_TAB   = "People";
var EXPENSE_TAB  = "Expenses";
var SETTINGS_TAB = "Settings";
var PEOPLE_HEADERS  = ["id", "name", "order"];
var EXPENSE_HEADERS = ["id", "desc", "amount", "paidBy", "splitAmong", "createdAt"];

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
  try {
    lock.waitLock(20000); // serialize writes so two people don't clash
  } catch (_) {
    return json_({ ok: false, error: "busy, try again" });
  }
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    checkToken_(body);

    switch (body.action) {
      case "addExpense":    addExpense_(body);          break;
      case "deleteExpense": deleteRowById_(EXPENSE_TAB, body.id); break;
      case "addPerson":     addPerson_(body.name);      break;
      case "renamePerson":  renamePerson_(body.id, body.name); break;
      case "removePerson":  deleteRowById_(PEOPLE_TAB, body.id);  break;
      case "setCurrency":   setSetting_("currency", body.currency); break;
      default: throw new Error("unknown action: " + body.action);
    }
    // Always return the fresh full state so the client can resync in one call.
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
  if (people.length === 0) {
    seedPeople_();
    people = readRows_(PEOPLE_TAB, PEOPLE_HEADERS);
  }
  people = people.map(function (p) {
    return { id: String(p.id), name: String(p.name), order: Number(p.order) || 0 };
  }).sort(function (a, b) { return a.order - b.order; });

  var expenses = readRows_(EXPENSE_TAB, EXPENSE_HEADERS).map(function (r) {
    return {
      id: String(r.id),
      desc: String(r.desc || ""),
      amount: Number(r.amount) || 0,            // major units, e.g. 100.50
      paidBy: String(r.paidBy || ""),
      splitAmong: String(r.splitAmong || "").split(",").map(trim_).filter(Boolean),
      createdAt: Number(r.createdAt) || 0
    };
  });

  return { people: people, expenses: expenses, currency: getSetting_("currency", "₹") };
}

// =========================================================================
// Write
// =========================================================================

function addExpense_(b) {
  var amount = Number(b.amount);
  if (!(amount > 0)) throw new Error("amount must be greater than zero");
  var among = (b.splitAmong || []).map(String).filter(Boolean);
  if (among.length === 0) throw new Error("splitAmong is empty");
  var sh = getOrCreate_(EXPENSE_TAB, EXPENSE_HEADERS);
  sh.appendRow([
    newId_(),
    String(b.desc || "").slice(0, 200),
    amount,
    String(b.paidBy || ""),
    among.join(","),
    Date.now()
  ]);
}

function addPerson_(name) {
  name = String(name || "").trim();
  if (!name) throw new Error("name required");
  var people = readRows_(PEOPLE_TAB, PEOPLE_HEADERS);
  var maxOrder = people.reduce(function (m, p) { return Math.max(m, Number(p.order) || 0); }, 0);
  getOrCreate_(PEOPLE_TAB, PEOPLE_HEADERS).appendRow([newId_(), name, maxOrder + 1]);
}

function renamePerson_(id, name) {
  name = String(name || "").trim();
  if (!name) throw new Error("name required");
  var sh = getOrCreate_(PEOPLE_TAB, PEOPLE_HEADERS);
  var r = findRow_(sh, id);
  if (r > 0) sh.getRange(r, 2).setValue(name); // column 2 = name
}

function deleteRowById_(tab, id) {
  var sh = getOrCreate_(tab, tab === PEOPLE_TAB ? PEOPLE_HEADERS : EXPENSE_HEADERS);
  var r = findRow_(sh, id);
  if (r > 0) sh.deleteRow(r);
}

function seedPeople_() {
  var sh = getOrCreate_(PEOPLE_TAB, PEOPLE_HEADERS);
  [["p1", "Akshay", 1], ["p2", "Praney", 2], ["p3", "Vivek", 3], ["p4", "Logesh", 4]]
    .forEach(function (row) { sh.appendRow(row); });
}

// =========================================================================
// Settings (key/value in the Settings tab)
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
// Sheet helpers
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
  }
  return sh;
}

// Read all data rows of a tab into [{header: value}, ...]
function readRows_(tabName, headers) {
  var sh = getOrCreate_(tabName, headers);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join("") === "") continue; // skip blank rows
    var obj = {};
    for (var c = 0; c < head.length; c++) obj[head[c]] = row[c];
    out.push(obj);
  }
  return out;
}

// Row number (1-based) of the row whose first column equals id, else -1.
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
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
