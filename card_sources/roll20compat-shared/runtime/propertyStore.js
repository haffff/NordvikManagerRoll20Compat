// See attrBinding.js's header for the loading model (plain <script>,
// window.Roll20Compat namespace, no bundler).
//
// propertyStore.js: wraps window.CardAPI in a facade with the same
// Properties surface, backed by a local copy of this card's properties, so
// the rest of the runtime keeps calling Properties.Get/Set/Init unchanged
// while the traffic to the host collapses:
//
//   - Get/GetMany are answered locally. The whole card is loaded once with
//     a single GetProperties request (see loadAll below), so "this attribute doesn't exist" is
//     known locally too — the host never caches a miss, so every getAttrs
//     of a never-set attribute used to be a QueryProperties request, on
//     every call (335 per open of Warhammer Fantasy Roleplay 4e alone).
//   - Init only records the default locally — nothing is sent. Like Roll20,
//     an attribute the player never changed isn't stored: it reads as its
//     sheet default, and is created on the server by the first Set that
//     actually changes it. Saving every default made a new character's first
//     open create every field — 3542 websocket Adds for Warhammer 4e
//     Character Sheet — and the server's backlog timed out the
//     QueryProperties requests queued behind it.
//   - The exception is a repeating section's list property: List.* needs it
//     to exist, so the first List operation on a local-only list creates it
//     (see ensureOnServer).
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
    let fallback = false; // the card couldn't be loaded: reads go to the host (still batched)
    // Names whose value here is only the sheet's default: never created on
    // the server by this store (see Init in the header).
    const localOnly = new Set();

    const onEvent = (name) => (prop) => {
      localOnly.delete(name);
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

    // One request for the whole card. The card bridge (NordvikManagerFrontEnd's
    // cardSandbox.js) only gained a scoped GetProperties later — older ones
    // have just Global.GetProperties(parentId), the same single
    // QueryProperties call for this card's id. Without either, the store
    // falls back (below) but still batches.
    const loadAll =
      typeof props.GetProperties === "function"
        ? () => props.GetProperties()
        : () => props.Global.GetProperties(cardApi.cardId);
    const loaded = Promise.resolve()
      .then(loadAll)
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
        console.warn("Roll20Compat.PropertyStore: couldn't load the card's properties; reads go to the host, still batched", err);
      });

    // Settles once every Init queued so far has been sent — extended the
    // moment an Init is QUEUED (not when its batch flushes), so a Set queued
    // any time after it always waits for it.
    let initsInFlight = Promise.resolve();

    const queueInit = createBatcher((items) => props.InitMany(dedupeByName(items)));

    // Fallback only (the card couldn't be loaded): reads made in the same tick
    // become one GetMany — never one host round trip (and, for a property
    // that doesn't exist, one server request) per attribute.
    const queueGet = createBatcher((names) => props.GetMany([...new Set(names)]));
    const fetchOne = (name) => queueGet(name).then((found) => (found || []).find((p) => p && p.name === name) ?? null);

    const queueSet = createBatcher((items) =>
      initsInFlight.then(() => props.SetMany(dedupeByName(items)))
    );

    const getOne = async (name) => {
      await loaded;
      if (fallback) return fetchOne(name);
      track(name);
      return store.get(name) ?? null;
    };

    const getMany = async (names) => {
      await loaded;
      if (fallback) return Promise.all((Array.isArray(names) ? names : [names]).map(fetchOne)).then((all) => all.filter(Boolean));
      const list = Array.isArray(names) ? names : [names];
      list.forEach(track);
      return list.map((name) => store.get(name)).filter(Boolean);
    };

    const initOne = async (name, value) => {
      const sentValue = normalizeValue(value);
      await loaded;
      if (fallback) {
        // Still one InitMany per tick; the host checks what already exists.
        const sent = queueInit({ name, value: sentValue });
        initsInFlight = Promise.all([initsInFlight, sent.catch(() => {})]);
        return sent;
      }
      track(name);
      if (store.has(name)) return;
      store.set(name, { name, value });
      localOnly.add(name);
    };

    // Creates a local-only property (its default) on the server and waits
    // until the host can see it: Properties.Add is fire-and-forget there, and
    // a List operation on a property the server hasn't created yet is lost.
    const ensureOnServer = async (name) => {
      await loaded;
      if (!localOnly.has(name)) return;
      localOnly.delete(name);
      const sent = queueInit({ name, value: normalizeValue(store.get(name)?.value) });
      initsInFlight = Promise.all([initsInFlight, sent.catch(() => {})]);
      await sent;
      for (let i = 0; i < 10; i++) {
        if (await props.Get(name)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const initMany = async (list) => {
      await Promise.all((list || []).map((p) => initOne(p.name, p.value)));
    };

    const setOne = async (name, value) => {
      const sentValue = normalizeValue(value);
      await loaded;
      if (fallback) return queueSet({ name, value: sentValue });
      track(name);
      const current = store.get(name);
      store.set(name, { ...(current || {}), name, value });
      if (current && normalizeValue(current.value) === sentValue) return;
      localOnly.delete(name);
      await queueSet({ name, value: sentValue });
    };

    const setMany = async (list) => {
      await Promise.all((list || []).map((p) => setOne(p.name, p.value)));
    };

    const removeOne = async (name) => {
      await loaded;
      store.delete(name);
      localOnly.delete(name);
      return props.Remove(name);
    };

    const listOp = (op) => async (name, ...args) => {
      await ensureOnServer(name);
      return props.List[op](name, ...args);
    };
    const List = props.List
      ? Object.freeze({ Add: listOp("Add"), Remove: listOp("Remove"), Update: listOp("Update"), Reorder: listOp("Reorder") })
      : props.List;

    const Properties = Object.create(props, {
      List: { value: List },
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
