#!/usr/bin/env python3
"""
ENIGMA AVATAR BRICK - Standalone Single-File Version
=====================================================
A fully standalone avatar display and bone control brick.
No dependencies on enigma_engine - just Python stdlib.

Features:
- Load glTF/GLB/OBJ 3D models
- Anatomically-correct bone rotation with limits
- TCP + JSON protocol for router communication
- Can run standalone or connected to router

Commands:
    avatar.load, avatar.show, avatar.hide, avatar.bone, avatar.reset,
    avatar.expression, avatar.position, avatar.scale, avatar.info, avatar.bones

Events:
    avatar.loaded, avatar.bone_moved, avatar.expression_changed, avatar.visibility_changed

Usage:
    python enigma_avatar_brick.py                    # Connect to router
    python enigma_avatar_brick.py --standalone       # Run without router
    python enigma_avatar_brick.py --model face.glb   # Load model on startup
"""

import argparse
import asyncio
import json
import logging
import struct
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import IntEnum
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any, Callable

# =============================================================================
# CONFIGURATION
# =============================================================================

DEFAULT_HOST = "localhost"
DEFAULT_PORT = 9900

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("enigma.avatar")


# =============================================================================
# PROTOCOL - TCP + JSON Message Format
# =============================================================================

class MessageType(IntEnum):
    """Protocol message types."""
    REGISTER = 1      # Brick registration
    COMMAND = 2       # Command to execute
    RESPONSE = 3      # Command response
    EVENT = 4         # Event broadcast
    HEARTBEAT = 5     # Keep-alive
    DISCOVERY = 6     # List registered bricks


@dataclass
class Message:
    """Protocol message structure."""
    type: MessageType
    id: str
    source: str = ""
    target: str = ""
    data: dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)
    
    def to_json(self) -> str:
        return json.dumps({
            "type": int(self.type),
            "id": self.id,
            "source": self.source,
            "target": self.target,
            "data": self.data,
            "timestamp": self.timestamp,
        })
    
    def to_bytes(self) -> bytes:
        return (self.to_json() + "\n").encode("utf-8")
    
    @classmethod
    def from_json(cls, data: str) -> "Message":
        d = json.loads(data)
        return cls(
            type=MessageType(d["type"]),
            id=d["id"],
            source=d.get("source", ""),
            target=d.get("target", ""),
            data=d.get("data", {}),
            timestamp=d.get("timestamp", time.time()),
        )


def parse_message(data: bytes) -> Message:
    """Parse bytes into a Message."""
    return Message.from_json(data.decode("utf-8").strip())


def create_register_message(name: str, brick_id: str, version: str,
                           description: str, commands: list, events: list,
                           ui: dict = None) -> Message:
    """Create a registration message."""
    return Message(
        type=MessageType.REGISTER,
        id=str(uuid.uuid4()),
        source=brick_id,
        data={
            "name": name,
            "brick_id": brick_id,
            "version": version,
            "description": description,
            "commands": commands,
            "events": events,
            "ui": ui or {},
        },
    )


def create_command_message(command: str, params: dict = None,
                          source: str = "", target: str = "") -> Message:
    """Create a command message."""
    return Message(
        type=MessageType.COMMAND,
        id=str(uuid.uuid4()),
        source=source,
        target=target,
        data={"command": command, "params": params or {}},
    )


def create_response_message(request_id: str, success: bool,
                           result: Any = None, error: str = None,
                           source: str = "", target: str = "") -> Message:
    """Create a response message."""
    data = {"success": success, "request_id": request_id}
    if result is not None:
        data["result"] = result
    if error:
        data["error"] = error
    return Message(
        type=MessageType.RESPONSE,
        id=str(uuid.uuid4()),
        source=source,
        target=target,
        data=data,
    )


def create_event_message(event: str, payload: dict = None,
                        source: str = "") -> Message:
    """Create an event message."""
    return Message(
        type=MessageType.EVENT,
        id=str(uuid.uuid4()),
        source=source,
        data={"event": event, "payload": payload or {}},
    )


def create_heartbeat_message(brick_id: str) -> Message:
    """Create a heartbeat message."""
    return Message(
        type=MessageType.HEARTBEAT,
        id=str(uuid.uuid4()),
        source=brick_id,
        data={"status": "alive"},
    )


# =============================================================================
# BONE CONTROL SYSTEM - Anatomically Correct Limits
# =============================================================================

