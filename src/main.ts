import {App, Editor, FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, Setting, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings as BridgeSettings, SampleSettingTab as SettingTab} from "./settings";
import { Octokit } from 'octokit';

type FileWithMeta = {file: TFile, updated: string}

export default class Bridge extends Plugin {
	settings: BridgeSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'publish-garden',
			name: 'Publish the Garden',
			callback: async () => {
				console.log("Publishing...")

				const notes = {
					pub: [] as FileWithMeta[],
					secret: [] as FileWithMeta[],
					secretIds: [] as {name: string, uuid: string}[],
				}

				await Promise.all(this.app.vault.getMarkdownFiles().map(async (file) => (
					this.app.fileManager.processFrontMatter(file, async (frontmatter) => {
						const postTag = frontmatter['post'] as string || ""
						const uuid = frontmatter['uuid'] as string || ""
						const updated = frontmatter['updated'] as string || "1970-01-01"

						if (postTag.contains("snlx.net")) {
							notes.pub.push({file, updated})
						} else if (postTag) {
							frontmatter['uuid'] = crypto.randomUUID()
							delete frontmatter['post']
							notes.secret.push({file, updated})
							notes.secretIds.push({name: file.name, uuid: frontmatter['uuid']})
						} else if (uuid) {
							notes.secret.push({file, updated})
							notes.secretIds.push({name: file.name, uuid: frontmatter['uuid']})
						} else {
							return
						}

						if (frontmatter['layout']) {
							return
						} else {
							frontmatter['layout'] = 'base.njk'
						}
					})
				)))

				const publicAssetSet = new Set<TFile>()
				let publicAssets: TFile[] = []
				const regexes = {
					wiki: /\[\[(.+?)(?:\|.+)?\]\]/gm,
					md: /\[.+]\((.+)\)/gm,
					wikiImage: /!\[\[(.+?)(?:\|.+)?\]\]/gm,
					mdImage: /!\[.+]\((.+)\)/gm,
					wikiNote: /([^!])\[\[(.+?)(?:\|.+)?\]\]/gm,
					mdNote: /([^!])\[.+?]\((.+)\)/gm,
				}
				let publicNotes = await Promise.all(notes.pub.map(async ({file, updated}) => {
					const body = await this.app.vault.read(file)
					const wikilinks = body.matchAll(regexes.wikiImage)
					const mdlinks = body.matchAll(regexes.mdImage)
					const links = [...wikilinks, ...mdlinks].map(match => match.last()!)
					links.forEach(link => {
						const file = this.app.vault.getFileByPath(link)
						file && publicAssetSet.add(file)
					})

					return {
						name: file.name,
						updated,
						body: body.replace(regexes.wiki, "[$1](/$1)"),
					}
				}))

				const secretAssetSet = new Set<TFile>()
				let secretAssets: TFile[] = []
				let secretNotes = await Promise.all(notes.secret.map(async ({file, updated}) => {
					const body = await this.app.vault.read(file)
					const wikilinks = body.matchAll(regexes.wikiImage)
					const mdlinks = body.matchAll(regexes.mdImage)
					const links = [...wikilinks, ...mdlinks].map(match => match.last()!)
					links.forEach(link => {
						const file = this.app.vault.getFileByPath(link)
						file && secretAssetSet.add(file)
					})

					return {
						name: file.name,
						updated,
						body: body.replace(regexes.wiki, "[$1](/$1)"),
						uuid: notes.secretIds.find(candidate => candidate.name === file.name)?.uuid!, // ensured 2 lines down
					}
				}))
				secretNotes = secretNotes.filter(note => {
					if (note.uuid === undefined) {
						new Notice("Note without a UUID marked as secret: " + note.name + ", deleting it")
					}
					return note.uuid !== undefined
				})

				let bridgeSys = this.app.vault.getFileByPath("bridge-sys.md")
				if (!bridgeSys) {
					bridgeSys = await this.app.vault.create("bridge-sys.md", "https://github.com/snlxnet/bridge system file")
				}
				await this.app.fileManager.processFrontMatter(bridgeSys, async (store) => {
					publicNotes = publicNotes.map(note => {
						if (store[note.name] === note.updated) {
							console.log("♻ unchanged public 📝 " + note.name)
							return null
						} else {
							store[note.name] = note.updated
							return note
						}
					}).filter(note => note !== null)
					secretNotes = secretNotes.map(note => {
						if (store[note.name] === note.updated) {
							console.log("♻ unchanged secret 📝 " + note.name)
							return null
						} else {
							store[note.name] = note.updated
							return note
						}
					}).filter(note => note !== null)
					publicAssets = Array.from(publicAssetSet).map(asset => {
						const stored = +store[asset.name]
						const current = asset.stat.mtime
						if (unixtimeCloseEnough(stored, current)) {
							console.log("♻ unchanged public 🖼️ " + asset.name)
							return null
						} else {
							store[asset.name] = asset.stat.mtime
							return asset
						}
					}).filter(asset => asset !== null)
					secretAssets = Array.from(secretAssetSet).map(asset => {
						const stored = +store[asset.name]
						const current = asset.stat.mtime
						if (unixtimeCloseEnough(stored, current)) {
							console.log("♻ unchanged secret 🖼️ " + asset.name)
							return null
						} else {
							store[asset.name] = asset.stat.mtime
							return asset
						}
					}).filter(asset => asset !== null)
				})

				const publicNotesMessage = [...publicNotes.map(note => '- ' + note.name), ...publicAssets.map(asset => '- ' + asset.name)].join('\n')
				if (publicNotesMessage) {
					new Notice('Public notes:\n' + publicNotesMessage)
					new Notice('Uploading to GitHub')
					await this.commit(publicNotes, publicAssets)
					new Notice('Public notes uploaded')
				} else {
					new Notice('No public notes were updated')
				}
				const secretNotesMessage = [...secretNotes.map(note => '- ' + note.name), ...secretAssets.map(asset => '- ' + asset.name)].join('\n')
				if (secretNotesMessage) {
					new Notice('Secret notes:\n' + secretNotesMessage)
					new Notice('Uploading to api.snlx.net')
					await this.uploadSecret(secretNotes, secretAssets).catch(err => new Notice("Failed" + JSON.stringify(err)))
					new Notice('Secret notes uploaded')
				} else {
					new Notice('No secret notes were updated')
				}
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
			id: 'upgrade-server',
			name: 'Upgrade Server',
			callback: () => this.upgradeServer(),
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

	private async commit(files: {name: string, body: string}[], assets: TFile[]) {
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
			const body = await this.app.vault.readBinary(asset)
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
				path: asset.name,
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
				message: "bridge: publish the updates",
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

	private async uploadSecret(files: {name: string, body: string, uuid: string}[], assets: TFile[]) {
		const filePromises = files.map(file => this.uploadFile(file.uuid, file.body))
		const assetPromises = assets.map(async (asset) => this.uploadFile(asset.name, await this.app.vault.readBinary(asset)))
		filePromises.push(...assetPromises)
		await Promise.all(filePromises)
	}

	private async uploadFile(name: string, body: string | ArrayBuffer) {
		const type = typeof body === "string" ? "string" : undefined;
		const blob = new Blob([body], { type })

	    const formData = new FormData()
	    formData.append("file", blob)
		return fetch(`https://api.snlx.net/file?pass=${this.settings.apiKey}&id=${name}`, {
			method: "POST",
			body: formData,
		})
	}

	private async upgradeServer() {
		const response = await fetch(`https://api.snlx.net/upgrade?pass=${this.settings.apiKey}`)
		const body = await response.text()
		new Notice(`Server responded with ${body}`)
	}
}

function unixtimeCloseEnough(a: number, b: number) {
	const deltaSec = Math.abs(b - a)
	console.log(a, b, deltaSec)
	return deltaSec < 15 * 60
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
