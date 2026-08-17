/* ============================================================================
 * EXPENSE AGENT  —  main script
 * ----------------------------------------------------------------------------
 * Reads a Gmail mailbox, uses Claude to decide what is a real expense (or a
 * real payout), files the invoice PDF in Drive, and writes a row to a Google
 * Sheet. Then builds live budget tabs on top of that sheet.
 *
 * Everything you need to change is in CONFIG, immediately below. Nothing else
 * in this file needs editing to get started.
 *
 * Paste this whole file into a new Apps Script project, set your Anthropic API
 * key in Project Settings > Script Properties, then run setup().
 * ==========================================================================*/


/* ============================================================================
 * SECTION 0 — MANUAL RUN TARGET
 * ----------------------------------------------------------------------------
 * The Apps Script editor's Run button uses the FIRST function in the file and
 * its dropdown is unreliable. So this stub sits at the top: edit its body to
 * whatever you want to run by hand, save, hit Run.
 * ==========================================================================*/
function RUN() {
  return setup();
}


/* ============================================================================
 * SECTION 1 — CONFIG
 * ==========================================================================*/
var CONFIG = {

  /* ---- required ---------------------------------------------------------*/

  // The Google Sheet that holds the ledger. Take the long id out of its URL:
  // docs.google.com/spreadsheets/d/<<<THIS PART>>>/edit
  SHEET_ID: 'PUT_YOUR_SHEET_ID_HERE',

  // The Drive folder where invoice PDFs get filed, as <folder>/2026/2026-03/.
  // Take the id out of the folder URL: drive.google.com/drive/folders/<<<THIS>>>
  // Leave '' to skip filing entirely and only keep the Gmail link.
  DRIVE_FOLDER_ID: 'PUT_YOUR_DRIVE_FOLDER_ID_HERE',

  // Your accounting currency. Everything is converted to this for the budget.
  // Any ISO code: 'USD', 'EUR', 'GBP', 'ILS', 'INR', ...
  BASE_CURRENCY: 'USD',

  // What this mailbox belongs to, in one line. This is the single most useful
  // thing you can tune — the classifier reads it before every decision.
  // e.g. 'Acme Ltd, a UK company that sells handmade furniture online.'
  BUSINESS_DESCRIPTION: 'PUT A ONE LINE DESCRIPTION OF YOUR BUSINESS HERE',

  /* ---- backfill ---------------------------------------------------------*/

  // How far back the first full scan should reach. YYYY-MM-DD.
  // Set to '' to skip history entirely and only track from today onwards.
  // The backfill runs flat out — see SECTION 4 — not one month per hour.
  BACKFILL_FROM: '2026-01-01',

  // How often to check for new expenses once the backfill is done.
  //   1  once a day        — plenty for most people, cheapest, safest on quota
  //   2  twice a day
  //   4  every 6 hours
  //   24 hourly            — only worth it on a Workspace account
  SCANS_PER_DAY: 1,

  /* ---- optional ---------------------------------------------------------*/

  TZ: 'Etc/GMT',                 // e.g. 'America/New_York', 'Europe/London'
  LABEL: 'ExpenseAgent/Scanned',       // applied to every thread we have looked at
  TAB: 'Expenses',
  TAB_IN: 'Income',
  TRACK_INCOME: true,            // set false if you only care about spending
  DAILY_HOUR: 6,                 // hour of the first scan of the day
  MAX_PER_RUN: 30,               // messages fully processed per execution
  MAX_PDF_MB: 20,                // skip attachments bigger than this
  BUDGET_YEARS: [2026, 2027],

  /* ---- multi-mailbox (leave alone for a single mailbox) -----------------*/
  // 'solo'      one mailbox, this project owns everything.
  // 'hub'       owns the sheet + Drive, and accepts rows from satellites.
  // 'satellite' scans a second mailbox and posts its findings to the hub.
  MODE: 'solo',
  SHARED_SECRET: '',             // same value in hub and satellite
  HUB_URL: '',                   // satellite only: the hub's web app /exec URL

  /* ---- models (auto-resolved on setup, you can ignore these) ------------*/
  MODEL_FAST: '',
  MODEL_SMART: ''
};

/** Tried in order until one answers. setup() stores the winners. */
var MODEL_CANDIDATES = {
  fast:  ['claude-haiku-4-5', 'claude-3-5-haiku-latest'],
  smart: ['claude-sonnet-4-5', 'claude-sonnet-5', 'claude-3-7-sonnet-latest']
};


/* ============================================================================
 * SECTION 2 — CATEGORIES
 * ----------------------------------------------------------------------------
 * CATS is a CLOSED list. The classifier must pick from it and may never invent
 * a new name; if nothing fits it picks the closest and writes what it would
 * have called it into the Note, for you to decide.
 *
 * To add a category: add the name to CATS and give it a section in SECTION.
 * You can also just type a new name straight into the Category column of the
 * sheet — the budget picks it up on the next rebuild and files it under
 * UNASSIGNED until you add it here.
 * ==========================================================================*/
var CATS = [
  // cost of delivering the product or service
  'Cost of Goods', 'Manufacturing & Production', 'Shipping & Fulfilment',
  'Payment Processing',
  // building the product
  'Software & SaaS', 'Hosting & Infrastructure', 'AI & Dev Tools',
  'Contractors - Product',
  // getting customers
  'Advertising', 'Marketing Services', 'Contractors - Marketing',
  // running the company
  'Professional Services', 'Banking & Fees', 'Insurance', 'Taxes & Licences',
  'Telecom & Internet', 'Office & Supplies', 'Rent & Facilities', 'Utilities',
  'Equipment & Hardware', 'Travel', 'Meals & Entertainment', 'Training',
  'Payroll & Benefits', 'Other'
];

var SECTION = {
  'COGS': ['Cost of Goods', 'Manufacturing & Production', 'Shipping & Fulfilment',
           'Payment Processing'],
  'R&D':  ['Software & SaaS', 'Hosting & Infrastructure', 'AI & Dev Tools',
           'Contractors - Product'],
  'S&M':  ['Advertising', 'Marketing Services', 'Contractors - Marketing'],
  'G&A':  ['Professional Services', 'Banking & Fees', 'Insurance', 'Taxes & Licences',
           'Telecom & Internet', 'Office & Supplies', 'Rent & Facilities', 'Utilities',
           'Equipment & Hardware', 'Travel', 'Meals & Entertainment', 'Training',
           'Payroll & Benefits', 'Other']
};

