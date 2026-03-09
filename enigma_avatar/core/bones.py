"""
Bone Control System for Avatar Brick

Direct bone/joint manipulation for rigged 3D avatars.
Standalone version - no external enigma_engine dependencies.
"""

import logging
import time
from dataclasses import dataclass
from threading import Lock
from typing import Callable, Optional

logger = logging.getLogger(__name__)


@dataclass
class BoneLimits:
    """Rotation limits for a bone (in degrees)."""
    pitch_min: float = -45.0
    pitch_max: float = 45.0
    yaw_min: float = -45.0
    yaw_max: float = 45.0
    roll_min: float = -30.0
    roll_max: float = 30.0
    speed_limit: float = 90.0
    
    def clamp(self, pitch: float, yaw: float, roll: float) -> tuple[float, float, float]:
        """Clamp rotation values to limits."""
        pitch = max(self.pitch_min, min(self.pitch_max, pitch))
        yaw = max(self.yaw_min, min(self.yaw_max, yaw))
        roll = max(self.roll_min, min(self.roll_max, roll))
        return pitch, yaw, roll


# Standard bone limits based on human anatomy
STANDARD_BONE_LIMITS: dict[str, BoneLimits] = {
    # Head and neck
    "head": BoneLimits(pitch_min=-40, pitch_max=40, yaw_min=-80, yaw_max=80, roll_min=-30, roll_max=30),
    "neck": BoneLimits(pitch_min=-30, pitch_max=30, yaw_min=-60, yaw_max=60, roll_min=-20, roll_max=20),
    
    # Spine
    "spine": BoneLimits(pitch_min=-30, pitch_max=45, yaw_min=-30, yaw_max=30, roll_min=-20, roll_max=20),
    "chest": BoneLimits(pitch_min=-15, pitch_max=25, yaw_min=-20, yaw_max=20, roll_min=-10, roll_max=10),
    "hips": BoneLimits(pitch_min=-20, pitch_max=20, yaw_min=-30, yaw_max=30, roll_min=-15, roll_max=15),
    
    # Arms - Left
    "left_shoulder": BoneLimits(pitch_min=-30, pitch_max=30, yaw_min=-30, yaw_max=30, roll_min=-20, roll_max=20),
    "left_arm": BoneLimits(pitch_min=-90, pitch_max=180, yaw_min=-90, yaw_max=90, roll_min=-90, roll_max=90),
    "left_forearm": BoneLimits(pitch_min=0, pitch_max=145, yaw_min=-90, yaw_max=90, roll_min=-5, roll_max=5),
    "left_hand": BoneLimits(pitch_min=-80, pitch_max=80, yaw_min=-20, yaw_max=45, roll_min=-45, roll_max=45),
    
    # Arms - Right
    "right_shoulder": BoneLimits(pitch_min=-30, pitch_max=30, yaw_min=-30, yaw_max=30, roll_min=-20, roll_max=20),
    "right_arm": BoneLimits(pitch_min=-90, pitch_max=180, yaw_min=-90, yaw_max=90, roll_min=-90, roll_max=90),
    "right_forearm": BoneLimits(pitch_min=0, pitch_max=145, yaw_min=-90, yaw_max=90, roll_min=-5, roll_max=5),
    "right_hand": BoneLimits(pitch_min=-80, pitch_max=80, yaw_min=-45, yaw_max=20, roll_min=-45, roll_max=45),
    
    # Legs - Left
    "left_leg": BoneLimits(pitch_min=-30, pitch_max=120, yaw_min=-45, yaw_max=45, roll_min=-45, roll_max=30),
    "left_shin": BoneLimits(pitch_min=-140, pitch_max=0, yaw_min=-5, yaw_max=5, roll_min=-5, roll_max=5),
    "left_foot": BoneLimits(pitch_min=-45, pitch_max=45, yaw_min=-20, yaw_max=20, roll_min=-30, roll_max=30),
    
    # Legs - Right
    "right_leg": BoneLimits(pitch_min=-30, pitch_max=120, yaw_min=-45, yaw_max=45, roll_min=-30, roll_max=45),
    "right_shin": BoneLimits(pitch_min=-140, pitch_max=0, yaw_min=-5, yaw_max=5, roll_min=-5, roll_max=5),
    "right_foot": BoneLimits(pitch_min=-45, pitch_max=45, yaw_min=-20, yaw_max=20, roll_min=-30, roll_max=30),
}

DEFAULT_BONE_LIMITS = BoneLimits(
    pitch_min=-45, pitch_max=45,
    yaw_min=-45, yaw_max=45,
    roll_min=-30, roll_max=30,
    speed_limit=60.0
)


@dataclass
class BoneState:
    """Current state of a bone."""
    pitch: float = 0.0
    yaw: float = 0.0
    roll: float = 0.0
    last_update: float = 0.0


