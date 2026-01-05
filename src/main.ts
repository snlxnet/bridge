import {App, Editor, MarkdownView, Modal, Notice, Plugin, Setting, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings as BridgeSettings, SampleSettingTab as SettingTab} from "./settings";

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

				await Promise.all(this.app.vault.getMarkdownFiles().map(async (file) => {
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
				}))

				// This will bite me at some point
				new Notice('Waiting for all notes to be processed')
				await new Promise((resolve) => setTimeout(resolve, 500))

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

				console.log({secretNotes, secretAssets, publicNotes, publicAssets})

				new Notice('Not yet Implemented')
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
