// physics.js — the avatar's RIGID-BODY layer (rapier3d-compat: Rust→WASM, deterministic, npm-only
// install — no admin). This is the §E architectural adoption the roadmap called for: spring.js
// keeps the cheap soft-body jiggle (hair/tail/NSFW chains), THIS layer owns real dynamics.
// FIRST SLICE: throwable props (the bundled baseball) with gravity, a floor at the bottom of her
// current monitor, restitution bounces and rolling. Foundation for sit / throw-and-catch / cloth.
//
// Lazy by design: rapier's WASM (~2 MB) initializes only when the first physics prop spawns —
// zero cost for users who never throw anything. v1 limitation (documented in TODO): physics props
// live in the BRAIN window's scene only, so they render on the primary monitor.
import * as THREE from "three";

export function createPhysics({ scene, loadAsset }) {
  let RAPIER = null,
    world = null,
    floorBody = null;
  let avatarBody = null,
    avatarR = 0,
    avatarHalf = 0; // a kinematic capsule tracking HER body, so props collide with her
  let initing = null;
  const props = []; // [{ body, obj, radius }]
  let floorY = -4.6; // world-space floor line (screen bottom) — avatar.js updates it
  const GRAVITY = { x: 0, y: -14, z: 0 }; // single source of truth for the gravity vector (also exposed via diag())

  async function ensureWorld() {
    if (world) return;
    if (!initing)
      initing = (async () => {
        RAPIER = (await import("@dimforge/rapier3d-compat")).default ?? (await import("@dimforge/rapier3d-compat"));
        await RAPIER.init({}); // object form — the bare call is deprecated
        world = new RAPIER.World(GRAVITY); // slightly heavier than g — reads livelier at desktop-toy scale
        // The floor: one wide static slab whose top sits at floorY; repositioned when she changes monitor.
        floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, floorY - 0.5, 0));
        world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 50).setFriction(0.55).setRestitution(0.4), floorBody);
      })();
    await initing;
  }

  function setFloor(y) {
    if (!isFinite(y)) return;
    floorY = y;
    if (floorBody) floorBody.setTranslation({ x: 0, y: floorY - 0.5, z: 0 }, true);
  }

  // AI-PLACEABLE PLATFORMS (user design 2026-06-12): static slabs anywhere on screen — balls roll
  // on them; the avatar's release-snap treats their tops as floor lines (avatar.js side). Replaced
  // wholesale on every set; lazy like everything else (queued until the world exists).
  let platBodies = [],
    _pendingPlats = null;
  function setPlatforms(rects) {
    if (!world) {
      _pendingPlats = rects;
      ensureWorld().then(() => {
        if (_pendingPlats) {
          const p = _pendingPlats;
          _pendingPlats = null;
          setPlatforms(p);
        }
      });
      return;
    }
    for (const b of platBodies) {
      try {
        world.removeRigidBody(b);
      } catch {}
    }
    platBodies = [];
    for (const r of rects || []) {
      if (!isFinite(r.x) || !isFinite(r.y) || !(r.halfW > 0)) continue;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(r.x, r.y - 0.1, 0)); // sunk by half-height so the TOP still sits at r.y
      world.createCollider(RAPIER.ColliderDesc.cuboid(r.halfW, 0.1, 50).setFriction(0.55).setRestitution(0.4), body); // thicker slab (was 0.04) — backstop against tunneling
      platBodies.push(body);
    }
  }

  // Track HER body as a KINEMATIC capsule (driven by us, unaffected by impacts) so props bounce off
  // her instead of passing through. Called every frame with her live torso centre + size; the capsule
  // is rebuilt only when her SIZE changes meaningfully (a resize), else just repositioned — cheap.
  function setAvatar(c) {
    if (!world || !c || !isFinite(c.x) || !isFinite(c.y)) return;
    const r = Math.max(0.05, c.r),
      half = Math.max(0.05, c.halfH);
    if (
      !avatarBody ||
      Math.abs(r - avatarR) > avatarR * 0.15 + 1e-3 ||
      Math.abs(half - avatarHalf) > avatarHalf * 0.15 + 1e-3
    ) {
      if (avatarBody) world.removeRigidBody(avatarBody); // size changed → rebuild the collider (rapier can't resize one live)
      avatarBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(c.x, c.y, 0));
      world.createCollider(RAPIER.ColliderDesc.capsule(half, r).setRestitution(0.45).setFriction(0.6), avatarBody);
      avatarR = r;
      avatarHalf = half;
    }
    avatarBody.setNextKinematicTranslation({ x: c.x, y: c.y, z: 0 }); // smooth kinematic move → proper contact velocity
  }

  // Spawn a prop mesh as a dynamic ball and hurl it. from = {x,y} world, vel = {x,y} world/s.
  async function throwProp(url, from, vel, sizeWorld = 0.34) {
    if (![from?.x, from?.y, vel?.x, vel?.y].every(Number.isFinite)) return null; // a NaN off the bus must not enter the sim as a permanent dead body (serializes NaN to peers, can poison the contact solver)
    await ensureWorld();
    return new Promise((resolve) => {
      loadAsset(
        url,
        (asset) => {
          if (!asset.scene) return resolve(null);
          const obj = asset.scene;
          const bb = new THREE.Box3().setFromObject(obj);
          const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
          obj.scale.setScalar(sizeWorld / span); // normalize the prop to a sane world size
          obj.traverse((o) => {
            if (o.isMesh) o.frustumCulled = false;
          });
          const c = bb.getCenter(new THREE.Vector3()).multiplyScalar(obj.scale.x);
          obj.userData._centerOff = c; // keep the visual centered on the body
          scene.add(obj);
          const r = sizeWorld / 2;
          const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
              .setTranslation(from.x, Math.max(from.y, floorY + r + 0.01), 0)
              .setLinvel(vel.x, vel.y, 0)
              .setAngvel({ x: 0, y: 0, z: -vel.x * 1.6 }) // spin with the throw → it ROLLS on landing
          );
          body.setEnabledTranslations(true, true, false, true); // keep the toy in the 2D screen plane
          body.enableCcd(true); // CCD: a fast throw (vy ~5.8, dt<=0.05) can't tunnel thin slabs
          world.createCollider(
            RAPIER.ColliderDesc.ball(r).setRestitution(0.62).setFriction(0.45).setDensity(1.2),
            body
          );
          while (props.length >= 24) {
            const old = props.shift();
            scene.remove(old.obj);
            old.obj.traverse((o) => {
              if (o.geometry) o.geometry.dispose();
              if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
            });
            if (world) world.removeRigidBody(old.body);
          } // HARD CAP: a stuck bus / AI loop must not spawn rapier bodies until the step + VRAM choke
          props.push({ body, obj, radius: r });
          resolve(true);
        },
        () => resolve(null)
      );
    });
  }

  function clearProps() {
    for (const p of props) {
      scene.remove(p.obj);
      p.obj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      if (world) world.removeRigidBody(p.body);
    }
    props.length = 0;
  }

  // Serialize each live prop's visual transform RELATIVE to her root (ox,oy) so PEER windows can
  // render ghost copies on whatever monitor she's actually on — physics props live only in the
  // brain's scene (it can draw on the primary display alone), so without this the ball spawns
  // off-screen whenever she's parked on another monitor. Layout (flat, transferable):
  //   [ count, then per prop: dx, dy, qx, qy, qz, qw, scale ]
  // World units are model-tied (worldH is a fixed per-window constant), so an offset-from-her-root
  // is portable across displays of any size/DPI — and because the ghosts hang off HER root, they
  // automatically fall off-screen on every monitor she isn't standing on (no per-monitor logic).
  function serializeProps(ox, oy) {
    const n = props.length,
      buf = new Float32Array(1 + n * 7);
    buf[0] = n;
    let k = 1;
    for (const p of props) {
      const o = p.obj,
        q = o.quaternion;
      buf[k++] = o.position.x - ox;
      buf[k++] = o.position.y - oy;
      buf[k++] = q.x;
      buf[k++] = q.y;
      buf[k++] = q.z;
      buf[k++] = q.w;
      buf[k++] = o.scale.x;
    }
    return buf;
  }

  const _q = new THREE.Quaternion();
  function step(dt) {
    if (!world || !props.length) return false;
    world.timestep = Math.min(0.05, Math.max(1 / 240, dt > 0 ? dt : 1 / 240)); // NaN/<=0 dt -> floor, never propagate a NaN timestep into world.step() (one bad frame NaNs every prop)
    world.step();
    let awake = false;
    for (const p of props) {
      const t = p.body.translation(),
        rq = p.body.rotation();
      const off = p.obj.userData._centerOff;
      _q.set(rq.x, rq.y, rq.z, rq.w);
      p.obj.quaternion.copy(_q);
      p.obj.position.set(t.x, t.y, t.z);
      if (off) p.obj.position.sub(off.clone().applyQuaternion(_q));
      if (!p.body.isSleeping()) awake = true;
    }
    return awake; // keep the frame rate up only while something moves
  }

  // Tiny by-numbers diagnostic: the live gravity vector + floor line, for verifying the
  // gravity-vs-floor contract (a thrown ball must rest at ~floorY + r) without poking internals.
  function diag() {
    return { gravity: { ...GRAVITY }, floorY };
  }

  return {
    throwProp,
    clearProps,
    step,
    setFloor,
    setPlatforms,
    setAvatar,
    serializeProps,
    diag,
    count: () => props.length,
  };
}