var SEC_ORDER = ['COGS', 'R&D', 'S&M', 'G&A', 'Unassigned'];
var SEC_LABEL = {
  'COGS': 'COGS  (cost of goods sold)',
  'R&D': 'R&D  (product & engineering)',
  'S&M': 'S&M  (sales & marketing)',
  'G&A': 'G&A  (general & admin)',
  'Unassigned': 'UNASSIGNED  (new categories — give them a section in SECTION)'
};

/** category -> section, derived from SECTION so there is one source of truth */
function catSection() {
  var m = {};
  Object.keys(SECTION).forEach(function (s) {
    SECTION[s].forEach(function (c) { m[c] = s; });
  });
  return m;
}


/* ============================================================================
 * SECTION 3 — SHEET LAYOUT
 * ----------------------------------------------------------------------------
 * Column order is load-bearing: several functions address columns by number.
 * If you add a column, add it at the END.
 * ==========================================================================*/
function HDR_EXP() {
  var c = CONFIG.BASE_CURRENCY;
  return ['Charge Date', 'Month', 'Vendor', 'Description', 'Invoice #', 'Category',
    'Business/Personal', 'Currency', 'Amount', 'Amount ' + c, 'Tax ' + c,
    'Payment Method', 'File Link', 'Gmail Link', 'Source Inbox', 'Email ID',
    'Billed To', 'Note'];
}
function HDR_INC() {
  var c = CONFIG.BASE_CURRENCY;
  return ['Received Date', 'Month', 'Payer / Source', 'Description', 'Doc #', 'Channel',
    'Currency', 'Gross', 'Gross ' + c, 'Fees ' + c, 'Net ' + c,
    'Gmail Link', 'Source Inbox', 'Email ID', 'Note'];
}
var COL = { EXP_ID: 16, INC_ID: 14, EXP_FILE: 13, EXP_CAT: 6, EXP_BP: 7, EXP_NOTE: 18 };
var TAGCOL = 20;   // hidden machine tag on budget tabs, read by the drill-down script


/* ============================================================================
 * SECTION 4 — SETUP AND SCHEDULING
 * ==========================================================================*/

/**
 * Run this once. Safe to run again — it never deletes rows and never rewinds
 * the backfill, so re-running after a config change costs you nothing.
 */
function setup() {
  var out = [];

  if (!apiKey()) throw new Error(
    'No API key. Project Settings > Script Properties > add ANTHROPIC_API_KEY.');

  out.push(resolveModels());

  if (CONFIG.MODE !== 'satellite') {
    sheet(CONFIG.TAB, HDR_EXP());
    if (CONFIG.TRACK_INCOME) sheet(CONFIG.TAB_IN, HDR_INC());
    out.push(buildBudgets());
  }

  // ongoing scan, at whatever cadence was asked for
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'dailyRun' || f === 'backfillTick' || f === 'catchUp') ScriptApp.deleteTrigger(t);
  });
  var n = Number(CONFIG.SCANS_PER_DAY) || 1;
  if (n <= 1) {
    ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(CONFIG.DAILY_HOUR).create();
    out.push('scanning once a day at ' + CONFIG.DAILY_HOUR + ':00');
  } else {
    ScriptApp.newTrigger('dailyRun').timeBased().everyHours(Math.max(1, Math.round(24 / n))).create();
    out.push('scanning ' + n + 'x a day');
  }

  var p = props();
  if (!p.getProperty('BF_CURSOR') && CONFIG.BACKFILL_FROM) {
    p.setProperty('BF_CURSOR', CONFIG.BACKFILL_FROM);
  }

  // history, if wanted — this runs flat out rather than dribbling
  if (CONFIG.BACKFILL_FROM && !p.getProperty('BF_DONE')) {
    out.push(catchUp());
  } else {
    out.push('no backfill requested, tracking from today onwards');
  }

  var s = out.join(' | ');
  console.log(s);
  return s;
}


/* ============================================================================
 * SECTION 4b — FAST BACKFILL, AND THE GMAIL QUOTA
 * ----------------------------------------------------------------------------
 * The obvious design is a 5-minute trigger doing one month per tick. Do not do
 * that. It turns a year into an afternoon at best, and if anything fails the
 * cursor never advances and it retries forever — I watched a real install rack
 * up 288 consecutive failures in a day, ingesting nothing.
 *
 * Instead: one execution chews through as many months as fit in ~4.5 minutes
 * (Apps Script kills you at 6), then chains the next execution a minute later.
 * A year is a handful of runs.
 *
 * The real ceiling is the Gmail daily quota, which a consumer account exhausts
 * far sooner than a Workspace one. When that happens the guard stops the loop
 * and schedules a resume for just after the quota resets at midnight PACIFIC —
 * so it restarts itself instead of hammering away and burning tomorrow's
 * allowance too.
 * ========================================================================== */

function catchUp() {
  var start = new Date().getTime();
  var p = props();
  var passes = 0;

  while (new Date().getTime() - start < 4.5 * 60 * 1000) {
    if (quotaBlocked()) {
      return 'gmail quota spent after ' + passes + ' passes, resuming ' + scheduleAfterQuotaReset();
    }
    var r = guard(backfillTickWork);
    passes++;
    if (typeof r === 'string' && r.indexOf('paused') === 0) {
      return 'gmail quota hit after ' + passes + ' passes, resuming ' + scheduleAfterQuotaReset();
    }
    if (p.getProperty('BF_DONE')) {
      clearCatchUp();
      return 'backfill complete after ' + passes + ' passes';
    }
  }
  chainCatchUp();
  return 'ran ' + passes + ' passes, cursor at ' + p.getProperty('BF_CURSOR') + ', chained';
}

function clearCatchUp() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'catchUp') ScriptApp.deleteTrigger(t);
  });
}
function chainCatchUp() {
  clearCatchUp();
  ScriptApp.newTrigger('catchUp').timeBased().after(60 * 1000).create();
}

