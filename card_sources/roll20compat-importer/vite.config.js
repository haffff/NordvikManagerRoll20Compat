import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// This card imports raw text (?raw) from ../roll20compat-shared/{runtime,patches,tools}
// — a sibling directory one level up from this project's own root — both at
// build time (fine, unrestricted) and, for local `pnpm run dev` convenience,
// at dev-server time too, where Vite's default server.fs.allow would
// otherwise reject requests for files outside this package's own root.
// pack-cards.mjs (the actual packaging path used to ship this card) only
// ever runs `vite build`, which isn't subject to server.fs at all — this
// setting exists purely so `pnpm run dev` also works without extra setup.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..'] },
  },
})
