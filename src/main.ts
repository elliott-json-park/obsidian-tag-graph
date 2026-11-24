import { App, Notice, Plugin, PluginSettingTab, SettingDefinitionItem, TFile, WorkspaceLeaf, getLanguage, normalizePath } from 'obsidian';
import { TagGraphView, VIEW_TYPE, viewOptions } from './view';
import { COMPANION_TYPE, TagCompanionView } from './companion';
import { Actions } from './actions';
import { LangChoice, initI18n, isLangChoice, t } from './i18n';
import { StarState, askWhenPicked, maybeAskForStar, starChanged, starOnLoad } from './star';

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
  /** The one-time star request after an update (star.ts). */
  starAsk?: StarState;
  /** Tidy suggestions the reader chose to keep as they are (tidy.ts ids). */
  tidyKept: string[];
  /** The base the ribbon icon opens: made on first use, at the vault root. */
  homeBase: string;
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
  tidyKept: [],
  homeBase: '',
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
    // A base showing a graph is a 'bases' leaf; tell ours apart by the graph's canvas.
    askWhenPicked(this, leaf => !!leaf.view.containerEl.querySelector('.tag-graph-canvas'), () => this.askForStar());

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

    /* The sidebar lives outside Bases, so it works with Bases off too. */
    this.registerView(COMPANION_TYPE, leaf => new TagCompanionView(leaf, this));

    // One click from anywhere to a graph of the whole vault, with no base to set up first.
    this.addRibbonIcon('waypoints', t('ribbon.open'), () => { void this.openVaultGraph(); });

    this.addCommand({
      id: 'open-vault-graph',
      name: t('cmd.openGraph'),
      callback: () => { void this.openVaultGraph(); },
    });

    this.addCommand({
      id: 'open-sidebar',
      name: t('cmd.openSidebar'),
      callback: () => { void this.openSidebar(); },
    });

    this.addCommand({
      id: 'reset-kept',
      name: t('cmd.resetKept'),
      callback: () => {
        this.settings.tidyKept = [];
        void this.saveSettings();
        this.redrawSidebars();
        new Notice(t('notice.resetKept'));
      },
    });

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
        new Notice(this.firstRunMessage(), 20000);
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

  /** The first-run notice, with the two ways in as buttons rather than names of commands. */
  private firstRunMessage(): DocumentFragment {
    return createFragment(f => {
      f.createDiv({ text: t('notice.firstRun') });
      const row = f.createDiv({ cls: 'tag-graph-notice-actions' });
      const graph = row.createEl('button', { cls: 'mod-cta', text: t('notice.openGraph') });
      graph.addEventListener('click', () => { void this.openVaultGraph(); });
      const side = row.createEl('button', { text: t('notice.openSidebar') });
      side.addEventListener('click', () => { void this.openSidebar(); });
    });
  }

  /**
   * The ribbon icon: open the vault-wide graph base, making it the first time.
   * A base that was deleted or moved away is simply made again.
   */
  async openVaultGraph(): Promise<void> {
    const saved = this.settings.homeBase ? this.app.vault.getAbstractFileByPath(this.settings.homeBase) : null;
    if (saved instanceof TFile && saved.extension === 'base') {
      const open = this.app.workspace.getLeavesOfType('bases').find(l => l.getViewState().state?.file === saved.path);
      if (open) { await this.app.workspace.revealLeaf(open); return; }
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(saved);
      if (!this.registerGraph() || leaf.view.getViewType() !== 'bases') new Notice(t('notice.basesOff', { path: saved.path }), 20000);
      return;
    }
    const file = await this.createBase('', true);
    if (file) {
      this.settings.homeBase = file.path;
      await this.saveSettings();
    }
  }

  /** The tag sidebar in the right sidebar, made there once and shown again after. */
  async openSidebar(): Promise<void> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(COMPANION_TYPE)[0];
    if (!leaf) {
      const right = ws.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: COMPANION_TYPE, active: true });
      leaf = right;
    }
    await ws.revealLeaf(leaf);
  }

  /** Redraw the open tag sidebars, e.g. after a settings change. */
  redrawSidebars(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(COMPANION_TYPE)) {
      if (leaf.view instanceof TagCompanionView) leaf.view.redraw();
    }
  }

  /** A starter base in `at` (default: next to the active note, else the root), opened on the graph. */
  private async createBase(at?: string, newTab = false): Promise<TFile | null> {
    const active = this.app.workspace.getActiveFile();
    const dir = at !== undefined ? at : active?.parent && !active.parent.isRoot() ? active.parent.path + '/' : '';
    const name = t('view.name');
    let path = normalizePath(`${dir}${name}.base`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}${name} ${i}.base`);
    const file = await this.app.vault.create(path, starterBase(name));
    new Notice(t('cmd.created', { path: file.path }));
    if (!(file instanceof TFile)) return null;
    const leaf = this.app.workspace.getLeaf(newTab ? 'tab' : false);
    await leaf.openFile(file);
    /* With the Bases core plugin off, a .base file has no view to open in:
       the leaf comes back empty and nothing says why. That is the one case
       where this command looks broken, so it is named. */
    if (!this.registerGraph() || leaf.view.getViewType() !== 'bases') new Notice(t('notice.basesOff', { path: file.path }), 20000);
    return file;
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<TagGraphSettings> | null;
    this.settings = Object.assign({}, DEFAULTS, saved);
    // Someone updating already found their way in; only a fresh install gets the hint.
    if (saved && saved.introShown === undefined) this.settings.introShown = true;
    if (!isLangChoice(this.settings.language)) this.settings.language = DEFAULTS.language;
    if (!['name', 'recent', 'folder'].includes(this.settings.infoSort)) this.settings.infoSort = DEFAULTS.infoSort;
    const kept: unknown = this.settings.tidyKept;
    this.settings.tidyKept = Array.isArray(kept) ? kept.filter((x): x is string => typeof x === 'string') : [];
    if (typeof this.settings.homeBase !== 'string') this.settings.homeBase = '';
    const star = starOnLoad(saved?.starAsk, !!saved, this.manifest.version);
    const changed = starChanged(saved?.starAsk, star);
    this.settings.starAsk = star;
    if (changed) await this.saveSettings();
  }

  /** Show the one-time star request if an update armed it. Called when a graph view opens. */
  askForStar(): void {
    let language: string = this.settings.language;
    if (language === 'auto') { try { language = getLanguage(); } catch { language = 'en'; } }
    maybeAskForStar(this.app, {
      state: this.settings.starAsk,
      name: this.manifest.name,
      url: 'https://github.com/elliott-json-park/obsidian-tag-graph',
      language,
      save: next => { this.settings.starAsk = next; return this.saveSettings(); },
    });
  }

  /** Switch the interface language now. The view's name in the Bases menu and the command names keep theirs until a restart. */
  setLanguage(choice: LangChoice): void {
    initI18n(choice);
    for (const view of this.views) view.relabel();
    this.redrawSidebars();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

type ToggleKey = Exclude<keyof TagGraphSettings, 'language' | 'infoSort' | 'introShown' | 'starAsk' | 'tidyKept' | 'homeBase'>;

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
    this.plugin.redrawSidebars();
  }
}