@dataclass
class BoneLimits:
    """Rotation limits for a bone (in degrees)."""
    pitch_min: float = -180.0  # X-axis rotation min
    pitch_max: float = 180.0   # X-axis rotation max
    yaw_min: float = -180.0    # Y-axis rotation min
    yaw_max: float = 180.0     # Y-axis rotation max
    roll_min: float = -180.0   # Z-axis rotation min
    roll_max: float = 180.0    # Z-axis rotation max


@dataclass
class BoneState:
    """Current state of a bone."""
    name: str
    pitch: float = 0.0  # X-axis rotation (degrees)
    yaw: float = 0.0    # Y-axis rotation (degrees)
    roll: float = 0.0   # Z-axis rotation (degrees)
    limits: BoneLimits = field(default_factory=BoneLimits)


# Standard anatomical bone limits for humanoid avatars
STANDARD_BONE_LIMITS: Dict[str, BoneLimits] = {
    # HEAD & NECK
    "head": BoneLimits(pitch_min=-45, pitch_max=45, yaw_min=-80, yaw_max=80, roll_min=-30, roll_max=30),
    "neck": BoneLimits(pitch_min=-40, pitch_max=40, yaw_min=-60, yaw_max=60, roll_min=-20, roll_max=20),
    
    # SPINE
    "spine": BoneLimits(pitch_min=-30, pitch_max=30, yaw_min=-30, yaw_max=30, roll_min=-20, roll_max=20),
    "spine_01": BoneLimits(pitch_min=-20, pitch_max=20, yaw_min=-25, yaw_max=25, roll_min=-15, roll_max=15),
    "spine_02": BoneLimits(pitch_min=-20, pitch_max=20, yaw_min=-25, yaw_max=25, roll_min=-15, roll_max=15),
    "pelvis": BoneLimits(pitch_min=-20, pitch_max=20, yaw_min=-15, yaw_max=15, roll_min=-10, roll_max=10),
    "hips": BoneLimits(pitch_min=-20, pitch_max=20, yaw_min=-15, yaw_max=15, roll_min=-10, roll_max=10),
    
    # LEFT ARM
    "left_shoulder": BoneLimits(pitch_min=-30, pitch_max=30, yaw_min=-20, yaw_max=20, roll_min=-10, roll_max=10),
    "left_upper_arm": BoneLimits(pitch_min=-180, pitch_max=60, yaw_min=-90, yaw_max=90, roll_min=-90, roll_max=90),
    "left_arm": BoneLimits(pitch_min=-180, pitch_max=60, yaw_min=-90, yaw_max=90, roll_min=-90, roll_max=90),
    "left_forearm": BoneLimits(pitch_min=0, pitch_max=145, yaw_min=-90, yaw_max=90, roll_min=-5, roll_max=5),
    "left_lower_arm": BoneLimits(pitch_min=0, pitch_max=145, yaw_min=-90, yaw_max=90, roll_min=-5, roll_max=5),
    "left_hand": BoneLimits(pitch_min=-80, pitch_max=80, yaw_min=-45, yaw_max=45, roll_min=-20, roll_max=20),
    
    # RIGHT ARM
    "right_shoulder": BoneLimits(pitch_min=-30, pitch_max=30, yaw_min=-20, yaw_max=20, roll_min=-10, roll_max=10),
    "right_upper_arm": BoneLimits(pitch_min=-180, pitch_max=60, yaw_min=-90, yaw_max=90, roll_min=-90, roll_max=90),
    "right_arm": BoneLimits(pitch_min=-180, pitch_max=60, yaw_min=-90, yaw_max=90, roll_min=-90, roll_max=90),
    "right_forearm": BoneLimits(pitch_min=0, pitch_max=145, yaw_min=-90, yaw_max=90, roll_min=-5, roll_max=5),
    "right_lower_arm": BoneLimits(pitch_min=0, pitch_max=145, yaw_min=-90, yaw_max=90, roll_min=-5, roll_max=5),
    "right_hand": BoneLimits(pitch_min=-80, pitch_max=80, yaw_min=-45, yaw_max=45, roll_min=-20, roll_max=20),
    
    # LEFT LEG
    "left_upper_leg": BoneLimits(pitch_min=-120, pitch_max=30, yaw_min=-45, yaw_max=45, roll_min=-60, roll_max=30),
    "left_thigh": BoneLimits(pitch_min=-120, pitch_max=30, yaw_min=-45, yaw_max=45, roll_min=-60, roll_max=30),
    "left_lower_leg": BoneLimits(pitch_min=0, pitch_max=150, yaw_min=-5, yaw_max=5, roll_min=-5, roll_max=5),
    "left_shin": BoneLimits(pitch_min=0, pitch_max=150, yaw_min=-5, yaw_max=5, roll_min=-5, roll_max=5),
    "left_foot": BoneLimits(pitch_min=-50, pitch_max=30, yaw_min=-30, yaw_max=30, roll_min=-20, roll_max=20),
    "left_toe": BoneLimits(pitch_min=-30, pitch_max=60, yaw_min=-10, yaw_max=10, roll_min=-5, roll_max=5),
    
    # RIGHT LEG
    "right_upper_leg": BoneLimits(pitch_min=-120, pitch_max=30, yaw_min=-45, yaw_max=45, roll_min=-30, roll_max=60),
    "right_thigh": BoneLimits(pitch_min=-120, pitch_max=30, yaw_min=-45, yaw_max=45, roll_min=-30, roll_max=60),
    "right_lower_leg": BoneLimits(pitch_min=0, pitch_max=150, yaw_min=-5, yaw_max=5, roll_min=-5, roll_max=5),
    "right_shin": BoneLimits(pitch_min=0, pitch_max=150, yaw_min=-5, yaw_max=5, roll_min=-5, roll_max=5),
    "right_foot": BoneLimits(pitch_min=-50, pitch_max=30, yaw_min=-30, yaw_max=30, roll_min=-20, roll_max=20),
    "right_toe": BoneLimits(pitch_min=-30, pitch_max=60, yaw_min=-10, yaw_max=10, roll_min=-5, roll_max=5),
    
    # FINGERS (simplified)
    "left_thumb": BoneLimits(pitch_min=-30, pitch_max=60, yaw_min=-45, yaw_max=45, roll_min=-10, roll_max=10),
    "left_index": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-20, yaw_max=20, roll_min=-5, roll_max=5),
    "left_middle": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-15, yaw_max=15, roll_min=-5, roll_max=5),
    "left_ring": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-15, yaw_max=15, roll_min=-5, roll_max=5),
    "left_pinky": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-20, yaw_max=20, roll_min=-5, roll_max=5),
    "right_thumb": BoneLimits(pitch_min=-30, pitch_max=60, yaw_min=-45, yaw_max=45, roll_min=-10, roll_max=10),
    "right_index": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-20, yaw_max=20, roll_min=-5, roll_max=5),
    "right_middle": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-15, yaw_max=15, roll_min=-5, roll_max=5),
    "right_ring": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-15, yaw_max=15, roll_min=-5, roll_max=5),
    "right_pinky": BoneLimits(pitch_min=-10, pitch_max=90, yaw_min=-20, yaw_max=20, roll_min=-5, roll_max=5),
    
    # JAW & EYES
    "jaw": BoneLimits(pitch_min=0, pitch_max=30, yaw_min=-5, yaw_max=5, roll_min=-2, roll_max=2),
    "left_eye": BoneLimits(pitch_min=-30, pitch_max=25, yaw_min=-45, yaw_max=45, roll_min=-5, roll_max=5),
    "right_eye": BoneLimits(pitch_min=-30, pitch_max=25, yaw_min=-45, yaw_max=45, roll_min=-5, roll_max=5),
}


