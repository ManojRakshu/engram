import { execFileSync } from "node:child_process";
import path from "node:path";

/** Stable graph slug for a repo: "owner-name" from the origin remote, else the directory name. */
export function repoSlug(root: string) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const m = /[:/]([^/:]+)\/([^/]+?)(\.git)?$/.exec(url);
    if (m) return `${m[1]}-${m[2]}`.toLowerCase();
  } catch {
    /* not a git repo or no origin */
  }
  return path.basename(root).toLowerCase();
}

/** The git work tree containing `dir`, if any. */
export function gitRoot(dir: string) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}
