"""
Avatar Model Management

Handles loading and managing 3D avatar models.
Supports glTF/GLB formats.
"""

import json
import logging
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class Bone:
    """A bone in the skeleton."""
    name: str
    index: int
    parent_index: int = -1
    local_position: tuple[float, float, float] = (0, 0, 0)
    local_rotation: tuple[float, float, float, float] = (0, 0, 0, 1)  # Quaternion xyzw
    local_scale: tuple[float, float, float] = (1, 1, 1)
    children: list[int] = field(default_factory=list)


@dataclass
class Mesh:
    """3D mesh data."""
    name: str
    vertices: list[float] = field(default_factory=list)
    normals: list[float] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)
    bone_indices: list[int] = field(default_factory=list)


@dataclass
class AvatarModel:
    """A loaded avatar model."""
    name: str
    path: str
    bones: list[Bone] = field(default_factory=list)
    meshes: list[Mesh] = field(default_factory=list)
    
    def get_bone_names(self) -> list[str]:
        """Get list of all bone names."""
        return [bone.name for bone in self.bones]
    
    def get_bone(self, name: str) -> Optional[Bone]:
        """Get bone by name."""
        for bone in self.bones:
            if bone.name == name:
                return bone
        return None
    
    def to_dict(self) -> dict:
        """Export model info as dictionary."""
        return {
            "name": self.name,
            "path": self.path,
            "bone_count": len(self.bones),
            "mesh_count": len(self.meshes),
            "bones": self.get_bone_names(),
        }


class ModelManager:
    """
    Manages loading and caching avatar models.
    """
    
    def __init__(self, models_dir: Optional[str] = None):
        self._models: dict[str, AvatarModel] = {}
        self._current_model: Optional[AvatarModel] = None
        self._models_dir = Path(models_dir) if models_dir else Path("data/avatar/models")
        self._models_dir.mkdir(parents=True, exist_ok=True)
    
    def load(self, path: str) -> Optional[AvatarModel]:
        """
        Load a model from file.
        
        Args:
            path: Path to model file (glTF, GLB, OBJ)
            
        Returns:
            Loaded AvatarModel or None if failed
        """
        path = Path(path)
        
        if not path.exists():
            # Try models directory
            alt_path = self._models_dir / path.name
            if alt_path.exists():
                path = alt_path
            else:
                logger.error(f"Model not found: {path}")
                return None
        
        try:
            suffix = path.suffix.lower()
            
            if suffix == ".glb":
                model = self._load_glb(path)
            elif suffix == ".gltf":
                model = self._load_gltf(path)
            elif suffix == ".obj":
                model = self._load_obj(path)
            else:
                logger.error(f"Unsupported format: {suffix}")
                return None
            
            if model:
                self._models[model.name] = model
                self._current_model = model
                logger.info(f"Loaded model: {model.name} ({len(model.bones)} bones)")
            
            return model
            
        except Exception as e:
            logger.error(f"Failed to load model {path}: {e}")
            return None
    
    def get_current(self) -> Optional[AvatarModel]:
        """Get the currently loaded model."""
        return self._current_model
    
    def list_models(self) -> list[str]:
        """List available model files."""
        models = []
        for ext in ["*.glb", "*.gltf", "*.obj"]:
            models.extend(self._models_dir.glob(ext))
        return [p.name for p in models]
    
    def _load_glb(self, path: Path) -> Optional[AvatarModel]:
        """Load a GLB (binary glTF) file."""
        with open(path, "rb") as f:
            # GLB header
            magic = struct.unpack("<I", f.read(4))[0]
            if magic != 0x46546C67:  # "glTF"
                raise ValueError("Not a valid GLB file")
            
            version = struct.unpack("<I", f.read(4))[0]
            length = struct.unpack("<I", f.read(4))[0]
            
            # JSON chunk
            chunk_length = struct.unpack("<I", f.read(4))[0]
            chunk_type = struct.unpack("<I", f.read(4))[0]
            
            if chunk_type != 0x4E4F534A:  # "JSON"
                raise ValueError("Expected JSON chunk")
            
            json_data = f.read(chunk_length).decode("utf-8")
            gltf = json.loads(json_data)
            
            # Binary chunk (if any)
            binary_data = b""
            if f.tell() < length:
                chunk_length = struct.unpack("<I", f.read(4))[0]
                chunk_type = struct.unpack("<I", f.read(4))[0]
                if chunk_type == 0x004E4942:  # "BIN"
                    binary_data = f.read(chunk_length)
        
        return self._parse_gltf(gltf, binary_data, path)
    
    def _load_gltf(self, path: Path) -> Optional[AvatarModel]:
        """Load a glTF (JSON) file."""
        with open(path) as f:
            gltf = json.load(f)
        return self._parse_gltf(gltf, b"", path)
    
    def _parse_gltf(self, gltf: dict, binary_data: bytes, path: Path) -> Optional[AvatarModel]:
        """Parse glTF data into AvatarModel."""
        model = AvatarModel(
            name=path.stem,
            path=str(path),
        )
        
        # Parse skeleton/bones from skin
        if "skins" in gltf and gltf["skins"]:
            skin = gltf["skins"][0]
            joints = skin.get("joints", [])
            nodes = gltf.get("nodes", [])
            
            for i, joint_idx in enumerate(joints):
                if joint_idx < len(nodes):
                    node = nodes[joint_idx]
                    bone = Bone(
                        name=node.get("name", f"bone_{i}"),
                        index=i,
                        local_position=tuple(node.get("translation", [0, 0, 0])),
                        local_rotation=tuple(node.get("rotation", [0, 0, 0, 1])),
                        local_scale=tuple(node.get("scale", [1, 1, 1])),
                    )
                    
                    # Find parent
                    for pi, pnode in enumerate(nodes):
                        if "children" in pnode and joint_idx in pnode["children"]:
                            if pi in joints:
                                bone.parent_index = joints.index(pi)
                            break
                    
                    model.bones.append(bone)
        
        # Parse meshes (simplified - just count them)
        if "meshes" in gltf:
            for mesh_data in gltf["meshes"]:
                mesh = Mesh(name=mesh_data.get("name", "mesh"))
                model.meshes.append(mesh)
        
        return model
    
    def _load_obj(self, path: Path) -> Optional[AvatarModel]:
        """Load an OBJ file (static, no bones)."""
        model = AvatarModel(
            name=path.stem,
            path=str(path),
        )
        
        mesh = Mesh(name=path.stem)
        
        with open(path) as f:
            for line in f:
                parts = line.strip().split()
                if not parts:
                    continue
                
                if parts[0] == "v" and len(parts) >= 4:
                    mesh.vertices.extend([float(parts[1]), float(parts[2]), float(parts[3])])
                elif parts[0] == "vn" and len(parts) >= 4:
                    mesh.normals.extend([float(parts[1]), float(parts[2]), float(parts[3])])
                elif parts[0] == "f":
                    # Parse face indices
                    for part in parts[1:]:
                        idx = part.split("/")[0]
                        mesh.indices.append(int(idx) - 1)  # OBJ is 1-indexed
        
        model.meshes.append(mesh)
        return model
