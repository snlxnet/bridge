import {App, Editor, MarkdownView, Modal, Notice, Plugin, Setting} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings as BridgeSettings, SampleSettingTab as SettingTab} from "./settings";

export default class Bridge extends Plugin {
	settings: BridgeSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'publish-garden',
			name: 'Publish the Garden',
			callback: () => {
				// const files = this.app.vault.getMarkdownFiles()
					// .map(file => this.app.fileManager.processFrontMatter(file))
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
