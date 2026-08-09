import * as React from "react";

/**
 * Loads a ported sheet's own bundled translation.json (flat `key -> string`,
 * already portable as-is from the original Roll20 sheet's `translation.json`)
 * as a game-wide Resource — NOT a live call to Roll20's i18n service, which
 * this addon doesn't and won't integrate with.
 *
 * The bundle is expected to already exist as a global Resource under
 * `resourceKey` (e.g. "roll20compat/bitd/translation") — uploading it there
 * is the ported card's install Action's job (mirrors how dnd5e's
 * sync_data/get_data actions populate its own static data Resources), not
 * this hook's.
 *
 * @param {object} Api - CardAPI instance
 * @param {string} resourceKey - global Resource key holding the translation.json content
 * @returns {{ t: (key: string, fallback?: string) => string, loaded: boolean }}
 */
export const useTranslationBundle = (Api, resourceKey) => {
  const [bundle, setBundle] = React.useState(null);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    (async () => {
      try {
        const raw = await Api.Resources.Global.Read(resourceKey);
        if (cancelled) return;
        setBundle(raw ? JSON.parse(raw) : {});
      } catch (err) {
        console.error(`useTranslationBundle: failed to load "${resourceKey}"`, err);
        if (!cancelled) setBundle({});
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [Api, resourceKey]);

  const t = React.useCallback(
    (key, fallback) => bundle?.[key] ?? fallback ?? key,
    [bundle]
  );

  return { t, loaded };
};

export default useTranslationBundle;
