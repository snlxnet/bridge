import {
	App,
	Component,
	Editor,
	MarkdownRenderer,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	Setting,
	TFile,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	MyPluginSettings as BridgeSettings,
	SampleSettingTab as SettingTab,
} from "./settings";
import { Octokit } from "octokit";
import beautify from "js-beautify";

const REDIRECT_TEMPLATE = `<!doctype html>
<html>
	<head>
		<title>TITLE</title>
		<meta charset="UTF-8">
		<meta http-equiv="X-UA-Compatible" content="IE=edge">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<meta name="color-scheme" content="light dark">
		<style>
		  body {
		    background: #1e1e2e;
		    color: #fab387;
		    font-family: monospace;
		  }
		  code {
		    color: transparent;
		  }
		</style>
	</head>
	<body>
		<h1>⚙ Redirecting, please wait...</h1>
		<script>
		  window.location.href = "LINK"
		</script>
	</body>
</html>
`;

const HTML_TEMPLATE = `<!doctype html>
<html>
	<head>
		<title>TITLE</title>
		<link rel="stylesheet" href="https://snlx.net/new.css">
		<meta charset="UTF-8">
		<meta http-equiv="X-UA-Compatible" content="IE=edge">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<meta name="color-scheme" content="light dark">
	</head>
	<body>
		CONTENT
		<script src="https://snlx.net/mobile.js"></script>
		<!-- TODO router.js -->
		<!-- TODO include typ.js everywhere so it's downloaded in the bg & cached -->
	</body>
</html>
`;

const REGEXES = {
	app: /app:\/\/.+\/([^?]+)(:?\?.+)?/gm,
	wiki: /\[\[(.+?)(?:\|.+)?\]\]/gm,
	md: /\[.+?]\((.+?)\)/gm,
	wikiImage: /!\[\[(.+?)(?:\|.+)?\]\]/gm,
	mdImage: /!\[.+?]\((.+?)\)/gm,
	wikiNote: /([^!])\[\[(.+?)(?:\|.+)?\]\]/gm,
	mdNote: /([^!])\[.+?]\((.+?)\)/gm,
};

type FileWithMeta = {
	file: TFile;
	created: string;
	updated: string;
	body: string;
	redirect: string | undefined;
	tags: string[];
};
type LinkTreeEntry = { from: TFile; for: TFile };

