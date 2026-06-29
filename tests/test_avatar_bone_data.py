"""Validation tests for the salvaged anatomical bone-limits dataset.

The avatar mod itself was killed in slice 2.1-avatar-deadfile (May 26, 2026)
because both implementations were unreachable from the mod launcher and had no
renderer. The only piece worth preserving was the 19-row anatomy table from
the old ``enigma_avatar/core/bones.py``. These tests guard the JSON shape so
the data stays usable when (and if) the avatar mod is rebuilt.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

DATA_PATH = Path(__file__).resolve().parents[1] / "bone_limits.json"  # repo root (standalone Enigma Avatar repo)

EXPECTED_BONES = {
    "head",
    "neck",
    "spine",
    "chest",
    "hips",
    "left_shoulder",
    "left_arm",
    "left_forearm",
    "left_hand",
    "right_shoulder",
    "right_arm",
    "right_forearm",
    "right_hand",
    "left_leg",
    "left_shin",
    "left_foot",
    "right_leg",
    "right_shin",
    "right_foot",
}

ANGLE_FIELDS = (
    "pitch_min",
    "pitch_max",
    "yaw_min",
    "yaw_max",
    "roll_min",
    "roll_max",
)


@pytest.fixture(scope="module")
def payload() -> dict:
    assert DATA_PATH.exists(), f"missing salvaged anatomy data at {DATA_PATH}"
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def test_top_level_shape(payload: dict) -> None:
    assert "default" in payload, "missing fallback limits"
    assert "bones" in payload and isinstance(payload["bones"], dict)


def test_default_limits_well_formed(payload: dict) -> None:
    default = payload["default"]
    for field in ANGLE_FIELDS:
        assert field in default, f"default missing {field}"
        assert isinstance(default[field], (int, float))
    assert default["pitch_min"] <= default["pitch_max"]
    assert default["yaw_min"] <= default["yaw_max"]
    assert default["roll_min"] <= default["roll_max"]
    assert default["speed_limit"] > 0


def test_all_expected_bones_present(payload: dict) -> None:
    have = set(payload["bones"].keys())
    missing = EXPECTED_BONES - have
    extra = have - EXPECTED_BONES
    assert not missing, f"missing bones: {sorted(missing)}"
    assert not extra, f"unexpected bones: {sorted(extra)}"
    assert len(have) == 19


def test_every_bone_has_valid_ranges(payload: dict) -> None:
    for name, limits in payload["bones"].items():
        for field in ANGLE_FIELDS:
            assert field in limits, f"{name} missing {field}"
            assert isinstance(limits[field], (int, float)), f"{name}.{field} not numeric: {limits[field]!r}"
        assert limits["pitch_min"] <= limits["pitch_max"], f"{name} pitch range inverted"
        assert limits["yaw_min"] <= limits["yaw_max"], f"{name} yaw range inverted"
        assert limits["roll_min"] <= limits["roll_max"], f"{name} roll range inverted"
        assert limits["speed_limit"] > 0, f"{name} speed_limit not positive"


def test_anatomical_invariants(payload: dict) -> None:
    """Sanity-check known joint physiology so the data is not garbage."""
    bones = payload["bones"]

    # Knees only flex backward (shin pitch range entirely <= 0).
    for shin in ("left_shin", "right_shin"):
        assert bones[shin]["pitch_max"] <= 0, f"{shin} pitch_max > 0 implies hyperextension"

    # Elbows only flex forward (forearm pitch range entirely >= 0).
    for forearm in ("left_forearm", "right_forearm"):
        assert bones[forearm]["pitch_min"] >= 0, f"{forearm} pitch_min < 0 implies hyperextension"

    # Hands mirror on yaw (left thumb-side vs right thumb-side).
    assert bones["left_hand"]["yaw_max"] == -bones["right_hand"]["yaw_min"]
    assert bones["left_hand"]["yaw_min"] == -bones["right_hand"]["yaw_max"]