/** Gmail's daily quota resets at midnight Pacific, not local midnight. */
function quotaDay() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}
function quotaBlocked() {
  return props().getProperty('QUOTA_BLOCKED') === quotaDay();
}
function guard(fn) {
  if (quotaBlocked()) return 'skipped: gmail quota spent for today';
  try {
    return fn();
  } catch (e) {
    if (String(e).indexOf('too many times for one day') >= 0) {
      props().setProperty('QUOTA_BLOCKED', quotaDay());
      return 'paused: gmail quota hit';
    }
    throw e;
  }
}
function scheduleAfterQuotaReset() {
  var now = new Date();
  var h = Number(Utilities.formatDate(now, 'America/Los_Angeles', 'HH'));
  var mi = Number(Utilities.formatDate(now, 'America/Los_Angeles', 'mm'));
  var at = new Date(now.getTime() + ((24 - h) * 60 - mi + 10) * 60 * 1000);
  clearCatchUp();
  ScriptApp.newTrigger('catchUp').timeBased().at(at).create();
  return at.toISOString();
}

/** Rewind and redo a whole period. Safe — rows dedupe on Gmail message id. */
function restartBackfill(fromDate) {
  var p = props();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'backfillTick' || f === 'catchUp') ScriptApp.deleteTrigger(t);
  });
  p.setProperty('BF_CURSOR', fromDate || CONFIG.BACKFILL_FROM);
  p.deleteProperty('BF_DONE');
  p.deleteProperty('QUOTA_BLOCKED');
  return catchUp();
}

/**
 * Ask the API which model ids actually work with this key, so a renamed or
 * unavailable model never silently breaks the whole thing.
 */
