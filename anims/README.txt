Animation clip library — drop Mixamo-style humanoid clips here (.glb / .gltf / .fbx).

They are RETARGETED at runtime onto whatever avatar is loaded, through the engine's
resolved role map with rest-pose compensation (retarget.js) — no per-model setup.

Play one:  bus  {"action":"anim","name":"dance"}        (matches the file name, loops)
Stop:      bus  {"action":"anim","name":"x","stop":true}
One-shot:  bus  {"action":"anim","name":"wave","loop":false}

Sources: Mixamo (download as FBX, "Without Skin" works), or any CC0 humanoid clip pack
(e.g. the Quaternius Universal Animation Library) — clips must use Mixamo-convention
bone names (mixamorig:Hips / Spine / Spine2 / Neck / Head / Left|RightShoulder / Arm /
ForeArm / Hand / UpLeg / Leg / Foot) for the skeleton to be recognized.
