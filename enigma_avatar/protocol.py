"""
Brick Protocol - Standalone version for enigma-avatar brick

TCP + JSON protocol for connecting to Enigma router.
"""

import json
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional
import time


class MessageType(Enum):
    """Types of messages in the brick protocol."""
    REGISTER = "register"
    COMMAND = "command"
    RESPONSE = "response"
    EVENT = "event"
    QUERY = "query"
    ERROR = "error"
    HEARTBEAT = "heartbeat"
    UNREGISTER = "unregister"


@dataclass
class Message:
    """A protocol message."""
    id: str
    type: MessageType
    data: dict = field(default_factory=dict)
    source: Optional[str] = None
    target: Optional[str] = None
    timestamp: Optional[float] = None
    
    def to_dict(self) -> dict:
        result = {
            "id": self.id,
            "type": self.type.value,
            "data": self.data,
        }
        if self.source:
            result["source"] = self.source
        if self.target:
            result["target"] = self.target
        if self.timestamp:
            result["timestamp"] = self.timestamp
        return result
    
    def to_json(self) -> str:
        return json.dumps(self.to_dict())
    
    def to_bytes(self) -> bytes:
        return (self.to_json() + "\n").encode("utf-8")


def generate_id() -> str:
    return str(uuid.uuid4())


def parse_message(data: str | bytes | dict) -> Message:
    if isinstance(data, bytes):
        data = data.decode("utf-8").strip()
    if isinstance(data, str):
        data = json.loads(data)
    
    return Message(
        id=data["id"],
        type=MessageType(data["type"]),
        data=data.get("data", {}),
        source=data.get("source"),
        target=data.get("target"),
        timestamp=data.get("timestamp"),
    )


def create_message(
    msg_type: MessageType,
    data: dict | None = None,
    msg_id: str | None = None,
    source: str | None = None,
    target: str | None = None,
) -> Message:
    return Message(
        id=msg_id or generate_id(),
        type=msg_type,
        data=data or {},
        source=source,
        target=target,
        timestamp=time.time(),
    )


def create_register_message(
    name: str,
    brick_id: str,
    version: str = "1.0.0",
    author: str = "",
    description: str = "",
    commands: list[dict] | None = None,
    events: list[str] | None = None,
    ui: dict | None = None,
) -> Message:
    return create_message(
        MessageType.REGISTER,
        data={
            "name": name,
            "brick_id": brick_id,
            "version": version,
            "author": author,
            "description": description,
            "commands": commands or [],
            "events": events or [],
            "ui": ui or {},
        },
        source=brick_id,
    )


def create_response_message(
    request_id: str,
    success: bool,
    result: Any = None,
    error: str | None = None,
    source: str | None = None,
    target: str | None = None,
) -> Message:
    data = {"request_id": request_id, "success": success}
    if success:
        data["result"] = result
    else:
        data["error"] = error
    return create_message(MessageType.RESPONSE, data=data, source=source, target=target)


def create_event_message(
    event: str,
    payload: dict | None = None,
    source: str | None = None,
) -> Message:
    return create_message(
        MessageType.EVENT,
        data={"event": event, "payload": payload or {}},
        source=source,
    )


def create_heartbeat_message(source: str | None = None) -> Message:
    return create_message(MessageType.HEARTBEAT, source=source)
