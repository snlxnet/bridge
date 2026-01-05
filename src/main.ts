import {App, Editor, FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, Setting, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings as BridgeSettings, SampleSettingTab as SettingTab} from "./settings";
import { Octokit } from 'octokit';

export default class Bridge extends Plugin {
	settings: BridgeSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'publish-garden',
			name: 'Publish the Garden',
			callback: async () => {
				const now = new Date()
				const today = now.toISOString().split('T')[0] || "1970-01-01"

				const notes = {
					pub: [] as TFile[],
					secret: [] as TFile[],
					secretIds: [] as {name: string, uuid: string}[],
				}

				await Promise.all(this.app.vault.getMarkdownFiles().map(async (file) => (
					this.app.fileManager.processFrontMatter(file, async (frontmatter) => {
						const postTag = frontmatter['post'] as string || ""
						const uuid = frontmatter['uuid'] as string || ""

						if (postTag.contains("snlx.net")) {
							notes.pub.push(file)
						} else if (postTag) {
							frontmatter['uuid'] = crypto.randomUUID()
							delete frontmatter['post']
							notes.secret.push(file)
							notes.secretIds.push({name: file.name, uuid: frontmatter['uuid']})
						} else if (uuid) {
							notes.secret.push(file)
							notes.secretIds.push({name: file.name, uuid: frontmatter['uuid']})
						} else {
							return
						}

						if (!frontmatter['created']) {
							const created = new Date(file.stat.ctime)
							frontmatter['created'] = created.toISOString().split('T')[0]
						}
						frontmatter['updated'] = today
						if (frontmatter['layout']) {
							return
						} else {
							frontmatter['layout'] = 'base.njk'
						}
					})
				)))

				const publicAssets = new Set<string>()
				const publicNotes = await Promise.all(notes.pub.map(async (file) => {
					const body = await this.app.vault.read(file)
					const wikilinks = body.matchAll(/!\[\[(.+?)(?:\|.+)?\]\]/gm)
					const mdlinks = body.matchAll(/!\[.+]\((.+)\)/gm)
					const links = [...wikilinks, ...mdlinks].map(match => match.last()!)
					links.forEach(link => publicAssets.add(link))

					return {
						name: file.name,
						body: body,
					}
				}))

				const secretAssets = new Set<string>()
				const secretNotes = await Promise.all(notes.secret.map(async (file) => {
					const body = await this.app.vault.read(file)
					const wikilinks = body.matchAll(/!\[\[(.+?)(?:\|.+)?\]\]/gm)
					const mdlinks = body.matchAll(/!\[.+]\((.+)\)/gm)
					const links = [...wikilinks, ...mdlinks].map(match => match.last()!)
					links.forEach(link => secretAssets.add(link))

					return {
						name: file.name,
						uuid: notes.secretIds.find(candidate => candidate.name === file.name)?.uuid,
						body: body,
					}
				}))
				secretNotes.forEach(note => {
					const wikilink = /([^!])\[\[(.+?)(?:\|.+)?\]\]/gm
					const mdlink = /([^!])\[.+?]\((.+)\)/gm

					note.body = note.body.replace(mdlink, replacer).replace(wikilink, replacer)

					function replacer(_match: string, prefix: string, name: string) {
						const uuid = secretNotes.find(note => note.name === name + ".md")?.uuid || name

						return `${prefix}[${name}](/secure?id=${uuid})`
					}
				})

				new Notice('Note processing done')
				new Notice('Uploading to GitHub')
				await this.commit(publicNotes, Array.from(publicAssets))
				new Notice('Public notes uploaded')
			}
		});
		this.addCommand({
			id: 'set-status',
			name: 'Set Status',
			callback: () => {
				new StatusModal(this.app, this.settings.apiKey).open();
			}
		});

		this.addCommand({
			id: 'add-uuid',
			name: 'Add a UUID to the note',
			editorCallback: (_editor: Editor, view: MarkdownView) => {
				if (!view.file) {
					new Notice("No files are open")
					return
				}

				this.app.fileManager.processFrontMatter(view.file, (frontmatter) => {
					if (frontmatter['uuid']) {
						new Notice("Already has a UUID")
						return
					}
					frontmatter['uuid'] = crypto.randomUUID()
				})
			}
		});
		
		this.addSettingTab(new SettingTab(this.app, this));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<BridgeSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async commit(files: {name: string, body: string}[], assets: string[]) {
		const octokit = new Octokit({auth: this.settings.ghKey})

		const lastCommit = await octokit.request(
			`GET /repos/snlxnet/{repo}/commits/HEAD?cacheBust=${Date.now()}`,
			{ repo: this.settings.repo },
		)
		const lastCommitSha = lastCommit.data.sha;
		const baseTreeSha = lastCommit.data.commit.tree.sha

		const treePromises = files.map(async (file) => {
			const blob = await octokit.request(
				"POST /repos/snlxnet/{repo}/git/blobs",
				{
					repo: this.settings.repo,
					content: file.body,
					encoding: "utf-8",
				}
			)

			return {
				path: file.name,
				mode: "100644",
				type: "blob",
				sha: blob.data.sha,
			}
		})

		const treeAssetPromises = assets.map(async (asset) => {
			const file = this.app.vault.getFileByPath(asset)!
			const body = await this.app.vault.readBinary(file)
			const base64 = Buffer.from(body).toString('base64')
			console.log(body, base64)

			const blob = await octokit.request(
				"POST /repos/snlxnet/{repo}/git/blobs",
				{
					repo: this.settings.repo,
					content: base64,
					encoding: "base64",
				}
			)

			return {
				path: asset,
				mode: "100644",
				type: "blob",
				sha: blob.data.sha,
			}
		})

		treePromises.push(...treeAssetPromises)
		const tree = await Promise.all(treePromises)

		console.log(tree)
		const newTree = await octokit.request(
			"POST /repos/snlxnet/{repo}/git/trees",
			{
				repo: this.settings.repo,
				base_tree: baseTreeSha,
				tree,
			}
		)
		const newCommit = await octokit.request(
			"POST /repos/snlxnet/{repo}/git/commits",
			{
				repo: this.settings.repo,
				message: "bridge: publish multiple files",
				tree: newTree.data.sha,
				parents: [lastCommitSha],
			}
		)
		await octokit.request(
			"PATCH /repos/snlxnet/{repo}/git/refs/heads/main",
			{
				repo: this.settings.repo,
				sha: newCommit.data.sha,
			}
		)
	}
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
		this.link = app.workspace.getActiveViewOfType(MarkdownView)?.file?.name.split('.').slice(0, -1).join('.');
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.createEl('h1', { text: "Currently..." });

		contentEl.addEventListener("keypress", (event) => {
			if (event.key === "Enter" && event.ctrlKey) {
				this.close()
				this.onSubmit()
			}
		})

		new Setting(contentEl).setName("action")
		.addText(text => text.setValue(this.action || "").onChange(val => this.action = val))

		new Setting(contentEl).setName("link")
		.addText(text => text.setValue(this.link || "").onChange(val => this.link = val))

		new Setting(contentEl).setName("location")
		.addText(text => text.onChange(val => this.location = val))

		new Setting(contentEl).setName("duration")
		.setDesc("`+20` for 20 minutes, `+pomo` to start a pomo, `7:15` until 7:15 AM")
		.addText(text => text.setValue(this.duration || "").onChange(val => this.location = val))

		new Setting(contentEl).addButton((button) => button.setButtonText("Set status").setCta().onClick(() => {
			this.close()
			this.onSubmit()
		}))
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}

	onSubmit() {
		const url = `/status?pass=${this.apiKey}` + this.addParam("action", this.action) + this.addParam("link", this.link) + this.addParam("location", this.location) + this.addParam("duration", this.duration)
		new Notice(url)
	}

	private addParam(name: string, value: string | undefined) {
		if (!value) {
			return ""
		} else {
			return "&" + name + "=" + value
		}
	}
}
