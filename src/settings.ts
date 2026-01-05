import {App, PluginSettingTab, Setting} from "obsidian";
import Bridge from "./main";

export interface MyPluginSettings {
	apiKey: string;
	ghKey: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	apiKey: '',
	ghKey: '',
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: Bridge;

	constructor(app: App, plugin: Bridge) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('snlx.net API key')
			.setDesc('For the secret notes')
			.addText(text => text
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('github API key')
			.setDesc('For the public notes')
			.addText(text => text
				.setValue(this.plugin.settings.ghKey)
				.onChange(async (value) => {
					this.plugin.settings.ghKey = value;
					await this.plugin.saveSettings();
				}));
	}
}
