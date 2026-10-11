import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative } from "node:path";
import {
	type DecisionRow,
	parseDecisionFile,
	renderDecisionIndex,
} from "@rigelbuild/design-ledger-gate/decision-files.ts";
import { slug as githubSlug } from "github-slugger";

const REPO_SLUG = "RigelBuild/docs";
const DECISION_PATH_RE =
	/^docs\/designs\/([^/]+)\/decisions\/[^/]+\/DL-\d+\.md$/;
const MARKDOWN_LINK = /(!?\[[^\][\n]*)?(\]\()([^)\s]+)(\s+"[^"]*")?(\))/g;

function firstH1Index(lines: readonly string[]): number {
	let fence: { marker: "`" | "~"; length: number } | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const fenceMarker = line.trim().match(/^(`{3,}|~{3,})/)?.[1];
		if (fence !== undefined) {
			if (
				fenceMarker !== undefined &&
				fenceMarker[0] === fence.marker &&
				fenceMarker.length >= fence.length
			) {
				fence = undefined;
			}
			continue;
		}
		if (fenceMarker !== undefined) {
			fence = {
				marker: fenceMarker[0] === "`" ? "`" : "~",
				length: fenceMarker.length,
			};
			continue;
		}
		if (/^#\s+.+$/.test(line.trim())) return index;
	}
	return -1;
}

export function extractTitle(source: string, sourcePath: string): string {
	const lines = source.split("\n");
	const heading = firstH1Index(lines);
	return heading < 0
		? basename(sourcePath, ".md")
		: (lines[heading] ?? "").trim().replace(/^#\s+/, "").trim();
}

export function stripFirstH1(source: string): string {
	const lines = source.split("\n");
	const heading = firstH1Index(lines);
	if (heading < 0) return source;
	lines.splice(heading, lines[heading + 1] === "" ? 2 : 1);
	return lines.join("\n");
}

export function routeSlug(contentPath: string): string {
	return `/${contentPath
		.replace(/\.mdx?$/i, "")
		.split("/")
		.map((segment) => githubSlug(segment))
		.join("/")
		.replace(/\/index$/, "")}`;
}

function contentPath(sourcePath: string): string {
	return sourcePath.replace(/^docs\//, "");
}

function normalizeRepoPath(path: string): string {
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return segments.join("/");
}

export function rewriteLinks(
	source: string,
	sourcePath: string,
	gathered: ReadonlySet<string>,
): string {
	return source.replace(
		MARKDOWN_LINK,
		(
			match,
			label: string | undefined,
			open: string,
			target: string,
			title: string | undefined,
			close: string,
		) => {
			if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) return match;
			const suffixAt = target.search(/[?#]/);
			const linkPath = suffixAt < 0 ? target : target.slice(0, suffixAt);
			const suffix = suffixAt < 0 ? "" : target.slice(suffixAt);
			const resolved = normalizeRepoPath(
				posix.join(dirname(sourcePath), linkPath),
			);
			let destination: string;
			if (/\.md$/i.test(resolved) && gathered.has(resolved)) {
				destination = routeSlug(contentPath(resolved)) + suffix;
			} else if (label?.startsWith("!") && gathered.has(resolved)) {
				return match;
			} else {
				const kind = linkPath.endsWith("/") ? "tree" : "blob";
				destination = `https://github.com/${REPO_SLUG}/${kind}/main/${resolved}${suffix}`;
			}
			return `${label ?? ""}${open}${destination}${title ?? ""}${close}`;
		},
	);
}

function frontmatter(title: string, sourcePath?: string): string {
	const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const editUrl =
		sourcePath === undefined
			? ""
			: `editUrl: "https://github.com/${REPO_SLUG}/edit/main/${sourcePath}"\n`;
	return `---\ntitle: "${escaped}"\n${editUrl}---\n`;
}

export function transform(
	source: string,
	sourcePath: string,
	gathered: ReadonlySet<string>,
): string {
	if (DECISION_PATH_RE.test(sourcePath)) {
		const parsed = parseDecisionFile(sourcePath, source);
		if (!parsed.ok) {
			throw new Error(
				`${sourcePath}:${parsed.error.line}: ${parsed.error.reason}`,
			);
		}
		const { id, decision, status, recordRaw } = parsed.row;
		const body = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
		const page = `${decision}\n\n**Status:** ${status}\n\n**Record:** [${recordRaw}](${recordRaw})\n${body.trim() === "" ? "" : `\n${body}`}`;
		return (
			frontmatter(id, sourcePath) + rewriteLinks(page, sourcePath, gathered)
		);
	}
	return (
		frontmatter(extractTitle(source, sourcePath), sourcePath) +
		rewriteLinks(stripFirstH1(source), sourcePath, gathered)
	);
}

export function buildDecisionIndex(
	surface: string,
	rows: readonly DecisionRow[],
	gathered: ReadonlySet<string>,
): string {
	const byArea = new Map<string, DecisionRow[]>();
	for (const row of rows) {
		const area = dirname(row.path);
		const existing = byArea.get(area);
		if (existing === undefined) byArea.set(area, [row]);
		else existing.push(row);
	}
	const sections = [...byArea.keys()].sort().map((area) => {
		const table = renderDecisionIndex(byArea.get(area) ?? []);
		return `## ${basename(area)}\n\n${rewriteLinks(table, `${area}/index.md`, gathered)}`;
	});
	return `${frontmatter(`${surface} decisions`)}\nEvery ${surface} decision, by area. Generated from the decision files at build time.\n\n${sections.join("\n")}`;
}

async function markdownFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
	}
	return files;
}

export async function gather(
	repoRoot: string,
	siteRoot: string,
): Promise<number> {
	const docsRoot = join(repoRoot, "docs");
	const files = (await markdownFiles(docsRoot)).sort();
	const sources = new Map<string, string>();
	for (const file of files) {
		const sourcePath = relative(repoRoot, file).split("\\").join("/");
		sources.set(sourcePath, await readFile(file, "utf8"));
	}
	const gathered = new Set(sources.keys());
	const contentRoot = join(siteRoot, "src", "content", "docs");
	await rm(contentRoot, { recursive: true, force: true });
	const landing = join(contentRoot, "index.md");
	await mkdir(dirname(landing), { recursive: true });
	await writeFile(
		landing,
		`${frontmatter("Rigel public design docs")}\nDesign records and decisions for Rigel's public repositories.\n\n## Designs\n\nProjects are listed in the sidebar. Their design records and decisions are grouped by repository.\n`,
	);
	const decisions = new Map<string, DecisionRow[]>();
	for (const [sourcePath, source] of sources) {
		const destination = join(contentRoot, contentPath(sourcePath));
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, transform(source, sourcePath, gathered));
		const surface = sourcePath.match(DECISION_PATH_RE)?.[1];
		if (surface !== undefined) {
			const parsed = parseDecisionFile(sourcePath, source);
			if (parsed.ok) {
				const existing = decisions.get(surface);
				if (existing === undefined) decisions.set(surface, [parsed.row]);
				else existing.push(parsed.row);
			}
		}
	}
	for (const [surface, rows] of decisions) {
		const destination = join(
			contentRoot,
			"designs",
			surface,
			"decisions",
			"index.md",
		);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, buildDecisionIndex(surface, rows, gathered));
	}
	return files.length;
}

if (import.meta.main) {
	const siteRoot = join(import.meta.dir, "..");
	const repoRoot = join(siteRoot, "..");
	const count = await gather(repoRoot, siteRoot);
	console.log(
		`gather: wrote ${count} docs into ${join(siteRoot, "src", "content", "docs")}`,
	);
}
