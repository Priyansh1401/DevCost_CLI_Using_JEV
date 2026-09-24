import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export class UserFacingError extends Error {}

export function assertLocalGitRepository(repoPath: string): void {
  if (/^(https?:\/\/|git@)/i.test(repoPath)) {
    throw new UserFacingError("Error: --repo must be a local path to a cloned repository, not a URL. Clone it first with 'git clone <url>', then pass the local folder path.");
  }
  const gitDirectory = join(repoPath, ".git");
  if (!existsSync(repoPath) || !existsSync(gitDirectory) || !statSync(gitDirectory).isDirectory()) {
    throw new UserFacingError(`Error: '${repoPath}' is not a valid git repository`);
  }
}

export type GitExecutor = (command: string, arguments_: string[], options: { encoding: "utf8" }) => string;

/** Runs git without leaking child-process stack traces into CLI output. */
export function runGitCommand(repoPath: string, arguments_: string[], action: string, execute: GitExecutor = defaultGitExecutor): string {
  try {
    return execute("git", ["-C", repoPath, ...arguments_], { encoding: "utf8" });
  } catch {
    throw new UserFacingError(`Error: Git command failed while ${action}. Verify that '${repoPath}' is a readable local git repository.`);
  }
}

const defaultGitExecutor: GitExecutor = (command, arguments_, options) => execFileSync(command, arguments_, options);
