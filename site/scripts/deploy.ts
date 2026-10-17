import { $ } from "bun";

const PROJECT_NAME = "docs";
const COMMENT_MARKER = "<!-- docs-preview -->";
const SITE_LABEL = "Rigel public design docs";

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

export type CommentAction = { type: "create" } | { type: "update"; id: string };

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
	return `${COMMENT_MARKER}\n**${SITE_LABEL} preview:** ${meta.previewUrl}\n\nDeployed from \`${meta.branch}\` at \`${meta.commitSha.slice(0, 7)}\`.`;
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

export function resolveCommentAction(
	exitCode: number,
	stdout: string,
): CommentAction {
	if (exitCode !== 0) {
		throw new Error(
			`failed to look up existing PR comments (exit ${exitCode})`,
		);
	}
	const id = stdout.trim().split("\n")[0]?.trim();
	return id ? { type: "update", id } : { type: "create" };
}

async function upsertPreviewComment(opts: {
	repo: string;
	pr: string;
	token: string;
	body: string;
}): Promise<void> {
	const ghEnv = { ...process.env, GH_TOKEN: opts.token };
	const existing =
		await $`gh api --paginate ${`repos/${opts.repo}/issues/${opts.pr}/comments`} --jq ${`.[] | select(.body | startswith("${COMMENT_MARKER}")) | .id`}`
			.env(ghEnv)
			.nothrow()
			.quiet();
	const action = resolveCommentAction(
		existing.exitCode,
		existing.stdout.toString(),
	);
	if (action.type === "update") {
		await $`gh api --method PATCH ${`repos/${opts.repo}/issues/comments/${action.id}`} -f ${`body=${opts.body}`}`
			.env(ghEnv)
			.quiet();
		console.log("updated existing preview comment");
		return;
	}

	await $`gh pr comment ${opts.pr} --repo ${opts.repo} --body ${opts.body}`
		.env(ghEnv)
		.quiet();
	console.log("created preview comment");
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
	const result = await $`bunx ${wranglerArgs(branch)}`.nothrow();
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
	await upsertPreviewComment({
		...comment.inputs,
		body: commentBody({ previewUrl, branch, commitSha }),
	});
}

if (import.meta.main) await main();
