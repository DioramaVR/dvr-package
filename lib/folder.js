'use strict';
// The "folder" loader (docs/SPEC.md section 3): a mod the game loads itself
// from a folder of its own (Timberborn's Documents\Timberborn\Mods\<mod>).
// game.json install.folder (mod.json "folder") says where that folder is:
//   { "target": "documents" | "game", "path": "Timberborn/Mods/TimberbornVr" }
// target is a base folder the installer knows: "documents" is the player's
// Documents folder (the shell's known folder, wherever OneDrive moved it),
// "game" the game's install folder. path is relative to it.

const TARGETS = ['documents', 'game'];
const BAD_CHARS = /[<>:"\|?*\x00-\x1f]/;

// Why folder isn't a usable {target, path}, or null when it is.
function folderProblem(folder) {
  if (!folder || typeof folder !== 'object' || Array.isArray(folder)) return 'folder must be an object {target, path}';
  const extra = Object.keys(folder).filter((k) => k !== 'target' && k !== 'path');
  if (extra.length) return `folder has unknown fields: ${extra.join(', ')}`;
  if (!TARGETS.includes(folder.target)) return `folder.target must be one of ${TARGETS.join(', ')}`;
  const p = folder.path;
  if (typeof p !== 'string' || !p) return 'folder.path must be a non-empty string';
  if (p.length > 200) return 'folder.path is too long (at most 200 characters)';
  if (p.startsWith('/') || BAD_CHARS.test(p)) return `folder.path "${p}" must be relative, with forward slashes and no drive, ":" or "\\"`;
  for (const seg of p.split('/')) {
    if (!seg || seg === '.' || seg === '..') return `folder.path "${p}" has an empty, "." or ".." part`;
    if (/[ .]$/.test(seg)) return `folder.path "${p}": a part may not end with a space or a dot`;
  }
  return null;
}

// Why a mod.json's folder doesn't fit its loader, or null: a folder mod needs a
// safe folder; any other loader has none. The writer and the reader both ask.
function modFolderProblem(mod) {
  if (mod?.loader?.type === 'folder') return folderProblem(mod.folder);
  return mod?.folder !== undefined ? `mod.json has a folder but its loader isn't "folder"` : null;
}

module.exports = { TARGETS, folderProblem, modFolderProblem };
