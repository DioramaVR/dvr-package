'use strict';
// A game's VR launch option (docs/SPEC.md section 3, since 0.1.6): game.json
// install.vrLaunch (mod.json "vrLaunch") asks the installer to add a "Play in
// VR" launch option to the game's Steam entry, which is what a standalone
// headset such as the Steam Frame starts from its library:
//   { "args": "-dvr-vr" }
// The option runs the game exe with its launchArgs (install.launchArgs, e.g.
// Cataclismo's -force-d3d11), then args: "-force-d3d11 -dvr-vr". The flat
// option keeps the game's own arguments. The installer owns the rest (the
// exe, the wording, where in Steam's entry it goes).

const ARGS_MAX = 300;

// Why vrLaunch isn't a usable {args}, or null when it is.
function vrLaunchProblem(vrLaunch) {
  if (!vrLaunch || typeof vrLaunch !== 'object' || Array.isArray(vrLaunch)) return 'vrLaunch must be an object {args}';
  const extra = Object.keys(vrLaunch).filter((k) => k !== 'args');
  if (extra.length) return `vrLaunch has unknown fields: ${extra.join(', ')}`;
  const a = vrLaunch.args;
  if (typeof a !== 'string' || !a.trim()) return 'vrLaunch.args must be a non-empty string';
  if (a.length > ARGS_MAX) return `vrLaunch.args is too long (at most ${ARGS_MAX} characters)`;
  if (/[\x00-\x1f\x7f]/.test(a)) return 'vrLaunch.args may not hold control characters (tabs, newlines)';
  if (a !== a.trim()) return 'vrLaunch.args may not start or end with a space';
  return null;
}

// Why a mod.json's vrLaunch doesn't fit, or null (also null without one). A
// UEVR mod starts VR from its own launcher, not from a Steam launch option.
function modVrLaunchProblem(mod) {
  if (mod?.vrLaunch === undefined) return null;
  const p = vrLaunchProblem(mod.vrLaunch);
  if (p) return p;
  if (mod.loader?.type === 'uevr') return 'vrLaunch is not for a uevr mod (UEVR attaches from its own launcher)';
  return null;
}

module.exports = { vrLaunchProblem, modVrLaunchProblem, ARGS_MAX };
