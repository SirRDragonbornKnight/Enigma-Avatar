"""Avatar bus protocol — the Python mirror of src/control/protocol.js (the JS is the source of truth).

The Python drivers (say.py / avbus.py) speak the same JSON {action, ...} wire format
the overlay's bus dispatch (control/bus.js) understands. This module gives them the canonical verb
vocabulary + a structural validator so they don't each re-hardcode it. It is kept in lockstep with
protocol.js by tests/test_avatar_protocol.py, which parses the JS and fails if the two ever diverge.

Like its JS twin, validate_command is STRUCTURAL only (object + known verb + required field); it does
NOT coerce/range-check argument values — that stays at the engine boundary in the overlay.
"""

from __future__ import annotations

# The bus move set — one verb per concept. MUST equal protocol.js ACTIONS (drift-guarded by the test).
ACTIONS: tuple[str, ...] = (
    "attach", "ball", "blink", "capabilities", "conjure", "detach", "facialTune", "fingers", "gallery",
    "highlightBone", "hue", "impulse", "load", "mesh", "monitor", "morph", "mouth", "move",
    "nameBone", "outfit", "perform", "platform", "pose", "query", "recolor", "regionWeight",
    "resetColors", "rotate", "rotateMode", "say", "settings", "showBones", "size", "snap", "springTune",
    "stop", "tuneAttachment",
)

# The `what` values the `query` verb accepts (plus "actions", handled by the registry itself).
QUERY_KINDS: tuple[str, ...] = (
    "materials", "meshes", "regions", "bones", "morphs", "rotation", "facial", "model", "where",
    "capabilities", "caps", "roles", "joints", "stance", "grip", "outfits", "platforms",
    "bounds", "weights", "state",
)

# Verbs whose listed field must be present to be actionable (mirrors protocol.js REQUIRED_FIELDS).
REQUIRED_FIELDS: dict[str, str] = {
    "impulse": "region",
    "perform": "text",
    "say": "url",
    "mouth": "value",
    "size": "value",
    "load": "url",
    "hue": "name",
    "regionWeight": "region",
    "outfit": "name",
    "attach": "url",
    "tuneAttachment": "id",
    "nameBone": "bone",
    "highlightBone": "bone",
    "query": "what",
}


def is_action(action: object) -> bool:
    """Is `action` a known bus verb? (unknown -> the overlay no-ops, so this is advisory.)"""
    return isinstance(action, str) and action in ACTIONS


def validate_command(raw: object) -> tuple[bool, str | None]:
    """Structurally validate a command dict: object + known string action + that verb's required field.
    Returns (True, None) or (False, reason). Does NOT coerce/range-check values (engine-boundary job)."""
    if not isinstance(raw, dict):
        return False, "not an object"
    action = raw.get("action")
    if not isinstance(action, str):
        return False, "missing string 'action'"
    if action not in ACTIONS:
        return False, f"unknown action '{action}'"
    req = REQUIRED_FIELDS.get(action)
    if req and req not in raw:
        return False, f"'{action}' requires '{req}'"
    return True, None