class BoneController:
    """
    Controls avatar bones with anatomical limits.
    
    Prevents unnatural movements by:
    1. Clamping rotations to realistic limits
    2. Limiting movement speed to prevent jerkiness
    3. Smoothing movements over time
    """
    
    def __init__(self):
        self._lock = Lock()
        self._bone_states: dict[str, BoneState] = {}
        self._custom_limits: dict[str, BoneLimits] = {}
        self._available_bones: list[str] = []
        self._callbacks: list[Callable] = []
    
    def set_available_bones(self, bone_names: list[str]) -> None:
        """Set the available bones for the current avatar model."""
        with self._lock:
            self._available_bones = list(bone_names)
            for bone in bone_names:
                if bone not in self._bone_states:
                    self._bone_states[bone] = BoneState(last_update=time.time())
            logger.info(f"Bone controller initialized with {len(bone_names)} bones")
    
    def get_available_bones(self) -> list[str]:
        """Get list of available bone names."""
        with self._lock:
            return list(self._available_bones)
    
    def get_limits(self, bone_name: str) -> BoneLimits:
        """Get the rotation limits for a bone."""
        if bone_name in self._custom_limits:
            return self._custom_limits[bone_name]
        
        # Normalize and match
        bone_lower = bone_name.lower().replace("_", "").replace("-", "").replace(" ", "")
        
        for standard_name, limits in STANDARD_BONE_LIMITS.items():
            standard_lower = standard_name.lower().replace("_", "")
            if standard_lower in bone_lower or bone_lower in standard_lower:
                return limits
        
        return DEFAULT_BONE_LIMITS
    
    def move_bone(
        self,
        bone_name: str,
        pitch: Optional[float] = None,
        yaw: Optional[float] = None,
        roll: Optional[float] = None,
        smooth: bool = True
    ) -> tuple[float, float, float]:
        """
        Move a bone to the specified rotation.
        
        Args:
            bone_name: Name of the bone to move
            pitch: Target pitch rotation (degrees)
            yaw: Target yaw rotation (degrees)
            roll: Target roll rotation (degrees)
            smooth: If True, apply smoothing
        
        Returns:
            Tuple of (actual_pitch, actual_yaw, actual_roll) after clamping
        """
        with self._lock:
            if bone_name not in self._bone_states:
                self._bone_states[bone_name] = BoneState(last_update=time.time())
            
            state = self._bone_states[bone_name]
            limits = self.get_limits(bone_name)
            current_time = time.time()
            
            # Use current values if not specified
            target_pitch = pitch if pitch is not None else state.pitch
            target_yaw = yaw if yaw is not None else state.yaw
            target_roll = roll if roll is not None else state.roll
            
            # Clamp to limits
            target_pitch, target_yaw, target_roll = limits.clamp(
                target_pitch, target_yaw, target_roll
            )
            
            # Apply speed limiting
            if smooth and state.last_update > 0:
                dt = current_time - state.last_update
                max_delta = limits.speed_limit * dt
                
                actual_pitch = self._limit_delta(state.pitch, target_pitch, max_delta)
                actual_yaw = self._limit_delta(state.yaw, target_yaw, max_delta)
                actual_roll = self._limit_delta(state.roll, target_roll, max_delta)
            else:
                actual_pitch, actual_yaw, actual_roll = target_pitch, target_yaw, target_roll
            
            # Update state
            state.pitch = actual_pitch
            state.yaw = actual_yaw
            state.roll = actual_roll
            state.last_update = current_time
            
            # Notify callbacks
            for callback in self._callbacks:
                try:
                    callback(bone_name, actual_pitch, actual_yaw, actual_roll)
                except Exception as e:
                    logger.error(f"Bone callback error: {e}")
            
            return actual_pitch, actual_yaw, actual_roll
    
    def _limit_delta(self, current: float, target: float, max_delta: float) -> float:
        """Limit how much a value can change."""
        delta = target - current
        if abs(delta) > max_delta:
            return current + (max_delta if delta > 0 else -max_delta)
        return target
    
    def get_state(self, bone_name: str) -> Optional[BoneState]:
        """Get the current state of a bone."""
        with self._lock:
            return self._bone_states.get(bone_name)
    
    def get_all_states(self) -> dict[str, dict[str, float]]:
        """Get all bone states as a dictionary."""
        with self._lock:
            return {
                name: {"pitch": s.pitch, "yaw": s.yaw, "roll": s.roll}
                for name, s in self._bone_states.items()
            }
    
    def reset_all(self) -> None:
        """Reset all bones to neutral position."""
        with self._lock:
            for state in self._bone_states.values():
                state.pitch = 0.0
                state.yaw = 0.0
                state.roll = 0.0
                state.last_update = time.time()
        logger.info("All bones reset to neutral")
    
    def reset_bone(self, bone_name: str) -> None:
        """Reset a single bone to neutral position."""
        with self._lock:
            if bone_name in self._bone_states:
                state = self._bone_states[bone_name]
                state.pitch = 0.0
                state.yaw = 0.0
                state.roll = 0.0
                state.last_update = time.time()
    
    def add_callback(self, callback: Callable) -> None:
        """Add a callback called when any bone moves."""
        self._callbacks.append(callback)
    
    def remove_callback(self, callback: Callable) -> None:
        """Remove a callback."""
        if callback in self._callbacks:
            self._callbacks.remove(callback)
    
    def to_dict(self) -> dict:
        """Export bone info as dictionary."""
        with self._lock:
            return {
                "available_bones": self._available_bones,
                "states": self.get_all_states(),
            }
