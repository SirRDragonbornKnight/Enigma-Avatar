# Enigma Avatar Brick

Standalone avatar display and control for Enigma Engine.

## Installation

```bash
pip install -e .
```

## Usage

### As a brick (connects to router)

```bash
# Terminal 1: Start Enigma router
forge router

# Terminal 2: Start avatar brick
enigma-avatar
```

### Standalone (for testing)

```bash
enigma-avatar --standalone
```

## Commands

The avatar brick exposes these commands when connected to the router:

| Command | Description | Params |
|---------|-------------|--------|
| `avatar.load` | Load a 3D model | `path` (str) |
| `avatar.show` | Show the avatar window | - |
| `avatar.hide` | Hide the avatar window | - |
| `avatar.bone` | Move a bone | `name` (str), `rotation` ([p,y,r]) |
| `avatar.reset` | Reset all bones to neutral | - |
| `avatar.expression` | Set expression | `name` (str) |
| `avatar.speak` | Trigger lip sync | `text` (str) |
| `avatar.position` | Move window position | `x` (int), `y` (int) |
| `avatar.scale` | Set avatar scale | `scale` (float) |

## Events

The avatar brick emits these events:

| Event | Description | Payload |
|-------|-------------|---------|
| `avatar.loaded` | Model loaded | `{path, bones}` |
| `avatar.bone_moved` | Bone position changed | `{bone, rotation}` |
| `avatar.expression_changed` | Expression changed | `{expression}` |
| `avatar.window_moved` | Window position changed | `{x, y}` |

## Architecture

```
enigma-avatar/
├── enigma_avatar/
│   ├── __init__.py
│   ├── main.py          # Entry point + brick client
│   ├── core/            # Avatar logic
│   │   ├── bones.py     # Bone control
│   │   ├── model.py     # Model loading
│   │   └── renderer.py  # 3D rendering
│   └── ui/              # Display window
│       └── window.py    # Qt window
└── pyproject.toml
```

## Protocol

Connects to Enigma router on `localhost:9900` using TCP + JSON protocol.
