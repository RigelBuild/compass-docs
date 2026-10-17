import { describe, expect, test } from "bun:test";
import {
	commentBody,
	deployBranch,
	parsePreviewUrl,
	recordedCommitSha,
	resolveCommentAction,
	resolvePreviewComment,
} from "./deploy.ts";

describe("docs preview deployment", () => {
	test("deploys pushes to the production branch", () => {
		expect(deployBranch({ GITHUB_EVENT_NAME: "push" })).toBe("main");
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

	test("uses the last Pages URL in Wrangler output", () => {
		expect(
			parsePreviewUrl(
				"Uploading https://first.docs.pages.dev then https://last.docs.pages.dev",
			),
		).toBe("https://last.docs.pages.dev");
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

		expect(body.startsWith("<!-- docs-preview -->")).toBe(true);
		expect(body).toContain("Rigel public design docs");
		expect(body).toContain("https://preview.docs.pages.dev");
		expect(body).toContain("`feature/docs-preview` at `1234567`");
		expect(body).not.toContain("1234567890abcdef");
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

	test("uses the first matching comment ID for an update", () => {
		expect(resolveCommentAction(0, "42\n43\n")).toEqual({
			type: "update",
			id: "42",
		});
	});

	test("creates a comment when no marker comment ID was found", () => {
		expect(resolveCommentAction(0, "")).toEqual({ type: "create" });
	});

	test("fails rather than treating a comment lookup failure as no comment", () => {
		expect(() => resolveCommentAction(1, "")).toThrow(
			"failed to look up existing PR comments",
		);
	});
});
