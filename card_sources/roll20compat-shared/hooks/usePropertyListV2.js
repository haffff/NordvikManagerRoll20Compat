import * as React from "react";

// Reactive wrapper around a list-typed property — a JSON array of
// {id, fields} rows stored in a single property's Value (see the backend's
// PropertyList command handlers / Properties.List.* on CardAPI).
//
// Supersedes the old usePropertyList (name_count + name_0..N-1 positional
// scheme): rows are addressed by their own server-generated id, so remove
// and reorder never shift or re-key surviving rows. Reactivity comes for
// free from CardAPI's existing property_update subscription — no manual
// "_notify" companion property is needed, unlike the old hook.
//
// Usage:
//   const { items, addItem, removeItem, updateItem, reorder } =
//     usePropertyListV2(Api, "repeating_ability");
//   items: [{ id: "a1", fields: { name: "Hunt", value: "2" } }, ...]
export const usePropertyListV2 = (Api, propertyName) => {
  const [items, setItems] = React.useState([]);
  const [loaded, setLoaded] = React.useState(false);

  const parse = React.useCallback((prop) => {
    if (!prop?.value) return [];
    try {
      const parsed = JSON.parse(prop.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    const onChange = (prop) => {
      if (cancelled) return;
      // prop is null when the whole property row was removed (not just emptied).
      setItems(prop ? parse(prop) : []);
    };

    (async () => {
      // Init is idempotent — only creates the property if it doesn't exist yet,
      // so every consumer of this hook can assume the property is present
      // without a separate setup step (mirrors Properties.Init's existing
      // create-if-missing semantics elsewhere in the sandboxed API).
      //
      // Known caveat, shared with the old usePropertyList this supersedes:
      // Properties.Init's underlying Properties.Add is fire-and-forget over
      // the WebRTC channel — `await`ing it only waits for the send, not for
      // the server to actually create the row and broadcast it back. The
      // very next line's Get() is a separate, real HTTP round-trip, so on a
      // brand-new property there's a narrow window where Get() runs before
      // the server has processed Init()'s Add — same architectural gap as
      // the original hook, not something introduced here. In practice this
      // hasn't been observed to matter (Add/List.Add are ordered on the same
      // connection, and real user interaction is far slower than either
      // round-trip), but it's not a guarantee. Fixing it for real means
      // making Properties.Add resolve on the server's broadcast rather than
      // the local send — a CardAPI.js-wide change outside this library's
      // scope.
      await Api.Properties.Init(propertyName, "[]");
      const prop = await Api.Properties.Get(propertyName);
      if (cancelled) return;
      setItems(parse(prop));
      setLoaded(true);
    })();

    Api.Properties.Subscribe(propertyName, onChange);
    return () => {
      cancelled = true;
      Api.Properties.Unsubscribe(propertyName, onChange);
    };
  }, [Api, propertyName, parse]);

  const addItem = React.useCallback(
    (fields) => Api.Properties.List.Add(propertyName, fields ?? {}),
    [Api, propertyName]
  );

  const removeItem = React.useCallback(
    (itemId) => Api.Properties.List.Remove(propertyName, itemId),
    [Api, propertyName]
  );

  const updateItem = React.useCallback(
    (itemId, fields) => Api.Properties.List.Update(propertyName, itemId, fields ?? {}),
    [Api, propertyName]
  );

  const reorder = React.useCallback(
    (orderedItemIds) => Api.Properties.List.Reorder(propertyName, orderedItemIds),
    [Api, propertyName]
  );

  return { items, loaded, addItem, removeItem, updateItem, reorder };
};

export default usePropertyListV2;
