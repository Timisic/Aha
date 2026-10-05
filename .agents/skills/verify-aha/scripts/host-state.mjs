import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

async function socketIdentity(file) {
  try {
    const info = await lstat(file);
    assert(info.isSocket(), 'Main Obsidian CLI path must be a socket');
    return { device: info.dev, inode: info.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function hostState() {
  const home = homedir();
  const socket = await socketIdentity(path.join(home, '.obsidian-cli.sock'));
  const security = spawnSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(security.status, 0, 'Read the default login keychain before launching a fixture');
  const keychain = security.stdout.trim();
  let cli = null;
  if (socket) {
    const result = spawnSync('obsidian', ['version'], { encoding: 'utf8', timeout: 8000 });
    assert.equal(result.status, 0, 'Existing main Obsidian CLI must respond to version');
    cli = result.stdout.trim();
    assert(/\d+\.\d+/.test(cli), 'Main CLI must return an Obsidian version');
  }
  return { home, socket, keychain, cli };
}

export function assertHostUnchanged(before, after) {
  assert.deepEqual(after, before, 'Desktop verification changed the main CLI socket, availability, home or default keychain');
}