class BoneController:
    """Controls bone rotations with anatomical limits."""
    
    def __init__(self, bone_names: List[str] = None, custom_limits: Dict[str, BoneLimits] = None):
        self._bones: Dict[str, BoneState] = {}
        self._callbacks: List[Callable[[str, BoneState], None]] = []
        
        # Initialize with provided bone names or defaults
        if bone_names:
            for name in bone_names:
                self.add_bone(name)
        
        # Apply any custom limits
        if custom_limits:
            for name, limits in custom_limits.items():
                if name in self._bones:
                    self._bones[name].limits = limits
    
    def add_bone(self, name: str, limits: BoneLimits = None) -> None:
        """Add a bone to control."""
        if limits is None:
            # Try to get standard limits, fall back to unrestricted
            normalized = self._normalize_bone_name(name)
            limits = STANDARD_BONE_LIMITS.get(normalized, BoneLimits())
        
        self._bones[name] = BoneState(name=name, limits=limits)
    
    def _normalize_bone_name(self, name: str) -> str:
        """Normalize bone name for limit lookup."""
        # Convert common formats: mixamorig:LeftArm -> left_arm
        name = name.lower()
        name = name.replace("mixamorig:", "")
        name = name.replace("_l", "_left").replace("_r", "_right")
        name = name.replace(".", "_")
        # CamelCase to snake_case
        result = []
        for i, c in enumerate(name):
            if c.isupper() and i > 0:
                result.append("_")
            result.append(c.lower())
        return "".join(result)
    
    def set_rotation(self, bone_name: str, pitch: float = None, yaw: float = None, 
                     roll: float = None, enforce_limits: bool = True) -> BoneState:
        """Set bone rotation, optionally enforcing anatomical limits."""
        if bone_name not in self._bones:
            raise ValueError(f"Unknown bone: {bone_name}")
        
        bone = self._bones[bone_name]
        
        if pitch is not None:
            if enforce_limits:
                pitch = max(bone.limits.pitch_min, min(bone.limits.pitch_max, pitch))
            bone.pitch = pitch
        
        if yaw is not None:
            if enforce_limits:
                yaw = max(bone.limits.yaw_min, min(bone.limits.yaw_max, yaw))
            bone.yaw = yaw
        
        if roll is not None:
            if enforce_limits:
                roll = max(bone.limits.roll_min, min(bone.limits.roll_max, roll))
            bone.roll = roll
        
        # Notify callbacks
        for callback in self._callbacks:
            try:
                callback(bone_name, bone)
            except Exception as e:
                logger.error(f"Bone callback error: {e}")
        
        return bone
    
    def get_rotation(self, bone_name: str) -> Tuple[float, float, float]:
        """Get current bone rotation (pitch, yaw, roll)."""
        if bone_name not in self._bones:
            raise ValueError(f"Unknown bone: {bone_name}")
        bone = self._bones[bone_name]
        return (bone.pitch, bone.yaw, bone.roll)
    
    def reset_bone(self, bone_name: str) -> None:
        """Reset a bone to neutral position."""
        if bone_name in self._bones:
            self._bones[bone_name].pitch = 0.0
            self._bones[bone_name].yaw = 0.0
            self._bones[bone_name].roll = 0.0
    
    def reset_all(self) -> None:
        """Reset all bones to neutral position."""
        for name in self._bones:
            self.reset_bone(name)
    
    def get_all_states(self) -> Dict[str, dict]:
        """Get all bone states as a dictionary."""
        return {
            name: {
                "pitch": bone.pitch,
                "yaw": bone.yaw,
                "roll": bone.roll,
            }
            for name, bone in self._bones.items()
        }
    
    def on_bone_changed(self, callback: Callable[[str, BoneState], None]) -> None:
        """Register a callback for bone changes."""
        self._callbacks.append(callback)
    
    @property
    def bone_names(self) -> List[str]:
        """Get list of controlled bone names."""
        return list(self._bones.keys())


