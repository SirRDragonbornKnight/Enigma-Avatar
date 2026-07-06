// dispose.js — GPU-honest teardown. three's material.dispose() frees the SHADER PROGRAM but
// NOT the material's textures (.map/.normalMap/...), so every model swap / prop despawn would
// leak its whole texture set to VRAM (monotonic growth per swap and per throw).
// One helper, used by every teardown site (model swap, attachments, conjure, physics props).
// Texture.dispose() is idempotent, so within-model sharing (two meshes, one texture) is safe.

/** Dispose a material AND every texture it references. */
export function disposeMaterial(m) {
  if (!m) return;
  for (const k in m) {
    const v = m[k];
    if (v && v.isTexture) v.dispose();
  }
  m.dispose();
}

/** Dispose every geometry + material + texture under `root` (the mesh subtree teardown). */
export function disposeMeshTree(root) {
  if (!root || !root.traverse) return;
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(disposeMaterial);
  });
}
