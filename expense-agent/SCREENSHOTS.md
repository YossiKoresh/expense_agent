# Taking the three README screenshots

Three shots, about three minutes. The demo sheet is already built and sitting in
Support@lumebook.com's Drive, called **`Expense Agent - demo`**. Everything in
it is fake — Acme Ltd, Stripe, AWS, Meta, a print shop — so there is nothing to
redact.

Open it, then:

---

### 1 — `docs/01-expenses.png`

- Click the **Expenses** tab.
- Click cell **A1** so no stray cell is highlighted.
- Dismiss the "Convert to table" chip if it appears (the ✕ on it).
- Capture from the column headers (row 1) down to row 26.
  On a Mac: **Cmd+Shift+4**, drag the region.

Both highlighted rows — City Water Board and Kiro Coworking — should be in
frame. They are the point of the shot.

### 2 — `docs/02-budget.png`

- Click the **Budget 2026** tab.
- Click **A1**.
- Capture from row 1 down to the green **NET** row, and across to at least
  column N (`Actual 2026`). Wider is better if it fits.

### 3 — `docs/03-drilldown.png`

- Still on **Budget 2026**, click cell **N19** — the S&M year total, 8,786.
- Click the **Drill-down** tab.
- Capture the top ~10 rows. The header line should read
  `S&M (sales & marketing) | 2026 | 4 rows | 8,786`, matching the cell you clicked.

---

Save all three into the repo's `docs/` folder with exactly those filenames. The
README already points at them, so they will appear as soon as the files exist.

**Then delete the demo sheet** — it has served its purpose, and there is a stray
`Expense Agent - drill-down (demo)` Apps Script project attached to it that can
go too. Neither touches your live tracker.

For the LinkedIn post, shot 2 or 3 is the one to attach. Shot 3 is the more
interesting of the two: it shows the number *and* the receipts behind it, which
is the thing people do not expect a spreadsheet to do.