export default class Bridge extends Plugin {
	settings: BridgeSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "publish-garden",
			name: "Publish the Garden",
			callback: async () => {
				console.log("Publishing...");

				const notes = {
					pub: [] as FileWithMeta[],
					secret: [] as FileWithMeta[],
					secretIds: [] as { name: string; uuid: string }[],
					private: [] as string[],
				};

				await Promise.all(
					this.app.vault.getMarkdownFiles().map(async (file) =>
						this.app.fileManager.processFrontMatter(
							file,
							async (frontmatter) => {
								const postTag =
									(frontmatter["post"] as string) || "";
								const uuid =
									(frontmatter["uuid"] as string) || "";
								const created =
									(frontmatter["created"] as string) ||
									"1970-01-01";
								const updated =
									(frontmatter["updated"] as string) ||
									"1970-01-01";
								const tags =
									(frontmatter["tags"] as string[]) || [];
								const redirect = frontmatter["redirect"] as
									| string
									| undefined;
								const body = await this.app.vault.read(file);

								if (postTag.contains("snlx.net")) {
									notes.pub.push({
										file,
										created,
										updated,
										tags,
										body,
										redirect,
									});
								} else if (postTag) {
									frontmatter["uuid"] = crypto.randomUUID();
									frontmatter["name"] = file.name;
									delete frontmatter["post"];
									notes.secret.push({
										file,
										created,
										updated,
										tags,
										body,
										redirect,
									});
									notes.secretIds.push({
										name: file.name,
										uuid: frontmatter["uuid"],
									});
								} else if (uuid) {
									frontmatter["name"] = file.name;
									notes.secret.push({
										file,
										created,
										updated,
										tags,
										body,
										redirect,
									});
									notes.secretIds.push({
										name: file.name,
										uuid: frontmatter["uuid"],
									});
								} else {
									console.log(
										"skipping private note",
										file.name,
									);
									notes.private.push(file.path);
									return;
								}

								if (frontmatter["layout"]) {
									return;
								} else {
									frontmatter["layout"] = "base.njk";
								}
							},
						),
					),
				);

				await new Promise((resolve) => {
					let pub = 0;
					let secret = 0;
					check();

					function check() {
						if (
							pub > 0 &&
							secret > 0 &&
							pub === notes.pub.length &&
							secret === notes.secret.length
						) {
							resolve("ok");
							return;
						}
						pub = notes.pub.length;
						secret = notes.secret.length;
						console.log("Not all notes processed yet, waiting");
						setTimeout(check, 100);
					}
				});

				let publicAssets: TFile[] = [];
				let secretAssets: TFile[] = [];

				const { assets: publicAssetSet, linkTree: publicTree } =
					await this.processNotes(notes.pub);
				const { assets: secretAssetSet, linkTree: secretTree } =
					await this.processNotes(notes.secret);

				publicTree.forEach((entry) => {
					console.log(entry, notes.private);
					if (
						notes.private.contains(entry.for.path) ||
						notes.private.contains(entry.from.path)
					) {
						publicTree.delete(entry);
					}
				});
				secretTree.forEach((entry) => {
					if (
						notes.private.contains(entry.for.path) ||
						notes.private.contains(entry.from.path)
					) {
						secretTree.delete(entry);
					}
				});

				let publicNotes = await Promise.all(
					notes.pub.map(async (note) => {
						const html = note.redirect
							? REDIRECT_TEMPLATE.replace("LINK", note.redirect)
							: await this.toHTML(note, publicTree);

						return {
							name: note.file.name,
							updated: note.updated,
							body: note.body.replace(REGEXES.wiki, "[$1](/$1)"),
							html,
							redirect: note.redirect,
						};
					}),
				);

				let secretNotes = await Promise.all(
					notes.secret.map(async ({ file, updated, body }) => {
						return {
							name: file.name,
							updated,
							body: body
								.replace(
									REGEXES.wikiImage,
									"![$1](https://api.snlx.net/file?id=$1)",
								)
								.replace(REGEXES.wiki, "[$1](/$1)"),
							uuid: notes.secretIds.find(
								(candidate) => candidate.name === file.name,
							)?.uuid!, // ensured 2 lines down
						};
					}),
				);
				secretNotes = secretNotes.filter((note) => {
					if (note.uuid === undefined) {
						new Notice(
							"Note without a UUID marked as secret: " +
								note.name +
								", deleting it",
						);
					}
					return note.uuid !== undefined;
				});

				let bridgeSys = this.app.vault.getFileByPath("bridge-sys.md");
				if (!bridgeSys) {
					bridgeSys = await this.app.vault.create(
						"bridge-sys.md",
						"https://github.com/snlxnet/bridge system file",
					);
				}
				await this.app.fileManager.processFrontMatter(
					bridgeSys,
					async (store) => {
						publicNotes = publicNotes
							.map((note) => {
								if (store[note.name] === note.updated) {
									console.log(
										"♻ unchanged public 📝 " + note.name,
									);
									return null;
								} else {
									store[note.name] = note.updated;
									return note;
								}
							})
							.filter((note) => note !== null);
						secretNotes = secretNotes
							.map((note) => {
								if (store[note.name] === note.updated) {
									console.log(
										"♻ unchanged secret 📝 " + note.name,
									);
									return null;
								} else {
									store[note.name] = note.updated;
									return note;
								}
							})
							.filter((note) => note !== null);
						publicAssets = Array.from(publicAssetSet)
							.map((asset) => {
								const stored = +store[asset.name];
								const current = asset.stat.mtime;
								if (unixtimeCloseEnough(stored, current)) {
									console.log(
										"♻ unchanged public 🖼️ " + asset.name,
									);
									return null;
								} else {
									store[asset.name] = asset.stat.mtime;
									return asset;
								}
							})
							.filter((asset) => asset !== null);
						secretAssets = Array.from(secretAssetSet)
							.map((asset) => {
								const stored = +store[asset.name];
								const current = asset.stat.mtime;
								if (unixtimeCloseEnough(stored, current)) {
									console.log(
										"♻ unchanged secret 🖼️ " + asset.name,
									);
									return null;
								} else {
									store[asset.name] = asset.stat.mtime;
									return asset;
								}
							})
							.filter((asset) => asset !== null);
					},
				);

				const publicNotesMessage = [
					...publicNotes.map((note) => "- " + note.name),
					...publicAssets.map((asset) => "- " + asset.name),
				].join("\n");
				if (publicNotesMessage) {
					new Notice("Public notes:\n" + publicNotesMessage);
					new Notice("Uploading to GitHub");
					await this.commit(publicNotes, publicAssets);
					new Notice("Public notes uploaded");
				} else {
					new Notice("No public notes were updated");
				}
				const secretNotesMessage = [
					...secretNotes.map((note) => "- " + note.name),
					...secretAssets.map((asset) => "- " + asset.name),
				].join("\n");
				if (secretNotesMessage) {
					new Notice("Secret notes:\n" + secretNotesMessage);
					new Notice("Uploading to api.snlx.net");
					await this.uploadSecret(secretNotes, secretAssets).catch(
						(err) => new Notice("Failed" + JSON.stringify(err)),
					);
					new Notice("Secret notes uploaded");
				} else {
					new Notice("No secret notes were updated");
				}
			},
		});
		this.addCommand({
			id: "set-status",
			name: "Set Status",
			callback: () => {
				new StatusModal(this.app, this.settings.apiKey).open();
			},
		});

		this.addCommand({
			id: "upgrade-server",
			name: "Upgrade Server",
			callback: () => this.upgradeServer(),
		});

		this.addCommand({
			id: "add-uuid",
			name: "Add a UUID to the note",
			editorCallback: (_editor: Editor, view: MarkdownView) => {
				if (!view.file) {
					new Notice("No files are open");
					return;
				}

				this.app.fileManager.processFrontMatter(
					view.file,
					(frontmatter) => {
						if (frontmatter["uuid"]) {
							new Notice("Already has a UUID");
							return;
						}
						frontmatter["uuid"] = crypto.randomUUID();
					},
				);
			},
		});

		this.addSettingTab(new SettingTab(this.app, this));
	}

	onunload() {}

	async processNotes(pool: FileWithMeta[]) {
		const assets = new Set<TFile>();
		const linkTree: Set<LinkTreeEntry> = new Set();

		await Promise.all(
			pool.map(async ({ file: currentFile, body }) => {
				const wikilinks = body.matchAll(REGEXES.wiki);
				const mdlinks = body.matchAll(REGEXES.md);
				const links = [...wikilinks, ...mdlinks].map(
					(match) => match.last()!,
				);
				links.forEach((link) => {
					const linkedFile =
						this.app.vault.getFileByPath(link) ||
						this.app.vault.getFileByPath(link + ".md");

					if (linkedFile?.extension === "md") {
						linkTree.add({
							for: linkedFile,
							from: currentFile,
						});
					} else {
						linkedFile && assets.add(linkedFile);
					}
				});
			}),
		);

		return { assets, linkTree };
	}

	async toHTML(note: FileWithMeta, linkTree: Set<LinkTreeEntry>) {
		const component = new Component();
		component.load();
		const renderDiv = createDiv();
		await MarkdownRenderer.render(
			this.app,
			note.body,
			renderDiv,
			note.file.path,
			component,
		);
		const html = renderDiv.innerHTML;
		component.unload();
		return this.fillTemplate(note, html, Array.from(linkTree));
	}

	fillTemplate(
		note: FileWithMeta,
		withInnerHTML: string,
		linkTree: LinkTreeEntry[],
	) {
		const title = note.file.path.replace(/\/|\.md/g, "");

		const root = document.createElement("body");
		const backLinks: string[] = linkTree
			.filter((entry) => entry.for.path === note.file.path)
			.map((entry) => entry.from.basename);
		const forwardLinks: string[] = linkTree
			.filter((entry) => entry.from.path === note.file.path)
			.map((entry) => entry.for.basename);

		const nav = document.createElement("nav");
		root.appendChild(nav);
		nav.innerHTML = "<h2>Linked Notes</h2>";
		const links = document.createElement("ul");
		nav.appendChild(links);
		backLinks.map((note) => mkLink(note, "back"));
		mkLink(title, "current");
		forwardLinks.map((note) => mkLink(note, "forward"));
		const source = document.createElement("a");
		source.classList.add("source");
		source.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-github-icon lucide-github"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>Source&nbsp;code';
		source.href = "https://github.com/snlxnet/snlx.net";
		nav.appendChild(source);

		function mkLink(note: string, className: string) {
			const a = document.createElement("a");
			a.href = "/" + note;
			a.textContent = note;
			const li = document.createElement("li");
			li.classList.add(className);
			li.appendChild(a);
			links.appendChild(li);
		}

		const main = document.createElement("main");
		root.appendChild(main);
		main.innerHTML = withInnerHTML;
		root.querySelectorAll("a").forEach((anchor) => {
			anchor.removeAttribute("target");
			anchor.removeAttribute("rel");
		});

		const meta = document.createElement("div");
		meta.classList.add("metadata");
		const createdElement = document.createElement("div");
		const updatedElement = document.createElement("div");
		createdElement.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-feather-icon lucide-feather"><path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/></svg>';
		createdElement.innerHTML +=
			"created " + calculateRelativeDate(note.created);
		updatedElement.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw-icon lucide-refresh-cw"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
		updatedElement.innerHTML +=
			"updated " + calculateRelativeDate(note.updated);
		const tagElements = note.tags.map((text) => {
			const tag = document.createElement("div");
			tag.classList.add("tag");
			tag.textContent = "#" + text;
			return tag;
		});
		meta.append(createdElement, updatedElement, ...tagElements);
		main.prepend(meta);

		root.querySelectorAll(".copy-code-button").forEach((btn) =>
			btn.remove(),
		);
		root.querySelectorAll("img").forEach(
			(img) => (img.src = "/" + img.src.replace(REGEXES.app, "")),
		);
		root.querySelectorAll("a.internal-link").forEach(
			(link: HTMLAnchorElement) =>
				(link.href = "/" + link.href.replace(REGEXES.app, "")),
		);

		const html = root.innerHTML.replace(
			/"app:\/\/[^"]+\/(.+?)(\?.+?)?"/gm,
			'"$1"',
		);
		root.remove();
		return beautify.html(
			HTML_TEMPLATE.replace("TITLE", title).replace("CONTENT", html),
		);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<BridgeSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async commit(
		files: { name: string; body: string; html: string }[],
		assets: TFile[],
	) {
		const octokit = new Octokit({ auth: this.settings.ghKey });

		const lastCommit = await octokit.request(
			`GET /repos/snlxnet/{repo}/commits/HEAD?cacheBust=${Date.now()}`,
			{ repo: this.settings.repo },
		);
		const lastCommitSha = lastCommit.data.sha;
		const baseTreeSha = lastCommit.data.commit.tree.sha;

		const treePromises = files.map(async (file) => {
			const blob = await octokit.request(
				"POST /repos/snlxnet/{repo}/git/blobs",
				{
					repo: this.settings.repo,
					content: file.html,
					encoding: "utf-8",
				},
			);

			return {
				path: file.name.replace(".md", ".html"),
				mode: "100644",
				type: "blob",
				sha: blob.data.sha,
			};
		});

		const treeAssetPromises = assets.map(async (asset) => {
			const body = await this.app.vault.readBinary(asset);
			const base64 = Buffer.from(body).toString("base64");
			console.log(body, base64);

			const blob = await octokit.request(
				"POST /repos/snlxnet/{repo}/git/blobs",
				{
					repo: this.settings.repo,
					content: base64,
					encoding: "base64",
				},
			);

			return {
				path: asset.name,
				mode: "100644",
				type: "blob",
				sha: blob.data.sha,
			};
		});

		treePromises.push(...treeAssetPromises);
		const tree = await Promise.all(treePromises);

		console.log(tree);
		const newTree = await octokit.request(
			"POST /repos/snlxnet/{repo}/git/trees",
			{
				repo: this.settings.repo,
				base_tree: baseTreeSha,
				tree,
			},
		);
		const newCommit = await octokit.request(
			"POST /repos/snlxnet/{repo}/git/commits",
			{
				repo: this.settings.repo,
				message: "bridge: publish the updates",
				tree: newTree.data.sha,
				parents: [lastCommitSha],
			},
		);
		await octokit.request(
			"PATCH /repos/snlxnet/{repo}/git/refs/heads/main",
			{
				repo: this.settings.repo,
				sha: newCommit.data.sha,
			},
		);
	}

	private async uploadSecret(
		files: { name: string; body: string; uuid: string }[],
		assets: TFile[],
	) {
		const filePromises = files.map((file) =>
			this.uploadFile(file.uuid, file.body),
		);
		const assetPromises = assets.map(async (asset) =>
			this.uploadFile(asset.name, await this.app.vault.readBinary(asset)),
		);
		filePromises.push(...assetPromises);
		await Promise.all(filePromises);
	}

	private async uploadFile(name: string, body: string | ArrayBuffer) {
		const type = typeof body === "string" ? "string" : undefined;
		const blob = new Blob([body], { type });

		const formData = new FormData();
		formData.append("file", blob);
		return fetch(
			`https://api.snlx.net/file?pass=${this.settings.apiKey}&id=${name}`,
			{
				method: "POST",
				body: formData,
			},
		);
	}

	private async upgradeServer() {
		const response = await fetch(
			`https://api.snlx.net/upgrade?pass=${this.settings.apiKey}`,
		);
		const body = await response.text();
		new Notice(`Server responded with ${body}`);
	}
}

