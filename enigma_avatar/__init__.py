"""
Enigma Avatar Brick

Standalone avatar display and control that connects to Enigma router.

Usage:
    # As a brick
    enigma-avatar
    
    # Standalone
    enigma-avatar --standalone
"""

from .main import main, AvatarBrick
from .core.bones import BoneController, BoneLimits, BoneState
from .core.model import AvatarModel, ModelManager

__version__ = "1.0.0"
__all__ = [
    "main",
    "AvatarBrick",
    "BoneController",
    "BoneLimits",
    "BoneState",
    "AvatarModel",
    "ModelManager",
]
