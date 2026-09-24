import { describe, expect, it } from "vitest";
import { assertLocalGitRepository, runGitCommand, UserFacingError } from "./git-utils.js";

describe("git repository safety", () => {
  it("rejects a URL-shaped --repo argument before any git command", () => {
    expect(() => assertLocalGitRepository("https://github.com/example/repo.git")).toThrow("Error: --repo must be a local path to a cloned repository, not a URL.");
    expect(() => assertLocalGitRepository("git@github.com:example/repo.git")).toThrow(UserFacingError);
  });

  it("rejects nonexistent repository paths cleanly", () => {
    expect(() => assertLocalGitRepository("C:\\does-not-exist\\repo")).toThrow("Error: 'C:\\does-not-exist\\repo' is not a valid git repository");
  });

  it("converts a git execution failure into a user-facing error", () => {
    const failingGit = () => { throw new Error("simulated git failure"); };
    expect(() => runGitCommand("C:\\test-repo", ["log"], "reading commit history", failingGit)).toThrow("Error: Git command failed while reading commit history. Verify that 'C:\\test-repo' is a readable local git repository.");
  });
});
