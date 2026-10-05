import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } from 'obsidian';
import { TagGraphView, VIEW_TYPE, viewOptions } from './view';
import { Actions } from './actions';
import { initI18n, t } from './i18n';

export interface TagGraphSettings {
  confirmBulk: boolean;
  confirmMoves: boolean;
  inlineTags: boolean;
  animate: boolean;
  showHints: boolean;
}

const DEFAULTS: TagGraphSettings = {
  confirmBulk: true,
  confirmMoves: true,
  inlineTags: true,
  animate: true,
  showHints: true,
};

const STARTER_BASE = `filters:
  and:
    - file.ext == "md"
views:
  - type: ${VIEW_TYPE}
    name: Tag graph
    facet1: file.tags
    minCount: 2
`;

export default class TagGraphPlugin extends Plugin {
  settings: TagGraphSettings = { ...DEFAULTS };
  actions!: Actions;
  /** Open graph views, so settings changes can redraw them. */
  readonly views = new Set<TagGraphView>();

  async onload(): Promise<void> {
    initI18n();
    await this.loadSettings();
    this.actions = new Actions(this.app, () => this.settings);

    this.registerBasesView(VIEW_TYPE, {
      name: t('view.name'),
      icon: 'waypoints',
      factory: (controller, containerEl) => new TagGraphView(controller, containerEl, this),
      options: () => viewOptions(),
    });

    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Tag Graph', defaultMod: true });

    this.addCommand({
      id: 'undo-last-edit',
      name: t('cmd.undo'),
      callback: () => { void this.actions.undo(); },
    });

    this.addCommand({
      id: 'create-base',
      name: t('cmd.create'),
      callback: () => { void this.createBase(); },
    });

    this.addSettingTab(new TagGraphSettingTab(this.app, this));
  }

  /** A starter base next to the active note (or at the root), opened on the graph. */
  private async createBase(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    const dir = active?.parent && !active.parent.isRoot() ? active.parent.path + '/' : '';
    let path = normalizePath(dir + 'Tag graph.base');
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}Tag graph ${i}.base`);
    const file = await this.app.vault.create(path, STARTER_BASE);
    new Notice(t('cmd.created', { path: file.path }));
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class TagGraphSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TagGraphPlugin) {
    super(app, plugin);
  }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const toggle = (key: keyof TagGraphSettings, name: string, desc: string) =>
      new Setting(el).setName(name).setDesc(desc).addToggle(tg => tg
        .setValue(this.plugin.settings[key])
        .onChange(async v => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettings();
          for (const view of this.plugin.views) view.refresh();
        }));
    toggle('confirmBulk', t('set.confirmBulk'), t('set.confirmBulk.desc'));
    toggle('confirmMoves', t('set.confirmMoves'), t('set.confirmMoves.desc'));
    toggle('inlineTags', t('set.inlineTags'), t('set.inlineTags.desc'));
    toggle('animate', t('set.motion'), t('set.motion.desc'));
    toggle('showHints', t('set.hints'), t('set.hints.desc'));
  }
}
