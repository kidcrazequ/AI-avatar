# Soul Pig Sprite Prototype

This folder contains the first prototype assets for the Soul pig avatar.

## Character Baseline

- Loose short-sleeve T-shirt
- Relaxed cargo pants
- Low-top sneakers
- Neckband headphones
- Crossbody laptop bag
- Small clipped ID badge

The character standard is documented in:

```text
docs/soul-pig-character-standard.md
```

## Files

```text
soul-pig-office-standard-64.png
soul-pig-office-standard-64.meta.json
```

Standard office sprite sheet used by `office-game/officeSprites.ts`.

- Frame size: 64x64 px
- Sheet size: 256x768 px
- 4 frames per action
- Row 1: `idle_front`
- Row 2: `walk_se`
- Row 3: `walk_sw`
- Row 4: `walk_ne`
- Row 5: `walk_nw`
- Row 6: `sit_work`
- Row 7: `stand_drink`
- Row 8: `sit_sofa`
- Row 9: `sit_rest`
- Row 10: `sit_meeting`
- Row 11: `stand_research`
- Row 12: `stand_file`

The sheet is reproducible via:

```text
desktop-app/scripts/generate-soul-pig-office-standard.py
```

When replacing the art, keep the metadata contract stable: `frameWidth`, `frameHeight`, `columns`, `rows`, action row indexes, and action anchors.

```text
soul-pig-idle-walk-typing-source.png
```

Source concept sheet generated from the approved main character direction. It is not a production sprite sheet.

```text
soul-pig-idle-walk-typing-48-prototype.png
```

Prototype 3x4 sprite sheet:

- Row 1: idle, 4 frames
- Row 2: walk, 4 frames
- Row 3: typing at desk, 4 frames
- Frame size: 48x64 px
- Sheet size: 192x192 px

```text
soul-pig-typing-desk-96-prototype.png
```

Prototype typing-at-desk strip:

- 4 frames
- Frame size: 96x64 px
- Sheet size: 384x64 px

```text
actions-source/soul-pig-office-actions-source-chromakey.png
actions-source/soul-pig-office-actions-source-alpha.png
```

Prototype source sheet for office-specific actions. The chroma-key source was generated on a flat green background, then converted to alpha locally.

```text
soul-pig-office-actions-48-prototype.png
```

Prototype 4x4 office action sprite sheet:

- Row 1: researching / reading, 4 frames
- Row 2: meeting / discussing, 4 frames
- Row 3: filing / organizing, 4 frames
- Row 4: coffee break / water bar, 4 frames
- Frame size: 48x64 px
- Sheet size: 192x256 px

```text
frames-prototype/
```

Individual prototype frames split from the sheets above.

## Important Notes

These assets are good enough for visual validation and temporary office integration, but they are not final production pixel art.

Known limitations:

- The source image was mechanically cut and resized.
- The 48x64 typing frames are cramped because the desk and character share one small frame.
- The office-specific action frames are prototype generated assets; they are consistent enough for interaction validation, but not final hand-cleaned sprite art.
- The background was removed by matte extraction, so small edge artifacts may remain.
- Final production sprites should be redrawn or regenerated directly at the target pixel scale, with consistent lighting and one-pixel outlines.

Recommended next step:

1. Use the 48x64 sheet to test movement and office placement.
2. Use the 96x64 desk strip for typing at workstation if 48x64 is too cramped.
3. Validate the new office actions in context: `researching`, `meeting`, `filing`, and `coffee_break`.
4. After placement is approved, redraw final clean sheets from the same character baseline.
