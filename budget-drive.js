/* ============================================================================
   budget-drive.js — optional sync to the signed-in viewer's own Google Drive.

   Kept separate from everything else: budget.html wires up the connect/
   disconnect UI, and budget-ui.js's own saveState — the one place every
   edit already funnels through — calls BudgetDrive.queuePush(state) if this
   file happens to be loaded (one guarded line there; see its saveState).
   With this file absent, or with the viewer never connecting, the tool
   behaves exactly as it always has.

   Each person's budget lives in a file in THEIR OWN Drive, created by this
   app under the drive.file scope — which means this app can only ever see
   files it created (or files a person explicitly picks with it), never
   anything else in their Drive. Nothing is shared between accounts; there is
   no server here beyond Google's own.

   A person can have more than one budget in their Drive (a household one,
   a "what if" draft, whatever) — each is its own JSON file. The first one
   connect() finds or makes is named budget-data.json; listBudgets/
   createBudget/switchBudget manage the rest. Whichever file id is current
   (LS_FILEID) is what pull()/push() read and write.

   Requires the page to be served over https:// — Google's sign-in library
   refuses to authenticate a file:// page. On a local file, connect() reports
   that plainly instead of trying.
============================================================================ */

(function (global) {
  "use strict";

  var CLIENT_ID = "696291290439-h3t8a8323uitp0ohsuaplgcsbis8a7eq.apps.googleusercontent.com";
  var SCOPES = "https://www.googleapis.com/auth/drive.file " +
               "https://www.googleapis.com/auth/userinfo.email";
  var FILE_NAME = "budget-data.json";
  var API = "https://www.googleapis.com/drive/v3/files";
  var UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

  var LS_CONNECTED = "budget-drive-connected";
  var LS_FILEID     = "budget-drive-fileid";
  var LS_FILENAME   = "budget-drive-filename";
  var LS_EMAIL      = "budget-drive-email";

  var tokenClient = null;
  var accessToken = null;
  var tokenExpiresAt = 0;
  var listeners = [];
  var pushTimer = null;
  var pushing = false;
  var pendingState = null;

  function emit(status) { listeners.forEach(function (fn) { fn(status); }); }
  function onStatus(fn) { listeners.push(fn); }

  function ls(key) { try { return localStorage.getItem(key); } catch (err) { return null; } }
  function lsSet(key, v) { try { localStorage.setItem(key, v); } catch (err) {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (err) {} }

  function isConnected() { return ls(LS_CONNECTED) === "1"; }
  function connectedEmail() { return ls(LS_EMAIL) || ""; }
  function currentBudgetName() { return ls(LS_FILENAME) || FILE_NAME; }

  // ------------------------------------------------------------ sign-in ---

  function loadGis(done) {
    if (global.google && global.google.accounts && global.google.accounts.oauth2) { done(true); return; }
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true;
    s.onload = function () { done(true); };
    s.onerror = function () { done(false); };
    document.head.append(s);
  }

  function ensureClient(cb) {
    if (location.protocol !== "https:") {
      cb(new Error("Google Drive only connects when this page is opened over the web (https://), not from a local file."));
      return;
    }
    loadGis(function (ok) {
      if (!ok) { cb(new Error("Couldn't reach Google's sign-in service. Check your connection.")); return; }
      if (!tokenClient) {
        try {
          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID, scope: SCOPES, callback: function () {}
          });
        } catch (err) {
          cb(new Error("Google sign-in didn't start: " + err.message));
          return;
        }
      }
      cb(null);
    });
  }

  // interactive: shows Google's consent popup if a fresh grant is needed.
  // Silent (interactive=false) only succeeds if already granted and still
  // signed into Google in this browser — used to reconnect without asking.
  function getToken(interactive, cb) {
    ensureClient(function (err) {
      if (err) { cb(err); return; }
      if (accessToken && Date.now() < tokenExpiresAt - 30000) { cb(null, accessToken); return; }
      tokenClient.callback = function (resp) {
        if (resp && resp.error) {
          cb(new Error(resp.error === "access_denied" ? "Access wasn't granted." : resp.error));
          return;
        }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
        cb(null, accessToken);
      };
      tokenClient.error_callback = function (err) {
        cb(new Error(err && err.message ? err.message : "Sign-in didn't complete."));
      };
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    });
  }

  function whoAmI(token, cb) {
    fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + token }
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { cb(j && j.email ? j.email : ""); })
      .catch(function () { cb(""); });
  }

  // -------------------------------------------------------------- drive ---

  function api(url, token, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers.Authorization = "Bearer " + token;
    return fetch(url, opts).then(function (r) {
      if (!r.ok) return r.text().then(function (t) {
        throw new Error("Drive error " + r.status + (t ? ": " + t.slice(0, 200) : ""));
      });
      return r;
    });
  }

  // Finds this app's budget file in the signed-in Drive, or creates an empty
  // one. drive.file scope only shows files this app created (or that the
  // person opened with it), which is exactly the search space we want.
  function findOrCreateFile(token, cb) {
    var cached = ls(LS_FILEID);
    function create() {
      api(API, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: FILE_NAME })
      }).then(function (r) { return r.json(); })
        .then(function (f) { lsSet(LS_FILEID, f.id); lsSet(LS_FILENAME, FILE_NAME); cb(null, f.id, true); })
        .catch(function (err) { cb(err); });
    }
    function verify(id) {
      api(API + "/" + id + "?fields=id,trashed,name", token).then(function (r) { return r.json(); })
        .then(function (f) {
          if (f && !f.trashed) { if (f.name) lsSet(LS_FILENAME, f.name); cb(null, id, false); }
          else search();
        })
        .catch(function () { search(); });
    }
    function search() {
      var q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
      api(API + "?q=" + q + "&spaces=drive&fields=files(id,name)", token).then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.files && j.files.length) {
            lsSet(LS_FILEID, j.files[0].id); lsSet(LS_FILENAME, j.files[0].name);
            cb(null, j.files[0].id, false);
          } else create();
        }).catch(function (err) { cb(err); });
    }
    if (cached) verify(cached); else search();
  }

  // ------------------------------------------------------- other budgets --
  // A person can keep more than one budget in their Drive. These manage the
  // list and switch which file id pull()/push() read and write.

  function blankBudget(name) {
    return {
      meta: {
        household: name || "Budget",
        openingBalance: 0,
        payFrequency: "weekly",
        payAnchor: new Date().toISOString().slice(0, 10)
      },
      incomes: [], goals: [], debts: [], bills: []
    };
  }

  function sanitizeFileName(name) {
    name = (name || "").trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
    return name || "Untitled budget";
  }

  // Every JSON file this app can see in the person's Drive — everything
  // drive.file scope shows us is, by construction, something this app made.
  function listBudgets(cb) {
    getToken(false, function (err, token) {
      if (err) { cb(err); return; }
      var q = encodeURIComponent("mimeType='application/json' and trashed=false");
      api(API + "?q=" + q + "&spaces=drive&fields=files(id,name,modifiedTime)&orderBy=name", token)
        .then(function (r) { return r.json(); })
        .then(function (j) { cb(null, j.files || []); })
        .catch(function (err) { cb(err); });
    });
  }

  function createBudget(name, cb) {
    getToken(false, function (err, token) {
      if (err) { cb(err); return; }
      var fname = sanitizeFileName(name) + ".json";
      var data = blankBudget(name);
      api(API, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fname })
      }).then(function (r) { return r.json(); })
        .then(function (f) {
          api(UPLOAD_API + "/" + f.id + "?uploadType=media", token, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
          }).then(function () {
            lsSet(LS_FILEID, f.id); lsSet(LS_FILENAME, fname);
            cb(null, { id: f.id, name: fname, data: data });
          }).catch(function (err) { cb(err); });
        }).catch(function (err) { cb(err); });
    });
  }

  // Points pull()/push() at a different file already in Drive and reads it.
  function switchBudget(fileId, name, cb) {
    getToken(false, function (err, token) {
      if (err) { cb(err); return; }
      api(API + "/" + fileId + "?alt=media", token).then(function (r) { return r.text(); })
        .then(function (text) {
          var data = null;
          if (text && text.trim()) {
            try { data = JSON.parse(text); }
            catch (err2) { cb(new Error("That file in Drive isn't readable as a budget.")); return; }
          }
          lsSet(LS_FILEID, fileId);
          if (name) lsSet(LS_FILENAME, name);
          cb(null, data);
        }).catch(function (err) { cb(err); });
    });
  }

  function pull(cb) {
    getToken(false, function (err, token) {
      if (err) { cb(err); return; }
      findOrCreateFile(token, function (err, fileId, isNew) {
        if (err) { cb(err); return; }
        if (isNew) { cb(null, null); return; }   // brand new file: nothing to pull yet
        api(API + "/" + fileId + "?alt=media", token)
          .then(function (r) { return r.text(); })
          .then(function (text) {
            if (!text || !text.trim()) { cb(null, null); return; }
            try { cb(null, JSON.parse(text)); }
            catch (err) { cb(new Error("The file in Drive isn't readable as a budget.")); }
          })
          .catch(function (err) { cb(err); });
      });
    });
  }

  function push(state, cb) {
    getToken(false, function (err, token) {
      if (err) { cb(err); return; }
      findOrCreateFile(token, function (err, fileId) {
        if (err) { cb(err); return; }
        api(UPLOAD_API + "/" + fileId + "?uploadType=media", token, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state),
          keepalive: true   // so a save started right as the tab closes can still land
        }).then(function () { cb(null); }).catch(function (err) { cb(err); });
      });
    });
  }

  // Debounced: money fields fire on every keystroke, and each one calls
  // saveState — this waits for a pause before actually writing to Drive.
  function queuePush(state) {
    if (!isConnected()) return;
    pendingState = state;
    emit({ state: "pending" });
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flushPush, 1500);
  }

  // A backgrounded tab can have its timers frozen before the 1500ms debounce
  // ever fires — switching apps on a phone right after an edit is the normal
  // way to lose one. Flush immediately whenever the page is about to stop
  // being visible, instead of waiting on the timer.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && pendingState) { clearTimeout(pushTimer); flushPush(); }
    });
    window.addEventListener("pagehide", function () {
      if (pendingState) { clearTimeout(pushTimer); flushPush(); }
    });
  }

  function flushPush() {
    if (pushing || !pendingState) return;
    pushing = true;
    var state = pendingState;
    emit({ state: "syncing" });
    push(state, function (err) {
      pushing = false;
      if (err) {
        emit({ state: "error", error: err.message });
        return;   // left queued; the next edit (or a manual retry) tries again
      }
      pendingState = (state === pendingState) ? null : pendingState;
      emit({ state: "synced", at: new Date() });
      if (pendingState) flushPush();   // something changed mid-push
    });
  }

  // ----------------------------------------------------------- public API -

  // First connect: interactive sign-in, then either pull what's already in
  // Drive (name it) or push what's here now (a brand-new file).
  function connect(cb) {
    emit({ state: "connecting" });
    getToken(true, function (err, token) {
      if (err) { emit({ state: "error", error: err.message }); cb(err); return; }
      whoAmI(token, function (email) {
        lsSet(LS_CONNECTED, "1");
        if (email) lsSet(LS_EMAIL, email);
        findOrCreateFile(token, function (err, fileId, isNew) {
          if (err) { emit({ state: "error", error: err.message }); cb(err); return; }
          if (isNew) {
            emit({ state: "synced", at: new Date(), email: email });
            cb(null, { remote: null, email: email });
          } else {
            pull(function (err, data) {
              if (err) { emit({ state: "error", error: err.message }); cb(err); return; }
              emit({ state: "synced", at: new Date(), email: email });
              cb(null, { remote: data, email: email });
            });
          }
        });
      });
    });
  }

  // Silent reconnect on page load, for a device that connected before.
  // Never shows Google UI; if it can't get a token quietly, just reports
  // disconnected rather than interrupting the page.
  function autoConnect(cb) {
    if (!isConnected()) { cb(null, null); return; }
    emit({ state: "connecting" });
    getToken(false, function (err, token) {
      if (err) { emit({ state: "disconnected" }); cb(null, null); return; }
      pull(function (err, data) {
        if (err) { emit({ state: "error", error: err.message }); cb(null, null); return; }
        emit({ state: "synced", at: new Date(), email: connectedEmail() });
        cb(null, data);
      });
    });
  }

  function disconnect() {
    if (accessToken && global.google) {
      try { google.accounts.oauth2.revoke(accessToken, function () {}); } catch (err) {}
    }
    accessToken = null; tokenExpiresAt = 0;
    lsDel(LS_CONNECTED); lsDel(LS_FILEID); lsDel(LS_EMAIL);
    emit({ state: "disconnected" });
  }

  global.BudgetDrive = {
    isConnected: isConnected,
    connectedEmail: connectedEmail,
    currentBudgetName: currentBudgetName,
    connect: connect,
    autoConnect: autoConnect,
    disconnect: disconnect,
    queuePush: queuePush,
    onStatus: onStatus,
    listBudgets: listBudgets,
    createBudget: createBudget,
    switchBudget: switchBudget
  };
})(window);