function resolveModels() {
  var p = props(), found = {};
  ['fast', 'smart'].forEach(function (tier) {
    var list = MODEL_CANDIDATES[tier];
    for (var i = 0; i < list.length; i++) {
      var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
        payload: JSON.stringify({
          model: list[i], max_tokens: 4,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      if (r.getResponseCode() === 200) { found[tier] = list[i]; break; }
    }
    if (!found[tier]) throw new Error('None of the ' + tier + ' models responded: ' +
      list.join(', ') + '. Edit MODEL_CANDIDATES with a model id your key can use.');
    p.setProperty('MODEL_' + tier.toUpperCase(), found[tier]);
  });
  return 'models: ' + found.fast + ' + ' + found.smart;
}

function modelFast()  { return CONFIG.MODEL_FAST  || props().getProperty('MODEL_FAST'); }
function modelSmart() { return CONFIG.MODEL_SMART || props().getProperty('MODEL_SMART'); }

/** Yesterday and today, every day. Cheap because scanned threads are labelled. */
function dailyRunWork() {
  var now = new Date();
  // Gmail's before: is exclusive, so reach past midnight to include today
  var to = new Date(now.getTime() + 864e5);
  var from = new Date(now.getTime() - 3 * 864e5);
  var r = processRange(from, to);
  if (CONFIG.MODE !== 'satellite') { try { syncBudgets(); } catch (e) {} }
  console.log(r);
  return r;
}

/**
 * Walks the backfill forward one month per tick until it reaches today, then
 * removes its own trigger. Splitting it up keeps every execution well inside
 * the 6 minute limit and well inside the daily Gmail quota.
 */
function backfillTickWork() {
  var p = props();
  var cur = p.getProperty('BF_CURSOR');
  if (!cur) return 'no cursor';

  var from = new Date(cur + 'T00:00:00Z');
  if (from > new Date()) return finishBackfill();

  var to = new Date(from.getTime());
  to.setUTCMonth(to.getUTCMonth() + 1);

  var r = processRange(from, to);

  // only advance when the month completed cleanly, otherwise retry next tick
  if (r.remaining === 0 && r.errors === 0) {
    p.setProperty('BF_CURSOR', Utilities.formatDate(to, 'Etc/GMT', 'yyyy-MM-dd'));
  }
  console.log(cur + ' -> ' + JSON.stringify(r));
  return r;
}

function finishBackfill() {
  clearCatchUp();
  props().setProperty('BF_DONE', new Date().toISOString());
  if (CONFIG.MODE !== 'satellite') { try { buildBudgets(); } catch (e) {} }
  return 'backfill complete';
}

/** Quick health check. Run it any time. */
function status() {
  var p = props();
  var s = {
    mode: CONFIG.MODE,
    mailbox: Session.getEffectiveUser().getEmail(),
    cursor: p.getProperty('BF_CURSOR'),
    backfillDone: p.getProperty('BF_DONE') || null,
    models: modelFast() + ' / ' + modelSmart(),
    hasApiKey: !!apiKey()
  };
  if (CONFIG.MODE !== 'satellite') {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var e = ss.getSheetByName(CONFIG.TAB);
    var i = ss.getSheetByName(CONFIG.TAB_IN);
    s.expenseRows = e ? Math.max(0, e.getLastRow() - 1) : 0;
    s.incomeRows = i ? Math.max(0, i.getLastRow() - 1) : 0;
  }
  console.log(JSON.stringify(s));
  return s;
}


/* ============================================================================
 * SECTION 5 — SCANNING
 * ==========================================================================*/

/**
 * Keywords keep us from feeding the whole mailbox to the model. Anything that
 * looks like money leaving or arriving gets looked at; everything else is
 * never even read. Add your own bank, accountant or supplier words here.
 */
var KEYWORDS = '{invoice receipt "payment received" "payment confirmation" billing ' +
  '"your order" charged subscription renewal statement payout deposit ' +
  'remittance "tax invoice" refund "thank you for your payment" חשבונית קבלה}';

function processRange(from, to) {
  var q = 'after:' + fmtDay(from) + ' before:' + fmtDay(to) +
    ' -in:chats -in:drafts -label:"' + CONFIG.LABEL + '" ' + KEYWORDS;
  return processQuery(q);
}

function processQuery(query) {
  var label = getLabel();
  var seen = existingIds();
  var me = normAddr(Session.getEffectiveUser().getEmail());
  var done = 0, errors = 0, rows = [], inc = [];

  var threads = GmailApp.search(query, 0, 200);

  for (var i = 0; i < threads.length; i++) {
    if (done >= CONFIG.MAX_PER_RUN) {
      // hand back what we have before stopping — never lose a processed row
      if (rows.length || inc.length) commit(rows, inc);
      return { processed: done, errors: errors, remaining: threads.length - i };
    }
    var msgs = threads[i].getMessages();

    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      if (seen[m.getId()]) continue;

      // mail this mailbox sent itself, or forwarded copies of its own receipts
      if (normAddr(m.getFrom()) === me) continue;

      try {
        var r = processMessage(m);
        if (r && r.expense) rows.push(r.expense);
        if (r && r.income) inc.push(r.income);
        if (r && r.extra) rows.push(r.extra);
        if (r && r.kind) done++;
      } catch (e) {
        errors++;
        console.log('error on ' + m.getId() + ': ' + e);
      }
    }

    // Label the thread whether or not it produced a row. That is the whole
    // point: a thread we have already judged is never judged twice.
    try { threads[i].addLabel(label); } catch (e) {}
  }

  if (rows.length || inc.length) commit(rows, inc);
  return { processed: done, errors: errors, remaining: 0 };
}

/**
 * One message: triage cheaply, then extract expensively only if it matters.
 */
function processMessage(m) {
  var t = triage(m);
  if (!t || t.kind === 'skip') return null;
  if (t.kind === 'income' && !CONFIG.TRACK_INCOME) return null;

  if (t.kind === 'income') {
    var got = incomeRow(m);
    // a payout also produces the processor's fee as a real expense
    return { kind: 'income', income: got.row, extra: got.fee };
  }

  return { kind: 'expense', expense: expenseRow(m) };
}

/**
 * Cheap yes/no pass. The rules here are where most accuracy comes from —
 * they encode the mistakes that are easy to make and expensive to unpick.
 */
function triage(m) {
  var body = m.getPlainBody().substring(0, 3000);
  var atts = attachmentNames(m).join(', ');

  var p = [
    CONFIG.BUSINESS_DESCRIPTION,
    '',
    'Decide what this email is. Reply with JSON only:',
    '{"kind":"expense"|"income"|"skip","reason":"short"}',
    '',
    'expense = money this business PAID OUT and there is a real charge in the email.',
    'income  = money ARRIVING in this business\'s account: a payout or settlement',
    '          from a payment processor, marketplace or bank.',
    'skip    = everything else.',
    '',
    'Rules that matter:',
    '- An invoice or receipt this business ISSUED TO ITS OWN CUSTOMER is not an',
    '  expense. It is a sale. Mark it skip unless it is a processor payout.',
    '- A booking confirmation, order confirmation, quote, reminder or "your card',
    '  will be charged" notice with no completed charge is skip.',
    '- A payout summary line ("42 transactions, 3,910 total") that arrives',
    '  alongside individual transaction emails is the SETTLEMENT. Count the',
    '  settlement only, never the individual transactions.',
    '- Newsletters, shipping updates, password resets, marketing: skip.',
    '- Failed or declined payments: skip.',
    '- A refund the business RECEIVED is an expense with a negative amount.',
    '',
    'From: ' + m.getFrom(),
    'To: ' + m.getTo(),
    'Subject: ' + m.getSubject(),
    'Attachments: ' + (atts || 'none'),
    'Body:',
    body
  ].join('\n');

  return claude(modelFast(), [{ type: 'text', text: p }], 200);
}

/** Full extraction. The PDF itself is sent to the model, not just the text. */
function expenseRow(m) {
  var doc = pickDocument(m);
  var content = docBlocks(doc);

  content.push({
    type: 'text', text: [
      CONFIG.BUSINESS_DESCRIPTION,
      '',
      'Extract this expense. Reply with JSON only:',
      '{"date":"YYYY-MM-DD","vendor":"","description":"","invoice_number":"",',
      ' "category":"","business_personal":"Business"|"Personal","currency":"XXX",',
      ' "amount":0,"tax_amount":0,"payment_method":"","billed_to":"","note":""}',
      '',
      'category MUST be exactly one of:',
      CATS.join('\n'),
      'If none fits, pick the closest one and put the name you would have used',
      'in note as: suggested category: <name>. Never invent a category.',
      '',
      'business_personal: "Business" if it belongs to the business, "Personal"',
      'if it is a private expense of the owner that happens to land in this inbox.',
      '',
      'billed_to = the name the invoice is made out to.',
      'amount = the total actually charged, tax included. Negative for a refund.',
      'If a figure is genuinely absent leave it empty rather than guessing.',
      '',
      doc ? 'The attached file is the invoice — read it, not the email body.' : '',
      'From: ' + m.getFrom(),
      'Date: ' + m.getDate(),
      'Subject: ' + m.getSubject(),
      'Body:',
      m.getPlainBody().substring(0, 6000)
    ].join('\n')
  });

  var x = claude(modelSmart(), content, 1200) || {};

  var date = x.date || Utilities.formatDate(m.getDate(), CONFIG.TZ, 'yyyy-MM-dd');
  var month = date.substring(0, 7);
  var cur = (x.currency || CONFIG.BASE_CURRENCY).toUpperCase();
  var amt = num(x.amount);
  var base = toBase(amt, cur, date);
  var tax = toBase(num(x.tax_amount), cur, date);

  var note = String(x.note || '');
  if (amt === '' || amt === 0) note = 'NEEDS REVIEW: no amount found. ' + note;

  var link = '';
  if (doc && CONFIG.DRIVE_FOLDER_ID) {
    try {
      link = fileToDrive(doc, month, date, x.vendor || 'Unknown', amt, cur, x.invoice_number);
    } catch (e) { note = 'NEEDS REVIEW: could not file the document. ' + note; }
  }

  return [dateVal(date), month, x.vendor || 'Unknown', x.description || '',
    x.invoice_number || '', safeCat(x.category), bp(x.business_personal),
    cur, amt, base, tax, x.payment_method || '', link, gmailLink(m),
    Session.getEffectiveUser().getEmail(), m.getId(), x.billed_to || '', note.trim()];
}

/** Attachment as a model-readable block. PDFs as documents, images as images. */
function docBlocks(doc) {
  if (!doc) return [];
  if (doc.pdf) {
    return [{ type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: doc.b64 } }];
  }
  if (doc.type && doc.type.indexOf('image/') === 0) {
    return [{ type: 'image',
      source: { type: 'base64', media_type: doc.type, data: doc.b64 } }];
  }
  return [];
}

/**
 * A payout / settlement. The useful trick here: processors deposit NET but the
 * real revenue is GROSS, and the difference is a fee you actually paid. So one
 * payout email produces an income row AND a Payment Processing expense row.
 */
