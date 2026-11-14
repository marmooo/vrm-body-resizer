# VRM Body Resizer

A browser-based tool to adjust VRM body proportions and export a lightweight
model. Runs entirely client-side (Three.js + `@pixiv/three-vrm`).

## Features

- Load a VRM and pose bones (sphere / gizmo, sliders, mirror, random pose, reset
  pose).
- Body shape — height, overall thickness, head / neck / shoulders / chest /
  waist / arms / legs / hands / feet: length and thickness sliders, plus a spine
  curve. Applied as local scale on humanoid bones.
- Expressions, lights, materials, background, and floor grid.
- Export shaped VRM / GLB (Draco when available; otherwise GLTFExporter).
- Screenshot (up to ×4, optional transparent) and fixed-size portrait /
  full-body PNG captures.

## Bundled models

Put models and thumbnails in `src/vrm/` (sub-folders allowed) and generate the
list with [Deno](https://deno.com/):

```
src/vrm/1.vrm            the model
src/vrm/1_portrait.png   list thumbnail, waist-up (optional)
src/vrm/1_full_body.png  preview shown when selected (optional)
```

```sh
deno run -RW scripts/generate-vrm-list.ts
```

Thumbnails can be any image format (`png`, `webp`, `avif`, `jpg`, …); the
footer's "Portrait shot" / "Full-body shot" buttons save them with these names.
Random animations use `scripts/generate-animation-list.ts` the same way, and
`scripts/extract-vrm-thumbnail.ts` extracts a VRM's embedded thumbnail. `docs/`
is the generated site; run `build.sh` after changing `src/`.
