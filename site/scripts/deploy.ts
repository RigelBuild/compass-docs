import { $ } from "bun";

const PROJECT_NAME = "docs";
const COMMENT_MARKER = "<!-- docs-preview -->";
const SITE_LABEL = "Rigel public design docs";

const PREVIEW_COMMENT_AUTHOR = "github-actions[bot]";

export interface DeployEnv {
	GITHUB_EVENT_NAME?: string;
	GITHUB_HEAD_REF?: string;
	GITHUB_SHA?: string;
	PR_HEAD_SHA?: string;
	GITHUB_REPOSITORY?: string;
	PR_NUMBER?: string;
	GH_TOKEN?: string;
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
}

export interface PreviewCommentInputs {
	repo: string;
	pr: string;
	token: string;
}

export interface PreviewMeta {
	previewUrl: string;
	branch: string;
	commitSha: string;
}

export interface PreviewComment {
	id: number;
	body: string;
	user: { login: string };
}

export type GhRunner = (
	args: string[],
) => Promise<{ exitCode: number; stdout: string }>;

export function findPreviewComment(
	pages: { id: number; body: string; user: { login: string } }[][],
	marker: string,
	author: string,
): number | null {
	for (const page of pages) {
		const match = page.find(
			(comment) =>
				comment.body.startsWith(marker) && comment.user.login === author,
		);
		if (match) return match.id;
	}
	return null;
}

function isPullRequest(env: DeployEnv): boolean {
	return env.GITHUB_EVENT_NAME === "pull_request";
}

export function deployBranch(env: DeployEnv): string {
	if (!isPullRequest(env)) return "main";

	const branch = env.GITHUB_HEAD_REF?.trim();
	if (!branch) {
		throw new Error(
			"GITHUB_HEAD_REF is not set; refusing to deploy a pull request preview",
		);
	}
	if (branch === "main") {
		throw new Error("refusing to deploy a preview to production branch main");
	}
	return branch;
}

export function wranglerArgs(branch: string): string[] {
	return [
		"wrangler",
		"pages",
		"deploy",
		"site/dist",
		`--project-name=${PROJECT_NAME}`,
		`--branch=${branch}`,
		"--commit-dirty=true",
	];
}

export function parsePreviewUrl(output: string): string | null {
	const matches = output.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/g);
	return matches?.at(-1) ?? null;
}

export function recordedCommitSha(env: DeployEnv): string | undefined {
	return isPullRequest(env) ? env.PR_HEAD_SHA?.trim() : env.GITHUB_SHA?.trim();
}

export function commentBody(meta: PreviewMeta): string {
	const branch = meta.branch.replaceAll("`", "'");
	return `${COMMENT_MARKER}\n**${SITE_LABEL} preview:** ${meta.previewUrl}\n\nDeployed from \`${branch}\` at \`${meta.commitSha.slice(0, 7)}\`.`;
}

export function resolvePreviewComment(
	env: DeployEnv,
): { ok: true; inputs: PreviewCommentInputs } | { ok: false; reason: string } {
	const token = env.GH_TOKEN?.trim();
	const pr = env.PR_NUMBER?.trim();
	const repo = env.GITHUB_REPOSITORY?.trim();
	const missing: string[] = [];
	if (!token) missing.push("GitHub token (GH_TOKEN)");
	if (!pr) missing.push("PR number (PR_NUMBER)");
	if (!repo) missing.push("repo (GITHUB_REPOSITORY)");
	if (!token || !pr || !repo) {
		return {
			ok: false,
			reason: `cannot post preview comment: missing ${missing.join(", ")}`,
		};
	}
	return { ok: true, inputs: { repo, pr, token } };
}

function isPreviewCommentPages(pages: unknown): pages is PreviewComment[][] {
	if (!Array.isArray(pages)) return false;
	for (const page of pages) {
		if (!Array.isArray(page)) return false;
		for (const comment of page) {
			if (typeof comment !== "object" || comment === null) return false;
			if (
				!("id" in comment) ||
				typeof comment.id !== "number" ||
				!("body" in comment) ||
				typeof comment.body !== "string" ||
				!("user" in comment) ||
				typeof comment.user !== "object" ||
				comment.user === null ||
				!("login" in comment.user) ||
				typeof comment.user.login !== "string"
			) {
				return false;
			}
		}
	}
	return true;
}

export async function upsertPreviewComment(opts: {
	repo: string;
	pr: string;
	body: string;
	runner: GhRunner;
}): Promise<void> {
	const lookup = await opts.runner([
		"api",
		"--paginate",
		"--slurp",
		`repos/${opts.repo}/issues/${opts.pr}/comments`,
	]);
	if (lookup.exitCode !== 0) {
		throw new Error(
			`failed to look up existing PR comments (exit ${lookup.exitCode})`,
		);
	}

	let response: unknown;
	try {
		response = JSON.parse(lookup.stdout);
	} catch (error) {
		throw new Error("failed to parse existing PR comments", { cause: error });
	}
	if (!isPreviewCommentPages(response)) {
		throw new Error("GitHub returned invalid PR comments");
	}

	const commentId = findPreviewComment(
		response,
		COMMENT_MARKER,
		PREVIEW_COMMENT_AUTHOR,
	);
	const args =
		commentId === null
			? ["pr", "comment", opts.pr, "--repo", opts.repo, "--body", opts.body]
			: [
					"api",
					"--method",
					"PATCH",
					`repos/${opts.repo}/issues/comments/${commentId}`,
					"-f",
					`body=${opts.body}`,
				];
	const result = await opts.runner(args);
	if (result.exitCode !== 0) {
		throw new Error(
			`failed to upsert preview comment (exit ${result.exitCode})`,
		);
	}
	console.log(
		commentId === null
			? "created preview comment"
			: "updated existing preview comment",
	);
}

async function main(): Promise<void> {
	const env = process.env;
	if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
		throw new Error(
			"CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required",
		);
	}

	const branch = deployBranch(env);
	console.log(`Deploying site/dist to Cloudflare Pages (branch: ${branch})...`);
	const result = await $`bunx ${wranglerArgs(branch)}`.nothrow().quiet();
	const output = result.stdout.toString() + result.stderr.toString();
	console.log(output);
	if (result.exitCode !== 0) {
		throw new Error(`wrangler pages deploy failed (exit ${result.exitCode})`);
	}
	if (!isPullRequest(env)) return;

	const previewUrl = parsePreviewUrl(output);
	if (!previewUrl) {
		throw new Error(
			"deploy succeeded but no preview URL was found in wrangler output",
		);
	}
	const comment = resolvePreviewComment(env);
	if (!comment.ok) throw new Error(comment.reason);
	const commitSha = recordedCommitSha(env);
	if (!commitSha)
		throw new Error(
			"PR_HEAD_SHA is not set; cannot identify the preview commit",
		);
	const ghEnv = { ...process.env, GH_TOKEN: comment.inputs.token };
	const runner: GhRunner = async (args) => {
		const result = await $`gh ${args}`.env(ghEnv).nothrow().quiet();
		return { exitCode: result.exitCode, stdout: result.stdout.toString() };
	};
	await upsertPreviewComment({
		repo: comment.inputs.repo,
		pr: comment.inputs.pr,
		body: commentBody({ previewUrl, branch, commitSha }),
		runner,
	});
}

if (import.meta.main) await main();