function incomeRow(m) {
  var doc = pickDocument(m);
  var content = docBlocks(doc);
  content.push({ type: 'text', text: [
    CONFIG.BUSINESS_DESCRIPTION,
    '',
    'This is money arriving. Reply with JSON only:',
    '{"date":"YYYY-MM-DD","payer":"","description":"","doc_number":"","channel":"",',
    ' "currency":"XXX","gross_amount":0,"fees_amount":0,"net_amount":0,"note":""}',
    '',
    'gross_amount = the total the customers paid, BEFORE any commission.',
    'fees_amount  = the commission or processing fee deducted.',
    'net_amount   = what actually landed in the bank.',
    'If only two of the three are stated, leave the third empty — do not guess.',
    '',
    'From: ' + m.getFrom(),
    'Date: ' + m.getDate(),
    'Subject: ' + m.getSubject(),
    'Body:',
    m.getPlainBody().substring(0, 6000)
  ].join('\n') });

  var x = claude(modelSmart(), content, 900) || {};

  var date = x.date || Utilities.formatDate(m.getDate(), CONFIG.TZ, 'yyyy-MM-dd');
  var month = date.substring(0, 7);
  var cur = (x.currency || CONFIG.BASE_CURRENCY).toUpperCase();

  var gross = num(x.gross_amount), fees = num(x.fees_amount), net = num(x.net_amount);
  if (gross === '' && net !== '' && fees !== '') gross = round2(net + fees);
  if (net === '' && gross !== '' && fees !== '') net = round2(gross - fees);

  var note = String(x.note || '');
  if (gross === '') note = 'NEEDS REVIEW: no gross amount found. ' + note;
  else if (fees === '') note = 'NEEDS REVIEW: fees not stated, gross may be understated. ' + note;
  else note = 'Net ' + fmtAmt(net) + ' ' + cur + ' after ' + fmtAmt(fees) + ' fees. ' + note;

  var row = [dateVal(date), month, x.payer || 'Unknown', x.description || '',
    x.doc_number || '', x.channel || '', cur, gross,
    toBase(gross, cur, date), toBase(fees, cur, date), toBase(net, cur, date),
    gmailLink(m), Session.getEffectiveUser().getEmail(), m.getId(), note.trim()];

  // The commission the processor kept is money you spent. Without this row
  // your revenue is understated and your processing cost is invisible.
  var fee = null;
  if (fees !== '' && fees > 0) {
    fee = [dateVal(date), month, x.channel || x.payer || 'Payment processor',
      'Commission deducted at settlement', x.doc_number || '', 'Payment Processing',
      'Business', cur, fees, toBase(fees, cur, date), '', 'Deducted from payout',
      '', gmailLink(m), Session.getEffectiveUser().getEmail(), m.getId() + '-fee',
      '', ''];
  }
  return { row: row, fee: fee };
}


/* ============================================================================
 * SECTION 6 — DOCUMENTS AND DRIVE
 * ==========================================================================*/

/** The invoice attachment if there is one, otherwise a PDF of the email itself. */
function pickDocument(m) {
  var atts = [];
  try { atts = m.getAttachments({ includeInlineImages: false }); } catch (e) {}

  var best = null;
  for (var i = 0; i < atts.length; i++) {
    var a = atts[i];
    if (a.getSize() > CONFIG.MAX_PDF_MB * 1024 * 1024) continue;
    var type = a.getContentType();
    var isPdf = type === 'application/pdf';
    var isImg = type.indexOf('image/') === 0;
    if (!isPdf && !isImg) continue;
    if (!best || (isPdf && !best.pdf)) {
      best = { name: a.getName(), type: type, pdf: isPdf,
               bytes: a.getBytes(), b64: Utilities.base64Encode(a.getBytes()) };
    }
  }
  if (best) return best;

  // no usable attachment — snapshot the email so there is still a document
  var head = '<meta charset="utf-8"><div style="font-family:Arial,sans-serif;font-size:12px;' +
    'border-bottom:1px solid #999;padding-bottom:8px;margin-bottom:12px">' +
    '<b>From:</b> ' + esc(m.getFrom()) + '<br><b>To:</b> ' + esc(m.getTo()) +
    '<br><b>Date:</b> ' + esc(String(m.getDate())) +
    '<br><b>Subject:</b> ' + esc(m.getSubject()) + '</div>';
  var blob = Utilities.newBlob(head + m.getBody(), 'text/html', 'e.html').getAs('application/pdf');
  return { name: 'email.pdf', type: 'application/pdf', pdf: true,
           bytes: blob.getBytes(), b64: Utilities.base64Encode(blob.getBytes()) };
}

function fileToDrive(doc, month, date, vendor, amount, currency, invoiceNo) {
  var root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  var f = subFolder(subFolder(root, month.substring(0, 4)), month);

  var name = [date, sanitize(vendor)];
  if (amount !== '' && amount !== null) name.push(fmtAmt(amount) + ' ' + currency);
  if (invoiceNo) name.push('#' + sanitize(String(invoiceNo)));
  var ext = doc.type === 'application/pdf' ? '.pdf' : '.' + (doc.type.split('/')[1] || 'bin');
  var full = name.join(' ').substring(0, 180) + ext;

  var ex = f.getFilesByName(full);
  if (ex.hasNext()) return ex.next().getUrl();

  var file = f.createFile(Utilities.newBlob(doc.bytes, doc.type, full));
  return file.getUrl();
}

function subFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}


/* ============================================================================
 * SECTION 7 — WRITING TO THE SHEET
 * ==========================================================================*/

/** In satellite mode rows go to the hub instead of a local sheet. */
function commit(expenses, incomes) {
  if (CONFIG.MODE === 'satellite') {
    var res = UrlFetchApp.fetch(CONFIG.HUB_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({
        secret: CONFIG.SHARED_SECRET, action: 'ingest',
        expenses: expenses, incomes: incomes
      })
    });
    if (res.getResponseCode() !== 200) throw new Error('hub rejected: ' + res.getContentText());
    return;
  }
  if (expenses.length) appendRows(CONFIG.TAB, HDR_EXP(), expenses);
  if (incomes.length && CONFIG.TRACK_INCOME) appendRows(CONFIG.TAB_IN, HDR_INC(), incomes);
  sortTabs();
}

function sheet(name, header) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#efefef');
    sh.setFrozenRows(1);
  }
  return sh;
}

function appendRows(name, header, rows) {
  var sh = sheet(name, header);
  var start = sh.getLastRow() + 1;
  var w = rows[0].length;
  sh.getRange(start, 1, rows.length, w).setValues(rows);
  flagReview(sh, start, rows.length, w);
}

