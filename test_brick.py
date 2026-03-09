#!/usr/bin/env python3
"""
Test the Avatar Brick with the Router

Tests:
1. Start router
2. Start avatar brick
3. Check registration
4. Send commands
5. Verify responses
"""

import logging
import sys
import time

sys.path.insert(0, "c:\\Users\\SirKn\\Enigma Engine")
sys.path.insert(0, "c:\\Users\\SirKn\\Enigma Engine\\bricks\\enigma-avatar")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("test_avatar_brick")


def main():
    print("=" * 60)
    print("AVATAR BRICK TEST")
    print("=" * 60)
    
    # Start router
    print("\n1. Starting router...")
    from enigma_engine.router import start_router, stop_router, get_router
    
    server = start_router()
    time.sleep(0.5)
    
    if not server.is_running():
        print("   FAILED: Router not running")
        return 1
    print(f"   Router running on {server.host}:{server.port}")
    
    # Start avatar brick
    print("\n2. Starting avatar brick...")
    from enigma_avatar import AvatarBrick
    
    brick = AvatarBrick()
    brick.connect()
    time.sleep(0.5)
    
    if not brick._connected:
        print("   FAILED: Brick not connected")
        stop_router()
        return 1
    print("   Avatar brick connected")
    
    # Check registration
    print("\n3. Checking registration...")
    bricks = server.get_bricks()
    print(f"   Connected bricks: {len(bricks)}")
    
    avatar_info = server.registry.get("avatar")
    if not avatar_info:
        print("   FAILED: Avatar not registered")
        brick.disconnect()
        stop_router()
        return 1
    
    print(f"   Name: {avatar_info.name}")
    print(f"   Commands: {len(avatar_info.commands)}")
    for cmd in avatar_info.commands[:3]:
        print(f"     - {cmd.name}")
    if len(avatar_info.commands) > 3:
        print(f"     ... and {len(avatar_info.commands) - 3} more")
    
    # Test commands
    print("\n4. Testing avatar.info command...")
    result = server.send_command("avatar", "avatar.info", {})
    print(f"   Result: {result}")
    
    if not result or not result.get("success"):
        print("   FAILED: avatar.info failed")
        brick.disconnect()
        stop_router()
        return 1
    print("   avatar.info successful!")
    
    print("\n5. Testing avatar.bone command...")
    result = server.send_command("avatar", "avatar.bone", {
        "name": "head",
        "rotation": [15, -10, 0]
    })
    print(f"   Result: {result}")
    
    if not result or not result.get("success"):
        print("   FAILED: avatar.bone failed")
        brick.disconnect()
        stop_router()
        return 1
    
    actual = result.get("result", {}).get("rotation", [])
    print(f"   Bone moved to: {actual}")
    
    print("\n6. Testing avatar.reset command...")
    result = server.send_command("avatar", "avatar.reset", {})
    print(f"   Result: {result}")
    
    # Cleanup
    print("\n7. Cleaning up...")
    brick.disconnect()
    time.sleep(0.5)
    stop_router()
    print("   Done!")
    
    print("\n" + "=" * 60)
    print("ALL TESTS PASSED!")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
