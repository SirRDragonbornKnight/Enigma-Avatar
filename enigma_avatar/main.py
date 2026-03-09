#!/usr/bin/env python3
"""
Enigma Avatar Brick - Main Entry Point

Standalone avatar display and control that connects to Enigma router.

Usage:
    enigma-avatar                    # Connect to router
    enigma-avatar --standalone       # Run without router
    enigma-avatar --port 9900        # Specify router port
"""

import argparse
import asyncio
import logging
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from .protocol import (
    Message,
    MessageType,
    create_event_message,
    create_heartbeat_message,
    create_register_message,
    create_response_message,
    parse_message,
)
from .core.bones import BoneController
from .core.model import ModelManager, AvatarModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("enigma-avatar")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9900


class AvatarBrick:
    """
    Avatar brick that connects to Enigma router.
    
    Exposes commands:
    - avatar.load: Load a 3D model
    - avatar.show: Show avatar window
    - avatar.hide: Hide avatar window
    - avatar.bone: Move a bone
    - avatar.reset: Reset all bones
    - avatar.expression: Set expression
    - avatar.position: Move window
    - avatar.scale: Set scale
    - avatar.info: Get avatar info
    """
    
    BRICK_ID = "avatar"
    NAME = "Avatar"
    VERSION = "1.0.0"
    DESCRIPTION = "3D avatar display and bone control"
    
    def __init__(self):
        # Core systems
        self.bones = BoneController()
        self.models = ModelManager()
        
        # State
        self.visible = False
        self.position = (100, 100)
        self.scale = 1.0
        self.expression = "neutral"
        
        # Connection state
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected = False
        self._running = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        
        # Register commands
        self._commands: dict[str, Callable] = {
            "avatar.load": self._cmd_load,
            "avatar.show": self._cmd_show,
            "avatar.hide": self._cmd_hide,
            "avatar.bone": self._cmd_bone,
            "avatar.reset": self._cmd_reset,
            "avatar.expression": self._cmd_expression,
            "avatar.position": self._cmd_position,
            "avatar.scale": self._cmd_scale,
            "avatar.info": self._cmd_info,
            "avatar.bones": self._cmd_get_bones,
        }
        
        # Command definitions for registration
        self._command_info = [
            {"name": "avatar.load", "description": "Load a 3D model", 
             "params": {"path": {"type": "string", "description": "Path to model file"}}},
            {"name": "avatar.show", "description": "Show the avatar window"},
            {"name": "avatar.hide", "description": "Hide the avatar window"},
            {"name": "avatar.bone", "description": "Move a bone",
             "params": {
                 "name": {"type": "string", "description": "Bone name"},
                 "rotation": {"type": "array", "description": "[pitch, yaw, roll] in degrees"}
             }},
            {"name": "avatar.reset", "description": "Reset all bones to neutral"},
            {"name": "avatar.expression", "description": "Set facial expression",
             "params": {"name": {"type": "string", "description": "Expression name"}}},
            {"name": "avatar.position", "description": "Move window position",
             "params": {"x": {"type": "integer"}, "y": {"type": "integer"}}},
            {"name": "avatar.scale", "description": "Set avatar scale",
             "params": {"scale": {"type": "number"}}},
            {"name": "avatar.info", "description": "Get avatar information"},
            {"name": "avatar.bones", "description": "Get all bone states"},
        ]
        
        # Events
        self._events = [
            "avatar.loaded",
            "avatar.bone_moved",
            "avatar.expression_changed",
            "avatar.visibility_changed",
        ]
    
    # =========================================================================
    # Command Handlers
    # =========================================================================
    
    def _cmd_load(self, params: dict) -> dict:
        """Load a 3D model."""
        path = params.get("path", "")
        if not path:
            return {"error": "No path specified"}
        
        model = self.models.load(path)
        if model:
            # Set up bones from model
            self.bones.set_available_bones(model.get_bone_names())
            self._emit_event("avatar.loaded", {
                "path": path,
                "name": model.name,
                "bones": model.get_bone_names(),
            })
            return {"success": True, "model": model.to_dict()}
        else:
            return {"error": f"Failed to load model: {path}"}
    
    def _cmd_show(self, params: dict) -> dict:
        """Show the avatar window."""
        self.visible = True
        self._emit_event("avatar.visibility_changed", {"visible": True})
        logger.info("Avatar shown")
        return {"visible": True}
    
    def _cmd_hide(self, params: dict) -> dict:
        """Hide the avatar window."""
        self.visible = False
        self._emit_event("avatar.visibility_changed", {"visible": False})
        logger.info("Avatar hidden")
        return {"visible": False}
    
    def _cmd_bone(self, params: dict) -> dict:
        """Move a bone."""
        name = params.get("name", "")
        rotation = params.get("rotation", [0, 0, 0])
        
        if not name:
            return {"error": "No bone name specified"}
        
        if len(rotation) != 3:
            return {"error": "Rotation must be [pitch, yaw, roll]"}
        
        pitch, yaw, roll = rotation
        result = self.bones.move_bone(name, pitch=pitch, yaw=yaw, roll=roll)
        
        self._emit_event("avatar.bone_moved", {
            "bone": name,
            "rotation": list(result),
        })
        
        return {"bone": name, "rotation": list(result)}
    
    def _cmd_reset(self, params: dict) -> dict:
        """Reset all bones to neutral."""
        self.bones.reset_all()
        self._emit_event("avatar.bone_moved", {"bone": "*", "rotation": [0, 0, 0]})
        return {"reset": True}
    
    def _cmd_expression(self, params: dict) -> dict:
        """Set facial expression."""
        name = params.get("name", "neutral")
        self.expression = name
        self._emit_event("avatar.expression_changed", {"expression": name})
        logger.info(f"Expression set to: {name}")
        return {"expression": name}
    
    def _cmd_position(self, params: dict) -> dict:
        """Move window position."""
        x = params.get("x", self.position[0])
        y = params.get("y", self.position[1])
        self.position = (x, y)
        logger.info(f"Position set to: ({x}, {y})")
        return {"x": x, "y": y}
    
    def _cmd_scale(self, params: dict) -> dict:
        """Set avatar scale."""
        scale = params.get("scale", 1.0)
        self.scale = max(0.1, min(10.0, scale))  # Clamp 0.1-10x
        logger.info(f"Scale set to: {self.scale}")
        return {"scale": self.scale}
    
    def _cmd_info(self, params: dict) -> dict:
        """Get avatar information."""
        model = self.models.get_current()
        return {
            "visible": self.visible,
            "position": list(self.position),
            "scale": self.scale,
            "expression": self.expression,
            "model": model.to_dict() if model else None,
            "bone_count": len(self.bones.get_available_bones()),
        }
    
    def _cmd_get_bones(self, params: dict) -> dict:
        """Get all bone states."""
        return {
            "bones": self.bones.get_available_bones(),
            "states": self.bones.get_all_states(),
        }
    
    # =========================================================================
    # Router Connection
    # =========================================================================
    
    def connect(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT):
        """Connect to the Enigma router."""
        if self._connected:
            logger.warning("Already connected")
            return
        
        self._running = True
        self._thread = threading.Thread(
            target=self._run_client, 
            args=(host, port), 
            daemon=True
        )
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
            # Handle responses to our commands (if any)
            pass
        elif message.type == MessageType.EVENT:
            # Handle events from other bricks
            pass
    
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
    print("ENIGMA AVATAR BRICK")
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
        
        # Just keep running
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
