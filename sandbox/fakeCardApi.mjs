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

  window.CardAPI = {
    cardId: 'sandbox-card',
    additionalArguments: null,

    Properties: {
      // Same shapes as the real host (src/CardAPI.js): *Many take/return
      // arrays of { name, value }. Each call counts once in __apiCounts — one
      // host call each in the real app — and a Get/GetMany of a property
      // that doesn't exist is counted separately, since the real host never
      // caches a miss (every one is a QueryProperties server request).
      Get: (name) => {
        _count("Properties.Get");
        if (_props[name] === undefined) _count("server request: lookup of missing property");
        return _get(name);
      },
      GetMany: (names) => {
        _count("Properties.GetMany");
        const list = Array.isArray(names) ? names : [names];
        if (list.some((n) => _props[n] === undefined)) _count("server request: lookup of missing property");
        return Promise.all(list.map(_get)).then((found) => found.filter(Boolean));
      },
      GetProperties: () => {
        _count("Properties.GetProperties");
        return Promise.resolve(Object.keys(_props).map((name) => ({ name, value: _props[name] })));
      },
      Set: (name, value) => {
        _count("Properties.Set");
        return _set(name, value);
      },
      SetMany: (list) => {
        _count("Properties.SetMany");
        return Promise.all((list || []).map((p) => _set(p.name, p.value)));
      },
      Init: (name, value) => {
        _count("Properties.Init");
        if (_props[name] === undefined) _count("server request: lookup of missing property");
        return _init(name, value);
      },
      InitMany: (list) => {
        _count("Properties.InitMany");
        if ((list || []).some((p) => _props[p.name] === undefined)) _count("server request: lookup of missing property");
        return Promise.all((list || []).map((p) => _init(p.name, p.value)));
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
        GetProperties: () => Promise.resolve([]),
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

    SendChatMessage: (message) => { log('SendChatMessage', message); },
    FireAction: (action, args) => { log('FireAction', { action, args }); },
    SendCustomCommandToServer: (command, data) => { log('SendCustomCommandToServer', { command, data }); },

    SubscribeWebSocket: () => {},
    UnsubscribeWebSocket: () => {},
  };

  // Exposed for Playwright's page.evaluate() inspection — not part of the
  // real CardAPI surface, sandbox-only.
  window.__sandboxProps = _props;
})();
</script>`;
