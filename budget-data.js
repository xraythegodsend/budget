/* ============================================================================
   web-starter-data.js — the empty budget the hosted copy starts from.

   make-web-folder.bat puts this in the upload folder as budget-data.js, in
   place of your real one, so nothing personal goes to the web. On the phone,
   Setup → Load data file brings your numbers in; they stay on the phone.
============================================================================ */

window.BUDGET = {
  meta: {
    household:      "Budget",
    openingBalance: 0,
    payFrequency:   "weekly",
    payAnchor:      "2026-02-06"
  },
  incomes: [],
  goals:   [],
  debts:   [],
  bills:   []
};