function unixtimeCloseEnough(a: number, b: number) {
	const deltaSec = Math.abs(b - a);
	console.log(a, b, deltaSec);
	return deltaSec < 15 * 60;
}

class StatusModal extends Modal {
	apiKey: string;
	action?: string = "working on";
	link?: string;
	location?: string;
	duration?: string = "+pomo";

	constructor(app: App, key: string) {
		super(app);
		this.apiKey = key;
		this.link = app.workspace
			.getActiveViewOfType(MarkdownView)
			?.file?.name.split(".")
			.slice(0, -1)
			.join(".");
	}

	onOpen() {
		let { contentEl } = this;
		contentEl.createEl("h1", { text: "Currently..." });

		contentEl.addEventListener("keypress", (event) => {
			if (event.key === "Enter" && event.ctrlKey) {
				this.close();
				this.onSubmit();
			}
		});

		new Setting(contentEl)
			.setName("action")
			.addText((text) =>
				text
					.setValue(this.action || "")
					.onChange((val) => (this.action = val)),
			);

		new Setting(contentEl)
			.setName("link")
			.addText((text) =>
				text
					.setValue(this.link || "")
					.onChange((val) => (this.link = val)),
			);

		new Setting(contentEl)
			.setName("location")
			.addText((text) => text.onChange((val) => (this.location = val)));

		new Setting(contentEl)
			.setName("duration")
			.setDesc(
				"`+20` for 20 minutes, `+pomo` to start a pomo, `7:15` until 7:15 AM",
			)
			.addText((text) =>
				text
					.setValue(this.duration || "")
					.onChange((val) => (this.location = val)),
			);

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Set status")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit();
				}),
		);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	onSubmit() {
		const url =
			`/status?pass=${this.apiKey}` +
			this.addParam("action", this.action) +
			this.addParam("link", this.link) +
			this.addParam("location", this.location) +
			this.addParam("duration", this.duration);
		new Notice(url);
	}

	private addParam(name: string, value: string | undefined) {
		if (!value) {
			return "";
		} else {
			return "&" + name + "=" + value;
		}
	}
}

function calculateRelativeDate(dateStr: string) {
	const dateObj = new Date(dateStr);
	const now = new Date();
	// @ts-ignore
	const diffHours = (now - dateObj) / 1000 / 60 / 60;
	const diffDays = diffHours / 24;
	if (diffDays > 365) {
		return (diffDays / 365).toFixed(2) + " yrs ago";
	}
	if (diffDays < 1) {
		return diffHours.toFixed(2) + " hrs ago";
	}
	return Math.floor(diffDays) + "d ago";
}
