"""Drift guard: python/protocol.py MUST stay in lockstep with src/control/protocol.js (the source of
truth). This parses the JS exports and asserts the Python mirror matches, so adding/renaming a verb or
a required field in one language without the other fails here. Also checks the structural validator."""

from __future__ import annotations

import re
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import protocol  # noqa: E402  (path set above)

_JS = (Path(__file__).resolve().parent.parent / "src" / "control" / "protocol.js").read_text(encoding="utf-8")


def _js_frozen_array(name: str) -> list[str]:
    """Extract the string literals from `export const <name> = Object.freeze([ "...", ... ])`."""
    m = re.search(name + r"\s*=\s*Object\.freeze\(\[(.*?)\]\)", _JS, re.S)
    assert m, f"{name} not found in protocol.js"
    return re.findall(r'"([^"]+)"', m.group(1))


def _js_required_fields() -> dict[str, str]:
    """Extract the REQUIRED_FIELDS object literal from protocol.js."""
    m = re.search(r"REQUIRED_FIELDS\s*=\s*\{(.*?)\}", _JS, re.S)
    assert m, "REQUIRED_FIELDS not found in protocol.js"
    return dict(re.findall(r'(\w+):\s*"([^"]+)"', m.group(1)))


def test_actions_match_the_js_contract():
    assert sorted(protocol.ACTIONS) == sorted(_js_frozen_array("ACTIONS")), "ACTIONS drifted from protocol.js"


def test_query_kinds_match_the_js_contract():
    assert sorted(protocol.QUERY_KINDS) == sorted(_js_frozen_array("QUERY_KINDS")), "QUERY_KINDS drifted"


def test_required_fields_match_the_js_contract():
    assert protocol.REQUIRED_FIELDS == _js_required_fields(), "REQUIRED_FIELDS drifted from protocol.js"


def test_validate_command_structural():
    assert protocol.validate_command({"action": "pose"}) == (True, None)  # all-optional verb
    assert protocol.validate_command({"action": "say", "url": "file:///x.wav"})[0] is True
    assert protocol.validate_command(None)[0] is False
    assert protocol.validate_command("pose")[0] is False
    ok, reason = protocol.validate_command({"action": "teleport"})
    assert ok is False and "unknown action 'teleport'" in reason
    ok, reason = protocol.validate_command({"action": "say"})
    assert ok is False and "'say' requires 'url'" in reason
    # structural only: a non-numeric value is still structurally valid (coercion is the engine's job)
    assert protocol.validate_command({"action": "size", "value": "huge"}) == (True, None)


def test_is_action():
    assert protocol.is_action("perform") is True
    assert protocol.is_action("nope") is False
    assert protocol.is_action(42) is False
