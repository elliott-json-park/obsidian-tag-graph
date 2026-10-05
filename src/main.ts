import { App, Notice, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TFile, normalizePath } from 'obsidian';
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
    const saved = (await this.loadData()) as Partial<TagGraphSettings> | null;
    this.settings = Object.assign({}, DEFAULTS, saved);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

type ToggleKey = keyof TagGraphSettings;

/** Name and description of every toggle, shared by both ways of drawing the tab. */
function toggles(): { key: ToggleKey; name: string; desc: string }[] {
  return [
    { key: 'confirmBulk', name: t('set.confirmBulk'), desc: t('set.confirmBulk.desc') },
    { key: 'confirmMoves', name: t('set.confirmMoves'), desc: t('set.confirmMoves.desc') },
    { key: 'inlineTags', name: t('set.inlineTags'), desc: t('set.inlineTags.desc') },
    { key: 'animate', name: t('set.motion'), desc: t('set.motion.desc') },
    { key: 'showHints', name: t('set.hints'), desc: t('set.hints.desc') },
  ];
}

class TagGraphSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TagGraphPlugin) {
    super(app, plugin);
  }

  /** 1.13+: declared settings, so they show up in Obsidian's settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return toggles().map(({ key, name, desc }) => ({ name, desc, control: { type: 'toggle' as const, key } }));
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as ToggleKey];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await this.apply(key as ToggleKey, value === true);
  }

  private async apply(key: ToggleKey, value: boolean): Promise<void> {
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings();
    for (const view of this.plugin.views) view.refresh();
  }

  /** Before 1.13: the same toggles, drawn by hand. */
  display(): void {
    const el = this.containerEl;
    el.empty();
    for (const { key, name, desc } of toggles()) {
      new Setting(el).setName(name).setDesc(desc).addToggle(tg => tg
        .setValue(this.plugin.settings[key])
        .onChange(v => { void this.apply(key, v); }));
    }
  }
}
