/* ============================================================================
 * EXPENSE AGENT  —  drill-down
 * ----------------------------------------------------------------------------
 * This file goes in a SEPARATE Apps Script project that is BOUND to the
 * spreadsheet: open the sheet, Extensions > Apps Script, paste, save.
 *
 * Why separate: onSelectionChange — the trigger that makes a budget cell
 * clickable — only exists in a script bound to the spreadsheet. The main
 * expense-agent.gs project is standalone and cannot have one.
 *
 * What it does: click any number on a Budget tab, and the exact rows behind
 * that number are written to the Drill-down tab. Works on a single category,
 * a whole section, Total OPEX, TOTAL EXPENSES, a whole month, a whole year,
 * and the revenue row.
 *
 * It needs no category list of its own. buildBudget() in expense-agent.gs writes a
 * hidden machine tag in column T of every budget row, and this script reads
 * only that. Add or rename a category and drill-down keeps working untouched.
 * ==========================================================================*/

var DRILL = {
  EXPENSE_TAB: 'Expenses',    // must match CONFIG.TAB in expense-agent.gs
  INCOME_TAB: 'Income',       // must match CONFIG.TAB_IN in expense-agent.gs
  DRILL_TAB: 'Drill-down',
  TAGCOL: 20
};

/**
 * Simple trigger. Fires on every selection change, so it bails out fast on
 * anything that is not a single number cell inside a "Budget <year>" tab.
 */
function onSelectionChange(e) {
  try {
    var sh = e.range.getSheet();
    var nm = sh.getName();
    if (nm.indexOf('Budget ') !== 0) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

    var row = e.range.getRow(), col = e.range.getColumn();
    if (row < 3 || col < 2 || col > 17) return;

    var tag = String(sh.getRange(row, DRILL.TAGCOL).getValue() || '');
    if (!tag) return;

    var year = nm.replace('Budget ', '').trim();
    // columns B..M are months; N..Q (total, allocation, variance, %) mean the whole year
    var month = (col >= 2 && col <= 13) ? mkey(sh.getRange(2, col).getValue()) : '';
    var label = String(sh.getRange(row, 1).getValue() || '').trim();

    if (tag === 'rev') return drillIncome(year, month, label, sh);
    if (tag.indexOf('cat|') !== 0) return;
    drillExpenses(tag.substring(4).split(';'), year, month, label, sh);
  } catch (err) {
    // a simple trigger must never throw a dialog at the user
  }
}

/** Adds a menu, so the tab is also reachable without clicking a cell. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Expense Agent')
    .addItem('Open Drill-down tab', 'showDrill')
    .addToUi();
}
function showDrill() {
  var ss = SpreadsheetApp.getActive();
  var d = ss.getSheetByName(DRILL.DRILL_TAB);
  if (d) ss.setActiveSheet(d);
}

function drillExpenses(cats, year, month, label, fromSheet) {
  var ss = SpreadsheetApp.getActive();
  var src = ss.getSheetByName(DRILL.EXPENSE_TAB);
  if (!src || src.getLastRow() < 2) return;

  var want = {};
  cats.forEach(function (c) { want[String(c).trim()] = 1; });

  var vals = src.getRange(2, 1, src.getLastRow() - 1, 18).getValues();
  var out = [], total = 0;
  vals.forEach(function (r) {
    if (String(r[6]).trim() !== 'Business') return;
    var m = mkey(r[1]);
    if (month) { if (m !== month) return; }
    else if (m.substring(0, 4) !== String(year)) return;
    if (!want[String(r[5]).trim()]) return;
    total += Number(r[9]) || 0;
    out.push([r[0], m, r[2], r[3], r[4], r[5], r[9], r[7], r[8], r[10], r[11],
              r[16], r[12], r[13], r[17]]);
  });
  out.sort(function (a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; });

  write(['Date', 'Month', 'Vendor', 'Description', 'Invoice #', 'Category',
    'Amount (base)', 'Currency', 'Amount', 'Tax', 'Payment Method', 'Billed To',
    'File Link', 'Gmail Link', 'Note'],
    out, label, month || year, total, cats.length, fromSheet);
}

function drillIncome(year, month, label, fromSheet) {
  var ss = SpreadsheetApp.getActive();
  var src = ss.getSheetByName(DRILL.INCOME_TAB);
  var out = [], total = 0;
  if (src && src.getLastRow() > 1) {
    src.getRange(2, 1, src.getLastRow() - 1, 15).getValues().forEach(function (r) {
      var m = mkey(r[1]);
      if (month) { if (m !== month) return; }
      else if (m.substring(0, 4) !== String(year)) return;
      total += Number(r[8]) || 0;
      out.push([r[0], m, r[2], r[3], r[4], r[5], r[8], r[6], r[7], r[9], r[10], r[11], r[14]]);
    });
  }
  out.sort(function (a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; });

  write(['Date', 'Month', 'Payer / Source', 'Description', 'Doc #', 'Channel',
    'Gross (base)', 'Currency', 'Gross', 'Fees', 'Net', 'Gmail Link', 'Note'],
    out, label, month || year, total, 0, fromSheet);
}

function write(head, rows, label, period, total, nCats, fromSheet) {
  var ss = SpreadsheetApp.getActive();
  var d = ss.getSheetByName(DRILL.DRILL_TAB) || ss.insertSheet(DRILL.DRILL_TAB);
  d.clear();

  var W = head.length;
  d.getRange(1, 1).setValue(
    label.replace(/\s+/g, ' ').trim() + '   |   ' + period + '   |   ' +
    rows.length + ' rows   |   ' + Math.round(total).toLocaleString()
  ).setFontWeight('bold').setFontSize(12);

  d.getRange(2, 1).setFormula('=HYPERLINK("#gid=' + fromSheet.getSheetId() +
    '","<- back to ' + fromSheet.getName() + '")');
  if (nCats > 1) d.getRange(2, 3).setValue(nCats + ' categories rolled up');

  d.getRange(4, 1, 1, W).setValues([head]).setFontWeight('bold').setBackground('#efefef');
  if (rows.length) {
    d.getRange(5, 1, rows.length, W).setValues(rows);
    d.getRange(5, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    d.getRange(5, 2, rows.length, 1).setNumberFormat('@');
    d.getRange(5, 7, rows.length, 1).setNumberFormat('#,##0.00');
  } else {
    d.getRange(5, 1).setValue('Nothing matches this cell.');
  }
  d.setFrozenRows(4);
  for (var i = 1; i <= W; i++) d.setColumnWidth(i, i === 4 ? 300 : 130);
  ss.setActiveSheet(d);
}

/**
 * Sheets often stores a month key like 2026-03 as a real Date rather than text,
 * and it stores it at MIDNIGHT IN THE SPREADSHEET'S OWN TIMEZONE. Format it in
 * any other zone and a March date silently becomes February — which quietly
 * drops rows from the drill-down instead of erroring. So always read the
 * spreadsheet's timezone rather than hard-coding one.
 */
function mkey(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM');
  }
  return String(v == null ? '' : v).trim();
}
