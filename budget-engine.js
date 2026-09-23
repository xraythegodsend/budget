/* ============================================================================
   budget-engine.js  —  all the math, shared by every draft.

   Nothing in here draws anything. It turns budget-data.js + a month into a
   model: which paychecks land when, which bills each one has to cover, what's
   left over, and what the bank balance does day by day.
============================================================================ */

(function (global) {
  "use strict";

  var DAY = 86400000;

  var CADENCE_PER_YEAR = {
    weekly: 52, biweekly: 26, semimonthly: 24,
    monthly: 12, quarterly: 4, semiannual: 2, annual: 1
  };

  var PAY_PER_YEAR = {
    weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12
  };

  // Fixed category order. Colors are assigned by this index and never cycled.
  var CATEGORIES = [
    "Giving", "Saving", "Housing", "Transportation",
    "Food", "Clothing", "Debt", "Personal"
  ];

  // ---------------------------------------------------------------- dates ---
  // Everything is UTC so a timezone never shifts a due date by a day.

  function parseISO(s) {
    var p = String(s).split("-");
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }
  function toISO(d) {
    return d.toISOString().slice(0, 10);
  }
  function addDays(d, n) {
    return new Date(d.getTime() + n * DAY);
  }
  function addMonths(d, n) {
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    var last = daysInMonth(y + Math.floor(m / 12), ((m % 12) + 12) % 12);
    return new Date(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, Math.min(day, last)));
  }
  function daysInMonth(y, m) {           // m is 0-based
    return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  }
  function sameDay(a, b) {
    return a.getTime() === b.getTime();
  }
  function fmtDate(d, opts) {
    return d.toLocaleDateString("en-US", Object.assign({ timeZone: "UTC" }, opts || { month: "short", day: "numeric" }));
  }

  // ------------------------------------------------------------ paychecks ---

  function baseDatesBetween(meta, start, end) {
    var freq = meta.payFrequency || "weekly";
    var anchor = parseISO(meta.payAnchor);
    var out = [];

    if (freq === "weekly" || freq === "biweekly") {
      var step = freq === "weekly" ? 7 : 14;
      var offset = Math.round((start - anchor) / DAY);
      var d = addDays(anchor, Math.ceil(offset / step) * step);
      while (d <= end) { out.push(d); d = addDays(d, step); }

    } else if (freq === "semimonthly") {
      var c = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      while (c <= end) {
        [1, 15].forEach(function (day) {
          var p = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), day));
          if (p >= start && p <= end) out.push(p);
        });
        c = addMonths(c, 1);
      }

    } else { // monthly
      var day = anchor.getUTCDate();
      var cm = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      while (cm <= end) {
        var p2 = new Date(Date.UTC(cm.getUTCFullYear(), cm.getUTCMonth(),
          Math.min(day, daysInMonth(cm.getUTCFullYear(), cm.getUTCMonth()))));
        if (p2 >= start && p2 <= end) out.push(p2);
        cm = addMonths(cm, 1);
      }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  // ------------------------------------------------------ moving a column ---
  // Each pay week can sit on a weekday of its own — meta.weekDays maps the
  // week's own scheduled date to the weekday you moved it to. The scheduled
  // date stays the week's identity, so amounts you typed and bills you ticked
  // stay attached to the column rather than to whatever date is showing.

  function payShift(meta, baseDate) {
    var wd = meta.weekDays && meta.weekDays[toISO(baseDate)];
    if (wd === undefined || wd === null) return 0;
    var n = +wd - baseDate.getUTCDay();
    return (n >= -6 && n <= 6) ? n : 0;
  }

  // [{ key, base, date }] — key and base are the schedule, date is where the
  // column actually sits after any move.
  function paySchedule(meta, start, end) {
    var out = [];
    // widen the search: a column near a boundary can be nudged in or out of it
    baseDatesBetween(meta, addDays(start, -7), addDays(end, 7)).forEach(function (b) {
      var d = addDays(b, payShift(meta, b));
      if (d >= start && d <= end) out.push({ key: toISO(b), base: b, date: d });
    });
    out.sort(function (a, b) { return a.date - b.date; });
    return out;
  }

  function paychecksBetween(meta, start, end) {
    return paySchedule(meta, start, end).map(function (p) { return p.date; });
  }

  // -------------------------------------------------- bill/income schedule ---

  // INCOME rides the paycheck schedule — money arrives when you're paid.
  function occurrences(item, start, end, paycheckDates) {
    var cad = item.cadence || "monthly";
    var out = [];

    if (cad === "weekly" || cad === "biweekly") {
      var every = cad === "biweekly" ? 2 : 1;
      paycheckDates.forEach(function (d, i) { if (i % every === 0) out.push(d); });
      return out;
    }

    var day = item.dueDay || 1;
    var c = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (c <= end) {
      var y = c.getUTCFullYear(), m = c.getUTCMonth();
      var d1 = new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m))));
      if (d1 >= start && d1 <= end) out.push(d1);
      c = addMonths(c, 1);
    }
    return out;
  }

  // ------------------------------------------------------------ due dates ---
  // BILLS do not ride the paycheck schedule. Every bill carries one absolute
  // anchor date — `dueDate` — and its later due dates step from that anchor by
  // its own frequency. A weekly bill anchored to a Tuesday is due on Tuesdays,
  // whether or not you're paid on Fridays. Nothing here consults the paychecks.

  var STEP_DAYS   = { weekly: 7, biweekly: 14 };
  var STEP_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

  // Tolerates older data that only had a day-of-month.
  function dueAnchor(bill) {
    if (bill.dueDate) return parseISO(bill.dueDate);
    if (bill.firstDue) return parseISO(bill.firstDue);
    var day = bill.dueDay || 1;
    return new Date(Date.UTC(2026, 0, Math.min(day, 31)));
  }

  // Every date this bill is actually due, inside [start, end].
  function dueDates(bill, start, end) {
    var anchor = dueAnchor(bill);
    var cad = bill.cadence || "monthly";
    var out = [];
    var k, d;

    if (STEP_DAYS[cad]) {
      var step = STEP_DAYS[cad];
      k = Math.floor((start - anchor) / (DAY * step));
      d = addDays(anchor, k * step);
      while (d < start) { k++; d = addDays(anchor, k * step); }
      while (d <= end) { out.push(d); k++; d = addDays(anchor, k * step); }
      return out;
    }

    // Always step from the anchor, never from the last result — otherwise a
    // bill due the 31st would clamp to Feb 28 and then stay on the 28th.
    var stepM = STEP_MONTHS[cad] || 1;
    var months = (start.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
                 (start.getUTCMonth() - anchor.getUTCMonth());
    k = Math.floor(months / stepM) - 1;
    d = addMonths(anchor, k * stepM);
    while (d < start) { k++; d = addMonths(anchor, k * stepM); }
    while (d <= end) { out.push(d); k++; d = addMonths(anchor, k * stepM); }
    return out;
  }

  // ------------------------------------------------ what a paycheck gives ---
  // The single source of truth for "how much does this paycheck put toward this
  // bill". autoAmounts is the suggestion; plannedAmount lets anything typed into
  // the grid override it. Both the month builder and the funding check go
  // through here, so a number you type is reflected everywhere.

  function autoAmounts(bill, meta, pcs, dates) {
    var out = [], i;
    for (i = 0; i < pcs.length; i++) out.push(0);
    var mode = bill.mode || "spread";

    if (mode === "spread") {
      var slice = perPaycheck(bill, meta, pcs.length);
      for (i = 0; i < pcs.length; i++) out[i] = slice;
      return out;
    }

    if (mode === "pick") {
      var pi = Math.min(bill.payIndex || 0, pcs.length - 1);
      if (pi >= 0) out[pi] = dates.length * bill.amount;
      return out;
    }

    // "due": the last paycheck on or before each due date carries it
    dates.forEach(function (d) {
      var best = -1;
      pcs.forEach(function (pd, k) { if (pd <= d) best = k; });
      if (best < 0) best = 0;
      if (pcs.length) out[best] += bill.amount;
    });
    return out;
  }

  // Same idea for income: a suggestion per paycheck, which anything typed into
  // the income grid overrides.
  function autoIncome(inc, meta, payDates, monthStart, monthEnd) {
    var out = [], i;
    for (i = 0; i < payDates.length; i++) out.push(0);
    var cad = inc.cadence || "weekly";

    if (cad === "weekly") {
      for (i = 0; i < out.length; i++) out[i] = inc.amount;
      return out;
    }
    if (cad === "biweekly") {
      for (i = 0; i < out.length; i += 2) out[i] = inc.amount;
      return out;
    }

    // monthly: lands on the first paycheck on or after its nominal day
    occurrences(inc, monthStart, monthEnd, payDates).forEach(function (d) {
      var best = -1;
      payDates.forEach(function (pd, k) { if (best < 0 && pd >= d) best = k; });
      if (best < 0) best = payDates.length - 1;
      if (best >= 0) out[best] += inc.amount;
    });
    return out;
  }

  function plannedAmount(bill, meta, entry) {
    var typed = bill.plan ? bill.plan[entry.key] : undefined;
    if (typed !== undefined && typed !== null && typed !== "") return parseFloat(typed) || 0;

    var y = entry.date.getUTCFullYear(), mo = entry.date.getUTCMonth();
    var ms = new Date(Date.UTC(y, mo, 1));
    var me = new Date(Date.UTC(y, mo, daysInMonth(y, mo)));
    var sched = paySchedule(meta, ms, me);
    var idx = -1;
    sched.forEach(function (e, k) { if (e.key === entry.key) idx = k; });
    if (idx < 0) return 0;
    var dates = sched.map(function (e) { return e.date; });
    return autoAmounts(bill, meta, dates, dueDates(bill, ms, me))[idx];
  }

  // What this bill actually costs inside one month, and when it first lands.
  function monthNeed(bill, monthStart, monthEnd) {
    var occ = dueDates(bill, monthStart, monthEnd);
    return { count: occ.length, total: occ.length * bill.amount, first: occ[0] || null, dates: occ };
  }

  function prevDue(bill, due) {
    var cad = bill.cadence || "monthly";
    if (STEP_DAYS[cad]) return addDays(due, -STEP_DAYS[cad]);
    return addMonths(due, -(STEP_MONTHS[cad] || 1));
  }

  // Does this bill arrive at least as often as the paycheck? Those are already
  // per-paycheck sized; the rarer, lumpier ones are what a paycheck has to carry.
  function isFrequent(bill, meta) {
    return (CADENCE_PER_YEAR[bill.cadence] || 12) >=
           (PAY_PER_YEAR[meta.payFrequency || "weekly"] || 52);
  }

  // How much to hold back from ONE paycheck for a spread bill: this month's
  // cost split over this month's paychecks, so every row lands exactly on its
  // bill — what a spreadsheet does.
  function perPaycheck(item, meta, paychecksThisMonth) {
    var cpy = CADENCE_PER_YEAR[item.cadence] || 12;
    var ppy = PAY_PER_YEAR[meta.payFrequency || "weekly"] || 52;

    // Bills that arrive at least as often as the paycheck are already
    // per-paycheck sized — nothing to split.
    if (cpy >= ppy) return item.amount * cpy / ppy;

    return (item.amount * cpy / 12) / (paychecksThisMonth || 1);
  }

  function monthlyEquivalent(item) {
    return item.amount * (CADENCE_PER_YEAR[item.cadence] || 12) / 12;
  }

  // ------------------------------------------------------------- the model ---

  function buildMonth(budget, monthKey) {
    var meta = budget.meta;
    var parts = monthKey.split("-");
    var year = +parts[0], mon = +parts[1] - 1;

    var monthStart = new Date(Date.UTC(year, mon, 1));
    var monthEnd = new Date(Date.UTC(year, mon, daysInMonth(year, mon)));

    var sched = paySchedule(meta, monthStart, monthEnd);
    var payDates = sched.map(function (e) { return e.date; });
    var n = payDates.length;

    var activeBills = budget.bills.filter(function (b) { return b.active !== false; });
    var activeIncome = budget.incomes.filter(function (i) { return i.active !== false; });

    var paychecks = sched.map(function (e, i) {
      var d = e.date;
      return {
        // `key` is the column's identity and never moves; `iso`/`date` are
        // where it currently sits.
        index: i, date: d, iso: toISO(d), key: e.key, base: e.base,
        moved: e.key !== toISO(d),
        label: fmtDate(d),
        income: [], incomeTotal: 0,
        allocations: [], outTotal: 0,
        covers: [],                    // bill due dates this paycheck is responsible for
        startCarry: 0, net: 0, endCarry: 0
      };
    });

    // ---- income -----------------------------------------------------------
    activeIncome.forEach(function (inc) {
      var auto = autoIncome(inc, meta, payDates, monthStart, monthEnd);
      paychecks.forEach(function (pc, i) {
        var typed = inc.plan ? inc.plan[pc.key] : undefined;
        var manual = (typed !== undefined && typed !== null && typed !== "");
        var amount = manual ? (parseFloat(typed) || 0) : auto[i];
        pc.income.push({
          name: inc.name, amount: amount, source: inc,
          auto: auto[i], manual: manual
        });
        pc.incomeTotal += amount;
      });
    });

    // ---- bills ------------------------------------------------------------
    var billEvents = [];               // real cash-out dates, for the calendar

    activeBills.forEach(function (bill) {
      var dates = dueDates(bill, monthStart, monthEnd);
      var frequent = isFrequent(bill, meta);

      dates.forEach(function (d) {
        billEvents.push({
          date: d, iso: toISO(d), name: bill.name, amount: bill.amount,
          category: bill.category, bill: bill, frequent: frequent
        });
      });

      // ---- what each paycheck puts toward this bill ----
      // First work out the suggestion, then let anything typed into the grid
      // (bill.plan, keyed by the paycheck's date) replace it outright.

      var mode = bill.mode || "spread";
      var auto = autoAmounts(bill, meta, payDates, dates);

      paychecks.forEach(function (pc, i) {
        var typed = bill.plan ? bill.plan[pc.key] : undefined;
        var manual = (typed !== undefined && typed !== null && typed !== "");
        var amount = manual ? (parseFloat(typed) || 0) : auto[i];

        // Whether the money lands in time is a per-cycle question, not a
        // per-paycheck one — a contribution after the due date is funding the
        // NEXT one, not arriving late. fundingCheck() is what answers it.
        pc.allocations.push({
          bill: bill, name: bill.name, amount: amount,
          kind: manual ? "manual" : mode, auto: auto[i], manual: manual
        });
        pc.outTotal += amount;
      });

      // The card's "landing before the next paycheck" list is for the lumpy
      // bills a paycheck has to carry. A weekly bill's slice already equals
      // the bill, so listing it twice on the card adds nothing.
      dates.forEach(function (d) {
        if (frequent && mode === "spread") return;
        var pc = nearestPaycheck(paychecks, d, "onOrBefore") || paychecks[0];
        if (pc) pc.covers.push({ bill: bill, date: d, amount: bill.amount });
      });
    });

    // ---- carry-forward chain ---------------------------------------------
    var carry = meta.openingBalance || 0;
    paychecks.forEach(function (pc) {
      pc.startCarry = carry;
      pc.net = pc.incomeTotal - pc.outTotal;
      pc.endCarry = carry + pc.net;
      carry = pc.endCarry;
    });

    // ---- category rollup --------------------------------------------------
    var byCategory = {};
    CATEGORIES.forEach(function (c) { byCategory[c] = 0; });
    activeBills.forEach(function (b) {
      var cat = b.category || "Personal";
      if (!(cat in byCategory)) byCategory[cat] = 0;
      byCategory[cat] += monthlyEquivalent(b);
    });

    // ---- daily balance runway --------------------------------------------
    var runway = [];
    var bal = meta.openingBalance || 0;
    for (var day = 1; day <= daysInMonth(year, mon); day++) {
      var d = new Date(Date.UTC(year, mon, day));
      var inflow = 0, outflow = 0, events = [];

      paychecks.forEach(function (pc) {
        if (sameDay(pc.date, d)) {
          inflow += pc.incomeTotal;
          if (pc.incomeTotal) events.push({ type: "income", label: "Paycheck", amount: pc.incomeTotal });
        }
      });
      billEvents.forEach(function (ev) {
        if (sameDay(ev.date, d)) {
          outflow += ev.amount;
          events.push({ type: "bill", label: ev.name, amount: ev.amount, category: ev.category });
        }
      });

      bal += inflow - outflow;
      runway.push({ day: day, date: d, iso: toISO(d), inflow: inflow, outflow: outflow, balance: bal, events: events });
    }

    var monthIncome = paychecks.reduce(function (s, p) { return s + p.incomeTotal; }, 0);
    var monthOut = paychecks.reduce(function (s, p) { return s + p.outTotal; }, 0);

    return {
      year: year, month: mon, monthKey: monthKey,
      label: monthStart.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" }),
      monthStart: monthStart, monthEnd: monthEnd, daysInMonth: daysInMonth(year, mon),
      paychecks: paychecks, paycheckCount: n,
      billEvents: billEvents.sort(function (a, b) { return a.date - b.date; }),
      byCategory: byCategory,
      runway: runway,
      lowestBalance: runway.reduce(function (m, r) { return Math.min(m, r.balance); }, Infinity),
      monthIncome: monthIncome, monthOut: monthOut, monthNet: monthIncome - monthOut,
      perPaycheckIncome: n ? monthIncome / n : 0,
      perPaycheckOut: n ? monthOut / n : 0,
      breakEven: n ? monthOut / n : 0
    };
  }

  // -------------------------------------------------------- funding check ---
  // "Will the money actually be there when this bill lands?"
  //
  // Looks at one funding cycle — from the bill's previous occurrence up to and
  // including its due date — and adds up everything held back over that stretch.
  // The slice is recomputed per paycheck, because on the month-by-month setting
  // a 5-paycheck month holds back less each time than a 4-paycheck one.

  function fundingCheck(bill, meta, monthKey) {
    var p = monthKey.split("-");
    var year = +p[0], mon = +p[1] - 1;
    var monthStart = new Date(Date.UTC(year, mon, 1));
    var monthEnd = new Date(Date.UTC(year, mon, daysInMonth(year, mon)));

    var occ = dueDates(bill, monthStart, monthEnd);
    if (!occ.length) return null;

    var worst = null;

    // A weekly bill is due several times in a month. Report the tightest one.
    occ.forEach(function (due) {
      var cycle = paySchedule(meta, addDays(prevDue(bill, due), 1), due);
      var funded = 0;

      cycle.forEach(function (e) {
        funded += plannedAmount(bill, meta, e);
      });

      var r = {
        due: due, amount: bill.amount, funded: funded,
        covered: funded >= bill.amount - 0.005,
        shortfall: bill.amount - funded,
        cycleChecks: cycle.length,
        occurrences: occ.length
      };
      if (!worst || r.shortfall > worst.shortfall) worst = r;
    });

    return worst;
  }

  function nearestPaycheck(paychecks, date, dir) {
    var best = null;
    paychecks.forEach(function (pc) {
      if (dir === "onOrBefore") {
        if (pc.date <= date && (!best || pc.date > best.date)) best = pc;
      } else {
        if (pc.date >= date && (!best || pc.date < best.date)) best = pc;
      }
    });
    return best;
  }

  // --------------------------------------------------------- paying it off ---
  // How long a balance takes to clear at a fixed monthly payment. With an APR
  // this is the standard amortisation count; without one it's just division.
  // Returns Infinity when the payment never gets ahead of the interest.

  function payoffMonths(owed, payment, apr) {
    if (!(owed > 0)) return 0;
    if (!(payment > 0)) return Infinity;
    var r = (apr || 0) / 100 / 12;
    if (r <= 0) return Math.ceil(owed / payment);
    if (payment <= owed * r) return Infinity;
    return Math.ceil(-Math.log(1 - r * owed / payment) / Math.log(1 + r));
  }

  // Roughly what the interest costs you over that run.
  function payoffInterest(owed, payment, apr) {
    var n = payoffMonths(owed, payment, apr);
    if (!isFinite(n)) return Infinity;
    return Math.max(0, n * payment - owed);
  }

  function payoffDate(owed, payment, apr, from) {
    var n = payoffMonths(owed, payment, apr);
    if (!isFinite(n)) return null;
    return addMonths(from || todayUTC(), n);
  }

  // ------------------------------------------------------------- helpers ----

  function money(n, opts) {
    var o = opts || {};
    var v = Math.abs(n);
    var s = "$" + v.toLocaleString("en-US", {
      minimumFractionDigits: o.cents === false ? 0 : 2,
      maximumFractionDigits: o.cents === false ? 0 : 2
    });
    if (n < 0) s = (o.paren ? "(" + s + ")" : "−" + s);
    else if (o.sign && n > 0) s = "+" + s;
    return s;
  }

  function ordinal(n) {
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // "Now", read off the local clock, then expressed in the UTC terms the rest
  // of the engine works in — so today's date lines up with the calendar cells.
  function todayUTC() {
    var d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  function monthShift(monthKey, delta) {
    var p = monthKey.split("-"), y = +p[0], m = +p[1] - 1 + delta;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + "-" + String(m + 1).padStart(2, "0");
  }

  global.BudgetEngine = {
    CATEGORIES: CATEGORIES,
    CADENCE_PER_YEAR: CADENCE_PER_YEAR,
    PAY_PER_YEAR: PAY_PER_YEAR,
    buildMonth: buildMonth,
    fundingCheck: fundingCheck,
    plannedAmount: plannedAmount,
    perPaycheck: perPaycheck,
    monthlyEquivalent: monthlyEquivalent,
    occurrences: occurrences,
    dueDates: dueDates, dueAnchor: dueAnchor, prevDue: prevDue, isFrequent: isFrequent,
    monthNeed: monthNeed,
    paychecksBetween: paychecksBetween, paySchedule: paySchedule, payShift: payShift,
    parseISO: parseISO, toISO: toISO, addDays: addDays, addMonths: addMonths,
    daysInMonth: daysInMonth, fmtDate: fmtDate,
    money: money, ordinal: ordinal, monthShift: monthShift,
    payoffMonths: payoffMonths, payoffInterest: payoffInterest, payoffDate: payoffDate,
    todayUTC: todayUTC, todayKey: todayKey
  };

})(window);
