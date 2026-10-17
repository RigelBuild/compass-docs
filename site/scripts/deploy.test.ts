import { describe, expect, test } from "bun:test";
import {
	commentBody,
	deployBranch,
	findPreviewComment,
	parsePreviewUrl,
	recordedCommitSha,
	resolvePreviewComment,
	upsertPreviewComment,
	wranglerArgs,
} from "./deploy.ts";

const marker = "<!-- docs-preview -->";
const author = "github-actions[bot]";

function previewComment(id: number, body: string, login: string) {
	return { id, body, user: { login } };
}

describe("docs preview deployment", () => {
	test("deploys pushes to the production branch", () => {
		const pushEnv = { GITHUB_EVENT_NAME: "push" };
		expect(deployBranch(pushEnv)).toBe("main");
		expect(wranglerArgs(deployBranch(pushEnv))).toContain("--branch=main");
	});

	test("deploys pull requests to their source branch", () => {
		expect(
			deployBranch({
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_HEAD_REF: "feature/docs-preview",
			}),
		).toBe("feature/docs-preview");
	});

	test("refuses a pull request without its source branch", () => {
		expect(() => deployBranch({ GITHUB_EVENT_NAME: "pull_request" })).toThrow(
			"GITHUB_HEAD_REF is not set",
		);
	});

	test("refuses a pull request from the production branch", () => {
		expect(() =>
			deployBranch({
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_HEAD_REF: "main",
			}),
		).toThrow("refusing to deploy a preview to production");
	});

	test("uses the deployment alias URL from Wrangler output", () => {
		expect(
			parsePreviewUrl(
				"✨ Deployment complete! Take a peek over at https://3a92f7cc.docs-2ui.pages.dev\n✨ Deployment alias URL: https://web-rig-5616-docs-preview.docs-2ui.pages.dev",
			),
		).toBe("https://web-rig-5616-docs-preview.docs-2ui.pages.dev");
	});

	test("returns null when Wrangler output has no Pages URL", () => {
		expect(parsePreviewUrl("deployment completed without a URL")).toBeNull();
	});

	test("comments on the preview URL and short commit SHA", () => {
		const body = commentBody({
			previewUrl: "https://preview.docs.pages.dev",
			branch: "feature/docs-preview",
			commitSha: "1234567890abcdef",
		});

		expect(body.startsWith(marker)).toBe(true);
		expect(body).toContain("Rigel public design docs");
		expect(body).toContain("https://preview.docs.pages.dev");
		expect(body).toContain("`feature/docs-preview` at `1234567`");
		expect(body).not.toContain("1234567890abcdef");
	});

	test("escapes backticks in branch names before adding code spans", () => {
		const body = commentBody({
			previewUrl: "https://preview.docs.pages.dev",
			branch: "feature/`preview",
			commitSha: "1234567890abcdef",
		});

		expect(body).toContain("`feature/'preview` at `1234567`");
	});

	test("records the PR head SHA instead of the synthetic merge SHA", () => {
		expect(
			recordedCommitSha({
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_SHA: "merge-commit-sha",
				PR_HEAD_SHA: "pull-request-head-sha",
			}),
		).toBe("pull-request-head-sha");
	});

	test("reports each missing input needed to comment", () => {
		const result = resolvePreviewComment({});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("missing inputs must be rejected");
		expect(result.reason).toContain("GH_TOKEN");
		expect(result.reason).toContain("PR_NUMBER");
		expect(result.reason).toContain("GITHUB_REPOSITORY");
	});

	test("finds no matching preview comment", () => {
		expect(
			findPreviewComment(
				[[previewComment(10, "an unrelated comment", author)]],
				marker,
				author,
			),
		).toBeNull();
	});

	test("finds a marker comment by the expected bot", () => {
		expect(
			findPreviewComment(
				[[previewComment(10, `${marker}\npreview`, author)]],
				marker,
				author,
			),
		).toBe(10);
	});

	test("ignores a marker comment from another user", () => {
		expect(
			findPreviewComment(
				[[previewComment(10, `${marker}\npreview`, "someone-else")]],
				marker,
				author,
			),
		).toBeNull();
	});

	test("finds a matching comment on the second page", () => {
		expect(
			findPreviewComment(
				[
					[previewComment(10, "unrelated", author)],
					[previewComment(20, `${marker}\npreview`, author)],
				],
				marker,
				author,
			),
		).toBe(20);
	});

	test("fails when the comment lookup command fails", async () => {
		const runner = async (_args: string[]) => ({ exitCode: 1, stdout: "" });
		await expect(
			upsertPreviewComment({
				repo: "RigelBuild/docs",
				pr: "40",
				body: `${marker}\npreview`,
				runner,
			}),
		).rejects.toThrow("failed to look up existing PR comments");
	});

	test("patches the existing preview comment", async () => {
		const calls: string[][] = [];
		const runner = async (args: string[]) => {
			calls.push(args);
			return args[0] === "api" && args.includes("--slurp")
				? {
						exitCode: 0,
						stdout: JSON.stringify([
							[previewComment(27, `${marker}\nprevious`, author)],
						]),
					}
				: { exitCode: 0, stdout: "" };
		};

		await upsertPreviewComment({
			repo: "RigelBuild/docs",
			pr: "40",
			body: `${marker}\nupdated`,
			runner,
		});

		expect(calls[0]).toEqual([
			"api",
			"--paginate",
			"--slurp",
			"repos/RigelBuild/docs/issues/40/comments",
		]);
		expect(calls[1]).toEqual([
			"api",
			"--method",
			"PATCH",
			"repos/RigelBuild/docs/issues/comments/27",
			"-f",
			`body=${marker}\nupdated`,
		]);
	});

	test("creates a preview comment when no matching comment exists", async () => {
		const calls: string[][] = [];
		const runner = async (args: string[]) => {
			calls.push(args);
			return { exitCode: 0, stdout: JSON.stringify([[]]) };
		};

		await upsertPreviewComment({
			repo: "RigelBuild/docs",
			pr: "40",
			body: `${marker}\npreview`,
			runner,
		});

		expect(calls[1]).toEqual([
			"pr",
			"comment",
			"40",
			"--repo",
			"RigelBuild/docs",
			"--body",
			`${marker}\npreview`,
		]);
	});
});
