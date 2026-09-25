// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// propertyStore.js: wraps window.CardAPI in a facade with the same
// Properties surface, backed by a local copy of this card's properties, so
// the rest of the runtime keeps calling Properties.Get/Set/Init unchanged
// while the traffic to the host collapses:
//
//   - Get/GetMany are answered locally. The whole card is loaded once with
//     Properties.GetProperties (the host's cache is warmed with every
//     property when the card opens), so "this attribute doesn't exist" is
//     known locally too — the host never caches a miss, so every getAttrs
//     of a never-set attribute used to be a QueryProperties request, on
//     every call (335 per open of Warhammer Fantasy Roleplay 4e alone).
//   - Init calls made in the same tick are sent as ONE InitMany, and only
//     for properties that don't already exist. One Init per field meant one
//     QueryProperties request per field on a new character (~1500 for Call
//     of Cthulhu 7e).
//   - Set calls made in the same tick are sent as ONE SetMany, skipping
//     values that haven't changed (compared as strings — see normalizeValue) (a setAttrs of 40 computed values was 40
//     separate host calls).
//
// The copy stays current from the frame's own property events: the host
// forwards every add/update/remove for this card into the frame, and
// Subscribe is local to the frame, so the store subscribes to every name it
// has answered about (including missing ones — a later add then updates it).
//
// Writes are optimistic locally; subscribers are still only notified by the
// server's echo, exactly as before. A Set batch waits for any in-flight Init
// batch, so the two can never both create the same new property.
(function (global) {
  "use strict";
  const Roll20Compat = (global.Roll20Compat = global.Roll20Compat || {});

  // Collects items added in the same tick and hands them to flush() once, in
  // a microtask. Every caller's promise settles with that one flush.
  function createBatcher(flush) {
    let queue = null;
    return (item) =>
      new Promise((resolve, reject) => {
        if (!queue) {
          queue = [];
          Promise.resolve().then(() => {
            const batch = queue;
            queue = null;
            Promise.resolve()
              .then(() => flush(batch.map((entry) => entry.item)))
              .then(
                (result) => batch.forEach((entry) => entry.resolve(result)),
                (err) => batch.forEach((entry) => entry.reject(err))
              );
          });
        }
        queue.push({ item, resolve, reject });
      });
  }

  // Values are compared and SENT as strings, but kept locally with the type
  // the sheet script wrote. Both matter, and WFRP4CharSheet's version
  // migration needs both (it re-runs until typeof getAttrs().version is
  // "number"):
  //   - A loose == (what the host's own Set/SetMany use) says "" == 0, so a
  //     write of 0 over an empty value was dropped as "unchanged" and the
  //     script wrote it again forever. Compared and sent as strings,
  //     "" -> "0" is a real change for this store and for the host alike.
  //   - Roll20 hands values back with the type they were written with. The
  //     backend stores strings, so its echo of a written 0 is "0"; an echo
  //     (or a re-write) that matches the local value as a string therefore
  //     keeps the local, typed value instead of replacing it.
  function normalizeValue(value) {
    return value == null ? "" : String(value);
  }

  // Last write per name wins within one batch.
  function dedupeByName(items) {
    const byName = new Map();
    for (const item of items) byName.set(item.name, item);
    return [...byName.values()];
  }

  /**
   * Returns a CardAPI facade whose Properties.Get/GetMany/Init/InitMany/
   * Set/SetMany/Remove go through a local store. Everything else (List.*,
   * Subscribe, Global, Resources, chat, ...) is the original API.
   */
  function wrap(cardApi) {
    const props = cardApi.Properties;
    const store = new Map(); // name -> property DTO ({ name, value, id, ... })
    const tracked = new Set();
    let fallback = false; // GetProperties unavailable: pass everything through

    const onEvent = (name) => (prop) => {
      if (!prop) {
        store.delete(name);
        return;
      }
      const local = store.get(name);
      const keepTyped = local && normalizeValue(local.value) === normalizeValue(prop.value);
      store.set(name, { ...(local || {}), ...prop, name, value: keepTyped ? local.value : prop.value });
    };
    const track = (name) => {
      if (tracked.has(name)) return;
      tracked.add(name);
      props.Subscribe(name, onEvent(name));
    };

    const loaded = Promise.resolve()
      .then(() => props.GetProperties())
      .then((all) => {
        if (!Array.isArray(all)) throw new Error("GetProperties returned no list");
        for (const prop of all) {
          if (!prop || prop.name == null) continue;
          store.set(prop.name, prop);
          track(prop.name);
        }
      })
      .catch((err) => {
        fallback = true;
        console.warn("Roll20Compat.PropertyStore: falling back to direct CardAPI calls", err);
      });

    // Settles once every Init queued so far has been sent — extended the
    // moment an Init is QUEUED (not when its batch flushes), so a Set queued
    // any time after it always waits for it.
    let initsInFlight = Promise.resolve();

    const queueInit = createBatcher((items) => props.InitMany(dedupeByName(items)));

    const queueSet = createBatcher((items) =>
      initsInFlight.then(() => props.SetMany(dedupeByName(items)))
    );

    const getOne = async (name) => {
      await loaded;
      if (fallback) return props.Get(name);
      track(name);
      return store.get(name) ?? null;
    };

    const getMany = async (names) => {
      await loaded;
      if (fallback) return props.GetMany(names);
      const list = Array.isArray(names) ? names : [names];
      list.forEach(track);
      return list.map((name) => store.get(name)).filter(Boolean);
    };

    const initOne = async (name, value) => {
      const sentValue = normalizeValue(value);
      await loaded;
      if (fallback) return props.Init(name, sentValue);
      track(name);
      if (store.has(name)) return;
      store.set(name, { name, value });
      const sent = queueInit({ name, value: sentValue });
      initsInFlight = Promise.all([initsInFlight, sent.catch(() => {})]);
      await sent;
    };

    const initMany = async (list) => {
      await Promise.all((list || []).map((p) => initOne(p.name, p.value)));
    };

    const setOne = async (name, value) => {
      const sentValue = normalizeValue(value);
      await loaded;
      if (fallback) return props.Set(name, sentValue);
      track(name);
      const current = store.get(name);
      store.set(name, { ...(current || {}), name, value });
      if (current && normalizeValue(current.value) === sentValue) return;
      await queueSet({ name, value: sentValue });
    };

    const setMany = async (list) => {
      await Promise.all((list || []).map((p) => setOne(p.name, p.value)));
    };

    const removeOne = async (name) => {
      await loaded;
      store.delete(name);
      return props.Remove(name);
    };

    const Properties = Object.create(props, {
      Get: { value: getOne },
      GetMany: { value: getMany },
      Init: { value: initOne },
      InitMany: { value: initMany },
      Set: { value: setOne },
      SetMany: { value: setMany },
      Remove: { value: removeOne },
    });
    return Object.create(cardApi, { Properties: { value: Properties } });
  }

  Roll20Compat.PropertyStore = { wrap, createBatcher };
})(typeof window !== "undefined" ? window : globalThis);