/** Anything the model was unsure about gets the whole row painted yellow. */
function flagReview(sh, start, n, w) {
  for (var i = 0; i < n; i++) {
    var note = String(sh.getRange(start + i, w).getValue());
    if (note.indexOf('NEEDS REVIEW') === 0) {
      sh.getRange(start + i, 1, 1, w).setBackground('#fff2cc');
    }
  }
}

/** Newest first. Re-applies the yellow flags afterwards, since sorting drops them. */
function sortTabs() {
  [[CONFIG.TAB, HDR_EXP()], [CONFIG.TAB_IN, HDR_INC()]].forEach(function (pair) {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sh = ss.getSheetByName(pair[0]);
    if (!sh || sh.getLastRow() < 3) return;
    var w = pair[1].length, n = sh.getLastRow() - 1;
    sh.getRange(2, 1, n, w).sort({ column: 1, ascending: false });
    sh.getRange(2, 1, n, w).setBackground(null);
    flagReview(sh, 2, n, w);
  });
}

/** The real duplicate guard: the Gmail message id, stored in every row. */
function existingIds() {
  var out = {};
  if (CONFIG.MODE === 'satellite') {
    var res = UrlFetchApp.fetch(CONFIG.HUB_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ secret: CONFIG.SHARED_SECRET, action: 'ids' })
    });
    (JSON.parse(res.getContentText()).ids || []).forEach(function (id) { out[id] = 1; });
    return out;
  }
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  [[CONFIG.TAB, COL.EXP_ID], [CONFIG.TAB_IN, COL.INC_ID]].forEach(function (p) {
    var sh = ss.getSheetByName(p[0]);
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, p[1], sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      if (r[0]) out[String(r[0]).replace(/-fee$/, '')] = 1;
    });
  });
  return out;
}


/* ============================================================================
 * SECTION 8 — WEB APP (hub mode only)
 * ----------------------------------------------------------------------------
 * A second mailbox cannot be read by this project, because a Google account
 * cannot read another account's Gmail. So the second account runs its own copy
 * in 'satellite' mode and posts here. Deploy this project as a web app with
 * "Execute as: me" and "Who has access: Anyone", protected by SHARED_SECRET.
 * ==========================================================================*/
function doPost(e) {
  try {
    var r = JSON.parse(e.postData.contents);
    if (!CONFIG.SHARED_SECRET || r.secret !== CONFIG.SHARED_SECRET) return json({ error: 'unauthorized' });
    switch (r.action) {
      case 'ping':   return json({ ok: true, user: Session.getEffectiveUser().getEmail() });
      case 'ids':    return json({ ids: Object.keys(existingIds()) });
      case 'status': return json(status());
      case 'ingest':
        if (r.expenses && r.expenses.length) appendRows(CONFIG.TAB, HDR_EXP(), r.expenses);
        if (r.incomes && r.incomes.length && CONFIG.TRACK_INCOME) {
          appendRows(CONFIG.TAB_IN, HDR_INC(), r.incomes);
        }
        sortTabs();
        try { syncBudgets(); } catch (err) {}
        return json({ ok: true, expenses: (r.expenses || []).length, incomes: (r.incomes || []).length });
    }
    return json({ error: 'unknown action: ' + r.action });
  } catch (err) {
    return json({ error: String(err) });
  }
}
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ============================================================================
 * SECTION 9 — BUDGET TABS
 * ----------------------------------------------------------------------------
 * Every number is a live SUMIFS against the expense tab, so the budget updates
 * itself the moment a row is written. Nothing is copied or cached.
 *
 * Columns: A label | B..M months (actual) | N total actual
 *          O ALLOCATION — you type this, a rebuild never overwrites it
 *          P variance (actual − plan) | Q % of plan
 *          T hidden machine tag read by the drill-down script.
 * ==========================================================================*/

/** Categories present in the sheet, merged with the closed list. */
function liveCatsFlat() {
  var seen = {}, i;
  for (i = 0; i < CATS.length; i++) seen[CATS[i]] = 1;
  var sh = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.TAB);
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, COL.EXP_CAT, sh.getLastRow() - 1, 1).getValues();
    for (i = 0; i < v.length; i++) {
      var s = String(v[i][0]).trim();
      if (s) seen[s] = 1;
    }
  }
  return seen;
}

function liveCats() {
  var seen = liveCatsFlat(), map = catSection(), by = {};
  SEC_ORDER.forEach(function (s) { by[s] = []; });
  Object.keys(seen).forEach(function (c) { by[map[c] || 'Unassigned'].push(c); });
  SEC_ORDER.forEach(function (s) { by[s].sort(); });
  return by;
}

/** Rebuild only if the category list changed. Numbers never need a rebuild. */
function syncBudgets() {
  var f = Object.keys(liveCatsFlat()).sort().join('|');
  var p = props();
  if (p.getProperty('CAT_FINGERPRINT') === f) return 'categories unchanged';
  buildBudgets();
  return 'category list changed, budgets rebuilt';
}

function buildBudgets() {
  CONFIG.BUDGET_YEARS.forEach(function (y) { buildBudget(y); });
  props().setProperty('CAT_FINGERPRINT', Object.keys(liveCatsFlat()).sort().join('|'));
  return 'budgets rebuilt';
}

