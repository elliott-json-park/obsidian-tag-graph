import { App, Notice, Plugin, PluginSettingTab, SettingDefinitionItem, TFile, normalizePath } from 'obsidian';
import { TagGraphView, VIEW_TYPE, viewOptions } from './view';
import { Actions } from './actions';
import { LangChoice, initI18n, isLangChoice, t } from './i18n';

export interface TagGraphSettings {
  confirmBulk: boolean;
  confirmMoves: boolean;
  moveFolders: boolean;
  inlineTags: boolean;
  animate: boolean;
  showHints: boolean;
  /** Interface language; `auto` follows Obsidian's. */
  language: LangChoice;
}

const DEFAULTS: TagGraphSettings = {
  confirmBulk: true,
  confirmMoves: true,
  moveFolders: false,
  inlineTags: true,
  animate: true,
  showHints: true,
  language: 'auto',
};

/** A new base with one graph view, named in the interface language (quoted, so any name is valid YAML). */
const starterBase = (name: string) => `filters:
  and:
    - file.ext == "md"
views:
  - type: ${VIEW_TYPE}
    name: ${JSON.stringify(name)}
    facet1: file.tags
    minCount: 2
`;

export default class TagGraphPlugin extends Plugin {
  settings: TagGraphSettings = { ...DEFAULTS };
  actions!: Actions;
  /** Open graph views, so settings changes can redraw them. */
  readonly views = new Set<TagGraphView>();

  async onload(): Promise<void> {
    // Settings first, so the chosen language names the view and the commands.
    await this.loadSettings();
    initI18n(this.settings.language);
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
    const name = t('view.name');
    let path = normalizePath(`${dir}${name}.base`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}${name} ${i}.base`);
    const file = await this.app.vault.create(path, starterBase(name));
    new Notice(t('cmd.created', { path: file.path }));
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<TagGraphSettings> | null;
    this.settings = Object.assign({}, DEFAULTS, saved);
    if (!isLangChoice(this.settings.language)) this.settings.language = DEFAULTS.language;
  }

  /** Switch the interface language now. The view's name in the Bases menu and the command names keep theirs until a restart. */
  setLanguage(choice: LangChoice): void {
    initI18n(choice);
    for (const view of this.views) view.relabel();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

type ToggleKey = Exclude<keyof TagGraphSettings, 'language'>;

/** The language dropdown's choices, each language in its own name. */
function languageOptions(): Record<LangChoice, string> {
  return { auto: t('set.language.auto'), en: 'English', ko: '한국어', zh: '中文' };
}

/** Name and description of every toggle. */
function toggles(): { key: ToggleKey; name: string; desc: string }[] {
  return [
    { key: 'confirmBulk', name: t('set.confirmBulk'), desc: t('set.confirmBulk.desc') },
    { key: 'confirmMoves', name: t('set.confirmMoves'), desc: t('set.confirmMoves.desc') },
    { key: 'moveFolders', name: t('set.moveFolders'), desc: t('set.moveFolders.desc') },
    { key: 'inlineTags', name: t('set.inlineTags'), desc: t('set.inlineTags.desc') },
    { key: 'animate', name: t('set.motion'), desc: t('set.motion.desc') },
    { key: 'showHints', name: t('set.hints'), desc: t('set.hints.desc') },
  ];
}

class TagGraphSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TagGraphPlugin) {
    super(app, plugin);
  }

  /** Declared settings: Obsidian draws the tab from these and finds them in its settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [{
      name: t('set.language'), desc: t('set.language.desc'), aliases: ['language', 'English', '한국어', '中文'],
      control: { type: 'dropdown', key: 'language', options: languageOptions(), defaultValue: DEFAULTS.language },
    }];
    for (const { key, name, desc } of toggles()) items.push({ name, desc, control: { type: 'toggle', key } });
    return items;
  }

  getControlValue(key: string): unknown {
    if (key === 'language') return this.plugin.settings.language;
    return this.plugin.settings[key as ToggleKey];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'language') await this.applyLanguage(value);
    else await this.apply(key as ToggleKey, value === true);
  }

  private async applyLanguage(value: unknown): Promise<void> {
    // Checked, not asserted: the value arrives as unknown.
    if (!isLangChoice(value) || value === this.plugin.settings.language) return;
    this.plugin.settings.language = value;
    await this.plugin.saveSettings();
    this.plugin.setLanguage(value);
    // Redraw this tab in the new language.
    this.update();
  }

  private async apply(key: ToggleKey, value: boolean): Promise<void> {
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings();
    for (const view of this.plugin.views) view.refresh();
  }
}