# =============================================================================
# MODEL MANAGEMENT - glTF/GLB/OBJ Loading
# =============================================================================

@dataclass
class Bone:
    """Represents a bone in the skeleton."""
    name: str
    index: int
    parent_index: int = -1
    children: List[int] = field(default_factory=list)
    local_transform: List[float] = field(default_factory=lambda: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])


@dataclass  
class Mesh:
    """Represents a mesh in the model."""
    name: str
    vertices: List[float] = field(default_factory=list)
    normals: List[float] = field(default_factory=list)
    uvs: List[float] = field(default_factory=list)
    indices: List[int] = field(default_factory=list)


@dataclass
class AvatarModel:
    """Represents a loaded 3D avatar model."""
    name: str
    path: str
    format: str  # "glb", "gltf", "obj"
    meshes: List[Mesh] = field(default_factory=list)
    bones: List[Bone] = field(default_factory=list)
    animations: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    @property
    def bone_names(self) -> List[str]:
        return [b.name for b in self.bones]
    
    @property
    def mesh_count(self) -> int:
        return len(self.meshes)
    
    @property
    def bone_count(self) -> int:
        return len(self.bones)


class ModelManager:
    """Manages avatar model loading and storage."""
    
    SUPPORTED_FORMATS = {".glb", ".gltf", ".obj"}
    
    def __init__(self):
        self._models: Dict[str, AvatarModel] = {}
        self._current: Optional[str] = None
    
    def load(self, path: str) -> AvatarModel:
        """Load a model from file."""
        path_obj = Path(path)
        
        if not path_obj.exists():
            raise FileNotFoundError(f"Model not found: {path}")
        
        suffix = path_obj.suffix.lower()
        if suffix not in self.SUPPORTED_FORMATS:
            raise ValueError(f"Unsupported format: {suffix}")
        
        # Load based on format
        if suffix == ".glb":
            model = self._load_glb(path_obj)
        elif suffix == ".gltf":
            model = self._load_gltf(path_obj)
        elif suffix == ".obj":
            model = self._load_obj(path_obj)
        else:
            raise ValueError(f"Unsupported format: {suffix}")
        
        self._models[model.name] = model
        self._current = model.name
        
        logger.info(f"Loaded model: {model.name} ({model.bone_count} bones, {model.mesh_count} meshes)")
        return model
    
    def _load_glb(self, path: Path) -> AvatarModel:
        """Load a GLB (binary glTF) file."""
        try:
            from pygltflib import GLTF2
            gltf = GLTF2().load(str(path))
            return self._parse_gltf(gltf, path)
        except ImportError:
            # Fallback: parse GLB header manually
            return self._load_glb_basic(path)
    
    def _load_glb_basic(self, path: Path) -> AvatarModel:
        """Basic GLB loading without pygltflib."""
        with open(path, "rb") as f:
            # GLB header
            magic = f.read(4)
            if magic != b"glTF":
                raise ValueError("Invalid GLB file")
            
            version = struct.unpack("<I", f.read(4))[0]
            length = struct.unpack("<I", f.read(4))[0]
            
            # JSON chunk
            chunk_length = struct.unpack("<I", f.read(4))[0]
            chunk_type = f.read(4)
            json_data = json.loads(f.read(chunk_length).decode("utf-8"))
            
            # Extract bone names from nodes
            bones = []
            if "nodes" in json_data:
                for i, node in enumerate(json_data["nodes"]):
                    if "skin" in json_data.get("meshes", [{}])[0] if json_data.get("meshes") else False:
                        # Likely a bone
                        bones.append(Bone(
                            name=node.get("name", f"bone_{i}"),
                            index=i,
                        ))
                    elif "children" in node or i < 50:  # Heuristic for skeleton nodes
                        bones.append(Bone(
                            name=node.get("name", f"bone_{i}"),
                            index=i,
                            children=node.get("children", []),
                        ))
            
            return AvatarModel(
                name=path.stem,
                path=str(path),
                format="glb",
                bones=bones,
                metadata={"version": version, "nodes": len(json_data.get("nodes", []))},
            )
    
    def _load_gltf(self, path: Path) -> AvatarModel:
        """Load a glTF file."""
        try:
            from pygltflib import GLTF2
            gltf = GLTF2().load(str(path))
            return self._parse_gltf(gltf, path)
        except ImportError:
            # Fallback: parse JSON directly
            with open(path) as f:
                data = json.load(f)
            
            bones = []
            for i, node in enumerate(data.get("nodes", [])):
                bones.append(Bone(
                    name=node.get("name", f"bone_{i}"),
                    index=i,
                    children=node.get("children", []),
                ))
            
            return AvatarModel(
                name=path.stem,
                path=str(path),
                format="gltf",
                bones=bones,
            )
    
    def _parse_gltf(self, gltf, path: Path) -> AvatarModel:
        """Parse a loaded GLTF2 object."""
        bones = []
        for i, node in enumerate(gltf.nodes or []):
            bones.append(Bone(
                name=node.name or f"bone_{i}",
                index=i,
                children=list(node.children) if node.children else [],
            ))
        
        meshes = []
        for mesh in gltf.meshes or []:
            meshes.append(Mesh(name=mesh.name or "mesh"))
        
        animations = {}
        for anim in gltf.animations or []:
            animations[anim.name or f"anim_{len(animations)}"] = {"channels": len(anim.channels)}
        
        return AvatarModel(
            name=path.stem,
            path=str(path),
            format="glb" if path.suffix.lower() == ".glb" else "gltf",
            meshes=meshes,
            bones=bones,
            animations=animations,
        )
    
    def _load_obj(self, path: Path) -> AvatarModel:
        """Load an OBJ file (mesh only, no bones)."""
        vertices = []
        normals = []
        uvs = []
        
        with open(path) as f:
            for line in f:
                parts = line.strip().split()
                if not parts:
                    continue
                
                if parts[0] == "v" and len(parts) >= 4:
                    vertices.extend([float(parts[1]), float(parts[2]), float(parts[3])])
                elif parts[0] == "vn" and len(parts) >= 4:
                    normals.extend([float(parts[1]), float(parts[2]), float(parts[3])])
                elif parts[0] == "vt" and len(parts) >= 3:
                    uvs.extend([float(parts[1]), float(parts[2])])
        
        mesh = Mesh(
            name=path.stem,
            vertices=vertices,
            normals=normals,
            uvs=uvs,
        )
        
        return AvatarModel(
            name=path.stem,
            path=str(path),
            format="obj",
            meshes=[mesh],
            metadata={"vertex_count": len(vertices) // 3},
        )
    
    def get_current(self) -> Optional[AvatarModel]:
        """Get the currently active model."""
        if self._current:
            return self._models.get(self._current)
        return None
    
    def get(self, name: str) -> Optional[AvatarModel]:
        """Get a model by name."""
        return self._models.get(name)
    
    def list_models(self) -> List[str]:
        """List all loaded models."""
        return list(self._models.keys())
    
    def unload(self, name: str) -> bool:
        """Unload a model."""
        if name in self._models:
            del self._models[name]
            if self._current == name:
                self._current = None
            return True
        return False


# =============================================================================
# AVATAR BRICK - Main Controller
# =============================================================================

class AvatarBrick:
    """Standalone avatar display and control brick."""
    
    NAME = "Avatar"
    BRICK_ID = "enigma.avatar"
    VERSION = "1.0.0"
    DESCRIPTION = "3D avatar display and bone control"
    
    def __init__(self):
        # Core components
        self._model_manager = ModelManager()
        self._bone_controller: Optional[BoneController] = None
        
        # State
        self._visible = False
        self._position = [0.0, 0.0, 0.0]
        self._scale = 1.0
        self._expression = "neutral"
        
        # Router connection
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._connected = False
        
        # Command handlers
        self._commands = {
            "avatar.load": self._cmd_load,
            "avatar.show": self._cmd_show,
            "avatar.hide": self._cmd_hide,
            "avatar.bone": self._cmd_bone,
            "avatar.reset": self._cmd_reset,
            "avatar.expression": self._cmd_expression,
            "avatar.position": self._cmd_position,
            "avatar.scale": self._cmd_scale,
            "avatar.info": self._cmd_info,
            "avatar.bones": self._cmd_bones,
        }
        
        # Command metadata for registration
        self._command_info = [
            {"name": "avatar.load", "description": "Load a 3D model", "params": ["path"]},
            {"name": "avatar.show", "description": "Show the avatar", "params": []},
            {"name": "avatar.hide", "description": "Hide the avatar", "params": []},
            {"name": "avatar.bone", "description": "Rotate a bone", "params": ["name", "pitch", "yaw", "roll"]},
            {"name": "avatar.reset", "description": "Reset bones to neutral", "params": ["bone"]},
            {"name": "avatar.expression", "description": "Set facial expression", "params": ["name"]},
            {"name": "avatar.position", "description": "Set avatar position", "params": ["x", "y", "z"]},
            {"name": "avatar.scale", "description": "Set avatar scale", "params": ["scale"]},
            {"name": "avatar.info", "description": "Get avatar info", "params": []},
            {"name": "avatar.bones", "description": "List available bones", "params": []},
        ]
        
        self._events = [
            "avatar.loaded",
            "avatar.bone_moved", 
            "avatar.expression_changed",
            "avatar.visibility_changed",
        ]
    
    # -------------------------------------------------------------------------
    # Command Handlers
    # -------------------------------------------------------------------------
    
    def _cmd_load(self, params: dict) -> dict:
        """Load a 3D model file."""
        path = params.get("path", "")
        if not path:
            return {"error": "Missing 'path' parameter"}
        
        try:
            model = self._model_manager.load(path)
            
            # Initialize bone controller with model's bones
            self._bone_controller = BoneController(model.bone_names)
            
            self._emit_event("avatar.loaded", {
                "name": model.name,
                "path": model.path,
                "bones": model.bone_names,
            })
            
            return {
                "success": True,
                "model": {
                    "name": model.name,
                    "format": model.format,
                    "bone_count": model.bone_count,
                    "mesh_count": model.mesh_count,
                    "bones": model.bone_names,
                },
            }
        except Exception as e:
            return {"error": str(e)}
    
    def _cmd_show(self, params: dict) -> dict:
        """Show the avatar."""
        self._visible = True
        self._emit_event("avatar.visibility_changed", {"visible": True})
        return {"visible": True}
    
    def _cmd_hide(self, params: dict) -> dict:
        """Hide the avatar."""
        self._visible = False
        self._emit_event("avatar.visibility_changed", {"visible": False})
        return {"visible": False}
    
    def _cmd_bone(self, params: dict) -> dict:
        """Rotate a bone."""
        if not self._bone_controller:
            return {"error": "No model loaded"}
        
        name = params.get("name", "")
        if not name:
            return {"error": "Missing 'name' parameter"}
        
        try:
            pitch = params.get("pitch")
            yaw = params.get("yaw")
            roll = params.get("roll")
            
            state = self._bone_controller.set_rotation(name, pitch, yaw, roll)
            
            self._emit_event("avatar.bone_moved", {
                "bone": name,
                "pitch": state.pitch,
                "yaw": state.yaw,
                "roll": state.roll,
            })
            
            return {
                "bone": name,
                "pitch": state.pitch,
                "yaw": state.yaw,
                "roll": state.roll,
            }
        except ValueError as e:
            return {"error": str(e)}
    
    def _cmd_reset(self, params: dict) -> dict:
        """Reset bones to neutral position."""
        if not self._bone_controller:
            return {"error": "No model loaded"}
        
        bone = params.get("bone")
        if bone:
            self._bone_controller.reset_bone(bone)
            return {"reset": bone}
        else:
            self._bone_controller.reset_all()
            return {"reset": "all"}
    
    def _cmd_expression(self, params: dict) -> dict:
        """Set facial expression."""
        name = params.get("name", "neutral")
        self._expression = name
        self._emit_event("avatar.expression_changed", {"expression": name})
        return {"expression": name}
    
    def _cmd_position(self, params: dict) -> dict:
        """Set avatar position."""
        x = params.get("x", self._position[0])
        y = params.get("y", self._position[1])
        z = params.get("z", self._position[2])
        self._position = [float(x), float(y), float(z)]
        return {"position": self._position}
    
    def _cmd_scale(self, params: dict) -> dict:
        """Set avatar scale."""
        scale = params.get("scale", 1.0)
        self._scale = float(scale)
        return {"scale": self._scale}
    
    def _cmd_info(self, params: dict) -> dict:
        """Get current avatar info."""
        model = self._model_manager.get_current()
        return {
            "model": model.name if model else None,
            "visible": self._visible,
            "position": self._position,
            "scale": self._scale,
            "expression": self._expression,
            "bone_count": model.bone_count if model else 0,
        }
    
    def _cmd_bones(self, params: dict) -> dict:
        """List available bones and their current state."""
        if not self._bone_controller:
            return {"error": "No model loaded", "bones": []}
        
        states = self._bone_controller.get_all_states()
        return {
            "bones": list(states.keys()),
            "states": states,
        }
    
    # -------------------------------------------------------------------------
    # Router Connection
    # -------------------------------------------------------------------------
    
    def connect(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT):
        """Connect to the router."""
        self._running = True
        self._thread = threading.Thread(target=self._run_client, args=(host, port), daemon=True)
        self._thread.start()
        
        # Wait for connection
        for _ in range(50):
            if self._connected:
                break
            time.sleep(0.1)
        
        if self._connected:
            logger.info(f"Connected to router at {host}:{port}")
        else:
            logger.error(f"Failed to connect to router at {host}:{port}")
    
    def disconnect(self):
        """Disconnect from the router."""
        self._running = False
        
        if self._loop and self._connected:
            try:
                future = asyncio.run_coroutine_threadsafe(self._close(), self._loop)
                future.result(timeout=2.0)
            except Exception:
                pass
        
        self._connected = False
        
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
        
        if self._thread:
            self._thread.join(timeout=2.0)
        
        logger.info("Disconnected from router")
    
    def run_forever(self):
        """Block until disconnected."""
        try:
            while self._running:
                time.sleep(0.1)
        except KeyboardInterrupt:
            pass
        finally:
            self.disconnect()
    
    def _run_client(self, host: str, port: int):
        """Run the client event loop."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        
        try:
            self._loop.run_until_complete(self._connect_and_run(host, port))
            self._loop.run_forever()
        except Exception as e:
            logger.error(f"Client error: {e}")
        finally:
            self._loop.close()
    
    async def _connect_and_run(self, host: str, port: int):
        """Connect and start message handling."""
        try:
            self._reader, self._writer = await asyncio.open_connection(host, port)
            self._connected = True
            
            # Register with router
            await self._register()
            
            # Start heartbeat
            asyncio.create_task(self._heartbeat_loop())
            
            # Handle messages
            await self._message_loop()
        
        except ConnectionRefusedError:
            logger.error("Connection refused - is the router running?")
        except Exception as e:
            logger.error(f"Connection error: {e}")
        finally:
            self._connected = False
    
    async def _close(self):
        """Close the connection."""
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
    
    async def _register(self):
        """Send registration message."""
        message = create_register_message(
            name=self.NAME,
            brick_id=self.BRICK_ID,
            version=self.VERSION,
            description=self.DESCRIPTION,
            commands=self._command_info,
            events=self._events,
            ui={
                "tab_name": "Avatar",
                "width": 400,
                "height": 600,
            },
        )
        await self._send(message)
    
    async def _send(self, message: Message):
        """Send a message to the router."""
        if not self._writer:
            return
        try:
            self._writer.write(message.to_bytes())
            await self._writer.drain()
        except Exception as e:
            logger.error(f"Send failed: {e}")
    
    async def _message_loop(self):
        """Handle incoming messages."""
        while self._running and self._reader:
            try:
                line = await asyncio.wait_for(self._reader.readline(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            
            if not line:
                break
            
            try:
                message = parse_message(line)
                await self._handle_message(message)
            except Exception as e:
                logger.error(f"Message handling error: {e}")
    
    async def _handle_message(self, message: Message):
        """Handle an incoming message."""
        if message.type == MessageType.COMMAND:
            await self._handle_command(message)
        elif message.type == MessageType.RESPONSE:
            pass  # Handle responses if needed
        elif message.type == MessageType.EVENT:
            pass  # Handle events from other bricks
    
    async def _handle_command(self, message: Message):
        """Handle a command message."""
        command = message.data.get("command", "")
        params = message.data.get("params", {})
        
        handler = self._commands.get(command)
        if handler:
            try:
                result = handler(params)
                response = create_response_message(
                    message.id,
                    success=True,
                    result=result,
                    source=self.BRICK_ID,
                    target=message.source,
                )
            except Exception as e:
                logger.error(f"Command error: {e}")
                response = create_response_message(
                    message.id,
                    success=False,
                    error=str(e),
                    source=self.BRICK_ID,
                    target=message.source,
                )
        else:
            response = create_response_message(
                message.id,
                success=False,
                error=f"Unknown command: {command}",
                source=self.BRICK_ID,
                target=message.source,
            )
        
        await self._send(response)
    
    async def _heartbeat_loop(self):
        """Send periodic heartbeats."""
        while self._running:
            await asyncio.sleep(30)
            if self._connected:
                message = create_heartbeat_message(self.BRICK_ID)
                await self._send(message)
    
    def _emit_event(self, event: str, payload: dict):
        """Emit an event to the router."""
        if not self._loop or not self._connected:
            return
        message = create_event_message(event, payload, source=self.BRICK_ID)
        asyncio.run_coroutine_threadsafe(self._send(message), self._loop)


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================

def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        prog="enigma-avatar",
        description="Enigma Avatar Brick - 3D avatar display and control"
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help="Router host")
    parser.add_argument("--port", "-p", type=int, default=DEFAULT_PORT, help="Router port")
    parser.add_argument("--standalone", action="store_true", help="Run without router")
    parser.add_argument("--model", "-m", help="Model to load on startup")
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("ENIGMA AVATAR BRICK - Standalone")
    print("=" * 60)
    
    brick = AvatarBrick()
    
    # Load model if specified
    if args.model:
        print(f"\nLoading model: {args.model}")
        result = brick._cmd_load({"path": args.model})
        if "error" in result:
            print(f"  Error: {result['error']}")
        else:
            print(f"  Loaded: {result['model']['name']}")
            print(f"  Bones: {result['model']['bone_count']}")
    
    if args.standalone:
        print("\nRunning in standalone mode (no router connection)")
        print("Commands available via Python API")
        print("\nPress Ctrl+C to exit")
        
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nExiting...")
    else:
        print(f"\nConnecting to router at {args.host}:{args.port}...")
        brick.connect(args.host, args.port)
        
        if not brick._connected:
            print("\nFailed to connect. Start the router with:")
            print("  forge router")
            return 1
        
        print("\nAvatar brick running!")
        print(f"Commands: {', '.join(brick._commands.keys())}")
        print("\nPress Ctrl+C to stop")
        
        brick.run_forever()
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