function buildBudget(year) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var nm = 'Budget ' + year;
  var sh = ss.getSheetByName(nm) || ss.insertSheet(nm);

  // preserve anything typed into the Allocation column, keyed by row label
  var keep = {};
  if (sh.getLastRow() > 1) {
    var old = sh.getRange(1, 1, sh.getLastRow(), 15).getValues();
    for (var q = 0; q < old.length; q++) {
      var lbl = String(old[q][0]).trim(), a = old[q][14];
      if (lbl && a !== '' && a !== null && !isNaN(a)) keep[lbl] = a;
    }
  }
  sh.clear();

  var mk = [], i;
  for (i = 1; i <= 12; i++) mk.push(year + '-' + (i < 10 ? '0' + i : '' + i));
  var W = 17, EX = "'" + CONFIG.TAB + "'", IN = "'" + CONFIG.TAB_IN + "'";
  var rows = [], tags = [], bold = [], pct = [], alloc = [];

  function blank() { var r = [], k; for (k = 0; k < W; k++) r.push(''); return r; }
  function push(r, tag) { rows.push(r); tags.push(tag || ''); return rows.length; }
  function tail(r, n) {
    r[13] = '=SUM(B' + n + ':M' + n + ')';
    r[15] = '=IF(O' + n + '="","",N' + n + '-O' + n + ')';
    r[16] = '=IF(OR(O' + n + '="",O' + n + '=0),"",N' + n + '/O' + n + ')';
  }

  var t = blank();
  t[0] = 'Budget ' + year + '   ' + CONFIG.BASE_CURRENCY + '   business only';
  t[13] = 'click a number, then open the Drill-down tab';
  push(t, ''); bold.push(1);

  var h = blank();
  for (i = 0; i < 12; i++) h[i + 1] = mk[i];
  h[13] = 'Actual ' + year; h[14] = 'Allocation'; h[15] = 'Variance'; h[16] = '% of plan';
  push(h, ''); bold.push(2);

  var r = blank(); r[0] = 'Total Revenue';
  var revRow = push(r, 'rev');
  for (i = 0; i < 12; i++) {
    r[i + 1] = '=IFERROR(SUMIFS(' + IN + '!$I:$I,' + IN + '!$B:$B,"' + mk[i] + '"),0)';
  }
  r[14] = keep['Total Revenue'] === undefined ? '' : keep['Total Revenue'];
  alloc.push(revRow); tail(r, revRow); bold.push(revRow);

  var by = liveCats(), secRow = {};

  SEC_ORDER.forEach(function (sec) {
    var cats = by[sec];
    if (!cats.length) return;
    push(blank(), '');
    var hr = blank(); hr[0] = SEC_LABEL[sec];
    var sr = push(hr, 'cat|' + cats.join(';'));
    bold.push(sr);
    var first = sr + 1;

    cats.forEach(function (cat) {
      var cr = blank(); cr[0] = '      ' + cat;
      var rr = push(cr, 'cat|' + cat);
      for (var k = 0; k < 12; k++) {
        cr[k + 1] = '=SUMIFS(' + EX + '!$J:$J,' + EX + '!$B:$B,"' + mk[k] +
          '",' + EX + '!$F:$F,"' + cat + '",' + EX + '!$G:$G,"Business")';
      }
      var kk = '      ' + cat;
      cr[14] = keep[kk] === undefined ? '' : keep[kk];
      alloc.push(rr); tail(cr, rr);
    });

    var last = rows.length;
    for (var k = 0; k < 12; k++) {
      hr[k + 1] = '=SUM(' + colL(k + 2) + first + ':' + colL(k + 2) + last + ')';
    }
    hr[14] = '=SUM(O' + first + ':O' + last + ')';
    tail(hr, sr);
    secRow[sec] = sr;

    var p = blank(); p[0] = '      % of revenue';
    var pr = push(p, '');
    for (k = 0; k < 12; k++) {
      p[k + 1] = '=IFERROR(' + colL(k + 2) + sr + '/' + colL(k + 2) + revRow + ',"")';
    }
    p[13] = '=IFERROR(N' + sr + '/N' + revRow + ',"")';
    pct.push(pr);
  });

  push(blank(), '');

  var opexSecs = ['R&D', 'S&M', 'G&A', 'Unassigned'].filter(function (s) { return secRow[s]; });
  var allSecs = SEC_ORDER.filter(function (s) { return secRow[s]; });
  function catsOf(list) { var a = []; list.forEach(function (s) { a = a.concat(by[s]); }); return a; }
  function rollup(label, secs) {
    var x = blank(); x[0] = label;
    var n = push(x, 'cat|' + catsOf(secs).join(';'));
    for (var j = 0; j < 12; j++) {
      x[j + 1] = '=' + secs.map(function (s) { return colL(j + 2) + secRow[s]; }).join('+');
    }
    x[14] = '=' + secs.map(function (s) { return 'O' + secRow[s]; }).join('+');
    tail(x, n); bold.push(n);
    return n;
  }
  rollup('Total OPEX', opexSecs);
  var teR = rollup('TOTAL EXPENSES', allSecs);

  var nt = blank(); nt[0] = 'NET';
  var ntR = push(nt, '');
  for (i = 0; i < 12; i++) nt[i + 1] = '=' + colL(i + 2) + revRow + '-' + colL(i + 2) + teR;
  nt[13] = '=N' + revRow + '-N' + teR;
  nt[14] = '=IF(OR(O' + revRow + '="",O' + teR + '=""),"",O' + revRow + '-O' + teR + ')';
  nt[15] = '=IF(O' + ntR + '="","",N' + ntR + '-O' + ntR + ')';
  bold.push(ntR);

  sh.getRange(1, 1, rows.length, W).setValues(rows);
  // month keys must stay TEXT — Sheets would turn 2026-01 into a date
  sh.getRange(2, 2, 1, 12).setNumberFormat('@').setValues([mk]);
  sh.getRange(1, TAGCOL, tags.length, 1).setValues(tags.map(function (x) { return [x]; }));
  sh.getRange(3, 2, rows.length, 15).setNumberFormat('#,##0');
  sh.getRange(3, 17, rows.length, 1).setNumberFormat('0%');
  pct.forEach(function (x) { sh.getRange(x, 2, 1, 13).setNumberFormat('0.0%'); });
  bold.forEach(function (x) { sh.getRange(x, 1, 1, W).setFontWeight('bold'); });
  alloc.forEach(function (x) { sh.getRange(x, 15).setBackground('#fff9e6'); });
  sh.getRange(2, 1, 1, W).setBackground('#efefef');
  sh.getRange(teR, 1, 1, W).setBackground('#fce5cd');
  sh.getRange(ntR, 1, 1, W).setBackground('#d9ead3');
  sh.getRange(1, 15).setNote('Type your plan here. Rebuilds never overwrite this column.');
  sh.setFrozenRows(2); sh.setFrozenColumns(1); sh.setColumnWidth(1, 260);
  try { sh.hideColumns(18, 3); } catch (e) {}
  return nm + ' rebuilt';
}


/* ============================================================================
 * SECTION 10 — RECLASSIFY
 * ----------------------------------------------------------------------------
 * Re-runs ONLY the classification on rows already in the sheet: no Gmail, no
 * PDFs, no re-extraction, no Gmail quota. Run this when you change CATS or
 * BUSINESS_DESCRIPTION. Never wipe the sheet and re-scan — extraction is the
 * expensive part and it was already right.
 * ==========================================================================*/
