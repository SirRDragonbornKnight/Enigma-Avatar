// state.js — the engine STATE CONTAINER factory.
//
// The avatar engine's mutable state lives as locals in the big avatar.js bootstrap closure (model,
// proc, facial, sizeScale, the toggles, …). The carved-out control modules (control/surface.js,
// control/bus.js, control/query.js) need to read that state LIVE — a handler must always act on
// current truth, even after the model or a toggle changes. Historically each field was handed over
// as its own getter/setter thunk (getProc, getFacial, … — ~115 of them across the three factories),
// which is fragile: pass a frozen value by mistake instead of a thunk and the handler silently goes
// stale.
//
// makeEngineView collapses all of that into ONE object whose properties are live by construction:
//   - `getters`: name -> () => <closure var>      exposed as a live read-only accessor (engine.proc)
//   - `setters`: name -> (v) => { <closure var> = v }   exposed as a write accessor (engine.cursorIdle = 0)
//   - `statics`: stable in-place objects (pos, cursor, …) that are mutated but never reassigned, shared by ref
//
// The closure builds the view once and passes `engine` to each factory. Because the accessors close
// over the closure's live bindings, engine.proc is ALWAYS the current proc — you cannot accidentally
// snapshot a frozen value. This is the seam the closure's own reads will migrate onto next.
export function makeEngineView(getters = {}, setters = {}, statics = {}) {
  const view = { ...statics };
  for (const k in getters) {
    Object.defineProperty(view, k, { get: getters[k], enumerable: true, configurable: true });
  }
  for (const k in setters) {
    const prev = Object.getOwnPropertyDescriptor(view, k);
    Object.defineProperty(view, k, {
      get: prev && prev.get, // keep a same-named getter if one was also supplied
      set: setters[k],
      enumerable: true,
      configurable: true,
    });
  }
  return view;
}
