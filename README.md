# Entropy Garden

A logic-circuit puzzle PWA where you build circuits that survive decay. Wires corrode, gates drift, and heat from dense packing accelerates failure.

## Play

Visit the deployed site at: https://kimmania.github.io/game-entropy-garden/

## Tech Stack

- **Build:** Vite 6 + vite-plugin-pwa
- **Language:** TypeScript (strict)
- **Renderer:** HTML5 Canvas 2D
- **Deploy:** GitHub Actions → GitHub Pages

## Development

```bash
npm install
npm run dev       # local dev server
npm run build     # production build to dist/
npm run preview   # preview production build
```

## Levels

12 handcrafted levels across 6 gardens:
- Tutorial Gardens (4 levels) — learn gates one at a time
- Heat Chambers (2 levels) — thermal trade-offs
- Marathon Gardens (2 levels) — long survival, redundancy
- Storm Gardens (1 level) — fluctuating decay
- Zen Gardens (1 level) — pure minimal-gate optimization
- Cascade Gardens (2 levels) — route around broken gates
