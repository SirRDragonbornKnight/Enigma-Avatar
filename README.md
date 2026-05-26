# Avatar mod — STUB (no working implementation)

This mod is **not functional**. Slice `2.1-avatar-deadfile` (May 26, 2026) killed
the two prior implementations (`enigma_avatar_brick.py` and the `enigma_avatar/`
package) because:

- Neither file lived at the path the mod launcher expects (`mods/avatar/main.py`).
- Neither implementation spoke the real router wire protocol (4-byte length
  prefix + JSON, see `mods/_template/mod_base.py`); both used incompatible
  newline-framed JSON variants.
- Neither had a renderer — `mods/avatar/pyproject.toml` declared `PyOpenGL` but
  no `.py` file ever imported it.
- 2167 LOC total, unreachable, unverified, no tests.

## What survived

The only piece worth preserving was the 19-row anatomical bone-limits table
(head, neck, spine, chest, hips, L+R shoulder/arm/forearm/hand, L+R leg/shin/foot
with pitch/yaw/roll ranges + speed limit). That data now lives at:

```
mods/avatar/bone_limits.json
```

Validated by `tests/test_avatar_bone_data.py` (5 tests).

## Reviving the mod

A real avatar mod would need:

1. `mods/avatar/main.py` as the launcher entry point.
2. The real `mod_base.py` socket protocol (copy from `mods/_template/`).
3. A renderer — minimum viable is a tkinter Canvas stick figure; serious version
   is moderngl or pyglet. Decide before writing more code.
4. A quaternion-based bone controller (not the Euler one we just deleted — that
   had gimbal-lock issues and was inconsistent with the sibling glTF model
   loader, which already used quaternions).
5. Load `bone_limits.json` (sits next to `mod.json`) for anatomy constraints.

See the `2.1-avatar-deadfile` close-stamp in [`SUGGESTIONS.md`](../../SUGGESTIONS.md)
for the full disposition history and Option C blueprint if you pick up the work.
