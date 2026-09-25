// fakeCardApi.mjs
//
// A trimmed adaptation of the REAL bridge script
// (NordvikManagerFrontEnd/src/components/game/panels/cardSandbox.js's
// SANDBOX_BRIDGE_SCRIPT) for use OUTSIDE the main app. Same window.CardAPI
// surface the runtime actually calls (grep-confirmed against every
// card_sources/roll20compat-shared/runtime/*.js file: Properties.Get/Init/
// Set/Subscribe/Unsubscribe, Properties.List.Add/Remove/Update/Reorder,
// Resources.Global.Read, SendChatMessage, Subscribe/UnsubscribeWebSocket) —
// but backed by an in-memory store with synchronous (Promise-wrapped)
// resolution instead of postMessage to a real parent frame.
//
// Deliberately NOT faithful to: real network races (a real Properties.Init
// is fire-and-forget over the wire — the two known races documented in
// attrBinding.js/repeatingBinding.js this session came from THAT gap, not
// from this store's own behavior). Good enough for CSS/DOM correctness and
// binding-behavior checks (does a field seed/display its authored default,
// does a repeating row actually get added), not a substitute for the real
// app's final live check.
export const FAKE_CARD_API_SCRIPT = `<script>
(function () {
  'use strict';

  window.__sandboxLog = [];
  // Per-method call counts — in the real app every CardAPI call is a
  // postMessage round trip to the host, and most become a server request,
  // so these are the numbers to watch for load/interaction cost.
  window.__apiCounts = {};
  const _count = (method) => { window.__apiCounts[method] = (window.__apiCounts[method] || 0) + 1; };
  function log(kind, detail) { window.__sandboxLog.push({ kind, detail, t: Date.now() }); }

  const _props = {};       // name -> value (string)
  const _propSubs = {};    // name -> callback[]
  let _rowCounter = 0;

  function _notify(name) {
    const value = _props[name];
    const propData = value === undefined ? null : { name, value };
    (_propSubs[name] || []).forEach((cb) => {
      try { cb(propData); } catch (e) { console.error('sandbox prop subscriber error', e); }
    });
  }

  function _get(name) {
    return Promise.resolve(_props[name] === undefined ? null : { name, value: _props[name] });
  }
  function _set(name, value) {
    _props[name] = value;
    _notify(name);
    return Promise.resolve({ name, value });
  }
  function _init(name, value) {
    if (_props[name] === undefined) {
      _props[name] = value;
      _notify(name);
    }
    return Promise.resolve({ name, value: _props[name] });
  }
  function _remove(name) {
    delete _props[name];
    _notify(name);
    return Promise.resolve(true);
  }

  function _readList(name) {
    try { return JSON.parse(_props[name] || '[]'); } catch (e) { return []; }
  }
  function _writeList(name, items) {
    _props[name] = JSON.stringify(items);
    _notify(name);
  }

  // The real host's property cache (src/CardAPI.js _propertyCache).
  const _hostCached = new Set();
  let _hostWarm = false;
  function _warmHost() {
    if (_hostWarm) return;
    _hostWarm = true;
    Object.keys(_props).forEach((n) => _hostCached.add(n));
  }
  function _hostLookup(names) {
    _warmHost();
    const uncached = names.filter((n) => !_hostCached.has(n));
    if (!uncached.length) return;
    _count("server request: QueryProperties");
    uncached.forEach((n) => { if (_props[n] !== undefined) _hostCached.add(n); });
  }
  // Fire-and-forget websocket Add: the server creates it, and the host caches
  // it when the property_add echo arrives.
  function _hostAdd(name, value) {
    _count("server request: Add (websocket)");
    setTimeout(() => {
      if (_props[name] === undefined) _props[name] = value;
      _hostCached.add(name);
      _notify(name);
    }, 30);
  }
  function _hostInitMany(list) {
    _hostLookup(list.map((p) => p.name));
    list.forEach((p) => { if (_props[p.name] === undefined) _hostAdd(p.name, p.value); });
    return Promise.resolve();
  }
  // Every name written through Set/SetMany (the sheet's scripts or a
  // player) — check.mjs doesn't expect those to show their HTML default.
  window.__sandboxWritten = [];
  function _hostSetMany(list) {
    list.forEach((p) => window.__sandboxWritten.push(p.name));
    _hostLookup(list.map((p) => p.name));
    list.forEach((p) => {
      if (_hostCached.has(p.name)) _set(p.name, p.value);
      else _hostAdd(p.name, p.value);
    });
    return Promise.resolve();
  }

  window.CardAPI = {
    cardId: 'sandbox-card',
    additionalArguments: null,

    Properties: {
      // Same shapes as the real host (src/CardAPI.js): *Many take/return
      // arrays of { name, value }. Each call counts once in __apiCounts — one
      // host call each in the real app.
      //
      // Also models the real host's own cache, which is what decides server
      // traffic: it's warmed once at startup (InitApi), and a Get/GetMany/
      // Init/Set of a name it doesn't hold is a QueryProperties request.
      // Properties.Add is a fire-and-forget websocket command there — the
      // host only learns the new property from the server's property_add
      // echo a moment later — so a brand-new card's fields stay uncached
      // until then. Counted as "server request: QueryProperties" and
      // "server request: Add (websocket)".
      Get: (name) => {
        _count("Properties.Get");
        _hostLookup([name]);
        return _get(name);
      },
      GetMany: (names) => {
        _count("Properties.GetMany");
        const list = Array.isArray(names) ? names : [names];
        _hostLookup(list);
        return Promise.all(list.map(_get)).then((found) => found.filter(Boolean));
      },
      Set: (name, value) => {
        _count("Properties.Set");
        return window.CardAPI.Properties.SetMany._impl([{ name, value }]);
      },
      SetMany: (list) => {
        _count("Properties.SetMany");
        return window.CardAPI.Properties.SetMany._impl(list || []);
      },
      Init: (name, value) => {
        _count("Properties.Init");
        return window.CardAPI.Properties.InitMany._impl([{ name, value }]);
      },
      InitMany: (list) => {
        _count("Properties.InitMany");
        return window.CardAPI.Properties.InitMany._impl(list || []);
      },
      Remove: _remove,

      Subscribe: (name, cb) => {
        if (!_propSubs[name]) _propSubs[name] = [];
        _propSubs[name].push(cb);
      },
      Unsubscribe: (name, cb) => {
        const arr = _propSubs[name];
        if (!arr) return;
        const i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      },

      // See src/CardAPI.js's Properties.List for the full real contract
      // (stable per-row ids, Init(name, "[]") required first) — this
      // reproduces just enough of it against the in-memory store above.
      List: Object.freeze({
        Add: (name, fields, itemId) => {
          const items = _readList(name);
          const id = itemId || ('sandboxrow' + (++_rowCounter));
          items.push({ id, fields: fields || {} });
          _writeList(name, items);
          log('Properties.List.Add', { name, id, fields });
          return Promise.resolve({ id, fields });
        },
        Remove: (name, itemId) => {
          const items = _readList(name).filter((it) => it.id !== itemId);
          _writeList(name, items);
          log('Properties.List.Remove', { name, itemId });
          return Promise.resolve(true);
        },
        Update: (name, itemId, fields) => {
          const items = _readList(name);
          const item = items.find((it) => it.id === itemId);
          if (item) item.fields = Object.assign({}, item.fields, fields);
          _writeList(name, items);
          log('Properties.List.Update', { name, itemId, fields });
          return Promise.resolve(item || null);
        },
        Reorder: (name, orderedItemIds) => {
          const items = _readList(name);
          const byId = {};
          items.forEach((it) => { byId[it.id] = it; });
          const reordered = (orderedItemIds || []).map((id) => byId[id]).filter(Boolean);
          _writeList(name, reordered);
          log('Properties.List.Reorder', { name, orderedItemIds });
          return Promise.resolve(true);
        },
      }),

      // Not exercised by the generic runtime today (grep-confirmed), kept
      // only so a sheet script that happens to touch it doesn't throw.
      Global: Object.freeze({
        Get: (parentId, name) => _get(name),
        GetMany: (parentId, names) => Promise.all((names || []).map(_get)),
        GetByNames: (parentId, names) => Promise.all((names || []).map(_get)),
        // Mirrors the REAL bridge: it has no scoped Properties.GetProperties
        // (a fake that did hid a live bug — the property store fell back to
        // one request per field), only this one, for any card id.
        GetProperties: (parentId) => {
          _count("Properties.Global.GetProperties");
          return Promise.resolve(parentId === "sandbox-card" ? Object.keys(_props).map((name) => ({ name, value: _props[name] })) : []);
        },
        Set: (parentId, name, val) => _set(name, val),
        SetMany: (parentId, list) => Promise.all((list || []).map((p) => _set(p.name, p.value))),
        Init: (parentId, name, val) => _init(name, val),
        InitMany: (parentId, list) => Promise.all((list || []).map((p) => _init(p.name, p.value))),
        Remove: (parentId, name) => _remove(name),
        Subscribe: () => {},
        Unsubscribe: () => {},
      }),
    },

    Resources: {
      Create: () => Promise.resolve(null),
      Read: () => Promise.resolve(null),
      Update: () => Promise.resolve(null),
      Delete: () => Promise.resolve(null),
      Upsert: () => Promise.resolve(null),
      Global: Object.freeze({
        Create: () => Promise.resolve(null),
        // translationFill.js no longer calls this in practice — the
        // packager embeds the translation bundle directly into the page
        // (window.Roll20CompatConfig.translationBundle), read synchronously
        // instead, precisely to avoid a race this RPC path can't win
        // against a real worker script's own synchronous top-level code
        // (see translationFill.js's own header for the full story). Kept
        // here only as a fallback for a Template built by hand without the
        // packager — resolves null, same as a sheet with no translation.
        Read: () => Promise.resolve(null),
        Update: () => Promise.resolve(null),
        Delete: () => Promise.resolve(null),
        Upsert: () => Promise.resolve(null),
      }),
    },

    ClientMediator: {
      sendCommand: () => Promise.resolve(null),
      sendCommandAsync: () => Promise.resolve(null),
      register: () => Promise.resolve(null),
    },

    // Roll now, post later (the real one is the backend's RollsController via
    // src/CardAPI.js Rolls). Start rolls deterministically — every die shows
    // ceil(sides / 2), so 1d100 is 50 and 2d6 is 3+3 — and Finish just
    // records what would be posted, in __sandboxLog as "Rolls.Finish".
    Rolls: {
      Start: (formulas) => {
        _count('Rolls.Start');
        log('Rolls.Start', formulas);
        const results = (formulas || []).map(function (f) {
          const dices = [];
          // No backslashes in here: this whole script is a template literal,
          // where "\d" silently becomes "d".
          const expr = String(f.formula).replace(/([0-9]*)d([0-9]+)/g, function (_, count, sides) {
            const n = Number(count || 1);
            const s = Number(sides);
            const values = [];
            for (let i = 0; i < n; i++) {
              const v = Math.ceil(s / 2);
              values.push(v);
              dices.push({ index: dices.length, diceValue: s, times: 1, result: v, kept: true });
            }
            return '(' + values.join('+') + ')';
          });
          let result = 0;
          if (/^[-0-9+*/(). ]+$/.test(expr)) result = Math.round(Function('return (' + expr + ')')());
          return { key: f.key, roll: { result: result, rolled: f.formula, dices: dices } };
        });
        return Promise.resolve({ rollId: 'sandbox-roll-' + (++_rowCounter), results: results });
      },
      Finish: (payload) => {
        _count('Rolls.Finish');
        log('Rolls.Finish', payload);
        return Promise.resolve();
      },
    },

    SendChatMessage: (message) => { log('SendChatMessage', message); },
    FireAction: (action, args) => { log('FireAction', { action, args }); },
    SendCustomCommandToServer: (command, data) => { log('SendCustomCommandToServer', { command, data }); },

    SubscribeWebSocket: () => {},
    UnsubscribeWebSocket: () => {},
  };

  window.CardAPI.Properties.SetMany._impl = _hostSetMany;
  window.CardAPI.Properties.InitMany._impl = _hostInitMany;

  // Exposed for Playwright's page.evaluate() inspection — not part of the
  // real CardAPI surface, sandbox-only.
  window.__sandboxProps = _props;
})();
</script>`;