function reclassify() {
  var sh = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.TAB);
  if (!sh || sh.getLastRow() < 2) return 'nothing to reclassify';
  var n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, 18).getValues();
  var changed = 0, suggestions = [], B = 20;

  for (var s = 0; s < n; s += B) {
    var items = [];
    for (var i = s; i < Math.min(s + B, n); i++) {
      items.push({ i: i, vendor: String(vals[i][2] || ''),
        description: String(vals[i][3] || ''), billed_to: String(vals[i][16] || ''),
        amount: vals[i][9], current_category: String(vals[i][5] || '') });
    }
    var prompt = [
      CONFIG.BUSINESS_DESCRIPTION,
      'Classify each expense below.',
      '',
      'category MUST be exactly one of this closed list:',
      CATS.join('\n'),
      '',
      'business_personal is "Business" if it belongs to the business, "Personal"',
      'if it is a private expense of the owner.',
      '',
      'If an item truly fits nothing, still pick the closest and put your proposed',
      'name in suggest_new. Never invent a category in the category field.',
      '',
      'Items:', JSON.stringify(items), '',
      'Reply with JSON only:',
      '{"rows":[{"i":0,"category":"...","business_personal":"...","suggest_new":""}]}'
    ].join('\n');

    var parsed = claude(modelSmart(), [{ type: 'text', text: prompt }], 4000);
    if (!parsed || !parsed.rows) continue;

    parsed.rows.forEach(function (row) {
      var idx = Number(row.i);
      if (!(idx >= 0 && idx < n)) return;
      var cat = String(row.category || '').trim();
      var b = String(row.business_personal || '').trim();
      if (cat && CATS.indexOf(cat) >= 0 && cat !== vals[idx][5]) {
        sh.getRange(idx + 2, COL.EXP_CAT).setValue(cat); changed++;
      }
      if ((b === 'Business' || b === 'Personal') && b !== vals[idx][6]) {
        sh.getRange(idx + 2, COL.EXP_BP).setValue(b); changed++;
      }
      if (row.suggest_new) {
        suggestions.push(vals[idx][2] + ' -> ' + row.suggest_new);
        var note = String(vals[idx][17] || '');
        if (note.indexOf('suggested category') < 0) {
          sh.getRange(idx + 2, COL.EXP_NOTE)
            .setValue(('suggested category: ' + row.suggest_new + '. ' + note).trim());
        }
      }
    });
  }
  syncBudgets();
  var out = 'reclassified ' + n + ' rows, ' + changed + ' fields changed. suggestions: ' +
    (suggestions.length ? suggestions.join(' | ') : 'none');
  console.log(out);
  return out;
}


/* ============================================================================
 * SECTION 11 — CLAUDE
 * ==========================================================================*/
function apiKey() { return props().getProperty('ANTHROPIC_API_KEY'); }
function props() { return PropertiesService.getScriptProperties(); }

/**
 * One call. Returns the parsed JSON object the model replied with, or null.
 * Retries once on 429/5xx.
 */
function claude(model, content, maxTokens) {
  var payload = {
    model: model, max_tokens: maxTokens || 1000,
    messages: [{ role: 'user', content: content }]
  };
  for (var attempt = 0; attempt < 2; attempt++) {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload)
    });
    var code = res.getResponseCode();
    if (code === 200) {
      var body = JSON.parse(res.getContentText());
      var txt = (body.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
      var st = txt.indexOf('{'), en = txt.lastIndexOf('}');
      if (st < 0 || en <= st) return null;
      try { return JSON.parse(txt.substring(st, en + 1)); } catch (e) { return null; }
    }
    if (code === 429 || code >= 500) { Utilities.sleep(3000); continue; }
    throw new Error('Anthropic ' + code + ': ' + res.getContentText().substring(0, 300));
  }
  return null;
}


/* ============================================================================
 * SECTION 12 — SMALL HELPERS
 * ==========================================================================*/

/** Converts to BASE_CURRENCY at the rate on the charge date, with a day cache. */
function toBase(amount, currency, date) {
  if (amount === '' || amount === null || isNaN(amount)) return '';
  if (!currency || currency === CONFIG.BASE_CURRENCY) return round2(amount);
  var key = 'fx_' + currency + '_' + CONFIG.BASE_CURRENCY + '_' + date;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  var rate = hit ? Number(hit) : null;
  if (rate === null) {
    try {
      var url = 'https://api.frankfurter.app/' + date + '?from=' + currency +
        '&to=' + CONFIG.BASE_CURRENCY;
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) {
        rate = JSON.parse(r.getContentText()).rates[CONFIG.BASE_CURRENCY];
        if (rate) cache.put(key, String(rate), 21600);
      }
    } catch (e) {}
  }
  return rate ? round2(amount * rate) : '';
}

function safeCat(c) {
  c = String(c || '').trim();
  return CATS.indexOf(c) >= 0 ? c : 'Other';
}
function bp(v) { return String(v) === 'Personal' ? 'Personal' : 'Business'; }
function num(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function fmtAmt(n) { return (n === '' || n === null) ? '0.00' : Number(n).toFixed(2); }
function fmtDay(d) { return Utilities.formatDate(d, 'Etc/GMT', 'yyyy/MM/dd'); }
function dateVal(s) { return s ? new Date(s + 'T12:00:00Z') : ''; }
function sanitize(s) { return String(s).replace(/[\\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim(); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function gmailLink(m) { return 'https://mail.google.com/mail/u/0/#all/' + m.getId(); }
function attachmentNames(m) {
  try { return m.getAttachments({ includeInlineImages: false }).map(function (a) { return a.getName(); }); }
  catch (e) { return []; }
}
/** gmail-style address comparison: strips dots and +tags */
function normAddr(s) {
  var m = String(s).match(/[\w.+-]+@[\w.-]+/);
  if (!m) return '';
  var parts = m[0].toLowerCase().split('@');
  return parts[0].replace(/\./g, '').split('+')[0] + '@' + parts[1];
}
function getLabel() {
  return GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
}
function colL(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}


/* ============================================================================
 * SECTION 13 — GUARDED ENTRY POINTS
 * ----------------------------------------------------------------------------
 * Everything the scheduler calls goes through guard(), so a Gmail quota wall
 * pauses the system cleanly for the day instead of failing on a loop.
 * ========================================================================== */
function dailyRun()     { return guard(dailyRunWork); }
function backfillTick() { return guard(backfillTickWork); }
