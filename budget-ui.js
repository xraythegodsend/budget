/* ============================================================================
   budget-ui.js — shared widgets the drafts assemble in different ways.
   Theme, state, income/bill editors, paycheck cards, calendar, runway chart.
============================================================================ */

(function (global) {
  "use strict";

  var E = global.BudgetEngine;
  var STORE = "budget-tool-state-v2";

  // ------------------------------------------------------------- state -----

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Once you've edited anything, your working copy wins outright — otherwise a
  // bill you deleted would come back from the file every reload. "Reset edits"
  // throws the working copy away and returns to budget-data.js.
  function loadState() {
    var base = clone(global.BUDGET);
    try {
      var saved = localStorage.getItem(STORE);
      if (saved) {
        var s = JSON.parse(saved);
        if (s && s.bills && s.incomes) {
          s.meta = Object.assign(clone(base.meta), s.meta || {});
          if (!Array.isArray(s.debts)) s.debts = clone(base.debts || []);
          if (!Array.isArray(s.goals)) s.goals = clone(base.goals || []);
          // edits made before this was tracked: known to differ, origin unknown
          if (!s.meta.source) s.meta.source = { name: "budget-data.js", verb: "loaded", dirty: true };
          return openOnToday(s);
        }
      }
    } catch (err) { /* corrupt storage: fall back to the file */ }
    base.meta.source = { name: "budget-data.js", verb: "loaded", at: null, dirty: false };
    return openOnToday(base);
  }

  // Which month you were last looking at isn't worth remembering — opening the
  // budget should show the month you're actually in. Moving around inside a
  // session still works; it just doesn't stick.
  function openOnToday(state) {
    state.meta.viewMonth = E.todayKey();
    return state;
  }

  function newId(prefix, list) {
    var n = 1;
    while (list.some(function (x) { return x.id === prefix + n; })) n++;
    return prefix + n;
  }

  // Every edit marks the working copy as diverged from whatever file it came
  // from, so the toolbar can say "unsaved changes" rather than guessing.
  function saveState(state, clean) {
    if (state && state.meta) {
      if (!state.meta.source) {
        state.meta.source = { name: "budget-data.js", verb: "loaded", at: null };
      }
      state.meta.source.dirty = clean ? false : true;
    }
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (err) {}
  }

  // Records which file the data in front of you came from.
  function stampSource(state, name, verb) {
    if (!state.meta) state.meta = {};
    state.meta.source = { name: name, verb: verb, at: new Date().toISOString(), dirty: false };
    return state;
  }

  // What the toolbar shows: which save you're looking at, and whether you've
  // changed it since.
  function sourceLabel(state) {
    var s = (state && state.meta && state.meta.source) || {};
    var name = s.name || "budget-data.js";
    var when = "";
    if (s.at) {
      var d = new Date(s.at);
      var sameDay = d.toDateString() === new Date().toDateString();
      when = (s.verb || "loaded") + " " + (sameDay
        ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
    return {
      name: name,
      note: s.dirty ? "unsaved changes" : (when || "straight from the file"),
      dirty: !!s.dirty
    };
  }

  function resetState() {
    try { localStorage.removeItem(STORE); } catch (err) {}
    location.reload();
  }

  function isEdited() {
    try { return !!localStorage.getItem(STORE); } catch (err) { return false; }
  }

  // ------------------------------------------------------------- import ----
  // Reads a file you saved earlier. Accepts what this tool writes out
  // (window.BUDGET = {...}), a hand-edited budget-data.js with comments in it,
  // or plain JSON.

  var DEFAULT_META = {
    household: "Budget", openingBalance: 0, payFrequency: "weekly",
    payAnchor: "2026-02-06", viewMonth: "2026-02"
  };

  function parseBudget(text) {
    var body = String(text);

    // Skip past "window.BUDGET =" if it's there; a bare JSON file has no prefix.
    var at = body.indexOf("window.BUDGET");
    if (at >= 0) {
      var eq = body.indexOf("=", at);
      if (eq < 0) return { ok: false, error: "That file looks cut off." };
      body = body.slice(eq + 1);
    }
    body = body.trim().replace(/;\s*$/, "");
    if (!body) return { ok: false, error: "That file is empty." };

    var data = null;
    try {
      data = JSON.parse(body);
    } catch (err) {
      // A hand-edited budget-data.js has comments and unquoted keys, which
      // JSON.parse won't take. It's a local file you picked yourself, so read
      // it as the JavaScript object literal it is.
      try {
        data = (new Function("return (" + body + ");"))();
      } catch (err2) {
        return { ok: false, error: "Couldn't read that file — it isn't a budget file." };
      }
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Couldn't read that file — it isn't a budget file." };
    }
    if (!Array.isArray(data.bills) || !Array.isArray(data.incomes)) {
      return { ok: false, error: "No bills or income in that file." };
    }
    return { ok: true, data: normalizeState(data) };
  }

  // Fill in anything an older or partial file is missing, and guarantee the
  // unique ids the grids key their cells off.
  function normalizeState(data) {
    var used = {};
    function idFor(want, prefix, i) {
      var id = want && !used[want] ? want : prefix + (i + 1);
      while (used[id]) id = prefix + (++i + 1);
      used[id] = true;
      return id;
    }

    var out = { meta: {}, incomes: [], bills: [], debts: [], goals: [] };
    Object.keys(DEFAULT_META).forEach(function (k) { out.meta[k] = DEFAULT_META[k]; });
    Object.keys(data.meta || {}).forEach(function (k) { out.meta[k] = data.meta[k]; });

    data.incomes.forEach(function (x, i) {
      var row = {};
      Object.keys(x || {}).forEach(function (k) { row[k] = x[k]; });
      row.id = idFor(row.id, "inc-", i);
      if (typeof row.name !== "string") row.name = "Income";
      if (typeof row.amount !== "number") row.amount = parseFloat(row.amount) || 0;
      if (!row.cadence) row.cadence = "weekly";
      if (row.active === undefined) row.active = true;
      out.incomes.push(row);
    });

    used = {};
    data.bills.forEach(function (x, i) {
      var row = {};
      Object.keys(x || {}).forEach(function (k) { row[k] = x[k]; });
      row.id = idFor(row.id, "b-", i);
      if (typeof row.name !== "string") row.name = "Bill";
      if (typeof row.amount !== "number") row.amount = parseFloat(row.amount) || 0;
      if (!row.cadence) row.cadence = "monthly";
      if (E.CATEGORIES.indexOf(row.category) < 0) row.category = "Personal";
      if (!row.mode) row.mode = "spread";
      if (row.active === undefined) row.active = true;
      // dueDate may be absent on older files — the engine falls back to dueDay.
      out.bills.push(row);
    });

    used = {};
    (data.debts || []).forEach(function (x, i) {
      var row = {};
      Object.keys(x || {}).forEach(function (k) { row[k] = x[k]; });
      row.id = idFor(row.id, "d-", i);
      if (typeof row.name !== "string") row.name = "Debt";
      ["startedAt", "owed", "payment", "apr"].forEach(function (k) {
        if (typeof row[k] !== "number") row[k] = parseFloat(row[k]) || 0;
      });
      if (!row.startedAt) row.startedAt = row.owed;
      if (row.active === undefined) row.active = true;
      out.debts.push(row);
    });

    used = {};
    (data.goals || []).forEach(function (x, i) {
      var row = {};
      Object.keys(x || {}).forEach(function (k) { row[k] = x[k]; });
      row.id = idFor(row.id, "g-", i);
      if (typeof row.name !== "string") row.name = "Goal";
      ["target", "saved", "contribution"].forEach(function (k) {
        if (typeof row[k] !== "number") row[k] = parseFloat(row[k]) || 0;
      });
      if (row.active === undefined) row.active = true;
      out.goals.push(row);
    });

    return out;
  }

  function readBudgetFile(file, done) {
    var r = new FileReader();
    r.onload = function () { done(parseBudget(r.result)); };
    r.onerror = function () { done({ ok: false, error: "Couldn't open that file." }); };
    r.readAsText(file);
  }

  // Serialize the working state back into a drop-in budget-data.js.
  // `done` runs once it's actually saved, which on a phone can be a moment later.
  function downloadDataFile(state, done) {
    var lines = [];
    lines.push("/* budget-data.js — exported " + new Date().toLocaleString() + " */");
    lines.push("window.BUDGET = " + JSON.stringify(state, null, 2) + ";");
    var text = lines.join("\n");

    function saved() {
      stampSource(state, "budget-data.js", "saved");
      saveState(state, true);
      if (done) done();
    }

    // An iPhone won't reliably download a file from a Home Screen app, so on
    // a touch screen hand it to the share sheet instead — "Save to Files" is
    // in there. Backing out of the sheet doesn't count as saved.
    if (isTouchScreen() && navigator.canShare) {
      var file = new File([text], "budget-data.js", { type: "text/plain" });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file] }).then(saved, function () {});
        return;
      }
    }

    var blob = new Blob([text], { type: "text/javascript" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "budget-data.js";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    saved();
  }

  function isTouchScreen() {
    return !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  }

  // ------------------------------------------------------------- theme -----

  function initTheme(btn) {
    var saved = null;
    try { saved = localStorage.getItem("budget-theme"); } catch (err) {}
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    if (!btn) return;
    function paint() {
      var t = document.documentElement.getAttribute("data-theme");
      btn.textContent = t === "dark" ? "Light" : "Dark";
    }
    paint();
    btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("budget-theme", next); } catch (err) {}
      paint();
      document.dispatchEvent(new CustomEvent("themechange"));
    });
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function catColor(category) {
    var i = E.CATEGORIES.indexOf(category);
    return "var(--s" + ((i < 0 ? 7 : i) + 1) + ")";
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ------------------------------------------------------- money fields ----
  // Typed as plain text, not <input type="number">. A number input reports an
  // empty value halfway through "1700." in Chrome, which wiped the field on the
  // very keystroke that started a decimal — and it drags spinner arrows along.
  // Text + our own parsing lets you type freely, and the box shows $1,700.00
  // whenever you're not in it.

  function parseMoney(s) {
    if (s === null || s === undefined) return null;
    var t = String(s).replace(/[$,\s]/g, "");
    if (t === "") return null;                       // cleared
    if (t === "." || t === "-" || t === "-.") return 0;   // mid-typing
    var v = parseFloat(t);
    return isNaN(v) ? null : v;
  }

  function moneyText(v) {
    if (v === null || v === undefined) return "";
    var s = "$" + Math.abs(v).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? "-" + s : s;
  }

  // Editing shows the bare number so the caret never has to step over a comma;
  // leaving the field puts the money formatting back.
  function moneyField(fkey, value, onValue, opts) {
    opts = opts || {};
    var i = el("input", "money" + (opts.cls ? " " + opts.cls : ""));
    i.type = "text";
    i.setAttribute("inputmode", "decimal");
    i.setAttribute("autocomplete", "off");
    if (fkey) i.setAttribute("data-fkey", fkey);
    i.value = moneyText(value === undefined ? null : value);
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.title) i.title = opts.title;

    i.onfocus = function () {
      var v = parseMoney(i.value);
      i.value = (v === null) ? "" : String(v);
      i.select();
    };
    i.oninput = function () { onValue(parseMoney(i.value), i); };
    i.onblur = function () { i.value = moneyText(parseMoney(i.value)); };
    return i;
  }

  function cadenceLabel(item) {
    var c = item.cadence;
    if (c === "weekly") return "every paycheck";
    if (c === "biweekly") return "every other paycheck";
    if (item.dueDay) return c + ", due the " + E.ordinal(item.dueDay);
    return c;
  }

  // ------------------------------------------------------- month toolbar ---

  function monthNav(container, state, rerender) {
    container.innerHTML = "";
    var nav = el("div", "monthnav");
    var prev = el("button", "icon", "‹");
    var label = el("span", "m");
    var next = el("button", "icon", "›");
    var today = el("button", "ghost small", "Today");
    prev.title = "Previous month"; next.title = "Next month";

    function monthName(key) {
      var p = key.split("-");
      return new Date(Date.UTC(+p[0], +p[1] - 1, 1))
        .toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
    }

    function paint() {
      label.textContent = monthName(state.meta.viewMonth);
      today.hidden = (state.meta.viewMonth === E.todayKey());
      today.title = "Back to " + monthName(E.todayKey());
    }
    function go(key) { state.meta.viewMonth = key; saveState(state); paint(); rerender(); }

    prev.onclick = function () { go(E.monthShift(state.meta.viewMonth, -1)); };
    next.onclick = function () { go(E.monthShift(state.meta.viewMonth, 1)); };
    today.onclick = function () { go(E.todayKey()); };

    paint();
    nav.append(prev, label, next, today);
    container.append(nav);
  }

  // Which days the week columns fall on. Pick a frequency and one real payday;
  // every other one is counted from it, so the weekday follows the date.
  function paydayControl(state, rerender) {
    var grp = el("div", "grp");
    grp.append(el("label", null, "Payday"));

    var freq = el("select");
    [["weekly", "Every week"], ["biweekly", "Every 2 weeks"],
     ["semimonthly", "1st & 15th"], ["monthly", "Once a month"]].forEach(function (f) {
      var o = el("option", null, f[1]); o.value = f[0];
      if ((state.meta.payFrequency || "weekly") === f[0]) o.selected = true;
      freq.append(o);
    });
    freq.onchange = function () {
      state.meta.payFrequency = freq.value;
      delete state.meta.weekDays;      // the columns they applied to are gone
      saveState(state); rerender();
    };

    var anchor = el("input");
    anchor.type = "date";
    anchor.className = "wdate";
    anchor.value = state.meta.payAnchor;
    anchor.title = "Any real payday — the rest are counted from it";
    anchor.onchange = function () {
      if (!anchor.value) return;
      state.meta.payAnchor = anchor.value;
      delete state.meta.weekDays;      // ditto — every column just moved
      saveState(state); rerender();
    };

    var dow = el("span", "meta");
    dow.textContent = E.parseISO(state.meta.payAnchor)
      .toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" }) + "s";

    grp.append(freq, anchor);
    if (state.meta.payFrequency === "weekly" || state.meta.payFrequency === "biweekly") {
      grp.append(dow);
    }
    return grp;
  }

  // ------------------------------------------------------- income editor ---

  function renderIncomeEditor(host, state, rerender, opts) {
    opts = opts || {};
    host.innerHTML = "";
    state.incomes.forEach(function (inc) {
      var row = el("div", "rowedit" + (inc.active === false ? " off" : ""));

      var cb = el("input");
      cb.type = "checkbox"; cb.checked = inc.active !== false;
      cb.title = "Include this income";
      cb.onchange = function () { inc.active = cb.checked; saveState(state); rerender(); };

      var nmCell;
      if (opts.editable) {
        nmCell = el("input");
        nmCell.type = "text"; nmCell.value = inc.name; nmCell.className = "nm";
        nmCell.setAttribute("data-fkey", inc.id + ":iname");
        nmCell.oninput = function () { inc.name = nmCell.value; saveState(state); rerender(); };
      } else {
        nmCell = el("div", "nm");
        nmCell.append(el("div", null, inc.name));
        if (inc.note) nmCell.append(el("div", "meta", inc.note));
      }

      var amt = moneyField(inc.id + ":iamt", inc.amount, function (v) {
        inc.amount = v === null ? 0 : v;
        saveState(state); rerender();
      });

      var thirdCell;
      if (opts.editable) {
        thirdCell = el("select");
        [["weekly", "Every paycheck"], ["biweekly", "Every other paycheck"],
         ["monthly", "Once a month"]].forEach(function (c) {
          var o = el("option", null, c[1]); o.value = c[0];
          if (inc.cadence === c[0]) o.selected = true;
          thirdCell.append(o);
        });
        thirdCell.onchange = function () { inc.cadence = thirdCell.value; saveState(state); rerender(); };
      } else {
        thirdCell = el("div", "meta", cadenceLabel(inc));
      }

      var last = el("div");
      if (opts.removable) {
        var rm = el("button", "icon ghost", "✕");
        rm.title = "Remove " + inc.name;
        rm.onclick = function () {
          if (!confirm("Remove “" + inc.name + "”?")) return;
          state.incomes.splice(state.incomes.indexOf(inc), 1);
          saveState(state); rerender();
        };
        last.append(rm);
      }

      row.append(cb, nmCell, amt, thirdCell, last);
      host.append(row);
    });
  }

  // --------------------------------------------------------- bill editor ---

  function renderBillEditor(host, state, rerender) {
    host.innerHTML = "";
    var groups = {};
    state.bills.forEach(function (b) { (groups[b.category] = groups[b.category] || []).push(b); });

    var cols = el("div", "rowedit");
    cols.style.borderBottom = "1px solid var(--baseline)";
    cols.append(el("div"), el("div", "meta", "Bill"), el("div", "meta", "One bill"),
                el("div", "meta", "How often"), el("div", "meta", "How you pay it"));
    host.append(cols);

    E.CATEGORIES.forEach(function (cat) {
      if (!groups[cat]) return;
      var head = el("div", "rowedit");
      var sw = el("span", "swatch"); sw.style.background = catColor(cat);
      var lab = el("div", "nm"); lab.style.fontWeight = "600"; lab.textContent = cat;
      var box = el("div"); box.append(sw);
      head.append(box, lab, el("div"), el("div"), el("div"));
      host.append(head);

      groups[cat].forEach(function (b) {
        var row = el("div", "rowedit" + (b.active === false ? " off" : ""));

        var cb = el("input");
        cb.type = "checkbox"; cb.checked = b.active !== false;
        cb.onchange = function () { b.active = cb.checked; saveState(state); rerender(); };

        var nm = el("div", "nm");
        nm.append(el("div", null, b.name));
        if (b.note) nm.append(el("div", "meta", b.note));

        var amt = el("input");
        amt.type = "number"; amt.step = "0.01"; amt.min = "0"; amt.value = b.amount;
        amt.oninput = function () { b.amount = parseFloat(amt.value) || 0; saveState(state); rerender(); };

        var meta = el("div", "meta", cadenceLabel(b));

        var mode = el("select", "mode");
        [["spread", "Set aside weekly"], ["due", "Pay when due"]].forEach(function (o) {
          var op = el("option", null, o[1]); op.value = o[0];
          if ((b.mode || "spread") === o[0]) op.selected = true;
          mode.append(op);
        });
        mode.onchange = function () { b.mode = mode.value; saveState(state); rerender(); };

        row.append(cb, nm, amt, meta, mode);
        host.append(row);
      });
    });
  }

  // ----------------------------------------------------- the income grid ---
  // Same shape as the bill grid: a column per paycheck, and every cell is
  // yours to type in. A week where you pick up extra, or a paycheck that lands
  // light, goes straight in rather than being averaged away.

  var INCOME_CADENCES = [
    ["weekly", "Every paycheck"], ["biweekly", "Every other paycheck"],
    ["monthly", "Once a month"]
  ];

  function renderIncomeGrid(host, state, model, rerender) {
    host.innerHTML = "";
    var pcs = model.paychecks;
    var n = pcs.length;

    var cells = {};
    pcs.forEach(function (p, i) {
      p.income.forEach(function (x) {
        var row = cells[x.source.id] || (cells[x.source.id] = { amounts: [], manual: [] });
        while (row.amounts.length < n) { row.amounts.push(0); row.manual.push(false); }
        row.amounts[i] += x.amount;
        if (x.manual) row.manual[i] = true;
      });
    });

    var scroll = el("div", "tablescroll");
    var t = el("table", "gridtable");
    t.innerHTML = "<thead><tr><th></th><th>Source</th><th class='num'>Amount</th>" +
      "<th>How often</th>" +
      pcs.map(function () { return "<th class='num wk'></th>"; }).join("") +
      "<th class='num tot'>Row total</th><th></th></tr></thead>";

    var incHeads = t.querySelectorAll("thead th.wk");
    pcs.forEach(function (p, i) { incHeads[i].replaceWith(weekHead(p, state, rerender)); });

    var tb = el("tbody");
    state.incomes.forEach(function (inc) {
      var on = inc.active !== false;
      var tr = el("tr");
      if (!on) tr.className = "off";
      function cell(node, cls) { var td = el("td", cls); if (node) td.append(node); tr.append(td); return td; }

      var cb = el("input");
      cb.type = "checkbox"; cb.checked = on;
      cb.setAttribute("data-fkey", inc.id + ":on");
      cb.title = on ? "Take this income out of the budget" : "Put this income back in";
      cb.onchange = function () { inc.active = cb.checked; commit(); };
      cell(cb);

      var nm = el("input");
      nm.type = "text"; nm.value = inc.name;
      nm.setAttribute("data-fkey", inc.id + ":iname");
      nm.oninput = function () { inc.name = nm.value; commit(); };
      cell(nm);

      cell(moneyField(inc.id + ":iamt", inc.amount, function (v) {
        inc.amount = v === null ? 0 : v;
        commit();
      }), "num");

      var cad = el("select");
      cad.setAttribute("data-fkey", inc.id + ":icad");
      INCOME_CADENCES.forEach(function (c) {
        var o = el("option", null, c[1]); o.value = c[0];
        if ((inc.cadence || "weekly") === c[0]) o.selected = true;
        cad.append(o);
      });
      cad.onchange = function () { inc.cadence = cad.value; commit(); };
      cell(cad);

      var row = cells[inc.id] || { amounts: [], manual: [] };
      var total = 0;
      pcs.forEach(function (p, i) {
        var v = on ? (row.amounts[i] || 0) : 0;
        total += v;
        var wk = moneyField(inc.id + ":iwk" + i, Math.round(v * 100) / 100, function (val) {
          inc.plan = inc.plan || {};
          if (val === null) delete inc.plan[p.key];
          else inc.plan[p.key] = val;
          commit();
        }, {
          cls: "wcell",
          title: row.manual[i]
            ? "You typed this. Clear it to go back to the suggested amount."
            : "Suggested. Type over it to set your own."
        });
        if (row.manual[i]) wk.classList.add("typed");
        wk.disabled = !on;
        cell(wk, "num wk");
      });

      var tot = el("td", "num tot");
      tot.append(el("div", null, E.money(total)));
      tr.append(tot);

      var acts = el("div");
      acts.style.cssText = "display:flex;gap:4px;justify-content:flex-end";
      if (inc.plan && Object.keys(inc.plan).length) {
        var undo = el("button", "icon ghost", "↺");
        undo.title = "Clear the amounts you typed and go back to the suggested split";
        undo.onclick = function () { delete inc.plan; commit(); };
        acts.append(undo);
      }
      var rm = el("button", "icon ghost", "✕");
      rm.title = "Delete " + inc.name;
      rm.onclick = function () {
        if (!confirm("Delete “" + inc.name + "” for good? Untick it instead to just park it.")) return;
        state.incomes.splice(state.incomes.indexOf(inc), 1);
        commit();
      };
      acts.append(rm);
      cell(acts);

      tb.append(tr);
    });
    t.append(tb);

    var tf = el("tfoot");
    var rIn = el("tr", "sum");
    rIn.innerHTML = "<td></td><td>Total in</td><td colspan='2'></td>" +
      pcs.map(function (p) { return "<td class='num'>" + E.money(p.incomeTotal) + "</td>"; }).join("") +
      "<td class='num tot'>" + E.money(model.monthIncome) + "</td><td></td>";
    tf.append(rIn);
    t.append(tf);

    scroll.append(t);
    host.append(scroll);

    var add = el("button", null, "+ Add income");
    add.style.marginTop = "14px";
    add.onclick = function () {
      state.incomes.push({
        id: newId("inc-", state.incomes), name: "New income",
        amount: 0, cadence: "weekly", active: true
      });
      commit();
      setTimeout(function () {
        var all = document.querySelectorAll('[data-fkey$=":iname"]');
        var last = all[all.length - 1];
        if (last) { last.focus(); last.select(); }
      }, 0);
    };
    host.append(add);

    function commit() { saveState(state); preserveFocus(rerender); }
  }

  // ------------------------------------------ the weekly bill grid (tab 3) --
  // One row per bill, one column per paycheck — the shape of the spreadsheet.
  // The week cells are yours to type in; anything you leave alone falls back to
  // the suggested amount, so a new month is pre-filled rather than blank.

  // Re-rendering blows away focus mid-keystroke, so remember where the caret
  // was and put it back.
  function preserveFocus(fn) {
    var a = document.activeElement;
    var key = a && a.getAttribute && a.getAttribute("data-fkey");
    var raw = key ? a.value : null;
    var s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch (err) {}
    fn();
    if (!key) return;
    var n = document.querySelector('[data-fkey="' + key + '"]');
    if (!n) return;
    n.focus();
    // Put back exactly what was typed, so a half-finished "1700." survives the
    // redraw instead of snapping to the formatted value.
    if (raw !== null && n.value !== raw) n.value = raw;
    if (s !== null) { try { n.setSelectionRange(s, e); } catch (err) {} }
  }

  var CADENCES = [
    ["weekly", "Weekly"], ["biweekly", "Every 2 weeks"], ["monthly", "Monthly"],
    ["quarterly", "Quarterly"], ["semiannual", "Twice a year"], ["annual", "Yearly"]
  ];

  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // The heading of a week column: pick which day that week sits on. The column
  // keeps its identity, so nothing typed into it moves.
  function weekHead(pc, state, rerender) {
    var th = document.createElement("th");
    th.className = "num wk";
    var box = el("div", "wkpick" + (pc.moved ? " moved" : ""));

    var sel = el("select");
    sel.setAttribute("data-fkey", "week:" + pc.key);
    WEEKDAYS.forEach(function (name, dow) {
      var o = el("option", null, WEEKDAYS_SHORT[dow]);
      o.value = dow;
      if (pc.date.getUTCDay() === dow) o.selected = true;
      sel.append(o);
    });
    sel.title = "Which day of the week this column sits on";
    sel.onchange = function () {
      state.meta.weekDays = state.meta.weekDays || {};
      var base = E.parseISO(pc.key);
      if (+sel.value === base.getUTCDay()) delete state.meta.weekDays[pc.key];
      else state.meta.weekDays[pc.key] = +sel.value;
      saveState(state);
      preserveFocus(rerender);
    };

    box.append(sel, el("div", "d", E.fmtDate(pc.date)));
    th.append(box);
    return th;
  }

  // How you say when a bill is due. A weekly bill doesn't have a date — it has
  // a weekday — so asking for one would imply a particular week that doesn't
  // mean anything. Everything else keeps the real date.
  function dueField(b, commit) {
    var anchor = E.dueAnchor(b);

    if (b.cadence === "weekly") {
      var sel = el("select", "wday");
      sel.setAttribute("data-fkey", b.id + ":due");
      WEEKDAYS.forEach(function (name, i) {
        var o = el("option", null, name); o.value = i;
        if (anchor.getUTCDay() === i) o.selected = true;
        sel.append(o);
      });
      sel.title = "Which day of the week this bill comes out.";
      sel.onchange = function () {
        // Shift within the same week so the bill keeps its place in the month.
        b.dueDate = E.toISO(E.addDays(anchor, (+sel.value) - anchor.getUTCDay()));
        delete b.dueDay; delete b.firstDue;
        commit();
      };
      return sel;
    }

    var dd = el("input", "wdate");
    dd.setAttribute("data-fkey", b.id + ":due");
    dd.type = "date";
    dd.value = E.toISO(anchor);
    dd.title = "A real date it's due. Later ones step from here by the frequency.";
    dd.onchange = function () {
      if (!dd.value) return;
      b.dueDate = dd.value;
      delete b.dueDay; delete b.firstDue;
      commit();
    };
    return dd;
  }

  function renderBillGrid(host, state, model, rerender) {
    host.innerHTML = "";
    var pcs = model.paychecks;
    var n = pcs.length;

    // what each paycheck currently puts toward each bill
    var cells = {};
    pcs.forEach(function (p, i) {
      p.allocations.forEach(function (a) {
        var row = cells[a.bill.id] || (cells[a.bill.id] = { amounts: [], manual: [] });
        while (row.amounts.length < n) { row.amounts.push(0); row.manual.push(false); }
        row.amounts[i] += a.amount;
        if (a.manual) row.manual[i] = true;
      });
    });

    // What this row has to add up to this month.
    //
    // For a lumpy bill (monthly, yearly) that's simply what's due: the row must
    // reach it. For a bill that comes round at least as often as the paycheck,
    // each paycheck funds one round of it, and a calendar month can hold five
    // Sundays but only four Fridays — so the target is what the paychecks
    // themselves cover, otherwise every 5-Sunday month would cry short over a
    // week that the next month's paycheck already handles.
    function need(b) {
      var nd = E.monthNeed(b, model.monthStart, model.monthEnd);
      if (nd.count && E.isFrequent(b, state.meta)) {
        nd = { count: nd.count, dates: nd.dates, first: nd.first,
               total: n * E.perPaycheck(b, state.meta, n), perPaycheck: true };
      }
      return nd;
    }
    function rowTotal(b) {
      var r = cells[b.id];
      return r ? r.amounts.reduce(function (s, v) { return s + v; }, 0) : 0;
    }

    var live = state.bills.filter(function (b) { return b.active !== false; });
    var parked = state.bills.filter(function (b) { return b.active === false; });

    // ---- how the month is doing against what's actually due ----------------
    var checked = live.map(function (b) {
      var nd = need(b);
      var total = rowTotal(b);
      var fc = E.fundingCheck(b, state.meta, state.meta.viewMonth);
      var gap = nd.total - total;

      // "Late" means the row adds up but the money arrives after the bill.
      // A funding cycle runs due-date to due-date while the split runs
      // calendar month to calendar month, so a bill due mid-month is always a
      // fraction behind at the boundary — that's phasing, not lateness. Only
      // call it late once it's more than one contribution short.
      var slack = fc ? b.amount / Math.max(1, fc.cycleChecks) : 0;

      return {
        bill: b, need: nd, total: total, short: gap, fc: fc,
        late: gap <= 0.005 && !!fc && !fc.covered && fc.shortfall > slack + 0.005
      };
    }).filter(function (r) { return r.need.count > 0; });

    var short = checked.filter(function (r) { return r.short > 0.005; });
    var late = checked.filter(function (r) { return r.late; });
    var bad = short.length + late.length;

    var ban = el("div", "verdict " + (bad ? "critical" : "good"));
    ban.append(el("div", "ico", bad ? "!" : "✓"));
    var bd = el("div");
    bd.append(el("div", "t", bad
      ? bad + " of " + checked.length + " bills due this month need attention."
      : "All " + checked.length + " bills due this month are fully covered."));

    if (short.length) {
      bd.append(el("div", "d", "Short: " + short.map(function (r) {
        return r.bill.name + " by " + E.money(r.short);
      }).join(", ") + "."));
    }
    if (late.length) {
      bd.append(el("div", "d", "Funded late — the money lands after the bill does: " +
        late.map(function (r) { return r.bill.name; }).join(", ") + "."));
    }
    if (!bad) {
      bd.append(el("div", "d", "Every row adds up to what that bill needs, in time for the due date."));
    }
    ban.append(bd);
    host.append(ban);

    // ---- the grid ----------------------------------------------------------
    var scroll = el("div", "tablescroll");
    var t = el("table", "gridtable");

    var head = "<thead><tr>" +
      "<th></th><th>Bill</th><th>Category</th><th class='num'>Total needed</th>" +
      "<th>How often</th><th class='num'>Due</th>" +
      pcs.map(function () { return "<th class='num wk'></th>"; }).join("") +
      "<th class='num tot'>Row total</th><th></th></tr></thead>";
    t.innerHTML = head;
    var billHeads = t.querySelectorAll("thead th.wk");
    pcs.forEach(function (p, i) {
      billHeads[i].replaceWith(weekHead(p, state, rerender));
    });

    var tb = el("tbody");
    sortByCategory(live).forEach(function (b) { tb.append(billRow(b, false)); });
    t.append(tb);

    // ---- footer: out, in, left over, per week -----------------------------
    var tf = el("tfoot");

    var rOut = el("tr", "sum");
    rOut.innerHTML = "<td></td><td>Total out</td><td colspan='4'></td>" +
      pcs.map(function (p) { return "<td class='num'>" + E.money(p.outTotal) + "</td>"; }).join("") +
      "<td class='num tot'>" + E.money(model.monthOut) + "</td><td></td>";
    tf.append(rOut);

    var rIn = el("tr", "sum");
    rIn.innerHTML = "<td></td><td>Money in</td><td colspan='4'></td>" +
      pcs.map(function (p) { return "<td class='num'>" + E.money(p.incomeTotal) + "</td>"; }).join("") +
      "<td class='num tot'>" + E.money(model.monthIncome) + "</td><td></td>";
    tf.append(rIn);

    var rLeft = el("tr", "sum left");
    rLeft.innerHTML = "<td></td><td>Left over</td><td colspan='4'></td>" +
      pcs.map(function (p) {
        return "<td class='num " + (p.net < 0 ? "neg" : "pos") + "'>" + E.money(p.net) + "</td>";
      }).join("") +
      "<td class='num tot " + (model.monthNet < 0 ? "neg" : "pos") + "'>" +
      E.money(model.monthNet) + "</td><td></td>";
    tf.append(rLeft);

    t.append(tf);
    scroll.append(t);
    host.append(scroll);

    var add = el("button", "primary", "+ Add a bill");
    add.style.marginTop = "14px";
    add.onclick = function () {
      state.bills.push({
        id: newId("b-", state.bills), name: "New bill", category: "Personal",
        amount: 0, cadence: "monthly",
        dueDate: state.meta.viewMonth + "-01", mode: "spread", active: true
      });
      commit();
      setTimeout(function () {
        var all = document.querySelectorAll('[data-fkey$=":name"]');
        var last = all[all.length - 1];
        if (last) { last.focus(); last.select(); last.scrollIntoView({ block: "center" }); }
      }, 0);
    };
    host.append(add);

    // ---- parked bills ------------------------------------------------------
    if (parked.length) {
      var pw = el("div", "parked");
      pw.append(el("h3", null, "Not using right now"));
      pw.append(el("p", "hint",
        "Off the budget and out of every total. Tick one to put it back in the grid above."));

      var pt = el("table", "gridtable parkedtable");
      pt.innerHTML = "<thead><tr><th></th><th>Bill</th><th>Category</th>" +
        "<th class='num'>Total needed</th><th>How often</th>" +
        "<th class='num'>Due</th><th></th></tr></thead>";
      var ptb = el("tbody");
      sortByCategory(parked).forEach(function (b) { ptb.append(billRow(b, true)); });
      pt.append(ptb);
      var pscroll = el("div", "tablescroll");
      pscroll.append(pt);
      pw.append(pscroll);
      host.append(pw);
    }

    // ---- one row -----------------------------------------------------------
    function billRow(b, isParked) {
      var tr = el("tr");
      if (isParked) tr.className = "off";

      function cell(node, cls) { var td = el("td", cls); if (node) td.append(node); tr.append(td); return td; }
      function field(tag, fkey) { var i = el(tag); i.setAttribute("data-fkey", b.id + ":" + fkey); return i; }

      // in / out of the budget
      var cb = field("input", "on"); cb.type = "checkbox"; cb.checked = !isParked;
      cb.title = isParked ? "Put this bill back in the budget" : "Take this bill out of the budget";
      cb.onchange = function () { b.active = cb.checked; commit(); };
      cell(cb);

      // name
      var nm = field("input", "name"); nm.type = "text"; nm.value = b.name;
      nm.oninput = function () { b.name = nm.value; commit(); };
      cell(nm);

      // category
      var cat = field("select", "cat");
      E.CATEGORIES.forEach(function (c) {
        var o = el("option", null, c); o.value = c;
        if (b.category === c) o.selected = true;
        cat.append(o);
      });
      cat.onchange = function () { b.category = cat.value; commit(); };
      var swrap = el("div"); swrap.style.cssText = "display:flex;align-items:center;gap:6px";
      var sw = el("span", "swatch"); sw.style.background = catColor(b.category);
      swrap.append(sw, cat);
      cell(swrap);

      // total needed — one occurrence of the bill
      cell(moneyField(b.id + ":amt", b.amount, function (v) {
        b.amount = v === null ? 0 : v;
        commit();
      }), "num");

      // how often
      var cad = field("select", "cad");
      CADENCES.forEach(function (c) {
        var o = el("option", null, c[1]); o.value = c[0];
        if (b.cadence === c[0]) o.selected = true;
        cad.append(o);
      });
      cad.onchange = function () { b.cadence = cad.value; commit(); };
      cell(cad);

      // when it's due — still absolute, still nothing to do with payday
      cell(dueField(b, commit), "num");

      if (isParked) { cell(removeBtn(b)); return tr; }

      // ---- the week columns ----
      var nd = need(b);
      var row = cells[b.id] || { amounts: [], manual: [] };
      var dueSet = {};
      nd.dates.forEach(function (d) { dueSet[E.toISO(d)] = true; });

      pcs.forEach(function (p, i) {
        var wk = moneyField(b.id + ":wk" + i, round2(row.amounts[i] || 0), function (v) {
          b.plan = b.plan || {};
          if (v === null) delete b.plan[p.key];   // emptied — back to the suggestion
          else b.plan[p.key] = v;
          commit();
        }, {
          cls: "wcell",
          placeholder: "$0.00",
          title: row.manual[i]
            ? "You typed this. Clear it to go back to the suggested amount."
            : "Suggested. Type over it to set your own."
        });
        if (row.manual[i]) wk.classList.add("typed");
        var td = cell(wk, "num wk");
        // mark the week the bill actually lands in
        var windowEnd = pcs[i + 1] ? pcs[i + 1].date : model.monthEnd;
        var landsHere = nd.dates.some(function (d) {
          return d >= p.date && (i === n - 1 ? d <= model.monthEnd : d < windowEnd);
        });
        if (landsHere) { td.classList.add("duehere"); td.title = "This bill lands in this week"; }
      });

      // ---- row total ----
      var total = rowTotal(b);
      var tot = el("td", "num tot");
      var big = el("div", null, E.money(total));
      tot.append(big);
      if (nd.count > 0) {
        var diff = nd.total - total;
        var st = checked.filter(function (r) { return r.bill === b; })[0];
        var isLate = st && st.late;
        var fl = el("span", "flag " + (diff > 0.005 || isLate ? "tight" : "ok"));
        fl.textContent = diff > 0.005 ? "short " + E.money(diff)
                       : isLate ? "! late"
                       : diff < -0.005 ? "+" + E.money(-diff) + " over"
                       : "✓ covered";
        fl.title = "Needs " + E.money(nd.total) + " this month" +
          (nd.perPaycheck
            ? " — " + E.money(nd.total / n) + " from each of " + n + " paychecks, " +
              "covering " + nd.count + " due date" + (nd.count === 1 ? "" : "s")
            : nd.count > 1 ? " (" + nd.count + " × " + E.money(b.amount) + ")" : "") + "." +
          (isLate && st.fc
            ? " Only " + E.money(st.fc.funded) + " is set aside by the " +
              E.fmtDate(st.fc.due) + " due date."
            : "");
        tot.append(fl);
      } else {
        tot.append(el("span", "flag", "not due this month"));
      }
      tr.append(tot);

      // ---- reset / remove ----
      var acts = el("div"); acts.style.cssText = "display:flex;gap:4px;justify-content:flex-end";
      if (b.plan && Object.keys(b.plan).length) {
        var undo = el("button", "icon ghost", "↺");
        undo.title = "Clear the amounts you typed and go back to the suggested split";
        undo.onclick = function () { delete b.plan; commit(); };
        acts.append(undo);
      }
      acts.append(removeBtn(b));
      cell(acts);

      return tr;
    }

    function removeBtn(b) {
      var rm = el("button", "icon ghost", "✕");
      rm.title = "Delete " + b.name;
      rm.onclick = function () {
        if (!confirm("Delete “" + b.name + "” for good? Untick it instead to just park it.")) return;
        state.bills.splice(state.bills.indexOf(b), 1);
        commit();
      };
      return rm;
    }

    function sortByCategory(list) {
      return list.slice().sort(function (a, b) {
        return E.CATEGORIES.indexOf(a.category) - E.CATEGORIES.indexOf(b.category);
      });
    }

    function round2(v) { return Math.round(v * 100) / 100; }
    function commit() { saveState(state); preserveFocus(rerender); }
  }

  // ------------------------------------------------------ paycheck cards ---

  function renderPaychecks(host, model, opts) {
    opts = opts || {};
    host.innerHTML = "";
    if (!model.paychecks.length) {
      host.append(el("p", "hint", "No paychecks land in this month — check the pay anchor date."));
      return;
    }

    model.paychecks.forEach(function (pc) {
      var card = el("div", "paycard" + (pc.net < 0 ? " short" : ""));

      var head = el("header");
      head.append(el("div", "idx", "Paycheck " + (pc.index + 1) + " of " + model.paycheckCount));
      head.append(el("div", "when", pc.date.toLocaleDateString("en-US",
        { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })));
      card.append(head);

      var body = el("div", "body");

      var mi = el("div", "moneyin");
      var mtop = el("div", "top");
      mtop.append(el("span", "lbl", "Money in"));
      mtop.append(el("span", "amt", E.money(pc.incomeTotal)));
      mi.append(mtop);
      body.append(mi);

      var ul = el("ul", "linelist");
      pc.allocations
        .slice()
        .sort(function (a, b) { return b.amount - a.amount; })
        .filter(function (a) { return a.amount > 0.004; })
        .forEach(function (a) {
          var li = el("li");
          var sw = el("span", "swatch"); sw.style.background = catColor(a.bill.category);
          li.append(sw, el("span", "nm", a.name));
          if (a.kind === "due") li.append(el("span", "due", "due " + E.fmtDate(a.dueDate)));
          li.append(el("span", "am", E.money(a.amount)));
          ul.append(li);
        });
      body.append(ul);

      if (opts.showCovers !== false) {
        var cv = el("div", "covers");
        cv.append(el("div", "lbl", "Bills landing before the next paycheck"));
        if (!pc.covers.length) {
          cv.append(el("div", "none", "Nothing dated — just the weekly set-asides."));
        } else {
          var cl = el("ul", "linelist");
          pc.covers.sort(function (a, b) { return a.date - b.date; }).forEach(function (c) {
            var li = el("li");
            var sw = el("span", "swatch"); sw.style.background = catColor(c.bill.category);
            li.append(sw, el("span", "nm", c.bill.name),
              el("span", "due", E.fmtDate(c.date)),
              el("span", "am", E.money(c.amount)));
            cl.append(li);
          });
          cv.append(cl);
        }
        body.append(cv);
      }
      card.append(body);

      var foot = el("footer");
      foot.append(el("span", "lbl", pc.net < 0 ? "Short by" : "Left over"));
      var amt = el("span", "amt " + (pc.net < 0 ? "neg" : "pos"), E.money(Math.abs(pc.net)));
      foot.append(amt);
      card.append(foot);

      host.append(card);
    });
  }

  // ------------------------------------------------------------ calendar ---

  function renderCalendar(host, model) {
    host.innerHTML = "";
    var table = el("table", "cal");
    var thead = el("thead"); var trh = el("tr");
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (d) {
      trh.append(el("th", null, d));
    });
    thead.append(trh); table.append(thead);

    var tbody = el("tbody");
    var firstDow = model.monthStart.getUTCDay();
    var todayTime = E.todayUTC().getTime();
    var tr = el("tr");
    for (var i = 0; i < firstDow; i++) tr.append(el("td", "empty"));

    model.runway.forEach(function (r) {
      if ((firstDow + r.day - 1) % 7 === 0 && r.day !== 1) { tbody.append(tr); tr = el("tr"); }

      var td = el("td");
      var hasEvents = r.events.length > 0;
      if (hasEvents) td.classList.add("has");
      if (r.inflow > 0) td.classList.add("payday");
      if (r.balance < 0) td.classList.add("negative");
      if (r.date.getTime() === todayTime) { td.classList.add("today"); td.title = "Today"; }

      td.append(el("div", "dnum", String(r.day)));

      r.events
        .sort(function (a, b) { return (a.type === "income" ? -1 : 1) - (b.type === "income" ? -1 : 1); })
        .forEach(function (ev) {
          var p = el("div", "pill " + (ev.type === "income" ? "in" : "out"));
          p.textContent = (ev.type === "income" ? "+" : "") +
            E.money(ev.amount, { cents: false }) + " " + ev.label;
          p.title = ev.label + " — " + E.money(ev.amount);
          td.append(p);
        });

      if (hasEvents) {
        var b = el("div", "bal", E.money(r.balance, { cents: false }));
        b.title = "Balance after this day";
        if (r.balance < 0) b.style.color = "var(--critical)";
        td.append(b);
      }
      tr.append(td);
    });
    while (tr.children.length < 7) tr.append(el("td", "empty"));
    tbody.append(tr);
    table.append(tbody);
    host.append(table);
  }

  // ------------------------------------------------------ due-date grid ---
  // A plain month of when bills land. No balances, no payday shading — this
  // answers "what's due and when", and the paycheck cards above answer the
  // rest.
  function renderDueCalendar(host, model) {
    host.innerHTML = "";
    var table = el("table", "cal duecal");

    var thead = el("thead"), trh = el("tr");
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (d) {
      trh.append(el("th", null, d));
    });
    thead.append(trh);
    table.append(thead);

    // group this month's bill due dates by day
    var byDay = {};
    model.billEvents.forEach(function (ev) {
      var day = ev.date.getUTCDate();
      (byDay[day] = byDay[day] || []).push(ev);
    });

    var tbody = el("tbody");
    var firstDow = model.monthStart.getUTCDay();
    var todayTime = E.todayUTC().getTime();
    var tr = el("tr");
    for (var i = 0; i < firstDow; i++) tr.append(el("td", "empty"));

    for (var day = 1; day <= model.daysInMonth; day++) {
      if ((firstDow + day - 1) % 7 === 0 && day !== 1) { tbody.append(tr); tr = el("tr"); }

      var date = new Date(Date.UTC(model.year, model.month, day));
      var td = el("td");
      var due = byDay[day] || [];
      if (due.length) td.classList.add("has");
      if (date.getTime() === todayTime) { td.classList.add("today"); td.title = "Today"; }

      td.append(el("div", "dnum", String(day)));

      due.sort(function (a, b) { return b.amount - a.amount; }).forEach(function (ev) {
        var pill = el("div", "pill due");
        var sw = el("span", "swatch");
        sw.style.background = catColor(ev.category);
        pill.append(sw, el("span", "n", ev.name),
                    el("span", "a", E.money(ev.amount, { cents: false })));
        pill.title = ev.name + " — " + E.money(ev.amount) + " due " +
          ev.date.toLocaleDateString("en-US",
            { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
        td.append(pill);
      });

      tr.append(td);
    }
    while (tr.children.length < 7) tr.append(el("td", "empty"));
    tbody.append(tr);
    table.append(tbody);
    host.append(table);

    // The same dates as a list, for screens too narrow for seven columns.
    // The stylesheet shows one or the other.
    var agenda = el("ul", "dueagenda");
    Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; }).forEach(function (day) {
      var date = new Date(Date.UTC(model.year, model.month, day));
      var li = el("li", date.getTime() === todayTime ? "today" : date.getTime() < todayTime ? "past" : null);
      var when = el("div", "when");
      when.append(el("b", null, String(day)),
                  el("span", null, date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" })));
      var list = el("div", "items");
      byDay[day].forEach(function (ev) {
        var row = el("div", "item");
        var sw = el("span", "swatch");
        sw.style.background = catColor(ev.category);
        row.append(sw, el("span", "n", ev.name), el("span", "a", E.money(ev.amount)));
        list.append(row);
      });
      li.append(when, list);
      agenda.append(li);
    });
    if (!agenda.children.length) agenda.append(el("li", "none", "Nothing due this month."));
    host.append(agenda);
  }

  // -------------------------------------------------------------- runway ---

  function renderRunway(host, model) {
    host.innerHTML = "";
    var box = el("div", "chartbox");
    host.append(box);

    var W = Math.max(280, box.clientWidth || host.clientWidth || 720);
    var H = W < 520 ? 180 : 210;
    var M = { t: 14, r: 58, b: 26, l: 10 };
    var iw = W - M.l - M.r, ih = H - M.t - M.b;

    var pts = model.runway;
    var vals = pts.map(function (p) { return p.balance; }).concat([0]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = Math.max(20, (hi - lo) * 0.12);
    lo -= pad; hi += pad;

    function X(day) { return M.l + (day - 1) / Math.max(1, pts.length - 1) * iw; }
    function Y(v) { return M.t + (hi - v) / Math.max(1e-6, hi - lo) * ih; }

    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Bank balance day by day through " + model.label);

    function mk(t, attrs) {
      var n = document.createElementNS(NS, t);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    // clips: above / below the zero line
    var defs = mk("defs");
    var zeroY = Y(0);
    var cAbove = mk("clipPath", { id: "clip-above" });
    cAbove.append(mk("rect", { x: M.l, y: M.t, width: iw, height: Math.max(0, zeroY - M.t) }));
    var cBelow = mk("clipPath", { id: "clip-below" });
    cBelow.append(mk("rect", { x: M.l, y: zeroY, width: iw, height: Math.max(0, M.t + ih - zeroY) }));
    defs.append(cAbove, cBelow);
    svg.append(defs);

    // horizontal gridlines
    var ticks = niceTicks(lo, hi, 4);
    ticks.forEach(function (t) {
      svg.append(mk("line", {
        x1: M.l, x2: M.l + iw, y1: Y(t), y2: Y(t),
        stroke: t === 0 ? cssVar("--baseline") : cssVar("--grid"),
        "stroke-width": t === 0 ? 1.5 : 1
      }));
      var lb = mk("text", {
        x: M.l + iw + 8, y: Y(t) + 4, fill: cssVar("--muted"),
        "font-size": 11, "font-family": cssVar("--font")
      });
      lb.textContent = E.money(t, { cents: false });
      svg.append(lb);
    });

    // area under the line, split at zero
    var area = "M" + X(1) + "," + Y(0);
    pts.forEach(function (p) { area += " L" + X(p.day) + "," + Y(p.balance); });
    area += " L" + X(pts.length) + "," + Y(0) + " Z";
    svg.append(mk("path", { d: area, fill: cssVar("--good"), "fill-opacity": 0.10, "clip-path": "url(#clip-above)" }));
    svg.append(mk("path", { d: area, fill: cssVar("--critical"), "fill-opacity": 0.16, "clip-path": "url(#clip-below)" }));

    // the balance line
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.day) + "," + Y(p.balance); }).join(" ");
    svg.append(mk("path", {
      d: d, fill: "none", stroke: cssVar("--s1"), "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round"
    }));

    // payday markers, ringed so they sit on top of the line cleanly
    pts.forEach(function (p) {
      if (p.inflow <= 0) return;
      svg.append(mk("circle", {
        cx: X(p.day), cy: Y(p.balance), r: 4.5,
        fill: cssVar("--good"), stroke: cssVar("--surface"), "stroke-width": 2
      }));
    });

    // x ticks
    for (var day = 1; day <= pts.length; day += (pts.length > 28 ? 5 : 4)) {
      var tx = mk("text", {
        x: X(day), y: H - 8, fill: cssVar("--muted"),
        "font-size": 11, "font-family": cssVar("--font"), "text-anchor": "middle"
      });
      tx.textContent = day;
      svg.append(tx);
    }

    // hover layer
    var cross = mk("line", {
      x1: 0, x2: 0, y1: M.t, y2: M.t + ih,
      stroke: cssVar("--baseline"), "stroke-width": 1, opacity: 0
    });
    var dot = mk("circle", { r: 5, fill: cssVar("--s1"), stroke: cssVar("--surface"), "stroke-width": 2, opacity: 0 });
    svg.append(cross, dot);

    var tip = el("div", "tip");
    box.append(svg, tip);

    // Pointer events so a finger dragging across the chart scrubs it the way
    // a mouse does; vertical swipes still scroll the page.
    svg.style.touchAction = "pan-y";
    svg.addEventListener("pointerdown", scrub);
    svg.addEventListener("pointermove", scrub);
    function scrub(e) {
      var r = svg.getBoundingClientRect();
      var x = e.clientX - r.left;
      var day = Math.round((x - M.l) / iw * (pts.length - 1)) + 1;
      day = Math.max(1, Math.min(pts.length, day));
      var p = pts[day - 1];

      cross.setAttribute("x1", X(day)); cross.setAttribute("x2", X(day));
      cross.setAttribute("opacity", 1);
      dot.setAttribute("cx", X(day)); dot.setAttribute("cy", Y(p.balance));
      dot.setAttribute("opacity", 1);

      var rows = p.events.map(function (ev) {
        return '<div class="tr"><span>' + ev.label + "</span><span>" +
          (ev.type === "income" ? "+" : "−") + E.money(ev.amount) + "</span></div>";
      }).join("");
      tip.innerHTML = '<div class="th">' +
        p.date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) +
        "</div>" + rows +
        '<div class="tr" style="margin-top:4px;font-weight:600"><span>Balance</span><span>' +
        E.money(p.balance) + "</span></div>";
      tip.classList.add("on");
      var tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(W - tw, X(day) - tw / 2)) + "px";
      tip.style.top = Math.max(0, Y(p.balance) - tip.offsetHeight - 12) + "px";
    }
    // A mouse leaving clears the read-out; a finger lifting leaves it up to
    // be read, until the next tap somewhere else.
    function clear() {
      cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0);
      tip.classList.remove("on");
    }
    svg.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") clear(); });
    runwayTouch = { svg: svg, clear: clear };
  }

  function niceTicks(lo, hi, count) {
    var span = hi - lo;
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
      .filter(function (s) { return s >= raw; })[0] || mag * 10;
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v * 100) / 100);
    if (out.indexOf(0) === -1 && lo < 0 && hi > 0) out.push(0);
    return out.sort(function (a, b) { return a - b; });
  }

  // ------------------------------------------------------- category table --

  function renderCategoryTable(host, model) {
    host.innerHTML = "";
    var per = model.paycheckCount || 1;

    // What actually gets held back, straight off the paycheck allocations, so
    // these totals agree with the tiles rather than being computed a second way.
    var setAside = {};
    model.paychecks.forEach(function (p) {
      p.allocations.forEach(function (a) {
        var c = (a.bill && a.bill.category) || "Personal";
        setAside[c] = (setAside[c] || 0) + a.amount;
      });
    });

    var rows = E.CATEGORIES
      .map(function (c) { return { cat: c, hold: setAside[c] || 0, bill: model.byCategory[c] || 0 }; })
      .filter(function (r) { return r.hold > 0.005 || r.bill > 0.005; })
      .sort(function (a, b) { return b.hold - a.hold; });

    var totalHold = rows.reduce(function (s, r) { return s + r.hold; }, 0);
    var totalBill = rows.reduce(function (s, r) { return s + r.bill; }, 0);

    // stacked share bar — adjacent segments, 2px surface gap between them
    var bar = el("div");
    bar.style.cssText = "display:flex;gap:2px;height:12px;border-radius:6px;overflow:hidden;margin-bottom:14px";
    rows.forEach(function (r) {
      var seg = el("div");
      seg.style.cssText = "flex:" + (r.hold / (totalHold || 1)) + " 1 0;background:" + catColor(r.cat);
      seg.title = r.cat + " — " + E.money(r.hold) + " set aside this month";
      bar.append(seg);
    });
    host.append(bar);

    var t = el("table", "data");
    t.innerHTML = "<thead><tr><th>Category</th><th class='num'>Per paycheck</th>" +
      "<th class='num'>Set aside this month</th><th class='num'>Actual bills</th>" +
      "<th class='num'>Share</th></tr></thead>";
    var tb = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      var td1 = el("td");
      var sw = el("span", "swatch"); sw.style.cssText = "background:" + catColor(r.cat) + ";display:inline-block;margin-right:8px";
      td1.append(sw, document.createTextNode(r.cat));
      tr.append(td1);
      tr.append(el("td", "num", E.money(r.hold / per)));
      tr.append(el("td", "num", E.money(r.hold)));
      tr.append(el("td", "num", E.money(r.bill)));
      tr.append(el("td", "num", ((r.hold / (totalHold || 1)) * 100).toFixed(1) + "%"));
      tb.append(tr);
    });
    var trt = el("tr");
    trt.style.fontWeight = "600";
    trt.append(el("td", null, "Total"), el("td", "num", E.money(totalHold / per)),
      el("td", "num", E.money(totalHold)), el("td", "num", E.money(totalBill)),
      el("td", "num", "100%"));
    tb.append(trt);
    t.append(tb);
    host.append(t);

    var gap = totalBill - totalHold;
    if (Math.abs(gap) > 0.5) {
      var note = el("p", "hint");
      note.style.marginTop = "10px";
      note.textContent = "Set aside and actual bills differ by " + E.money(Math.abs(gap)) +
        " this month because " + (model.paycheckCount) + " paychecks isn't exactly one month's worth" +
        " — on the Even setting the difference evens out over the year.";
      host.append(note);
    }

    var lg = el("div", "legend");
    rows.forEach(function (r) {
      var li = el("div", "li");
      var sw = el("span", "swatch"); sw.style.background = catColor(r.cat);
      li.append(sw, document.createTextNode(r.cat));
      lg.append(li);
    });
    host.append(lg);
  }

  // ---------------------------------------------------- paying bills off ---
  // A tick is stored on the bill, keyed by the paycheck it belongs to — the
  // same shape as a typed week amount, so it rides along in Save/Load and past
  // months stay ticked when you navigate back.

  function billPaid(bill, iso) { return !!(bill.paid && bill.paid[iso]); }

  function setBillPaid(bill, iso, on) {
    if (on) { bill.paid = bill.paid || {}; bill.paid[iso] = true; return; }
    if (bill.paid) {
      delete bill.paid[iso];
      if (!Object.keys(bill.paid).length) delete bill.paid;
    }
  }

  // One row per cell of the bill grid that has money in it.
  function payRows(model) {
    var rows = [];
    model.paychecks.forEach(function (pc, i) {
      pc.allocations.forEach(function (a) {
        if (a.amount <= 0.004) return;
        rows.push({
          bill: a.bill, iso: pc.key, week: i, date: pc.date,
          name: a.name, amount: a.amount, category: a.bill.category,
          paid: billPaid(a.bill, pc.key)
        });
      });
    });
    return rows;
  }

  // Rolled up per bill, which is what the jars show.
  function payByBill(rows) {
    var seen = {}, out = [];
    rows.forEach(function (r) {
      var b = seen[r.bill.id];
      if (!b) {
        b = seen[r.bill.id] = { id: r.bill.id, name: r.name, category: r.category, total: 0, paid: 0 };
        out.push(b);
      }
      b.total += r.amount;
      if (r.paid) b.paid += r.amount;
    });
    return out;
  }

  // -------------------------------------------------------------- tooltip --
  var payTip = null;
  function ensureTip() {
    if (payTip) return payTip;
    payTip = el("div", "paytip");
    document.body.append(payTip);
    return payTip;
  }
  function showPayTip(b, anchorEl) {
    var t = ensureTip();
    var pct = b.total ? Math.round((b.paid / b.total) * 100) : 100;
    var done = b.paid >= b.total - 0.005;
    t.innerHTML =
      '<div class="t"><span class="swatch" style="background:' + catColor(b.category) + '"></span>' +
      escapeHtml(b.name) + '</div>' +
      '<div class="a">' + E.money(b.paid) + ' of ' + E.money(b.total) + '</div>' +
      '<div class="p">' + pct + '% paid' + (done ? '  \u00b7  done' : '') + '</div>';
    t.classList.add("on");
    var r = anchorEl.getBoundingClientRect();
    t.style.left = Math.max(8, Math.min(window.innerWidth - t.offsetWidth - 8,
      r.left + r.width / 2 - t.offsetWidth / 2)) + "px";
    t.style.top = (r.bottom + 8) + "px";
  }
  function hidePayTip() { if (payTip) payTip.classList.remove("on"); }

  // On a phone there's no hover to end. A tap shows a read-out; the next tap
  // anywhere else, or a scroll, puts it away.
  var runwayTouch = null;
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse") return;
    if (!e.target.closest || !e.target.closest(".jarwrap, .tick")) hidePayTip();
    if (runwayTouch && !runwayTouch.svg.contains(e.target)) runwayTouch.clear();
  });
  window.addEventListener("scroll", hidePayTip, { passive: true });
  function escapeHtml(x) {
    return String(x).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ------------------------------------------------------- the pay strip ---
  // Rebuilt only when the set of bills changes, so ticking one just slides its
  // jar rather than redrawing the whole row.
  function renderPayStrip(host, state, model) {
    var rows = payRows(model);
    var bills = payByBill(rows);
    var sig = bills.map(function (b) { return b.id; }).join(",");
    var today = E.todayUTC();

    var due = rows.reduce(function (s2, r) {
      return s2 + (!r.paid && r.date <= today ? r.amount : 0);
    }, 0);
    var paidAmt = bills.reduce(function (s2, b) { return s2 + b.paid; }, 0);
    var total = bills.reduce(function (s2, b) { return s2 + b.total; }, 0);
    var clear = bills.filter(function (b) { return b.paid >= b.total - 0.005; }).length;

    if (host.getAttribute("data-sig") !== sig) {
      host.setAttribute("data-sig", sig);
      host.innerHTML =
        '<div class="pending"><div class="cap">Still to move this week</div>' +
        '<div class="v" id="pay-due"></div></div>' +
        '<div class="sep"></div>' +
        '<div class="grow"><div class="cap" id="pay-cap"></div>' +
        '<div class="farm" id="pay-farm"></div></div>';
      var farm = host.querySelector("#pay-farm");
      bills.forEach(function (b) {
        var wrap = el("div", "jarwrap");
        wrap.setAttribute("data-bill", b.id);
        var jar = el("div", "jar");
        var fill = document.createElement("i");
        fill.style.background = catColor(b.category);
        jar.append(fill);
        wrap.append(jar, el("div", "nm", b.name));
        wrap.addEventListener("mouseenter", function (e) {
          var cur = payByBill(payRows(model)).filter(function (x) { return x.id === b.id; })[0];
          if (cur) showPayTip(cur, e.currentTarget);
        });
        wrap.addEventListener("mouseleave", hidePayTip);
        farm.append(wrap);
      });
    }

    var dueEl = host.querySelector("#pay-due");
    dueEl.textContent = E.money(due);
    dueEl.className = "v " + (due > 0.005 ? "neg" : "pos");
    host.querySelector("#pay-cap").textContent =
      "Paid this month  \u00b7  " + E.money(paidAmt, { cents: false }) + " of " +
      E.money(total, { cents: false }) + "  \u00b7  " + clear + " of " + bills.length + " bills clear";

    bills.forEach(function (b) {
      var wrap = host.querySelector('[data-bill="' + b.id + '"]');
      if (!wrap) return;
      var done = b.paid >= b.total - 0.005;
      wrap.querySelector("i").style.height =
        Math.max(0, Math.min(1, b.total ? b.paid / b.total : 1)) * 100 + "%";
      wrap.className = "jarwrap" + (done ? " full" : "");
      wrap.setAttribute("aria-label", b.name + ": " + E.money(b.paid) + " of " + E.money(b.total));
    });
  }

  // --------------------------------------------------- paycheck pay cards --
  function renderPayCards(host, state, model, rerender) {
    host.innerHTML = "";
    var today = E.todayUTC();
    var rows = payRows(model);
    var bills = payByBill(rows);
    var links = linkMap(state);

    if (!model.paychecks.length) {
      host.append(el("p", "hint", "No paychecks land in this month \u2014 check the payday setting."));
      return;
    }

    model.paychecks.forEach(function (pc, idx) {
      var mine = rows.filter(function (r) { return r.week === idx; });
      var owed = mine.reduce(function (s2, r) { return s2 + (r.paid ? 0 : r.amount); }, 0);
      var doneN = mine.filter(function (r) { return r.paid; }).length;
      var behind = pc.date <= today && owed > 0.005;
      var settled = mine.length && owed <= 0.005;

      var card = el("div", "paycard" + (behind ? " behind" : settled ? " settled" : ""));

      var head = el("header");
      head.append(el("div", "idx", "Paycheck " + (idx + 1) + " of " + model.paycheckCount));
      head.append(el("div", "when", pc.date.toLocaleDateString("en-US",
        { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })));
      card.append(head);

      var body = el("div", "body");

      // Money in, then where it actually comes from. A source that pays
      // nothing this week (a biweekly one on its off week) is left out rather
      // than listed as zero.
      var mi = el("div", "moneyin");
      var top = el("div", "top");
      top.append(el("span", "lbl", "Money in"), el("span", "amt", E.money(pc.incomeTotal)));
      mi.append(top);

      var srcs = pc.income.filter(function (x) { return x.amount > 0.004; })
        .sort(function (a, b) { return b.amount - a.amount; });

      if (!srcs.length) {
        mi.append(el("div", "none", "Nothing lands this week."));
      } else {
        var sl = el("ul", "linelist srcs");
        srcs.forEach(function (x) {
          var li = el("li");
          var am = el("span", "am" + (x.manual ? " typed" : ""), E.money(x.amount));
          if (x.manual) am.title = "Typed into the income grid for this week, not the usual " +
            E.money(x.auto);
          li.append(el("span", "nm", x.name), am);
          sl.append(li);
        });
        mi.append(sl);
      }
      body.append(mi);

      var pay = el("div", "topay");
      var lbl = el("div", "lbl");
      lbl.append(el("span", null, "Pay these  \u00b7  " + E.money(pc.outTotal)));
      lbl.append(el("b", null, doneN + " / " + mine.length));
      pay.append(lbl);

      if (!mine.length) {
        pay.append(el("div", "none", "Nothing set aside this week."));
      } else {
        mine.forEach(function (r) {
          var overdue = !r.paid && r.date <= today;
          var line = el("label", "tick" + (r.paid ? " done" : "") + (overdue ? " overdue" : ""));
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = r.paid;
          cb.setAttribute("data-fkey", r.bill.id + ":pay:" + r.iso);
          cb.onchange = function () {
            setBillPaid(r.bill, r.iso, cb.checked);
            saveState(state);
            preserveFocus(rerender);
          };
          var sw = el("span", "swatch");
          sw.style.background = catColor(r.category);
          line.append(cb, sw, el("span", "nm", r.name));

          // Ticking this one also moves a goal or a debt — say so here, where
          // the tick actually happens, rather than only on the Goals tab.
          var feeds = links[r.bill.id];
          if (feeds) {
            var chip = el("span", "golink", "↗");
            chip.title = "Also credited to " + feeds.join(", ");
            line.append(chip);
          }

          line.append(el("span", "amt", E.money(r.amount)));
          line.addEventListener("mouseenter", function (e) {
            var b = bills.filter(function (x) { return x.id === r.bill.id; })[0];
            if (b) showPayTip(b, e.currentTarget);
          });
          line.addEventListener("mouseleave", hidePayTip);
          pay.append(line);
        });
      }
      body.append(pay);
      card.append(body);

      var foot = el("footer");
      foot.append(el("span", "lbl", owed > 0.005 ? "Left to pay" : "All paid"));
      foot.append(el("span", "amt " + (owed > 0.005 ? "" : "pos"),
        owed > 0.005 ? E.money(owed) : "\u2713"));
      card.append(foot);

      host.append(card);
    });
  }

  // -------------------------------------------------------- the goals tab --
  // Two things you're working toward, in one place: savings goals filling up,
  // and debts going down. Same table, opposite directions. Either one can name
  // the bill that funds it, and then ticking that bill off on This month moves
  // the number for you.

  // What you owe and how far down it you are. Each debt keeps the balance it
  // started at purely so the bar has something to measure against; `owed` is
  // the number you actually maintain.
  function debtStats(d) {
    var started = d.startedAt > 0 ? d.startedAt : d.owed;
    var owed = Math.max(0, d.owed);
    var paid = Math.max(0, started - owed);
    var months = E.payoffMonths(owed, d.payment, d.apr);
    return {
      started: started, owed: owed, paid: paid,
      frac: started > 0 ? Math.min(1, paid / started) : (owed > 0 ? 0 : 1),
      cleared: owed <= 0.005,
      months: months,
      stuck: !isFinite(months) && owed > 0.005,
      when: E.payoffDate(owed, d.payment, d.apr),
      interest: E.payoffInterest(owed, d.payment, d.apr)
    };
  }

  // ------------------------------------------------ a bill that funds one --
  // Ticks already live on the bill (bill.paid, keyed by paycheck). A linked
  // debt or goal keeps a matching `credited` map: the same keys, and the amount
  // each one moved. So unticking gives back exactly what was credited rather
  // than a freshly recomputed number that may have drifted since, and the
  // balance you maintain by hand is never double-counted.

  function round2(n) { return Math.round(n * 100) / 100; }

  function findBill(state, id) {
    if (!id) return null;
    var hit = null;
    (state.bills || []).forEach(function (b) { if (b.id === id) hit = b; });
    return hit;
  }

  // What one ticked paycheck actually put toward this bill — the typed week
  // amount if there is one, otherwise the suggested slice. Same number the
  // paycheck card showed next to the checkbox.
  function plannedFor(bill, meta, key) {
    var base = E.parseISO(key);
    var date = E.addDays(base, E.payShift(meta, base));
    return E.plannedAmount(bill, meta, { key: key, date: date }) || 0;
  }

  // Everything already ticked on this bill, across every month — what linking
  // it would credit the moment you pick it.
  function tickedTotal(bill, meta) {
    var t = 0;
    Object.keys((bill && bill.paid) || {}).forEach(function (key) {
      t += plannedFor(bill, meta, key);
    });
    return round2(t);
  }

  function creditedTotal(item) {
    var t = 0;
    Object.keys(item.credited || {}).forEach(function (k) { t += item.credited[k]; });
    return round2(t);
  }
  function creditedCount(item) {
    return Object.keys(item.credited || {}).length;
  }

  // Reconcile every linked item against the ticks on its bill. Returns true if
  // anything moved, so the caller knows to save. Called before each render, so
  // no panel is ever drawn from stale numbers.
  function syncLinks(state) {
    var changed = false;
    if (!Array.isArray(state.goals)) state.goals = [];
    if (!Array.isArray(state.debts)) state.debts = [];
    state.debts.forEach(function (d) { if (syncOne(state, d, -1)) changed = true; });
    state.goals.forEach(function (g) { if (syncOne(state, g, +1)) changed = true; });
    return changed;
  }

  // dir −1 pays a balance down (never past zero); dir +1 fills a pot up.
  function syncOne(state, item, dir) {
    var field = dir < 0 ? "owed" : "saved";
    var bill = findBill(state, item.billId);
    var changed = false;

    // Unlinked, or pointing at a bill that's been deleted: hand back everything
    // this link ever moved, so the number goes back to being yours alone.
    if (!bill) {
      if (item.credited && Object.keys(item.credited).length) {
        Object.keys(item.credited).forEach(function (k) {
          item[field] = round2((item[field] || 0) - dir * item.credited[k]);
        });
        delete item.credited;
        changed = true;
      }
      return changed;
    }

    item.credited = item.credited || {};
    var paid = bill.paid || {};

    // newly ticked
    Object.keys(paid).forEach(function (key) {
      if (item.credited[key] !== undefined) return;
      var amt = round2(plannedFor(bill, state.meta, key));
      // A debt can't be paid past zero, so only bank what actually landed —
      // that way unticking restores the balance exactly.
      var applied = dir < 0 ? Math.min(amt, Math.max(0, item.owed || 0)) : amt;
      item.credited[key] = round2(applied);
      item[field] = round2((item[field] || 0) + dir * applied);
      changed = true;
    });

    // un-ticked since last time
    Object.keys(item.credited).forEach(function (key) {
      if (paid[key]) return;
      item[field] = round2((item[field] || 0) - dir * item.credited[key]);
      delete item.credited[key];
      changed = true;
    });

    if (!Object.keys(item.credited).length) delete item.credited;
    return changed;
  }

  // billId -> [names of the debts/goals it feeds]
  function linkMap(state) {
    var m = {};
    function add(list, suffix) {
      (list || []).forEach(function (x) {
        if (!x.billId) return;
        (m[x.billId] = m[x.billId] || []).push(x.name + suffix);
      });
    }
    add(state.debts, "");
    add(state.goals, "");
    return m;
  }

  // -------------------------------------------------- picking that bill ----

  function billSelect(state, item, onPick) {
    var s = el("select", "billpick");
    var none = el("option", null, "— not linked —");
    none.value = "";
    s.append(none);

    (state.bills || []).forEach(function (b) {
      var o = el("option", null,
        b.name + "  ·  " + E.money(E.monthlyEquivalent(b), { cents: false }) + "/mo" +
        (b.active === false ? "  (parked)" : ""));
      o.value = b.id;
      if (item.billId === b.id) o.selected = true;
      s.append(o);
    });

    if (item.billId && !findBill(state, item.billId)) {
      var gone = el("option", null, "(that bill is gone)");
      gone.value = item.billId;
      gone.selected = true;
      s.append(gone);
    }

    // onPick may veto the choice, in which case the dropdown snaps back.
    s.onchange = function () {
      if (onPick(s.value || null) === false) s.value = item.billId || "";
    };
    return s;
  }

  // The line under the dropdown: what the link has actually moved so far.
  function linkNote(state, item) {
    var bill = findBill(state, item.billId);
    var n = el("span", "sub");
    if (!item.billId) { n.textContent = "paid by hand"; return n; }
    if (!bill) { n.textContent = "bill missing — credit returned"; n.className = "sub warn"; return n; }
    var count = creditedCount(item);
    n.textContent = count
      ? E.money(creditedTotal(item), { cents: false }) + " credited · " +
        count + " tick" + (count === 1 ? "" : "s")
      : "nothing ticked yet";
    return n;
  }

  function linkCell(state, item, commit, onLink, noun) {
    var wrap = el("div", "linkcell");
    wrap.append(billSelect(state, item, function (id) {
      var bill = findBill(state, id);

      // Ticks already on that bill count the moment it's linked — which is
      // right, that money was moved — but a bill with months of history behind
      // it would move the balance a long way without warning. So say so first.
      if (bill) {
        var already = tickedTotal(bill, state.meta);
        if (already > 0.005 && !confirm(
          bill.name + " already has " + E.money(already) + " ticked off.\n\n" +
          "Linking it credits all of that to \u201c" + item.name + "\u201d straight away, " +
          (noun === "goal" ? "so the pot jumps up by that much." : "so the balance drops by that much.") +
          "\n\nUnlink it again and every penny goes back."
        )) return false;
      }

      item.billId = id;
      if (bill && onLink) onLink(bill);
      syncLinks(state);
      commit();
    }));
    wrap.append(linkNote(state, item));
    return wrap;
  }
  // ------------------------------------------------------- savings goals ---
  // A pot you're filling: the mirror of a debt, counting up to a target rather
  // than down to zero.

  function goalStats(g) {
    var target = Math.max(0, g.target || 0);
    var saved = Math.max(0, g.saved || 0);
    var left = Math.max(0, round2(target - saved));
    var per = g.contribution || 0;
    var months = left <= 0.005 ? 0 : (per > 0 ? Math.ceil(left / per) : Infinity);
    return {
      target: target, saved: saved, left: left, per: per, months: months,
      frac: target > 0 ? Math.min(1, saved / target) : (saved > 0 ? 1 : 0),
      pct: target > 0 ? saved / target : 0,
      done: target > 0 && saved >= target - 0.005,
      when: isFinite(months) ? E.addMonths(E.todayUTC(), months) : null
    };
  }

  function renderSavings(host, state, rerender) {
    host.innerHTML = "";
    if (!Array.isArray(state.goals)) state.goals = [];

    var live = state.goals.filter(function (g) { return g.active !== false; });
    var stats = {};
    live.forEach(function (g) { stats[g.id] = goalStats(g); });

    var saved = live.reduce(function (s, g) { return s + stats[g.id].saved; }, 0);
    var target = live.reduce(function (s, g) { return s + stats[g.id].target; }, 0);
    var left = Math.max(0, round2(target - saved));
    var per = live.reduce(function (s, g) { return s + (g.contribution || 0); }, 0);
    var done = live.filter(function (g) { return stats[g.id].done; }).length;
    var stalled = live.filter(function (g) { return !isFinite(stats[g.id].months); });
    var longest = live.reduce(function (m, g) {
      var n = stats[g.id].months;
      return isFinite(n) ? Math.max(m, n) : m;
    }, 0);

    // ---- headline ----
    var tiles = el("div", "tiles");
    tiles.innerHTML =
      tile("Saved so far", E.money(saved, { cents: false }),
           target > 0 ? Math.round((saved / target) * 100) + "% of " + E.money(target, { cents: false })
                      : live.length + " goal" + (live.length === 1 ? "" : "s"), "pos", true) +
      tile("Still to go", E.money(left, { cents: false }),
           live.length + " goal" + (live.length === 1 ? "" : "s") + " being filled") +
      tile("Going in a month", E.money(per, { cents: false }), "across every goal") +
      tile("All funded by", stalled.length ? "—" : (left <= 0.005 ? "Done" : monthsLabel(longest)),
           stalled.length ? "a goal has nothing going into it"
                          : left <= 0.005 ? "everything's funded"
                          : "at the amounts below",
           stalled.length ? "" : "pos");
    host.append(tiles);

    if (target > 0) {
      var rail = el("div", "debtrail goalrail");
      rail.title = E.money(saved) + " saved of " + E.money(target);
      var fill = document.createElement("i");
      fill.style.width = Math.min(100, (saved / target) * 100) + "%";
      rail.append(fill);
      host.append(rail);
    }

    // ---- the table ----
    var scroll = el("div", "tablescroll");
    var t = el("table", "gridtable debttable goaltable");
    t.innerHTML = "<thead><tr><th></th><th>Goal</th>" +
      "<th class='num'>Target</th><th class='num'>Saved</th>" +
      "<th class='num'>Monthly</th><th>Funded by</th>" +
      "<th>Progress</th><th class='num'>Filled</th><th>Ready by</th><th></th>" +
      "</tr></thead>";
    var tb = el("tbody");

    state.goals.forEach(function (g) {
      var on = g.active !== false;
      var st = on ? stats[g.id] : goalStats(g);
      var tr = el("tr", (!on ? "off" : st.done ? "cleared" : ""));

      function cell(node, cls) {
        var td = el("td", cls);
        if (node) td.append(node);
        tr.append(td);
        return td;
      }

      var cb = el("input");
      cb.type = "checkbox"; cb.checked = on;
      cb.setAttribute("data-fkey", g.id + ":on");
      cb.title = on ? "Stop tracking this one" : "Track this one again";
      cb.onchange = function () { g.active = cb.checked; commit(); };
      cell(cb);

      var nm = el("input");
      nm.type = "text"; nm.value = g.name;
      nm.setAttribute("data-fkey", g.id + ":gname");
      nm.oninput = function () { g.name = nm.value; commit(); };
      cell(nm);

      cell(moneyField(g.id + ":target", g.target, function (v) {
        g.target = v === null ? 0 : v; commit();
      }), "num");

      cell(moneyField(g.id + ":saved", g.saved, function (v) {
        g.saved = v === null ? 0 : v; commit();
      }), "num");

      cell(moneyField(g.id + ":per", g.contribution, function (v) {
        g.contribution = v === null ? 0 : v; commit();
      }), "num");

      // Linking a bill fills in the monthly figure from it — that IS what's
      // going in now, and it can still be typed over afterwards.
      cell(linkCell(state, g, commit, function (bill) {
        if (bill) g.contribution = round2(E.monthlyEquivalent(bill));
      }, "goal"));

      var bar = el("div", "dbar");
      bar.title = E.money(st.saved) + " saved of " + E.money(st.target);
      var bf = document.createElement("i");
      bf.style.width = (st.frac * 100) + "%";
      bar.append(bf);
      cell(bar);

      var pct = el("div", "num");
      pct.innerHTML = "<div>" + Math.round(st.pct * 100) + "%</div>" +
        '<span class="sub">' + E.money(st.left, { cents: false }) + " to go</span>";
      cell(pct, "num");

      var when = el("div");
      if (!on) when.append(el("span", "flag", "not tracked"));
      else if (st.done) when.append(el("span", "flag ok", "✓ funded"));
      else if (!isFinite(st.months)) when.append(el("span", "flag tight", "! nothing going in"));
      else {
        when.append(el("div", null, st.when
          ? st.when.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" })
          : "—"));
        when.append(el("span", "sub", monthsLabel(st.months) + " at " +
          E.money(st.per, { cents: false }) + "/mo"));
      }
      cell(when);

      var rm = el("button", "icon ghost", "✕");
      rm.title = "Delete " + g.name;
      rm.onclick = function () {
        if (!confirm("Delete “" + g.name + "”? Untick it instead to stop tracking without losing it.")) return;
        state.goals.splice(state.goals.indexOf(g), 1);
        commit();
      };
      cell(rm);

      tb.append(tr);
    });

    var tf = el("tr", "totals");
    tf.innerHTML = "<td></td><td>Totals</td>" +
      "<td class='num'>" + E.money(target) + "</td>" +
      "<td class='num'>" + E.money(saved) + "</td>" +
      "<td class='num'>" + E.money(per) + "</td>" +
      "<td></td><td></td>" +
      "<td class='num'>" + (target > 0 ? Math.round((saved / target) * 100) + "%" : "—") + "</td>" +
      "<td>" + (done ? done + " funded" : "") + "</td><td></td>";
    tb.append(tf);

    t.append(tb);
    scroll.append(t);
    host.append(scroll);

    var add = el("button", "primary", "+ Add a savings goal");
    add.style.marginTop = "14px";
    add.onclick = function () {
      state.goals.push({
        id: newId("g-", state.goals), name: "New goal",
        target: 0, saved: 0, contribution: 0, billId: null, active: true
      });
      commit();
      setTimeout(function () {
        var all = document.querySelectorAll('[data-fkey$=":gname"]');
        var last = all[all.length - 1];
        if (last) { last.focus(); last.select(); }
      }, 0);
    };
    host.append(add);

    function commit() { saveState(state); preserveFocus(rerender); }
  }
  // ------------------------------------------------------- what you owe ----

  function renderDebts(host, state, rerender) {
    host.innerHTML = "";
    if (!Array.isArray(state.debts)) state.debts = [];

    var live = state.debts.filter(function (d) { return d.active !== false; });
    var stats = {};
    live.forEach(function (d) { stats[d.id] = debtStats(d); });

    var owed = live.reduce(function (s, d) { return s + stats[d.id].owed; }, 0);
    var started = live.reduce(function (s, d) { return s + stats[d.id].started; }, 0);
    var paid = Math.max(0, started - owed);
    var monthly = live.reduce(function (s, d) { return s + (d.payment || 0); }, 0);
    var cleared = live.filter(function (d) { return stats[d.id].cleared; }).length;
    var stuck = live.filter(function (d) { return stats[d.id].stuck; });
    var longest = live.reduce(function (m, d) {
      var n = stats[d.id].months;
      return isFinite(n) ? Math.max(m, n) : m;
    }, 0);

    var tiles = el("div", "tiles");
    tiles.innerHTML =
      tile("Still owed", E.money(owed, { cents: false }),
           live.length + " debt" + (live.length === 1 ? "" : "s") + " being tracked", "", true) +
      tile("Paid off so far", E.money(paid, { cents: false }),
           started > 0 ? Math.round((paid / started) * 100) + "% of where you started" : "—", "pos") +
      tile("Going out a month", E.money(monthly, { cents: false }), "across every debt") +
      tile("Debt free", stuck.length ? "—" : (owed <= 0.005 ? "Done" : monthsLabel(longest)),
           stuck.length ? "a payment isn't covering interest"
                        : owed <= 0.005 ? "everything's clear"
                        : "at the payments below",
           stuck.length ? "neg" : "pos");
    host.append(tiles);

    if (started > 0) {
      var railWrap = el("div", "debtrail");
      railWrap.title = E.money(paid) + " paid of " + E.money(started);
      var fill = document.createElement("i");
      fill.style.width = (started > 0 ? (paid / started) * 100 : 0) + "%";
      railWrap.append(fill);
      host.append(railWrap);
    }

    if (stuck.length) {
      var warn = el("div", "verdict critical");
      warn.append(el("div", "ico", "!"));
      var wb = el("div");
      wb.append(el("div", "t", stuck.length === 1
        ? stuck[0].name + " isn't going down."
        : stuck.length + " debts aren't going down."));
      wb.append(el("div", "d", "The monthly payment is smaller than the interest, so the balance grows. Raise the payment, or check the rate."));
      warn.append(wb);
      host.append(warn);
    }

    var scroll = el("div", "tablescroll");
    var t = el("table", "gridtable debttable debtlinked");
    t.innerHTML = "<thead><tr><th></th><th>Debt</th>" +
      "<th class='num'>Started at</th><th class='num'>Owed now</th>" +
      "<th class='num'>Monthly</th><th class='num'>Rate</th>" +
      "<th>Paid by</th>" +
      "<th>Progress</th><th class='num'>Paid off</th><th>Clear by</th><th></th>" +
      "</tr></thead>";
    var tb = el("tbody");

    state.debts.forEach(function (d) {
      var on = d.active !== false;
      var st = on ? stats[d.id] : debtStats(d);
      var tr = el("tr", (!on ? "off" : st.cleared ? "cleared" : ""));

      function cell(node, cls) {
        var td = el("td", cls);
        if (node) td.append(node);
        tr.append(td);
        return td;
      }

      var cb = el("input");
      cb.type = "checkbox"; cb.checked = on;
      cb.setAttribute("data-fkey", d.id + ":on");
      cb.title = on ? "Stop tracking this one" : "Track this one again";
      cb.onchange = function () { d.active = cb.checked; commit(); };
      cell(cb);

      var nm = el("input");
      nm.type = "text"; nm.value = d.name;
      nm.setAttribute("data-fkey", d.id + ":dname");
      nm.oninput = function () { d.name = nm.value; commit(); };
      cell(nm);

      cell(moneyField(d.id + ":start", d.startedAt, function (v) {
        d.startedAt = v === null ? 0 : v; commit();
      }), "num");

      cell(moneyField(d.id + ":owed", d.owed, function (v) {
        d.owed = v === null ? 0 : v; commit();
      }), "num");

      cell(moneyField(d.id + ":pay", d.payment, function (v) {
        d.payment = v === null ? 0 : v; commit();
      }), "num");

      var apr = el("input");
      apr.type = "text";
      apr.className = "money apr";
      apr.setAttribute("inputmode", "decimal");
      apr.setAttribute("data-fkey", d.id + ":apr");
      apr.value = (d.apr || 0) ? (+d.apr).toFixed(2) + "%" : "";
      apr.placeholder = "0%";
      apr.title = "Yearly rate. Leave blank if it doesn't charge interest.";
      apr.onfocus = function () { apr.value = (d.apr || 0) ? String(d.apr) : ""; apr.select(); };
      apr.oninput = function () {
        d.apr = parseFloat(String(apr.value).replace(/[%\s]/g, "")) || 0;
        commit();
      };
      apr.onblur = function () { apr.value = d.apr ? (+d.apr).toFixed(2) + "%" : ""; };
      cell(apr, "num");

      // The link. A debt's Monthly is load-bearing — it's what the payoff maths
      // runs on — so linking never overwrites it. It flags a mismatch instead.
      var lc = linkCell(state, d, commit, null, "debt");
      var bill = findBill(state, d.billId);
      if (bill && bill.active !== false) {
        var billMo = round2(E.monthlyEquivalent(bill));
        if (Math.abs(billMo - (d.payment || 0)) > 0.5) {
          var mm = el("span", "sub warn",
            "bill is " + E.money(billMo, { cents: false }) + "/mo");
          mm.title = "The bill funds " + E.money(billMo) + " a month but Monthly says " +
            E.money(d.payment || 0) + ". Clear by is worked out from Monthly.";
          lc.append(mm);
        }
      }
      cell(lc);

      var bar = el("div", "dbar");
      bar.title = E.money(st.paid) + " paid of " + E.money(st.started);
      var bf = document.createElement("i");
      bf.style.width = (st.frac * 100) + "%";
      bar.append(bf);
      cell(bar);

      var pct = el("div", "num");
      pct.innerHTML = "<div>" + Math.round(st.frac * 100) + "%</div>" +
        '<span class="sub">' + E.money(st.paid, { cents: false }) + "</span>";
      cell(pct, "num");

      var clear = el("div");
      if (!on) clear.append(el("span", "flag", "not tracked"));
      else if (st.cleared) clear.append(el("span", "flag ok", "✓ cleared"));
      else if (st.stuck) clear.append(el("span", "flag tight", "! never, at this payment"));
      else {
        clear.append(el("div", null, st.when
          ? st.when.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" })
          : "—"));
        clear.append(el("span", "sub", monthsLabel(st.months) +
          (d.apr ? "  ·  " + E.money(st.interest, { cents: false }) + " interest" : "")));
      }
      cell(clear);

      var rm = el("button", "icon ghost", "✕");
      rm.title = "Delete " + d.name;
      rm.onclick = function () {
        if (!confirm("Delete “" + d.name + "”? Untick it instead to stop tracking without losing it.")) return;
        state.debts.splice(state.debts.indexOf(d), 1);
        commit();
      };
      cell(rm);

      tb.append(tr);
    });

    var tf = el("tr", "totals");
    tf.innerHTML = "<td></td><td>Totals</td>" +
      "<td class='num'>" + E.money(started) + "</td>" +
      "<td class='num'>" + E.money(owed) + "</td>" +
      "<td class='num'>" + E.money(monthly) + "</td>" +
      "<td></td><td></td><td></td>" +
      "<td class='num'>" + (started > 0 ? Math.round((paid / started) * 100) + "%" : "—") + "</td>" +
      "<td>" + (cleared ? cleared + " cleared" : "") + "</td><td></td>";
    tb.append(tf);

    t.append(tb);
    scroll.append(t);
    host.append(scroll);

    var add = el("button", "primary", "+ Add a debt");
    add.style.marginTop = "14px";
    add.onclick = function () {
      state.debts.push({
        id: newId("d-", state.debts), name: "New debt",
        startedAt: 0, owed: 0, payment: 0, apr: 0, billId: null, active: true
      });
      commit();
      setTimeout(function () {
        var all = document.querySelectorAll('[data-fkey$=":dname"]');
        var last = all[all.length - 1];
        if (last) { last.focus(); last.select(); }
      }, 0);
    };
    host.append(add);

    function commit() { saveState(state); preserveFocus(rerender); }
  }
  function monthsLabel(n) {
    if (!isFinite(n)) return "never";
    if (n <= 0) return "now";
    if (n < 12) return n + " month" + (n === 1 ? "" : "s");
    var y = Math.floor(n / 12), m = n % 12;
    return y + "y" + (m ? " " + m + "m" : "");
  }

  function tile(k, v, n, cls, hero) {
    return '<div class="tile' + (hero ? " hero" : "") + '"><div class="k">' + k +
      '</div><div class="v ' + (cls || "") + '">' + v + '</div><div class="n">' + n + "</div></div>";
  }

  global.BudgetUI = {
    loadState: loadState, saveState: saveState, resetState: resetState,
    isEdited: isEdited, downloadDataFile: downloadDataFile, isTouchScreen: isTouchScreen,
    stampSource: stampSource, sourceLabel: sourceLabel,
    readBudgetFile: readBudgetFile, parseBudget: parseBudget, normalizeState: normalizeState,
    initTheme: initTheme, cssVar: cssVar, catColor: catColor, el: el,
    monthNav: monthNav, paydayControl: paydayControl,
    moneyField: moneyField, parseMoney: parseMoney, moneyText: moneyText,
    renderIncomeEditor: renderIncomeEditor, renderBillEditor: renderBillEditor,
    renderBillGrid: renderBillGrid, renderIncomeGrid: renderIncomeGrid,
    preserveFocus: preserveFocus, newId: newId,
    renderPaychecks: renderPaychecks, renderCalendar: renderCalendar,
    renderPayStrip: renderPayStrip, renderPayCards: renderPayCards,
    renderDueCalendar: renderDueCalendar, renderDebts: renderDebts,
    renderSavings: renderSavings, syncLinks: syncLinks,
    debtStats: debtStats, goalStats: goalStats,
    billPaid: billPaid, setBillPaid: setBillPaid, payRows: payRows, payByBill: payByBill,
    renderRunway: renderRunway, renderCategoryTable: renderCategoryTable,
    cadenceLabel: cadenceLabel
  };

})(window);
