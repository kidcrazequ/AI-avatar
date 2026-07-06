# Soul Pixel Office Prototype

This folder contains the first pixel-art office background prototype for the Soul avatar office.

## Files

```text
soul-pixel-office-source.png
```

Original generated source image.

```text
soul-pixel-office-1080x780-prototype.png
```

Processed app background:

- Size: 1080x780 px
- Target viewBox: `0 0 1080 780`
- Usage: temporary background for `AvatarOffice.tsx`

## Scene Intent

The office should read as a compact pixel RPG workplace instead of a white product-render scene.

Current spatial anchors:

- Main workstation: active typing / execution state
- Center aisle: walking / task movement
- Knowledge shelves: idle / reading / research state
- Meeting table and whiteboard: reserved for future presenting / meeting states
- Coffee and lounge corners: reserved for future idle personality moments

## Important Notes

This is a prototype background for visual validation. It should not be treated as final map art.

Known limitations:

- Furniture is generated as a single flat image, so character depth sorting is approximate.
- No collision grid or explicit tile map exists yet.
- The current avatar routes are hand-placed coordinates inside `AvatarOffice.tsx`.

Recommended next step:

1. Validate whether Soul pig sprites visually fit the map.
2. Adjust character scale and route anchors.
3. If the direction is approved, redraw or author a proper tile/map layer with separate walkable zones.
