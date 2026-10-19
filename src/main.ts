import { App, Notice, Plugin, PluginSettingTab, SettingDefinitionItem, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
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
  /** How a value's notes are listed in the details panel. */
  infoSort: 'name' | 'recent' | 'folder';
  /** The how-to-open hint has been shown once. */
  introShown: boolean;
}

const DEFAULTS: TagGraphSettings = {
  confirmBulk: true,
  confirmMoves: true,
  moveFolders: false,
  inlineTags: true,
  animate: true,
  showHints: true,
  language: 'auto',
  infoSort: 'name',
  introShown: false,
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
  /** Whether the view is registered with Bases; false while the Bases core plugin is off. */
  private basesReady = false;

  async onload(): Promise<void> {
    // Settings first, so the chosen language names the view and the commands.
    await this.loadSettings();
    initI18n(this.settings.language);
    this.actions = new Actions(this.app, () => this.settings);

    this.registerGraph();
    /* Bases turned on after this plugin loaded leaves the view unregistered,
       and every base that uses it reads "unknown view type" until a restart.
       So the registration is tried again whenever a base is opened, and the
       tabs showing one are redrawn once it takes. */
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (this.basesReady || file?.extension !== 'base' || !this.registerGraph()) return;
      for (const leaf of this.app.workspace.getLeavesOfType('bases')) void this.reopen(leaf);
    }));

    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Tag Graph', defaultMod: true });

    this.addCommand({
      id: 'undo-last-edit',
      name: t('cmd.undo'),
      callback: () => { void this.actions.undo(); },
    });

    // No default hotkey: Settings → Hotkeys can bind them, to Delete or anything else.
    this.addCommand({
      id: 'remove-selected-everywhere',
      name: t('cmd.removeSelected'),
      checkCallback: checking => this.activeView()?.runOnSelected('remove', checking) ?? false,
    });

    this.addCommand({
      id: 'delete-selected',
      name: t('cmd.deleteSelected'),
      checkCallback: checking => this.activeView()?.runOnSelected('delete', checking) ?? false,
    });

    this.addCommand({
      id: 'create-base',
      name: t('cmd.create'),
      callback: () => { void this.createBase(); },
    });

    this.addSettingTab(new TagGraphSettingTab(this.app, this));

    /* A graph that lives inside Bases has no ribbon icon and no view of its
       own to open, so a fresh install shows a settings tab and nothing else.
       Said once, on the first start, with the two ways in. */
    if (!this.basesReady) {
      this.app.workspace.onLayoutReady(() => new Notice(t('notice.basesOffLoad'), 15000));
    } else if (!this.settings.introShown) {
      this.app.workspace.onLayoutReady(() => {
        new Notice(t('notice.firstRun'), 15000);
        this.settings.introShown = true;
        void this.saveSettings();
      });
    }
  }

  /** Register the graph with Bases, if Bases is there to take it. */
  private registerGraph(): boolean {
    if (this.basesReady) return true;
    this.basesReady = this.registerBasesView(VIEW_TYPE, {
      name: t('view.name'),
      icon: 'waypoints',
      factory: (controller, containerEl) => new TagGraphView(controller, containerEl, this),
      options: () => viewOptions(),
    });
    return this.basesReady;
  }

  /** Redraw a tab from scratch: the same state again is a no-op, so it goes through an empty tab first. */
  private async reopen(leaf: WorkspaceLeaf): Promise<void> {
    const state = leaf.getViewState();
    await leaf.setViewState({ type: 'empty' });
    await leaf.setViewState(state);
  }

  /** The graph in the active tab, if there is one. */
  private activeView(): TagGraphView | undefined {
    for (const view of this.views) if (view.isActive()) return view;
    return undefined;
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
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    /* With the Bases core plugin off, a .base file has no view to open in:
       the leaf comes back empty and nothing says why. That is the one case
       where this command looks broken, so it is named. */
    if (!this.registerGraph() || leaf.view.getViewType() !== 'bases') new Notice(t('notice.basesOff', { path: file.path }), 20000);
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<TagGraphSettings> | null;
    this.settings = Object.assign({}, DEFAULTS, saved);
    // Someone updating already found their way in; only a fresh install gets the hint.
    if (saved && saved.introShown === undefined) this.settings.introShown = true;
    if (!isLangChoice(this.settings.language)) this.settings.language = DEFAULTS.language;
    if (!['name', 'recent', 'folder'].includes(this.settings.infoSort)) this.settings.infoSort = DEFAULTS.infoSort;
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

type ToggleKey = Exclude<keyof TagGraphSettings, 'language' | 'infoSort' | 'introShown'>;

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
