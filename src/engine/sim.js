// sim.js — the SIMULATION TICK (carve S2-a, 2026-07-06): the one canonical order the world
// advances in, extracted from the brain window's animate() loop on the road to S2's
// "everything is a peer" (a utilityProcess hosts this tick; every window just renders).
//
// The tick is pure orchestration — pose seam, grab servo, rigid-body props, conjured props —
// with every subsystem INJECTED, so the ORDER itself is headless and test-pinned. View concerns
// (fps ladder, glide publish, shadow, renderer.render, pose broadcast, footprint) stay with the
// window that owns them.
//
// createSimTick(deps):
//   stepPose(dt)      -> proc pose → springs → vrm.update (the module-top seam; order #1/#24)
//   stepGrabServo()   -> grab mouse-lock retarget + the post-update aim snapshot
//   physics           -> rapier store: count/setFloor/setAvatar/step
//   conjurer          -> conjured-prop store: step
//   wake(sec)         -> hold full frame rate while something is in flight
//   isWorldReady()    -> the first global-pos broadcast arrived (floor math is real)
//   getFloorY()       -> the physics floor line (the same ground the contact shadow rests on)
//   getBody()         -> { x, y, motionY, w, h, size, baseH } — her live footprint for the capsule
export function createSimTick({ stepPose, stepGrabServo, physics, conjurer, wake, isWorldReady, getFloorY, getBody }) {
  let _floorWY = null; // last floor Y pushed into rapier — epsilon-gated so we don't churn the world

  function tick(dt) {
    stepPose(dt); // proc pose → springs → vrm.update, in the ONE order that survives the VRM humanoid copy-back (#1)
    stepGrabServo(); // after the skeleton settles: pin the GRABBED PART back under the cursor + refresh the aim snapshot
    // rigid-body props (rapier): keep the floor at the bottom of HER current monitor, track her body
    // as a collision capsule (props bounce off her), step the world.
    if (physics.count() > 0 && isWorldReady()) {
      const fy = getFloorY();
      if (_floorWY === null || Math.abs(fy - _floorWY) > 1e-3) {
        _floorWY = fy;
        physics.setFloor(fy);
      }
      const b = getBody();
      const hW = (b.h || b.baseH) * b.size,
        rr = Math.max(0.1, (b.w || 1.5) * b.size * 0.28);
      physics.setAvatar({ x: b.x, y: b.y + hW * 0.5 + b.motionY, halfH: Math.max(0.1, hW * 0.5 - rr), r: rr }); // capsule spanning feet→head, centred mid-body
      if (physics.step(dt)) wake(0.5); // hold full frame rate while something is in flight
    }
    // P3: advance conjured props (pop-in / glide / hover / timed-dismiss) UNCONDITIONALLY. This was
    // wrongly nested in the `physics.count() > 0` guard once, so a conjured prop never animated unless
    // a rapier ball happened to be in flight. step() early-outs cheaply when there are no props.
    if (conjurer.step(dt)) wake(0.5);
  }

  return { tick };
}
